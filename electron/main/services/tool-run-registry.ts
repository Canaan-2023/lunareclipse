/**
 * 工具运行托管注册表（软超时协作协议的核心状态层）。
 *
 * 为什么存在：月蚀外墙对工具执行有 30s 保护墙（llm.ts），本意是防卡死拖住对话，
 * 但对真实子进程类工具（run_command / code_run 等）是"锁死固定时间"：
 * 即使底层还在正常推进（长构建/长下载/批量任务），外墙一到 30s 就 abort 杀进程，
 * AI 被迫重试或放弃，长任务永远完不成。用户要求改为"超时不打断，让 AI 检查、
 * 设定新检查时间，到期没完继续检查，或 AI 自己停止"。
 *
 * 本模块提供的就是这套协作协议的落点：
 * - 外墙超时命中的托管工具：进程不杀、请求不 reject，注册到本表并返回 taskId；
 * - AI 用 tool_watch(taskId, waitMs) 检查：未完成继续等/再查，完成则取回最终结果；
 * - AI 用 tool_stop(taskId) 主动停止：转发 abort 信号，底层跑 killTree 收尸；
 * - 完成记录短时保留（TTL），watch 在任务结束后仍能取回结果；
 * - 永不硬截断：超时一律转托管，不因并发占满等任何条件退回 abort 强杀；后台任务
 *   是否堆积由 AI 用 tool_watch/tool_stop 自行管理（用户硬性要求，明确禁止
 *   "为了兜底改变实际使用逻辑"式的并发上限兜底）。
 * - 并发决策权在 AI：系统按设备实际负载（CPU/内存采样）动态计算一个「并发参考上限」，
 *   把上限与当前活跃数告知 AI；超限只提醒（AI 自行排序取舍，tool_stop 低优任务），
 *   系统永不拦注册、永不强杀——上限是告知刻度，不是硬门禁。
 *
 * 边界：本表只负责"登记 + 状态 + 结果暂存 + 停止转发"，不发起、不执行任何工具逻辑；
 * 所有真正终止动作由底层工具感知 ctx.signal 后自行完成（run_command 共用 killTree）。
 */

import { createHash } from 'crypto'
import { randomUUID } from 'crypto'

/** 单次托管运行的完整状态 */
export interface ManagedToolRun {
  /** 全局唯一任务 id（tool_watch / tool_stop 的寻址键） */
  taskId: string
  /** 进入托管的工具名 */
  toolName: string
  /** 进入托管的参数（快照，供诊断展示） */
  args: Record<string, unknown>
  /** 工具开始执行的时间戳（含外墙等待前） */
  startedAt: number
  /** 状态机：running（后台运行中）→ settled（已出终局结果）/ stopped（AI 主动停止） */
  status: 'running' | 'settled' | 'stopped'
  /** 状态落定时间（settled / stopped 时写入） */
  finishedAt?: number
  /** 终局结果字符串（settled 时写入；stopped 可能无结果） */
  result?: string
  /** 终局错误（promise reject 时写入） */
  error?: string
  /** 取消信号源：tool_stop 时 abort()，底层工具感知后自行终止子进程 */
  controller: AbortController
}

/** 已完成（settled/stopped）任务的结果保留时长：watch 在结束后仍可读，超时清理 */
const SETTLED_TTL_MS = 10 * 60_000

const runs = new Map<string, ManagedToolRun>()

/** 生成短任务 id：工具名前缀 + 随机短码（避免暴露单调序号） */
function makeTaskId(toolName: string): string {
  const short = createHash('sha1').update(randomUUID()).digest('hex').slice(0, 10)
  return `${toolName}-${short}`
}

/**
 * 注册一个转入后台的托管运行。
 * @param toolName 工具名
 * @param args 参数快照
 * @param startedAt 开始时间戳
 * @param controller 取消信号源（tool_stop 转发用）
 * @param execPromise 工具执行的原始 promise（settle 后写入结果/错误）
 */
export function registerManagedRun(
  toolName: string,
  args: Record<string, unknown>,
  startedAt: number,
  controller: AbortController,
  execPromise: Promise<unknown>
): string {
  const taskId = makeTaskId(toolName)
  const run: ManagedToolRun = {
    taskId,
    toolName,
    args,
    startedAt,
    status: 'running',
    controller
  }
  runs.set(taskId, run)

  // 后台 promise 落定 → 记录终局（成功/失败统一收敛为字符串结果，watch 可读）
  execPromise
    .then((raw: unknown) => {
      const cur = runs.get(taskId)
      if (!cur || cur.status !== 'running') return
      cur.status = 'settled'
      cur.finishedAt = Date.now()
      cur.result =
        typeof raw === 'string' ? raw : typeof raw === 'undefined' ? '' : JSON.stringify(raw)
      scheduleGc()
    })
    .catch((err: unknown) => {
      const cur = runs.get(taskId)
      if (!cur || cur.status !== 'running') return
      cur.status = 'settled'
      cur.finishedAt = Date.now()
      cur.error = err instanceof Error ? err.message : String(err)
      scheduleGc()
    })

  // 惰性 GC：有任务落定后延迟清理一次（避免常驻定时器）
  scheduleGc()
  return taskId
}

/** 查询托管状态快照（不等待） */
export function peekManagedRun(taskId: string): ManagedToolRun | undefined {
  return runs.get(taskId)
}

/**
 * 等待托管任务落定，至多 waitMs。
 * 返回四种可能：任务不存在 / 等待期内落定（含终局结果） / 等待超时（仍 running） /
 * 等待被中断（signal aborted，调用方通常因用户打断而放弃本轮等待；任务本身不受影响，仍可稍后 watch）。
 * watch 工具据此实现"AI 设定检查时间，到期未完成继续检查"语义。
 * @param signal 可选中断信号：等待期间 signal 被 abort 时提前返回 'interrupted'（不再等满 waitMs）
 */
export async function waitForManagedRun(
  taskId: string,
  waitMs: number,
  signal?: AbortSignal
): Promise<ManagedToolRun | 'not_found' | 'wait_timeout' | 'interrupted'> {
  const run = runs.get(taskId)
  if (!run) return 'not_found'
  if (run.status !== 'running') return run
  if (signal?.aborted) return 'interrupted'
  // waitMs 语义 =「本次调用再等多久」，基准必须是本次调用时刻，而非任务总耗时。
  // 旧实现用 (now - startedAt) >= waitMs 短路，把任务总时长误当等待窗口——
  // 任务已跑过 waitMs 时直接返回 wait_timeout，即使它在窗口内落定也拿不到结果，
  // AI 不得不空耗多轮 watch（与 tool_watch「提前落定立即返回」的描述相悖）。
  // 分段轮询：每 200ms 唤醒一次，同时检查落定/超时/中断三个条件。
  // 不用 Promise.race(settleSignal, timeout)：interrupt 信号无法插入 race 且
  // 无法及时感知——轮询把小段等待切成可中断片，用户打断（llm.ts 豁免桥接
  // ctrl.signal → toolAbort.signal）时最迟 200ms 让位，旧对话流立刻收尾。
  const deadline = Date.now() + waitMs
  for (;;) {
    const cur = runs.get(taskId)
    if (!cur) return 'not_found'
    if (cur.status !== 'running') return cur
    if (signal?.aborted) return 'interrupted'
    if (Date.now() >= deadline) return 'wait_timeout'
    await sleep(Math.min(WATCH_POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

/** 等待轮询间隔：平衡打断响应速度与空转会开销 */
const WATCH_POLL_MS = 200

/** Node 兼容 sleep：await 可中断的毫秒延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 主动停止托管任务：abort 取消信号（底层工具监听 ctx.signal 后 killTree 收尸）。
 * 已落定的任务返回现有终局，不再重复 abort。
 */
export function stopManagedRun(taskId: string): ManagedToolRun | undefined {
  const run = runs.get(taskId)
  if (!run) return undefined
  if (run.status === 'running') {
    run.status = 'stopped'
    run.finishedAt = Date.now()
    run.error = '已由 AI 主动停止（tool_stop）'
    try {
      run.controller.abort()
    } catch {
      /* abort 本身不抛错，防御性兜底 */
    }
    scheduleGc()
  }
  return run
}

/** 已落定任务的 TTL 清理：只清 settled/stopped，running 永不清理 */
let gcTimer: ReturnType<typeof setTimeout> | null = null
function scheduleGc(): void {
  if (gcTimer) return
  gcTimer = setTimeout(() => {
    gcTimer = null
    const now = Date.now()
    for (const [id, run] of runs) {
      if (run.status !== 'running' && run.finishedAt && now - run.finishedAt > SETTLED_TTL_MS) {
        runs.delete(id)
      }
    }
  }, SETTLED_TTL_MS)
}

// ===== 设备负载探测 + 动态并发上限 =====
// 为什么存在：托管任务（run_command / 子 agent 等）占 CPU/内存，若无限堆积会拖垮设备。
// 但上限绝不能是"满 8 个就 abort 强杀"（用户明令禁止，见文件头注释）——正确做法是：
// ① 按设备真实负载（CPU/内存采样）动态计算一个"当前应能承载多少并发"的参考上限；
// ② 把上限和当前活跃数告诉 AI；③ 超限只提醒、由 AI 自行排序取舍（tool_stop 低优任务），
// 系统永不拦注册、永不强杀。上限是"告知与提醒的刻度"，不是硬门禁。
import { cpus, freemem, totalmem } from 'os'

/** 动态上限的参考区间：无论负载多低，AI 同时跑这么多后台任务已无效益；负载再高也不低于 1（保留最少并行度） */
const DYNAMIC_CAP_MIN = 1
const DYNAMIC_CAP_MAX = 8
/** CPU/内存使用率高于该阈值时视为"重载"，上限降到参考区间的 1/3 */
const HEAVY_LOAD_PCT = 75

/** CPU 采样状态：双点采样（两次 read 间隔采样，算区间占用率） */
let cpuSample: { idleMs: number; totalMs: number } | null = null
let cpuSampleAt = 0
const CPU_SAMPLE_GAP_MS = 500

/** 采样一次 CPU 累计时间（os.cpus() 返回自开机起的累计运行时间） */
function sampleCpu(): { idleMs: number; totalMs: number } {
  const cores = cpus()
  let idleMs = 0
  let totalMs = 0
  for (const c of cores) {
    idleMs += c.times.idle
    totalMs += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq
  }
  return { idleMs, totalMs }
}

/** 当前 CPU 占用率（0-100）。双点采样：无历史窗口时先取一点并安排 500ms 后再取第二点；缓存达 2s 则刷新。 */
let cachedCpuPct = 0
let cachedCpuAt = 0
const CPU_CACHE_TTL_MS = 2000

function currentCpuPct(): number {
  const now = Date.now()
  if (!cpuSample || now - cpuSampleAt >= CPU_CACHE_TTL_MS) {
    cpuSample = sampleCpu()
    cpuSampleAt = now
    // 第二点尚未取得时返回上一份缓存（或 0），500ms 内刷新
    if (cachedCpuAt) return cachedCpuPct
    setTimeout(() => {
      const next = sampleCpu()
      if (cpuSample) {
        const idleDelta = next.idleMs - cpuSample.idleMs
        const totalDelta = next.totalMs - cpuSample.totalMs
        if (totalDelta > 0) cachedCpuPct = Math.round(100 * (1 - idleDelta / totalDelta))
        cachedCpuAt = Date.now()
      }
    }, CPU_SAMPLE_GAP_MS)
    return cachedCpuPct
  }
  // 采样窗口（首点拿到、第二点未回）内：用第二点重算一次
  const next = sampleCpu()
  const idleDelta = next.idleMs - cpuSample.idleMs
  const totalDelta = next.totalMs - cpuSample.totalMs
  if (totalDelta > 0) cachedCpuPct = Math.round(100 * (1 - idleDelta / totalDelta))
  cachedCpuAt = now
  return cachedCpuPct
}

/** 当前内存占用率（0-100） */
function currentMemPct(): number {
  const total = totalmem()
  if (!total) return 0
  return Math.round(100 * (1 - freemem() / total))
}

/** 设备负载采样结果（供 AI 可见的统计快照） */
export interface DeviceLoadStats {
  /** 当前后台托管中（running）的任务数 */
  running: number
  /** 按当前负载动态计算的并发参考上限（AI 自行排序的刻度，非硬门禁） */
  dynamicCap: number
  /** CPU 占用率 % */
  cpuPct: number
  /** 内存占用率 % */
  memPct: number
  /** 是否超出动态上限（超限时提醒 AI 自行取舍，系统不拦截） */
  overLimit: boolean
}

/** 按当前负载计算动态并发上限：重载时压缩（1/3），空闲时放宽（上限区间上限） */
export function computeDynamicCap(cpuPct: number, memPct: number): number {
  const heavy = Math.max(cpuPct, memPct) >= HEAVY_LOAD_PCT
  return heavy // 重载：1/3 缩放；空闲：全量
    ? Math.max(DYNAMIC_CAP_MIN, Math.round(DYNAMIC_CAP_MAX / 3))
    : DYNAMIC_CAP_MAX
}

/** 采集当前设备负载 + 托管并发统计快照（AI 可见） */
export function getDeviceLoadStats(): DeviceLoadStats {
  const cpuPct = currentCpuPct()
  const memPct = currentMemPct()
  const dynamicCap = computeDynamicCap(cpuPct, memPct)
  let running = 0
  for (const run of runs.values()) if (run.status === 'running') running++
  return { running, dynamicCap, cpuPct, memPct, overLimit: running >= dynamicCap }
}

/** 生成给 AI 看的并发上限说明文案（托管确认 / tool_watch 返回时附带） */
export function formatConcurrencyAdvisory(_extra?: { started?: 'agent' | 'tool'; taskId?: string }): string {
  const s = getDeviceLoadStats()
  const head = s.overLimit
    ? `⚠️ 设备并发已达动态上限（后台托管 ${s.running} 个 ≥ 当前上限 ${s.dynamicCap}）`
    : `设备并发状态：后台托管 ${s.running} 个，当前动态上限 ${s.dynamicCap}`
  const load = `（CPU ${s.cpuPct}% / 内存 ${s.memPct}%，上限按实际负载动态计算）`
  const tail = s.overLimit
    ? `。不强制停止任何任务——由你自行排序：确认低优先级/已完成任务的 tool_stop(taskId) 停掉以释放资源，再决定是否发起新任务。`
    : '；system 不代做"满即杀"决策，超出时由你自行排序取舍。'
  return head + load + tail
}