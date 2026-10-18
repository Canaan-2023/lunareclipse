/**
 * @category 核心
 * @summary ROOM 自主运行时装配（B8）：把已就绪的采集 / 规划 / 记忆 / 执行接到自主循环
 *
 * 为什么存在：ADR-18 的 `room/loop.ts` 与 `room/runtime.ts` 全是注入依赖，需要一个**组合根**把
 * 真实子系统接上（采集器 / 无头对话链路 / 内部会话 / 执行器 → 工具注册表）。
 * 依 CODE-RULES §3.4，跨域装配只许在 `bootstrap/`。
 *
 * 不删理由：删掉即 ROOM 永远是空壳（各子系统就绪但无人编排）。
 *
 * 接线口径：
 * - **每个 AI 一个房间**（ADR-25 L3）：运行时按 (uid, aiId) 分实例，会话 id 含 AI
 *   （`room-autonomous-U{uid}-AI{aiId}`），规划调 `runner(prompt, sessionId, aiId)`——
 *   自主行为计入**该 AI** 的会话与 RAW，不再一律计入 AI1。
 * - **采集**：**两层缺一不可**（ADR-16 §3.2）——用户层总开关 `config.collector.enabled`，
 *   且每次采集都要过 AI 层授予 `t1.collector`（唯一检查点 `evaluatePolicy`，见 `evaluateRoomCollectGate`）。
 *   为什么两层都要：用户层开关只表达「允许采集」的意愿，不等于把采集权授予 AI；
 *   自主循环每轮自动采集，若只看开关就等于「开了开关即授予」，与 ADR-11 分级语义相悖
 *   （2026-10-18 工程保障团队 P0-1）。
 * - **规划**：`getHeadlessChatRunner()`（完整月蚀链路：会话 + 工具 + RAW）——AI 用自己的工具
 *   查记忆系统，因此**不需要**在主进程造记忆检索 API（主进程本就没有，见 ADR-20）。
 * - **记忆区第二跳**：`InternalSessionStore.list(owner)` 取最近内部管理会话摘要注入提示词。
 * - **执行**：B5 执行器 → `executeTool(workflowToolRegistry, ...)`；权限由执行器自身裁决。
 * - **下线 AI 不运行**：`ai-registry.json` 中 `deactivated === true` 的 AI 不建运行时（数据保留）。
 */
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import type { InternalSessionStore } from '../services/internal-session-store'
import type { ToolRegistry } from '../tools/tool-registry'
import { EMPTY_GRANTS, evaluatePolicy } from '../tools/security-engine/policy-gate'
import { executeTool } from '../tools/execute-tool'
import { createExecutor, type Executor } from '../room/executor'
import { createToolReadOnlyResolver } from '../room/tool-risk'
import { createRoomLoopSupervisor, setRoomLoopSupervisor, getRoomLoopSupervisor } from '../room/loop-supervisor'
import { getGlobalTimerRegistry } from '../monitor/timer-registry'
import {
  createRoomRuntime,
  setRoomRuntime,
  setRoomAllowedTools,
  setRoomRuntimeFactory,
  getRoomRuntime,
  ensureRoomRuntime,
  stopAllRoomRuntimes,
  roomSessionId
} from '../room/runtime'
import { ToolZoneStore, routeToolName, runZoneTool } from '../room/tool-zone'
import { AvatarStore } from '../room/avatar-store'
import { defaultCollectorView, viewIncludes, type CollectorView } from '../room/collector-view'
import { createWakeArbiter, registerWakeArbiter, reportRoomWake } from '../room/wake'
import { RoomEventLog } from '../room/event-log'
import { readAiRegistry } from '../models/ai-registry'
import { setModelSwitchSink } from '../api/llm/model-switch-log'
import { createFileAuditSink, defaultAuditFilePath } from '../tools/security-engine/audit-log'
import { join } from 'path'
import { collectEnvironment, collectComputerStatus, collectSystem, setCollectorAppTransfers } from '../tools/collect-environment'
import type { ProcessInfo } from '../room/process-scan'
import type { CollectorConfig } from '@shared/types/collector'
import type { SecurityGrants, AuditSink } from '@shared/types/permission'
import type { AppConfig } from '@shared/types'
import { validateAvatarSpec } from '@shared/room/avatar-spec'
import { getHeadlessChatRunner } from '../api/service-refs'
import type { WorkflowManager } from '../workflow/manager'

export interface RoomRuntimeWiringDeps {
  internalSessionStore: InternalSessionStore
  /** 复用记忆工作流已建好的工具注册表（避免另造一份） */
  toolRegistry: ToolRegistry
  /** 工具区持久化目录（`{dataPaths.root}/room`） */
  toolZoneDir: string
  /** AI 注册表路径（`{dataPaths.root}/ai-registry.json`）：判定该 AI 是否可运行（未下线） */
  aiRegistryJson: string
  /**
   * 工作流管理器（可选）：其事件作为「**监控看到了**」唤醒源。**只上报**，不自己唤醒——
   * 是否真的唤醒由 `room/wake.ts` 的仲裁器去抖后决定（主进程单 owner）。
   */
  workflowManager?: WorkflowManager | null
}

/**
 * 自主采集的闸门（纯函数，不触发任何采集）。
 * 两层缺一不可：用户层开关（`collector.enabled`）+ AI 层授予（`t1.collector`，唯一检查点 `evaluatePolicy`）。
 * 为什么单独抽出来：闸门必须在**任何采集动作之前**生效，且要能被单测直接覆盖（不必起 PowerShell/tasklist 子进程）。
 * 返回 error 时调用方必须**立即返回**——不得先采集再判权限。
 */
export function evaluateRoomCollectGate(
  collector: CollectorConfig | undefined,
  grants: SecurityGrants,
  audit?: AuditSink
): { ok: true } | { ok: false; error: string } {
  if (collector?.enabled !== true) {
    return { ok: false, error: '采集器未开启（设置 → 自主房间 → 采集器）' }
  }
  const decision = evaluatePolicy(
    { capability: 't1.collector', action: 'collect.room', actor: 'ai' },
    { getGrants: () => grants, now: () => Date.now(), ...(audit ? { audit } : {}) }
  )
  if (!decision.allowed) {
    const hint = decision.grantHint ? `；${decision.grantHint}` : ''
    return { ok: false, error: `自主采集被拒：${decision.reason}${hint}` }
  }
  return { ok: true }
}

/**
 * 采集输入：**只取采集视图选中的字段**（AI 决定采集什么，诉求 10）。未开启或未授予则返回原因，循环据此 idle。
 * 两层不变：用户侧开关 + `t1.collector` 授予（`evaluateRoomCollectGate`）；视图只**收窄**范围，不放大权限。
 */
export async function buildRoomCollectInput(
  collector: CollectorConfig | undefined,
  grants: SecurityGrants,
  view: CollectorView = defaultCollectorView(),
  audit?: AuditSink
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const gate = evaluateRoomCollectGate(collector, grants, audit)
  if (!gate.ok) return { ok: false, error: gate.error }
  const s = collectEnvironment()
  const parts: string[] = []
  if (viewIncludes(view, 'platform')) parts.push(`平台 ${s.platform}`)
  if (viewIncludes(view, 'cpu')) parts.push(`CPU ${s.cpuUsagePct}%`)
  if (viewIncludes(view, 'memory')) parts.push(`内存 ${s.freeMemGB}/${s.totalMemGB} GB`)
  if (viewIncludes(view, 'cores')) parts.push(`逻辑核 ${s.logicalCores}`)
  const needDisks = viewIncludes(view, 'disks')
  const needGpus = viewIncludes(view, 'gpus')
  if (needDisks || needGpus) {
    try {
      const st = await collectComputerStatus()
      const low = st.disks.filter((d) => d.usedPercent >= 90)
      if (needDisks && st.disks.length > 0) {
        parts.push(
          `磁盘 ${st.disks.map((d) => `${d.drive}${d.freeGB}/${d.totalGB}GB`).join(' ')}${low.length > 0 ? `（${low.map((d) => d.drive).join('')} 已用 ${low[0].usedPercent}%+）` : ''}`
        )
      }
      if (needGpus && st.gpus.length > 0) {
        parts.push(`GPU ${st.gpus.map((g) => g.name).join('、')}`)
      }
    } catch {
      /* 电脑状态采集失败不影响基础环境段 */
    }
  }
  if (viewIncludes(view, 'processes') || viewIncludes(view, 'network')) {
    try {
      const sys = await collectSystem(collector)
      const procs = sys.processes as ProcessInfo[] | undefined
      if (viewIncludes(view, 'processes') && procs && procs.length > 0) {
        parts.push(`进程 Top${procs.length}：${procs.slice(0, 5).map((p) => `${p.name}(${p.memMB}MB)`).join('、')}`)
      }
      if (viewIncludes(view, 'network') && sys.network) {
        const rate = (v: number | null): string => (v == null ? '?' : `${Math.round(v / 1024)}KB/s`)
        parts.push(`网络 ↓${rate(sys.network.rxBytesPerSec)} ↑${rate(sys.network.txBytesPerSec)}`)
      }
    } catch {
      /* 系统段采集失败不影响环境段 */
    }
  }
  // 视图把字段全关掉 → 本轮没有「视觉」，按无输入处理（而不是给 AI 一段空文本）
  if (parts.length === 0) return { ok: false, error: `采集视图「${view.name}」未选中任何字段（无输入）` }
  return { ok: true, text: parts.join(' · ') }
}

export function initRoomRuntime(state: AppState, deps: BootstrapDeps, opts: RoomRuntimeWiringDeps): void {
  const { configStore } = deps
  const getGrants = (): typeof EMPTY_GRANTS => configStore.get().securityGrants ?? EMPTY_GRANTS

  const zoneStore = new ToolZoneStore(opts.toolZoneDir)
  const avatarStore = new AvatarStore(opts.toolZoneDir)
  /** 事件落盘（B-D 可观测）：`<data>/room/room-events.jsonl`，有界（超 512KB 滚一代） */
  const eventLog = new RoomEventLog(opts.toolZoneDir)
  /** room 侧 `evaluatePolicy` 的审计落点（B-D）：采集闸门与形象门控共用同一 sink（懒建） */
  let auditRef: AuditSink | null = null
  const roomAudit = (): AuditSink => (auditRef ??= createFileAuditSink(defaultAuditFilePath()))

  // 「监控看到了」唤醒源（ADR-29 裁决3）：工作流事件 → **只上报**，去抖与真正激活在 wake 仲裁器里。
  // 订阅是进程级（initRoomRuntime 只装配一次），故不保存退订函数——随进程退出释放。
  opts.workflowManager?.onEvent(() => {
    reportRoomWake('monitor')
  })
  const enabledZoneEntries = (): ReturnType<ToolZoneStore['load']> => zoneStore.load().filter((e) => e.enabled)
  const registryToolNames = (): string[] => [...opts.toolRegistry.tools.keys()]

  // 执行器：注册表工具直接执行；工具区工具按名命中后**逐步执行**（每步再过一次门控，见 ADR-17）
  let executorRef: Executor | null = null
  const executor = createExecutor({
    getGrants,
    evaluate: (req) => evaluatePolicy(req, { getGrants, now: () => Date.now() }),
    // 只读判定真源 = 工具注册表元数据（P0-2）：AI 自述的 readOnly 不再参与分流
    isReadOnly: createToolReadOnlyResolver(() => opts.toolRegistry.tools),
    run: async (d) => {
      const name = d.toolName ?? ''
      const route = routeToolName(name, registryToolNames(), enabledZoneEntries())
      if (route.kind === 'registry') return executeTool(opts.toolRegistry, name, d.params ?? {})
      if (route.kind === 'zone' && executorRef) {
        const r = await runZoneTool(route.entry, (step) => executorRef!.execute(step))
        return r.ok
          ? { ok: true, data: { zoneTool: route.entry.name, steps: r.steps } }
          : {
              ok: false,
              error: r.steps
                .filter((s) => !s.ok)
                .map((s) => `${s.tool}: ${s.error ?? '失败'}`)
                .join('; ')
            }
      }
      return { ok: false, error: `工具「${name}」不存在或未启用` }
    }
  })
  executorRef = executor

  // 运行时工厂（ADR-25 L3）：**按 (uid, aiId) 分实例**——每个 AI 有自己的房间、自己的自主会话
  // （会话 id 含 AI）、自己的规划链路（`runner(prompt, sessionId, aiId)`，行为计入该 AI 的 RAW）。
  // 不可用时返回 null（未登录 / 该 AI 已下线 / 未装配）——调用方据此报错，不静默借用别的 AI。
  const aiRunnable = (aiId: number): boolean => {
    try {
      const rec = readAiRegistry(opts.aiRegistryJson).ais.find((a) => a.id === aiId)
      return !!rec && rec.deactivated !== true
    } catch {
      return false
    }
  }
  setRoomRuntimeFactory((aiId) => {
    const uid = state.userStore?.getCurrentUser()?.UID
    if (!uid || !aiRunnable(aiId)) return null
    const scope = { uid, aiId }
    const existing = getRoomRuntime(scope)
    if (existing) return existing
    const rt = createRoomRuntime({
      collect: async (view) => buildRoomCollectInput(configStore.get().collector, getGrants(), view, roomAudit()),
      plan: async (prompt, sessionId) => {
        const runner = getHeadlessChatRunner()
        // 链路未就绪 = LLM 拿不到回复 → 返回空串，runtime 会标记 llmFailed 并**停止**循环
        if (!runner) return ''
        // 带 aiId：规划轮次落该 AI 的会话与 RAW（L3 修复点——此前不带，全计入 AI1）
        return runner(prompt, sessionId, aiId)
      },
      listInternalSessions: (ownerSessionId) =>
        opts.internalSessionStore.list(ownerSessionId).map((s) => ({
          id: s.id,
          title: s.title,
          summary: s.summary,
          updatedAt: s.updatedAt
        })),
      executor,
      // 计划可引用：注册表工具 + 启用中的工具区自造工具（两者共用同一可用集合口径）
      allowedTools: () => [...registryToolNames(), ...enabledZoneEntries().map((e) => e.name)],
      sessionId: roomSessionId(scope),
      // 定时器**只服务 AI 自设的待机到期**（采集本身不轮询，见 room/loop.ts 头注释）；
      // 走统一注册表 → 退出时 before-quit 可清、「无残留定时器」可机械验证
      timers: getGlobalTimerRegistry(),
      // AI 重画自身像素形象（P3）：「AI 决定像素点怎么摆放」的落点。
      // 顺序 = 门控（`t2.room-avatar`，T2 默认开但仍走唯一检查点）→ 校验（fail-closed）→ 原子落盘。
      // 任何一步失败只回传原因（不抛）——重画失败不该把自主循环打崩。
      applyAvatar: (raw) => {
        const decision = evaluatePolicy(
          { capability: 't2.room-avatar', action: 'room.draw', actor: 'ai' },
          { getGrants, now: () => Date.now(), audit: roomAudit() }
        )
        if (!decision.allowed) return { ok: false, error: `绘制被拒：${decision.reason}` }
        const v = validateAvatarSpec(raw)
        if (!v.ok) return { ok: false, error: v.error }
        avatarStore.save(v.spec)
        return { ok: true }
      },
      // 事件落盘（B-D 可观测）：启停 / 相位序列 / 唤醒源 / 重画 / 采集视图变更都进 JSONL
      onEvent: (ev) =>
        eventLog.append({
          ts: ev.ts,
          phase: ev.phase,
          ...(ev.detail ? { detail: ev.detail } : {}),
          ...(ev.mode ? { mode: ev.mode } : {})
        })
    })
    setRoomRuntime(scope, rt)
    // 唤醒仲裁（ADR-29 裁决3）：每个房间一个仲裁器，**唯一触发点**就是这里——
    // 渲染进程（用户到达）/ 监控（工作流事件）只 `reportRoomWake`，不得各自调 `rt.wake`。
    registerWakeArbiter(aiId, createWakeArbiter((source) => rt.wake(source)))
    return rt
  })
  // 循环生命周期 owner（P0-3）：主进程单例，按 (uid, aiId) 引用计数；
  // 渲染进程只表达「要 / 不要」，窗口关闭 / 渲染崩溃由 room-window 侧调 stopAll()。
  setRoomLoopSupervisor(
    createRoomLoopSupervisor({
      ensureRuntime: (aiId) => ensureRoomRuntime(aiId),
      getCurrentUid: () => state.userStore?.getCurrentUser()?.UID ?? null
    })
  )
  // 模型切换审计落盘（原本只有内存环，重启即清）：写 <data>/room/model-switch.jsonl
  // 复用 audit-log 的 JSONL 追加实现（两者条目形状不同，但落盘语义一致：一行一条、失败吞掉）
  setModelSwitchSink(
    createFileAuditSink(join(opts.toolZoneDir, 'model-switch.jsonl')) as unknown as (entry: unknown) => void
  )
  // 工具区步骤工具的可用集合 = 当前注册表工具名（校验与执行共用同一集合，口径单源）
  setRoomAllowedTools(() => registryToolNames())
  // 上传下载监控的「本应用传输」段：中继待取件数来自多实例服务（局域网未启动时如实说明）
  setCollectorAppTransfers(() => {
    try {
      const lan = state.multiInstance?.getLanStatus?.()
      return {
        activeLanStreams: lan?.activeStreams ?? 0,
        relayPending: lan?.pendingCount ?? 0,
        ...(lan ? {} : { note: '局域网未启动' })
      }
    } catch {
      return { activeLanStreams: 0, relayPending: 0 }
    }
  })
  // 主窗口关闭 / 退出时不留下常驻定时器（与其它启动原子的清理口径一致）
  // 走 supervisor 而非直接 stopAllRoomRuntimes：supervisor 会同时清引用计数，避免残留「已持有」状态
  state.mainWindow?.on('closed', () => {
    const supervisor = getRoomLoopSupervisor()
    if (supervisor) supervisor.stopAll()
    else stopAllRoomRuntimes()
  })

  // 启动期对账（B-D1）：**状态以运行时为准 + 不自动拉起**。
  // 进程刚起时没有任何运行时在跑，故持久化的 `room.enabled === true` 一定是陈旧值
  // （上一次崩溃/强杀留下的，P1-5）→ 写回 false，避免 UI 显示「已开启」而实际没跑。
  try {
    const cfg = configStore.get()
    if (cfg.room?.enabled === true) {
      configStore.save({ ...cfg, room: { ...(cfg.room ?? {}), enabled: false } } as AppConfig)
    }
  } catch {
    /* 对账失败不阻断启动（下次启动再对一次） */
  }
}
