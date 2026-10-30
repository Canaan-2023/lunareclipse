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
 * - **状态推送**：运行时状态**变了才推**（`room:state-changed` → 主窗口），渲染端不再定时轮询
 *   （与「采集器是条件激活、不是定时器」同源：没事发生时不产生任何流量）。
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
  roomSessionId,
  type TreeIndex
} from '../room/runtime'
import { ToolZoneStore, routeToolName, runZoneTool } from '../room/tool-zone'
import {
  buildRoomNoteExecutor,
  createRoomZoneTrees,
  getRoomExtraToolExecutors,
  setRoomZoneToolProvider,
  type RoomZoneTrees
} from '../room/zone-tools'
import { AvatarStore } from '../room/avatar-store'
import { defaultCollectorView, viewIncludes, type CollectorView } from '../room/collector-view'
import { createWakeArbiter, registerWakeArbiter, reportRoomWake } from '../room/wake'
import type { RoomSensorSnapshot } from '../room/sensor'
import { SensorPolicyStore } from '../room/sensor-policy-store'
import { PreplanStore, setPreplanAccess } from '../room/preplan-store'
import type { RoomSensorPolicy, SensorSignal } from '@shared/room/sensor-policy'
import { SessionSelectTool } from '../tools/session-select'
import { RoomEventLog } from '../room/event-log'
import { readAiRegistry } from '../models/ai-registry'
import { setModelSwitchSink } from '../api/llm/model-switch-log'
import { createFileAuditSink, defaultAuditFilePath } from '../tools/security-engine/audit-log'
import { join } from 'path'
import {
  collectEnvironment,
  collectComputerStatus,
  collectSystem,
  getCollectorAppTransfers,
  setCollectorAppTransfers,
  evaluateCollectorSwitch
} from '../tools/collect-environment'
import type { ProcessInfo } from '../room/process-scan'
import type { CollectorConfig } from '@shared/types/collector'
import type { SecurityGrants, AuditSink } from '@shared/types/permission'
import type { AppConfig } from '@shared/types'
import { DEFAULT_AI_ID } from '@shared/types'
import { validateAvatarSpec } from '@shared/room/avatar-spec'
import { getHeadlessChatRunner, serviceRefs } from '../api/service-refs'
import { safeSend } from '../services/crash-logger'
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
  // 用户层开关：与工具侧**同一份**判定（`evaluateCollectorSwitch`），避免两处语义漂移
  const sw = evaluateCollectorSwitch(collector, 'env')
  if (!sw.ok) return sw
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
    } catch (err) {
      // **不静默**（0.52.70 用户裁决「报错比兜底好」）：磁盘/GPU 读不到时，
      // AI 至少要知道「这段视觉缺了以及为什么」，而不是拿到一段看似完整的输入。
      parts.push(`电脑状态读取失败：${(err as Error).message}`)
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
    } catch (err) {
      parts.push(`系统信息读取失败：${(err as Error).message}`)
    }
  }
  // 视图把字段全关掉 → 本轮没有「视觉」，按无输入处理（而不是给 AI 一段空文本）
  if (parts.length === 0) return { ok: false, error: `采集视图「${view.name}」未选中任何字段（无输入）` }
  return { ok: true, text: parts.join(' · ') }
}

/**
 * 感知器的一次**廉价**采样（0.53.1）：只读进程内 / os 模块数据，**不起子进程**。
 *
 * 为什么不用 `buildRoomCollectInput`：那是「AI 主动采集」，会跑 PowerShell 取磁盘/GPU/进程/网卡；
 * 感知器按 AI 策略低频跑，绝不能有那种代价。
 *
 * **字段由 AI 的感知策略决定**（0.53.3）：被 `sensor.mute` 屏蔽的信号不采（也就不会产生唤醒）；
 * 未被屏蔽的信号即使不在采集视图里也采——否则 AI 为了省 token 收窄视图，会把唤醒源关掉，
 * 而它只有醒着时才有机会改回来（0.53.1 架构评审 P1）。LAN / 中继只在 AI 没有屏蔽它们时读取。
 * 未传策略（旧调用 / 单测）时保持 0.53.1 行为：CPU / 内存恒采，LAN 跟随 `network` 视图。
 */
export function buildRoomSensorSample(
  view: CollectorView,
  policy?: RoomSensorPolicy
): RoomSensorSnapshot | null {
  const at = Date.now()
  const env = collectEnvironment()
  const sample: RoomSensorSnapshot = { at }
  const muted = new Set<SensorSignal>(policy?.mute ?? [])
  if (!muted.has('cpu')) sample.cpuPct = env.cpuUsagePct
  if (!muted.has('memory')) sample.freeMemGB = env.freeMemGB
  // 无策略 = 旧行为（视图含 network 才看）；有策略 = AI 没屏蔽就看
  const watchTransfers = policy ? !muted.has('lan') || !muted.has('relay') : viewIncludes(view, 'network')
  if (watchTransfers) {
    const app = getCollectorAppTransfers()
    if (!muted.has('lan')) sample.lanStreams = app.activeLanStreams
    if (!muted.has('relay')) sample.relayPending = app.relayPending
  }
  return sample
}

/**
 * 把**承载会话的树**渲染成**索引**（ADR-30）：只给 id / 标题 / 摘要 / 代际 / 可写与否 / 当前落点，
 * **不给正文**——正文由 AI 按需回翻（读会话文件，或用 `landing` 承接该节点）。
 * 可写尾端判定与 `session_select` 同口径：无时间下级（`timeBranchId`）且无继承子（未被 `parentId` 引用）。
 *
 * 0.53.18：自主模式不再有独立房间树，`sessionId` 就是开启自主的那个会话。
 *
 * 为什么抽成纯函数：它是「AI 看到什么」的唯一构造点，必须能脱离 electron 装配被单测。
 */
export function describeTreeIndex(
  store: InternalSessionStore,
  sessionId: string
): TreeIndex | null {
  try {
    const all = store.list(sessionId)
    const childIds = new Set<string>()
    for (const s of all) if (s.parentId) childIds.add(s.parentId)
    return {
      sessionId,
      activeId: store.getActive(sessionId),
      sessions: all.map((s) => ({
        id: s.id,
        title: s.title,
        summary: s.summary,
        ...(s.gen != null ? { gen: s.gen } : {}),
        writableTail: !childIds.has(s.id) && !s.timeBranchId,
        updatedAt: s.updatedAt
      }))
    }
  } catch (err) {
    // 索引读不到不该打崩本轮（该树不注入），但绝不装作没发生
    console.error('[room] 会话树索引读取失败:', (err as Error).message)
    return null
  }
}

export function initRoomRuntime(state: AppState, deps: BootstrapDeps, opts: RoomRuntimeWiringDeps): void {
  const { configStore } = deps
  const getGrants = (): typeof EMPTY_GRANTS => configStore.get().securityGrants ?? EMPTY_GRANTS

  const zoneStore = new ToolZoneStore(opts.toolZoneDir)
  /** 事件落盘（B-D 可观测）：`<data>/room/room-events.jsonl`，有界（超 512KB 滚一代） */
  const eventLog = new RoomEventLog(opts.toolZoneDir)
  /** AI 感知策略（0.53.3）：每房间一份，启动恢复 / 变更落盘 */
  const sensorPolicyStore = new SensorPolicyStore(join(opts.toolZoneDir, 'sensor-policy'))
  /** 前置规划配置与滚动历史（2026-10-31 前置规划功能）：每房间一份 `{enabled, history[]}`，区自持存储 */
  const preplanStore = new PreplanStore(opts.toolZoneDir)
  // 注册进程级访问点（IPC `room:preplan-*` 经此读写；uid 解析器来自当前登录态）
  setPreplanAccess(preplanStore, () => state.userStore?.getCurrentUser()?.UID ?? null)
  /** room 侧 `evaluatePolicy` 的审计落点（B-D）：采集闸门与形象门控共用同一 sink（懒建） */
  let auditRef: AuditSink | null = null
  const roomAudit = (): AuditSink => (auditRef ??= createFileAuditSink(defaultAuditFilePath()))

  // 「监控看到了」唤醒源（ADR-29 裁决3）：工作流事件 → **只上报**，去抖与真正激活在 wake 仲裁器里。
  // 订阅是进程级（initRoomRuntime 只装配一次），故不保存退订函数——随进程退出释放。
  opts.workflowManager?.onEvent(() => {
    reportRoomWake('monitor', undefined, undefined, '工作流事件')
  })
  // 系统级环境事件（0.53.1）：睡眠恢复是**真的外部变化**（时间跳变、网络/进程重连），
  // 不采样也能判定。**不订阅 unlock-screen**：解锁时渲染进程本来就会上报「用户来了」，
  // 再广播一次只会让所有房间各跑一轮（SRE 评审 P1：惊群）。
  // 用动态 import 避免把 electron 顶层依赖带进纯 Node 单测（bootstrap 被 test 直接 import）。
  void import('electron')
    .then(({ powerMonitor }) => {
      powerMonitor.on('resume', () => reportRoomWake('collector', undefined, undefined, '系统从睡眠恢复'))
    })
    .catch(() => undefined)
  const enabledZoneEntries = (): ReturnType<ToolZoneStore['load']> => zoneStore.load().filter((e) => e.enabled)
  const registryToolNames = (): string[] => [...opts.toolRegistry.tools.keys()]

  // 只读判定器（执行器门控与前置规划工具面**共用同一份判定**，见下方 preplanReadonlyTools 与
  // 文件尾部 restrictToolsRef）：真源 = 注册表元数据 `behavior.readOnly`（P0-2），AI 自述无效。
  const toolReadOnly = createToolReadOnlyResolver(() => opts.toolRegistry.tools)

  // 执行器：注册表工具直接执行；工具区工具按名命中后**逐步执行**（每步再过一次门控，见 ADR-17）
  let executorRef: Executor | null = null
  const executor = createExecutor({
    getGrants,
    evaluate: (req) => evaluatePolicy(req, { getGrants, now: () => Date.now() }),
    // 只读判定真源 = 工具注册表元数据（P0-2）：AI 自述的 readOnly 不再参与分流
    isReadOnly: toolReadOnly,
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
      // 感知器（0.53.1）：AI 静默后的廉价采样。两层闸门与采集同源（用户开关 + t1.collector）——
      // 未授予时采样返回 null，房间静默（不假装在感知）；授权后下一次采样自动恢复。
      // 0.53.3：字段由 AI 的感知策略裁剪（被屏蔽的信号不采），策略本身持久化到本房间。
      sense: async (view, policy) => buildRoomSensorSample(view, policy),
      // 感知闸门**不落审计**：它每 5–15s 判一次，写 audit 会变成刷盘噪声；
      // 真正的拒绝原因已经在事件流 / 感知页可见（`sensing=false` + blocked 文案）。
      senseAllowed: () => evaluateRoomCollectGate(configStore.get().collector, getGrants()).ok,
      loadSensorPolicy: () => sensorPolicyStore.load(roomSessionId(scope)),
      saveSensorPolicy: (policy) => sensorPolicyStore.save(roomSessionId(scope), policy),
      // 规划者路由（前置规划功能）：读 preplan.json——启用 = 先跑前置规划轮；缺省/未启用 = 主AI自规划
      plannerRoute: () => (preplanStore.load(scope.uid, scope.aiId).enabled ? { kind: 'preplan' } : { kind: 'self' }),
      // 前置规划轮（两段式第一段）：前置规划会话挂在独立 sessionId（`room-preplan-U{uid}-AI{aiId}`）上，
      // purpose='room-preplan' = **全跳过落盘**（不写会话历史、不写 RAW——前置规划永不进记忆工作流）。
      // 链路未就绪返回空串：runtime 据此回落主AI自规划（不传播 llmFailed）。
      runPreplan: async (prompt) => {
        const runner = getHeadlessChatRunner()
        if (!runner) return ''
        return runner(prompt, `room-preplan-U${scope.uid}-AI${scope.aiId}`, aiId, 'room-preplan')
      },
      // 前置规划滚动历史环（自管理：append 时超环长自动砍头，见 preplan-store.ts）
      loadPreplanHistory: () => preplanStore.load(scope.uid, scope.aiId).history,
      appendPreplanHistory: (entry) => preplanStore.appendHistory(scope.uid, scope.aiId, entry),
      // 前置规划提示词 identity 段「你是 X 的前置规划」；注册表读不到时用兜底名（不该打崩本轮）
      preplanAiName: (() => {
        try {
          return readAiRegistry(opts.aiRegistryJson).ais.find((a) => a.id === aiId)?.name ?? `AI${aiId}`
        } catch {
          return `AI${aiId}`
        }
      })(),
      // 前置规划本轮可用来查证的只读工具清单：与执行器门控**同一份只读判定**（上方 toolReadOnly）。
      // 这份名单同时是文件尾部 restrictToolsRef 对 room-preplan 用途的收窄名单——提示词
      // 【查证】段列的与无头链路实际收窄的读同一份，口径不漂移（名单外工具物理不可见）。
      preplanReadonlyTools: () => registryToolNames().filter((n) => toolReadOnly(n)),
      // 唤醒必须走主进程单 owner：感知器只上报，去抖 / 相位判断在仲裁器与 runtime.wake
      reportWake: (source, detail) => reportRoomWake(source, aiId, undefined, detail),
      plan: async (prompt, sessionId) => {
        const runner = getHeadlessChatRunner()
        // 链路未就绪 = LLM 拿不到回复 → 返回空串，runtime 会标记 llmFailed 并**停止**循环
        if (!runner) return ''
        // 带 aiId：规划轮次落该 AI 的会话与 RAW（L3 修复点——此前不带，全计入 AI1）
        // 带 purpose='room'：注入链**跳过对话纪律段**（mode_branch）——房间规划输出的是计划契约
        // `{note,decisions[]}`，若继承 chat 的 JSON envelope / task 的 Team Lead / coding 的输出纪律
        // 会与之冲突（见 prompts/segments.ts 的 SegmentBuildCtx.purpose）
        return runner(prompt, sessionId, aiId, 'room')
      },
      // 承载会话的树索引（ADR-30 / 0.53.18）：owner = 开启自主的那个会话。
      // 走**同一个** `InternalSessionStore`（`service-assembly` 注入的共享实例）——存储、写链、
      // 继承/时间/落点指针语义零改动，房间侧只负责「读索引 / 应用落点」。
      listTreeSessions: (sid) => describeTreeIndex(opts.internalSessionStore, sid),
      // AI 主动落点（ADR-30）：**复用 `session_select` 工具本体**做校验与应用——
      // 承接/建档/继承/虚线的规则（只接可写尾端、父须可写、`gen` 递增）与普通对话
      // **同一份实现**，不另抄一套（抄一套必然漂移）。工具按 `ctx.sessionId` 归属树，
      // 故落点永远落在承载会话那棵树上。
      applyLanding: async (sid, l) => {
        const r = await new SessionSelectTool().execute(
          l.action === 'continue'
            ? { action: 'select', internalId: l.internalId ?? '' }
            : {
                action: 'create',
                ...(l.title ? { title: l.title } : {}),
                ...(l.summary ? { summary: l.summary } : {}),
                ...(l.internalId ? { parentId: l.internalId } : {}),
                ...(l.newTopic ? { newTopic: true } : {})
              },
          { getInternalSessionStore: () => opts.internalSessionStore, sessionId: sid }
        )
        if (!r.ok) return { ok: false, error: r.error ?? '落点应用失败' }
        const internalId = (r.data as { internalId?: unknown } | undefined)?.internalId
        return typeof internalId === 'string' && internalId
          ? { ok: true, internalId }
          : { ok: false, error: '落点应用失败：未返回节点 id' }
      },
      executor,
      // 计划可引用：注册表工具 + 启用中的工具区自造工具（两者共用同一可用集合口径）
      allowedTools: () => [...registryToolNames(), ...enabledZoneEntries().map((e) => e.name)],
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
        // 按 AI 分层：AI{aiId} 写入优先；读取时 AvatarStore 会回落全局（兼容旧数据）
        new AvatarStore(join(opts.toolZoneDir, `AI${aiId}`), opts.toolZoneDir).save(v.spec)
        return { ok: true }
      },
      // 事件落盘（B-D 可观测）：启停 / 相位序列 / 唤醒源 / 重画 / 采集视图变更都进 JSONL
      onEvent: (ev) =>
        eventLog.append({
          ts: ev.ts,
          phase: ev.phase,
          // 全房间共用一个 JSONL：没有 room 字段时，多 AI 事故无法回答「是哪个房间醒的」（SRE P1）
          room: roomSessionId(scope),
          ...(ev.detail ? { detail: ev.detail } : {}),
          ...(ev.mode ? { mode: ev.mode } : {})
        }),
      // 状态推送（**取代渲染端 3s 轮询**）：状态变了才发，安静期一个包都不发。
      // 目标只有主窗口——原位视图 `RoomView` 在里面；`safeSend` 自带「窗口/webContents
      // 已销毁」守卫（渲染进程崩溃时推送回调可能仍在飞）。
      // （B-F 后不再有第二路：独立窗口分支已物理删除。）
      onStateChange: (s) => safeSend(state.mainWindow, 'room:state-changed', { aiId, state: s })
    })
    setRoomRuntime(scope, rt)
    // 唤醒仲裁（ADR-29 裁决3）：每个房间一个仲裁器，**唯一触发点**就是这里——
    // 渲染进程（用户到达）/ 监控（工作流事件）/ 感知器（环境变化）只 `reportRoomWake`，
    // 不得各自调 `rt.wake`。
    registerWakeArbiter(aiId, createWakeArbiter((source, detail) => rt.wake(source, detail)))
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

  // ===== 区树（ADR-30）：区 = AI 写给自己用的一叠纸（逆生树结构，**不是会话**）=====
  // 存储 `<data>/room/zones/{zone}/{room-autonomous-U{uid}-AI{aiId}}/ai/*.json`——
  // 不在 sessions/ 下，所以既不会出现在用户会话列表，也不会进普通对话的路由候选。
  // 按 (uid, aiId) 缓存实例：换用户 / 换 AI 各一堆纸（换会话不动——纸属于房间，不属于会话）。
  const zonesRoot = join(opts.toolZoneDir, 'zones')
  const zoneTreesByRoom = new Map<string, RoomZoneTrees>()
  const zoneTreesFor = (aiId: number): RoomZoneTrees | null => {
    const uid = state.userStore?.getCurrentUser()?.UID
    if (!uid || !aiRunnable(aiId)) return null
    const key = `${uid}_${aiId}`
    let trees = zoneTreesByRoom.get(key)
    if (!trees) {
      trees = createRoomZoneTrees({ zonesRoot, ownerSessionId: roomSessionId({ uid, aiId }) })
      zoneTreesByRoom.set(key, trees)
    }
    return trees
  }
  setRoomZoneToolProvider((_purpose, aiId) => {
    const id = typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID
    const trees = zoneTreesFor(id)
    return trees ? [buildRoomNoteExecutor(trees)] : []
  })
  // 无头链路经 serviceRefs 读它（§3.4：api/ 不得直连房间域，装配只在 bootstrap/）。
  // `getRoomExtraToolExecutors` 对非 'room' 用途返回空数组 → 普通对话工具面零变化。
  serviceRefs.extraToolExecutorsRef = getRoomExtraToolExecutors
  // 用途收窄（前置规划轮只读工具面，2026-10-31 前置规划功能）：room-preplan 用途把无头链路的工具集
  // 按名收窄到只读名单——写入/高危工具对前置规划**物理不可见**（不是门控拒绝，是清单里根本没有）。
  // 收窄名单与提示词【查证】段同源（上方 preplanReadonlyTools 的同一份名单）。
  // 按名过滤是 fail-closed 的交集语义：名单里但不在链路执行器集合中的名字自动失效
  // （两侧注册表实例不同——本侧 dmn 池 / 链路侧前端池——时安全方向不反），
  // 链路里但不在名单的工具被移除。其余用途返回 null = 工具面与引入前逐字一致。
  serviceRefs.restrictToolsRef = (purpose) =>
    purpose === 'room-preplan' ? registryToolNames().filter((n) => toolReadOnly(n)) : null

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
  } catch (err) {
    // 不静默：对账失败要看得见（不阻断启动，但不装作没发生）
    console.error('[room] 启动期对账失败（config.room.enabled 可能残留 true）:', (err as Error).message)
  }
}
