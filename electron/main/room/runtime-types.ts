/**
 * @category ROOM
 * @summary ROOM 运行时的**公共类型**（deps / phase / state / 接口）
 *
 * 为什么拆出来（0.53.3）：`runtime.ts` 已接近 800 行硬红线，而其中近 180 行是
 * 「调用方与渲染侧共同依赖的形状」。形状与编排分开后：
 * - `runtime.ts` 只保留装配与状态机；
 * - `sensor.ts` / 测试 / bootstrap 可以只依赖类型，不把运行时实现拖进来；
 * - 消费方 import 路径不变（`runtime.ts` 再导出这些类型）。
 *
 * 不删理由：删掉即类型重新堆回运行时文件，体量红线再次失守，且类型变更会牵动整个运行时的加载。
 */
import type { Executor } from './executor'
import type { LoopEvent, LoopTickResult, PlanDecision } from './loop'
import type { CollectorView } from './collector-view'
import type { WakeSource } from './wake'
import type { RoomSensorSnapshot } from './sensor'
import type { TreeIndex } from './tree-index'
import type { RoomLanding } from './landing'
import type { RoomSceneDirective } from '@shared/room/room-scene'
import type { RoomSensorPolicy } from '@shared/room/sensor-policy'

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
  /**
   * 取**承载会话**的内部会话树索引（ADR-30；0.53.18 起只有这一棵）。
   * 为什么不再用「最近内部会话摘要」（原 `listInternalSessions`）：那是**宿主替 AI 列全部**；
   * 现在索引进提示词，AI 自己用 `landing` 选承接哪条线。
   * 未绑定承载会话 / 该树不存在 → null（不注入，不报错）。
   */
  listTreeSessions?: (sessionId: string) => TreeIndex | null
  /**
   * 应用 AI 主动声明的**落点**（ADR-30）：在承载会话的树里承接某个节点 / 开一个新节点。
   * **调用方负责校验与应用**（复用 `session_select` 的规则：只接可写尾端、父须可写、
   * 实线继承 / 虚线新话题语义）——本层只做编排与状态回传，与 `applyAvatar` 同一分工。
   */
  applyLanding?: (
    sessionId: string,
    landing: RoomLanding
  ) => Promise<{ ok: boolean; internalId?: string; error?: string }>
  /** 执行器（B5） */
  executor: Executor
  /** 计划里允许出现的工具名（白名单；`parsePlan` 据此过滤） */
  allowedTools: () => readonly string[]
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
  /**
   * 状态变化推送钩子（**取代渲染端 3s 轮询**）。
   *
   * 为什么必须推送而不是轮询：自主模式大部分时间是安静的（待机 / 空闲），
   * 轮询在「什么都没发生」时也在消耗——这与用户对采集器的裁决同源
   * （「采集器只能是条件激活，不能是定时激活…其余时间都是浪费」）。
   * 状态**变了才推**：安静期零开销，有事时**立即**到界面（轮询还有最多一个周期的延迟）。
   *
   * 调用点覆盖全部状态字段：`pushEvent` / `onPhase` / `onResult` / 规划产物落定 / `tick` 收尾。
   */
  onStateChange?: (state: RoomRuntimeState) => void
  /**
   * **廉价环境采样**（0.53.1 感知器）：只在 `idle` / `standby`（驱动已 park）时调用，
   * 不调用模型、不跑 PowerShell；返回 null = 当前不可感知（未授权 / 视图没有可采样字段）。
   * `policy` 是 AI 当前声明的感知策略：实现方据此只取未被屏蔽的字段。
   */
  sense?: (view: CollectorView, policy: RoomSensorPolicy) => Promise<RoomSensorSnapshot | null>
  /** 感知是否被允许（用户开关 + `t1.collector`）；每次采样前判一次，授权变化即时生效 */
  senseAllowed?: () => boolean
  /**
   * 读取 AI 上一次保存的感知策略（可选）。策略属于这个房间（per uid + aiId），
   * 启动时恢复；读不到 / 非法 → 默认策略（全部感知）。
   */
  loadSensorPolicy?: () => unknown
  /** 保存 AI 的感知策略（可选）。落盘失败只留痕，不影响本轮流策略。 */
  saveSensorPolicy?: (policy: RoomSensorPolicy) => void
  /**
   * 唤醒上报（**必须走仲裁器**）：感知器发现变化时调用。
   * **返回值 = 是否被接受**（仲裁器去抖 / 相位拦下时为 false）；感知器据此决定是否重试。
   * 缺省 = 直接 `wake`（单测 / 未接仲裁器时的兜底）。
   */
  reportWake?: (source: WakeSource, detail?: string) => boolean | void
  now?: () => number
}

/**
 * 房间相位（采集器的「激活条件」就是它）：
 * - `stopped`：用户关停 / LLM 出问题被停 → 采集器不返回；
 * - `standby`：AI 主动声明待机（有到期时间）→ 不主动做事；**感知器仍可看**（除非 AI 关掉它）；
 * - `idle`：自主开 + 非待机 + 无在跑轮次 → **采集器睁眼**（激活）；
 * - `running`：正在处理一轮 → 采集器不返回。
 */
export type RoomPhase = 'stopped' | 'standby' | 'idle' | 'running'

export interface RoomRuntimeState {
  /** 兼容既有消费者：phase !== 'stopped' 即为「在跑」 */
  running: boolean
  phase: RoomPhase
  /**
   * **承载会话**：自主模式是在哪个会话窗口里开启的（0.53.18）。
   * 逆生树、规划轮、落点全部落在它身上——与普通对话共用同一棵树，不再另开房间树。
   * 未绑定（还没在会话里开启过）→ 不带该字段。
   */
  hostSessionId?: string
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
  /**
   * 当前生效的**感知策略**（AI 自己配置，0.53.3）：是否感知 / 屏蔽哪些信号 / 间隔 / 阈值。
   * 界面「感知」页据此显示「它选择看什么、忽略了什么」。
   */
  sensorPolicy?: RoomSensorPolicy
  /**
   * 当前**落点**（AI 主动声明，ADR-30）：承载会话树里的哪个节点。
   * 可选：未声明过 / 假体可不带。UI 据此显示「AI 现在接着哪条线」。
   */
  landing?: { internalId: string }
  /** AI 直接声明的房间动作（直播镜头里「去哪 / 做什么」） */
  scene?: RoomSceneDirective
  /** AI 最近一次对用户/镜头的回应（直播字幕；也会由渲染侧落回会话历史） */
  lastReply?: string
  /** 回应时刻（幂等追加用） */
  lastReplyAt?: number
  /**
   * 感知器是否在跑（0.53.1）：`idle` / `standby` 且驱动已 park、且 AI 没关掉感知时为 true。
   * 界面据此显示「空闲 · 感知中」——让用户看见「它不是静默了，它在睁着眼等变化」。
   */
  sensing?: boolean
  /** 最近一次唤醒（谁把它叫醒的 + 原因）；界面与事件流共用 */
  lastWake?: { source: WakeSource; detail?: string; at: number }
  /** 最近一次采集到的内容（截断；界面「感知」页据此显示它看到了什么） */
  lastCollect?: { text: string; at: number }
}

export interface RoomRuntime {
  /** 开启自主（进入 idle 并激活一次） */
  start: () => void
  /** 停止自主（回到 stopped；清待机定时器） */
  stop: () => void
  /** 是否在跑（phase !== 'stopped'） */
  isRunning: () => boolean
  /**
   * AI 主动声明待机：期间不主动做事，到期后自动回到 idle 并重新激活。
   * 时长由 AI 决定（计划输出 `standbyMs`），**没有产品上限**；感知器仍可提前叫醒它。
   */
  standby: (ms: number) => void
  /**
   * **用户侧回收路径**（0.53.3）：把 AI 的感知策略复位为默认（全部感知、不屏蔽）。
   * 为什么必须有：AI 可以把策略写成 `enabled=false` 并持久化；如果只有 AI 能改，
   * 一份「AI 拥有的配置」在运维上就是不可逆的。按钮走独立 IPC，不经过 AI。
   */
  resetSensorPolicy: () => { ok: boolean; policy?: RoomSensorPolicy; error?: string }
  /**
   * 事件唤醒（ADR-29 裁决3）：由主进程唤醒仲裁（`./wake`）调用，**不是**采集器/监控各自调。
   * 语义：`stopped`（用户关停）忽略；`running` 忽略（已在处理）；`standby`/`idle` → 清除待机并激活一次。
   * `detail` 是给人看的原因（如「CPU 12% → 78%」），进事件流。
   */
  wake: (reason: WakeSource, detail?: string) => void
  /**
   * 绑定承载会话：**在哪个会话开启自主，就继承哪个会话已有的逆生树**（0.53.18）。
   * 运行中不重新绑定（换窗口要先关停再开，见 `room:start-loop`）；房间**配置**仍挂在
   * (uid, aiId) 上——换会话不动配置，只有换 AI 才是另一个房间。
   */
  setHostSession: (sessionId: string | null) => void
  /**
   * 用户在房间视图里发了一条消息：作为**第一类输入**进入下一轮规划
   * （不依赖采集器是否开启 / 是否授权），并在 idle/standby 时激活。
   * `stopped`（用户关停）不自动拉起——尊重开关。
   */
  onUserMessage: (content: string, hostSessionId?: string) => { ok: boolean; error?: string }
  /** 手动跑一轮（UI 的「立即行动」） */
  tick: () => Promise<LoopTickResult>
  getState: () => RoomRuntimeState
}
