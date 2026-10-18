/**
 * @category ROOM
 * @summary ROOM 运行时：把自主循环接到真实子系统（采集 / 规划 / 记忆 / 执行）并对外暴露状态
 *
 * 为什么存在：ADR-18 交付的 `loop.ts` 只有链路，`collect`/`plan`/`execute`/`recall` 全是注入的。
 * 本模块是**装配层**——把已就绪的真实能力接上去，让 ROOM 从「骨架 + 单测」变成「能跑」。
 *
 * 不删理由：删掉即 ROOM 永远是空壳（各子系统就绪但无人编排）。
 *
 * 接线口径（各步各过各的门，循环本身不做权限判断——ADR-18 纪律）：
 * - `collect`：调用方注入（B4 采集器逻辑；受 `config.collector.enabled` + `t1.collector` 双重约束）
 * - `recall`：**内部管理会话**（`InternalSessionStore.list` 取最近 N 条摘要）；
 *   「记忆系统」那一跳由 AI 在 `plan` 里用自己的记忆工具完成（**主进程无记忆检索 API**，见 ADR-20）
 * - `plan`：调用方注入（`getHeadlessChatRunner` 跑完整月蚀链路）→ `parsePlan` 结构化
 * - `execute`：B5 执行器（自身过 `t1.executor-high-risk` 等）
 */
import type { Executor, ExecutorDecision, ExecutorResult } from './executor'
import { createAutonomousLoop, type AutonomousLoop, type LoopEvent, type LoopTickResult, type PlanDecision } from './loop'
import { parsePlan } from './plan'
import { defaultCollectorView, validateCollectorView, type CollectorView } from './collector-view'
import type { WakeSource } from './wake'

/** 定时器接口：**只用于 AI 自设的待机到期**（采集本身不轮询，见 `loop.ts` 头注释）。 */
export interface RoomTimers {
  setTimeout: (callback: () => void, delayMs: number, label?: string) => string
  clearTimeout: (handle: string) => void
}

export interface RoomRuntimeDeps {
  /**
   * 采集本轮输入（B4）；未启用/未授予时返回 ok=false 且带原因。
   * 入参 = **当前采集视图**（AI 声明，见 `./collector-view`）——采集实现据此只取被选中的字段。
   */
  collect: (view: CollectorView) => Promise<{ ok: boolean; text?: string; error?: string }>
  /** 规划：把提示词交给 AI，返回其文本回复（`getHeadlessChatRunner`）；空串/null = LLM 未回复 */
  plan: (prompt: string, sessionId: string) => Promise<string | null>
  /** 记忆区第二跳：最近内部管理会话摘要 */
  listInternalSessions?: (ownerSessionId: string) => Array<{ id: string; title: string; summary: string; updatedAt: number }>
  /** 执行器（B5） */
  executor: Executor
  /** 计划里允许出现的工具名（白名单；`parsePlan` 据此过滤） */
  allowedTools: () => readonly string[]
  /** 会话 id（规划用；缺省固定 ROOM 会话） */
  sessionId?: string
  /** 定时器（**仅供待机到期**；缺省用原生 setTimeout） */
  timers?: RoomTimers
  /**
   * AI 重画自身像素形象（P3）：计划输出带 `avatar` 时调用。**调用方负责门控 + 校验 + 落盘**
   * （见 `bootstrap/room-runtime.ts` 的 `applyAvatar`）——本层只做编排与状态回传。
   */
  applyAvatar?: (raw: unknown) => { ok: boolean; error?: string }
  /**
   * 事件落盘钩子（B-D 可观测）：每次事件入环时同步调用（**不抛**——落盘失败不该打崩循环）。
   * 由组合根接到 `<data>/room/room-events.jsonl`（有界追加）。
   */
  onEvent?: (ev: LoopEvent) => void
  now?: () => number
}

/**
 * 房间相位（采集器的「激活条件」就是它）：
 * - `stopped`：用户关停 / LLM 出问题被停 → 采集器不返回；
 * - `standby`：AI 主动声明待机（有到期时间）→ 采集器不返回；
 * - `idle`：自主开 + 非待机 + 无在跑轮次 → **采集器睁眼**（激活）；
 * - `running`：正在处理一轮 → 采集器不返回。
 */
export type RoomPhase = 'stopped' | 'standby' | 'idle' | 'running'

export interface RoomRuntimeState {
  /** 兼容既有消费者：phase !== 'stopped' 即为「在跑」 */
  running: boolean
  phase: RoomPhase
  /** 待机到期时间戳（phase==='standby' 时有值） */
  standbyUntil?: number
  /** 最近一次 tick 结果 */
  lastTick?: LoopTickResult
  /** 最近一次规划（结构化） */
  lastPlan?: PlanDecision
  /** 事件环（最近 N 条） */
  events: LoopEvent[]
  /**
   * 像素形象修订号：每次 AI 成功重画 +1（P3）。渲染侧据此**只在变化时**重取规格
   * （`room:avatar-get`），避免无谓轮询。
   */
  avatarRev: number
  /** 当前生效的采集视图（AI 声明；诉求 10「采集什么由 AI 决定」）。可选：假体/旧状态可不带 */
  collectorView?: CollectorView
}

export interface RoomRuntime {
  /** 开启自主（进入 idle 并激活一次） */
  start: () => void
  /** 停止自主（回到 stopped；清待机定时器） */
  stop: () => void
  /** 是否在跑（phase !== 'stopped'） */
  isRunning: () => boolean
  /**
   * AI 主动声明待机：期间采集器**不返回**，到期后自动回到 idle 并重新激活。
   * 时长由 AI 决定（计划输出 `standbyMs`），不是系统轮询周期。
   */
  standby: (ms: number) => void
  /**
   * 事件唤醒（ADR-29 裁决3）：由主进程唤醒仲裁（`./wake`）调用，**不是**采集器/监控各自调。
   * 语义：`stopped`（用户关停）忽略；`running` 忽略（已在处理）；`standby`/`idle` → 清除待机并激活一次。
   */
  wake: (reason: WakeSource) => void
  /** 手动跑一轮（UI 的「立即行动」） */
  tick: () => Promise<LoopTickResult>
  getState: () => RoomRuntimeState
}

const EVENT_RING_MAX = 50
const RECALL_SESSIONS_MAX = 5

/** 记忆区第二跳的提示段：把最近内部管理会话摘要拼成给 AI 的上下文。 */
export function buildRecallBlock(
  sessions: Array<{ title: string; summary: string; updatedAt: number }>
): string {
  if (sessions.length === 0) return ''
  const lines = sessions
    .slice(0, RECALL_SESSIONS_MAX)
    .map((s, i) => `${i + 1}. ${s.title}：${(s.summary || '（无摘要）').slice(0, 200)}`)
  return `\n【最近内部管理会话】\n${lines.join('\n')}\n`
}

/** 规划提示词：把 ROOM 的规则与输出契约写清（输出必须是 JSON 计划）。 */
export function buildPlanPrompt(ctx: { text: string; mode: string; recalled?: string; allowedTools: readonly string[] }): string {
  return [
    '你是自主房间（ROOM）里的执行主体。请根据下面的采集输入决定要做什么。',
    ctx.recalled ?? '',
    '【采集输入】',
    ctx.text,
    '',
    `【分诊结果】${ctx.mode === 'long-term' ? '长线（可深入分析）' : '即时（直接处理，不要过度思考）'}`,
    '',
    '【可调用工具】（只能从中选择，其它一律会被丢弃）',
    ctx.allowedTools.join(', ') || '（无）',
    '',
    '【输出契约】只输出一个 JSON 对象，不要任何其它文字：',
    '{"note":"一句话说明你的计划","decisions":[{"tool":"工具名","params":{},"description":"这一步做什么"}]}',
    '若无需动作，输出 {"note":"无需动作","decisions":[]}。',
    '（只读性由工具自身声明判定，你不需要也不应标注；标注不会被采信。）',
    '【待机】若你判断暂时不需要继续感知（例如在等一个不会马上到来的变化），在同一个 JSON 里加 "standbyMs": 毫秒数（上限 24 小时）声明待机：待机期间不再采集，到期后重新感知一次。不写 standbyMs 表示你希望立刻继续感知。',
    '【形象】你可以用 "avatar" 字段重画你自己的像素房间与形象（这是「AI 决定像素点怎么摆放」的入口）。形状：{"version":1,"room":{"w":40,"h":24,"palette":["#rrggbb",…],"frames":{"base":[行字符串…]}},"avatar":{"w":12,"h":12,"palette":[…],"frames":{"idle":[…],"running":[…],"standby":[…],"stopped":[…]}},"avatarPos":{"x":14,"y":12}}。字符约定：. 透明，0-9a-f 为调色板下标（0 起）。上限：单边 ≤64、色 ≤16、帧 ≤8，形象须完整落在房间内；越界会被拒且不影响本轮其它动作。不写 avatar 表示不改形象。',
    '【采集什么】你也可以用 "collectorView" 字段决定自己要看什么（不是看多久——采集由事件驱动，你无法也不应设定定时）。形状：{"name":"视图名","scopes":["env","system"],"fields":["platform","cpu","memory","cores","disks","gpus","processes","network"]}。只能选这些 scope 与字段；越界会被拒。不写 collectorView 表示保持当前视图。'
  ].join('\n')
}

export function createRoomRuntime(deps: RoomRuntimeDeps): RoomRuntime {
  const now = deps.now ?? (() => Date.now())
  const sessionId = deps.sessionId ?? 'room-autonomous'
  const events: LoopEvent[] = []
  let phase: RoomPhase = 'stopped'
  let standbyUntil: number | undefined
  let lastTick: LoopTickResult | undefined
  let lastPlan: PlanDecision | undefined
  let stopFn: (() => void) | null = null
  let clearStandbyTimer: (() => void) | null = null
  let avatarRev = 0
  /** 当前采集视图（AI 声明；未声明 = 默认全字段，行为与改造前一致） */
  let collectorView: CollectorView = defaultCollectorView()

  /** 事件入环（带裁剪）。提成函数是因为「重画形象」也要进事件流（不只 loop 的相位事件）。 */
  const pushEvent = (ev: LoopEvent): void => {
    events.push(ev)
    if (events.length > EVENT_RING_MAX) events.splice(0, events.length - EVENT_RING_MAX)
    try {
      deps.onEvent?.(ev)
    } catch {
      /* 落盘失败不阻断循环（可观测是旁路，不是主链） */
    }
  }

  const loop: AutonomousLoop = createAutonomousLoop({
    // 每轮读**当时**的采集视图（AI 可能在上一轮改了它）
    collect: () => deps.collect(collectorView),
    recall: async () => {
      // 记忆区第二跳：最近内部管理会话摘要（「记忆系统」那一跳由 AI 在 plan 里用自己的记忆工具完成）
      if (!deps.listInternalSessions) return { text: '' }
      try {
        const sessions = deps.listInternalSessions(sessionId)
        return { text: buildRecallBlock(sessions), sources: sessions.map((s) => s.id) }
      } catch {
        return { text: '' }
      }
    },
    plan: async ({ text, mode, recalled }) => {
      const prompt = buildPlanPrompt({ text, mode, ...(recalled ? { recalled } : {}), allowedTools: deps.allowedTools() })
      let reply: string | null = null
      try {
        reply = await deps.plan(prompt, sessionId)
      } catch {
        reply = null
      }
      // LLM 未回复（空输出 / 抛错 / 链路未就绪）= AI 出了问题 → 标记 llmFailed，驱动据此**停止**
      if (reply == null || !reply.trim()) {
        const failed: PlanDecision = { decisions: [], note: 'LLM 未回复（规划无输出）', llmFailed: true }
        lastPlan = failed
        return failed
      }
      const parsed = parsePlan(reply, deps.allowedTools())
      const decision: PlanDecision = {
        decisions: parsed.decisions,
        ...(parsed.note ? { note: parsed.note } : {}),
        ...(parsed.parseError ? { note: `解析失败：${parsed.parseError}` } : {}),
        ...(parsed.dropped.length > 0 ? { note: `${parsed.note ?? ''}（丢弃 ${parsed.dropped.length} 个动作）`.trim() } : {})
      }
      lastPlan = decision
      // AI 主动声明待机：期间采集器不返回（感官「闭眼」），到期由 runtime 回到 idle 并重新激活
      if (typeof parsed.standbyMs === 'number' && parsed.standbyMs > 0) {
        decision.standbyMs = parsed.standbyMs
        standby(parsed.standbyMs)
      }
      // AI 重画自身像素形象（P3）：门控 + 校验 + 落盘都在注入的 applyAvatar 里；本层只回传结果与修订号
      if (parsed.avatar !== undefined) {
        const applied = deps.applyAvatar?.(parsed.avatar)
        if (applied?.ok) {
          avatarRev += 1
          pushEvent({ phase: 'plan', ts: now(), detail: '已重画像素形象' })
        } else {
          pushEvent({ phase: 'plan', ts: now(), detail: `像素形象未更新：${applied?.error ?? '未接线'}` })
        }
      }
      // AI 决定采集什么（诉求 10）：校验通过才替换；非法视图只记事件、保留旧视图（下一轮仍能采）
      if (parsed.collectorView !== undefined) {
        const v = validateCollectorView(parsed.collectorView)
        if (v.ok) {
          collectorView = v.view
          pushEvent({ phase: 'plan', ts: now(), detail: `采集视图：${v.view.name}（${v.view.fields.join('、')}）` })
        } else {
          pushEvent({ phase: 'plan', ts: now(), detail: `采集视图未更新：${v.error}` })
        }
      }
      return decision
    },
    execute: async (d: ExecutorDecision): Promise<ExecutorResult> => deps.executor.execute(d),
    onEvent: (ev) => pushEvent(ev),
    onPhase: (p) => {
      // 驱动只在「非待机/非停止」时改相位（待机是 AI 的主动决定，不能被 idle 回调覆盖）
      if (p === 'running') phase = 'running'
      else if (phase === 'running') phase = 'idle'
    },
    onResult: (r) => {
      lastTick = r
      // LLM 未回复 = AI 出了问题：停驱动 + 回 stopped（不再空转），状态里留痕供 UI 显示
      if (r.llmFailed) {
        stopFn?.()
        stopFn = null
        clearStandby()
        phase = 'stopped'
      }
    },
    now
  })

  const clearStandby = (): void => {
    clearStandbyTimer?.()
    clearStandbyTimer = null
    standbyUntil = undefined
  }

  /** 激活：进入 idle 并让驱动开始「采集 → 一轮」；已有驱动则不重复起。 */
  const activate = (): void => {
    if (stopFn) return
    phase = 'idle'
    stopFn = loop.start()
  }

  const start = (): void => {
    clearStandby()
    pushEvent({ phase: 'idle', ts: now(), detail: '自主开启' })
    activate()
  }

  const stop = (): void => {
    stopFn?.()
    stopFn = null
    clearStandby()
    phase = 'stopped'
    pushEvent({ phase: 'idle', ts: now(), detail: '自主关闭' })
  }

  const standby = (ms: number): void => {
    const wait = Math.max(0, Math.floor(ms))
    // 先 park 驱动（采集器「闭眼」：不再采集、不再规划），到期再回到 idle 并重新激活
    stopFn?.()
    stopFn = null
    clearStandbyTimer?.()
    standbyUntil = now() + wait
    phase = 'standby'
    const onExpire = (): void => {
      clearStandbyTimer = null
      standbyUntil = undefined
      if (phase === 'standby') activate()
    }
    if (deps.timers) {
      const handle = deps.timers.setTimeout(onExpire, wait, 'room-standby')
      clearStandbyTimer = () => deps.timers?.clearTimeout(handle)
    } else {
      const handle = setTimeout(onExpire, wait)
      if (typeof handle.unref === 'function') handle.unref()
      clearStandbyTimer = () => clearTimeout(handle)
    }
  }

  /**
   * 事件唤醒（由 `./wake` 的仲裁器调用）：用户到达 / 监控命中 → 让房间重新感知一次。
   * 语义见接口注释：`stopped` 与 `running` 忽略（**不自动拉起已关停的房间**，也不打断在跑的轮次）。
   */
  const wake = (reason: WakeSource): void => {
    if (phase === 'stopped' || phase === 'running') return
    clearStandby()
    pushEvent({ phase: 'idle', ts: now(), detail: `唤醒（${reason}）` })
    activate()
  }

  const tick = async (): Promise<LoopTickResult> => {
    const r = await loop.tick()
    lastTick = r
    if (r.llmFailed) {
      // 手动「立即行动」也走同一处置：LLM 出问题就停，不空转
      stopFn?.()
      stopFn = null
      clearStandby()
      phase = 'stopped'
    }
    return r
  }

  return {
    start,
    stop,
    standby,
    wake,
    isRunning: () => phase !== 'stopped',
    tick,
    getState: () => ({
      running: phase !== 'stopped',
      phase,
      ...(standbyUntil != null ? { standbyUntil } : {}),
      ...(lastTick ? { lastTick } : {}),
      ...(lastPlan ? { lastPlan } : {}),
      events: [...events],
      avatarRev,
      collectorView
    })
  }
}

// ===== 运行时持有者（按 (uid, aiId) 分实例；ADR-25 支柱 2 / L3）=====
// 为什么按 scope 分：此前是**全局单例**且会话 id 固定 `room-autonomous`，导致所有 AI 的自主行为
// 都计入 AI1（L3）。用户要求「月蚀是多个 AI 存在的系统，每个 AI 都要有自己的自主模式」。
// 实例按需创建（`ensureRoomRuntime`）、关窗即停（`stopAllRoomRuntimes`）。

/** ROOM 运行时作用域：一个 (uid, aiId) 一个房间实例 */
export interface RoomScope {
  uid: number
  aiId: number
}

export function roomScopeKey(scope: RoomScope): string {
  return `${scope.uid}_${scope.aiId}`
}

/** 自主会话 id（**含 AI**）：`room-autonomous-U{uid}-AI{aiId}` */
export function roomSessionId(scope: RoomScope): string {
  return `room-autonomous-U${scope.uid}-AI${scope.aiId}`
}

const runtimes = new Map<string, RoomRuntime>()

/** 运行时工厂（组合根注入）：按 aiId 造实例；未登录 / 该 AI 不可运行 / 未装配 → null */
export type RoomRuntimeFactory = (aiId: number) => RoomRuntime | null

let runtimeFactory: RoomRuntimeFactory | null = null

export function setRoomRuntimeFactory(factory: RoomRuntimeFactory | null): void {
  runtimeFactory = factory
}

/** 取（必要时创建）某 AI 的运行时；不可用 → null（调用方按 null 报错，不静默用别的 AI） */
export function ensureRoomRuntime(aiId: number): RoomRuntime | null {
  return runtimeFactory?.(aiId) ?? null
}

export function setRoomRuntime(scope: RoomScope, rt: RoomRuntime | null): void {
  if (rt) runtimes.set(roomScopeKey(scope), rt)
  else runtimes.delete(roomScopeKey(scope))
}

export function getRoomRuntime(scope: RoomScope): RoomRuntime | null {
  return runtimes.get(roomScopeKey(scope)) ?? null
}

/**
 * **无副作用**读取某 AI 的运行时（P2-8）：只查已存在的实例，**不创建**。
 * 为什么需要：`room:runtime-state` 被原位视图每 3s 轮询，此前用 `ensureRoomRuntime` 会**持续创建**实例
 * （未启动的房间也被造出来，且带会话/链路副作用）。只读路径必须用本函数。
 */
export function peekRoomRuntime(aiId: number): RoomRuntime | null {
  for (const [k, rt] of runtimes) {
    if (k.endsWith(`_${aiId}`)) return rt
  }
  return null
}

/** 已存在实例的 aiId 列表（`room:status` 用）。 */
export function listRoomRuntimeAiIds(): number[] {
  const ids = new Set<number>()
  for (const k of runtimes.keys()) {
    const seg = k.slice(k.lastIndexOf('_') + 1)
    const n = Number(seg)
    if (Number.isInteger(n)) ids.add(n)
  }
  return [...ids]
}

/** 停某个 AI 的运行时（键 = `{uid}_{aiId}`，aiId 为数字段，后缀匹配即精确命中） */
export function stopRoomRuntimeForAi(aiId: number): void {
  for (const [k, rt] of runtimes) {
    if (k.endsWith(`_${aiId}`)) {
      rt.stop()
      runtimes.delete(k)
    }
  }
}

/** 停全部运行时并清空（主窗口关闭 / 退出时调用，不留常驻定时器） */
export function stopAllRoomRuntimes(): void {
  for (const rt of runtimes.values()) rt.stop()
  runtimes.clear()
}

// ===== 工具区步骤工具的可用集合（由组合根注入；缺省空 = 一切步骤被拒，安全默认）=====
let allowedToolsProvider: (() => readonly string[]) | null = null

export function setRoomAllowedTools(provider: (() => readonly string[]) | null): void {
  allowedToolsProvider = provider
}

export function getRoomAllowedTools(): readonly string[] {
  return allowedToolsProvider?.() ?? []
}
