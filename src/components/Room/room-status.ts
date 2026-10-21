/**
 * ROOM 状态栏的纯判定（相位 → 月相 / 语气 / 阶段）+ **16×16 像素月相的生成**
 * + **运行态快照的形状与归一化**（`RoomRuntimeSnapshot` / `toRoomSnapshot`）。
 *
 * 为什么独立成模块：状态栏要「一眼看懂它在干什么」，靠的是**相位到视觉的确定性映射**；
 * 映射一旦内联在组件里就没法单测，改一处也容易漏另一处。这里全是纯函数。
 * 快照形状也放这里：它是「ROOM 状态」的唯一表述，主进程推送与 IPC 读取共用同一归一化入口。
 *
 * 为什么月相是**程序生成**而不是手写 16×16 字符画：手写 5 种月相 = 80 行易错的字符；
 * 圆形光栅化 8 行就能得到同样可辨的像素月，且改半径/相位即改形状（可测）。
 *
 * ⚠️ 状态**不能只靠颜色**区分（无障碍硬要求）：形状（月相）+ 文字（相位名）+ 原因三件齐备。
 *
 * 不删理由：删掉即状态栏退回「一堆内联三元」，且月相形状与相位的关系无人可测。
 */
import {
  parseRoomScene,
  zoneForStage,
  zoneForToolCategory,
  type RoomSceneDirective,
  type RoomZoneId
} from '@shared/room/room-scene'
import { TOOL_MAP } from '@shared/tools/catalog'
import {
  DEFAULT_SENSOR_POLICY,
  applySensorPolicy,
  parseSensorPolicyPatch,
  type RoomSensorPolicy
} from '@shared/room/sensor-policy'

/** 与主进程 `room/runtime.ts` 的 RoomPhase 同形 */
export type RoomPhase = 'stopped' | 'standby' | 'idle' | 'running'

/** 月相形状（见任务 §状态与房间的对应）：待机=满月 / 思考与空闲=渐亏 / 执行=日偏食 / 待批=环食 / 出错=红月 */
export type MoonKind = 'new' | 'full' | 'waning' | 'eclipse' | 'ring' | 'red'

const GRID = 16
const CENTER = GRID / 2
/**
 * 月盘半径（格）。**为什么是 7.2 而不是 8**：格心坐标系下 r=8 会顶到网格边缘（视觉上「切边」），
 * 7.2 让月盘四周各留约 1 格，像一枚真正的月相图标。调大 → 更满，调小 → 更小。
 */
const MOON_RADIUS = 7.2
/** 渐亏：从右侧挖掉的**偏移圆**的水平偏移（越大月牙越细） */
const WANING_CUT_OFFSET = 4.4
/** 日偏食：从左上挖掉的偏移圆的偏移量（与渐亏方向相反，形成「缺口」而非「月牙」） */
const ECLIPSE_CUT_OFFSET = 3.6
/** 环食：挖掉的同心圆半径（月盘与它之间即环） */
const RING_INNER_RADIUS = 4.6
/** 新月：挖掉的同心圆半径（比环食大 → 只剩一圈细边） */
const NEW_INNER_RADIUS = 6.4
/** 红月：右上缺口的圆心偏移与半径（形状独有 = 「受损」的像素语义） */
const RED_NOTCH_OFFSET = 3.4
const RED_NOTCH_RADIUS = 3.4

/** 点 (x,y) 的格心是否落在以 (cx,cy) 为心、r 为半径的圆内。 */
function inDisc(x: number, y: number, cx: number, cy: number, r: number): boolean {
  const dx = x + 0.5 - cx
  const dy = y + 0.5 - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * 生成 16×16 月相网格（`'#'` = 亮像素，`'.'` = 透明）。
 * 形状语义：
 * - `full`    满月（整圆）
 * - `waning`  渐亏（整圆挖掉一个右偏圆 → 月牙）
 * - `eclipse` 日偏食（整圆挖掉一个左上偏移圆 → 缺口）
 * - `ring`    环食（整圆挖掉同心小圆 → 环）
 * - `new`     新月（只剩一圈细边）
 * - `red`     红月（**出错**：整圆挖掉一个右上小缺口——形状也独有，颜色只是加强语义）
 *
 * 顶栏把它当「存在」用（14px）：形状 + 呼吸节奏 + 色温 + 状态词四重编码，不只靠颜色。
 */
export function moonRows(kind: MoonKind): string[] {
  const rows: string[] = []
  for (let y = 0; y < GRID; y++) {
    let row = ''
    for (let x = 0; x < GRID; x++) {
      const disc = inDisc(x, y, CENTER, CENTER, MOON_RADIUS)
      let on = false
      switch (kind) {
        case 'full':
          on = disc
          break
        case 'red':
          // 红月必须**形状也独有**（不是「满月换个颜色」）——否则待机与出错在只看形状时无法区分，
          // 违反「状态不能只靠颜色」。缺口 = 「受损」的像素语义。
          on = disc && !inDisc(x, y, CENTER + RED_NOTCH_OFFSET, CENTER - RED_NOTCH_OFFSET, RED_NOTCH_RADIUS)
          break
        case 'waning':
          on = disc && !inDisc(x, y, CENTER + WANING_CUT_OFFSET, CENTER, MOON_RADIUS)
          break
        case 'eclipse':
          on = disc && !inDisc(x, y, CENTER - ECLIPSE_CUT_OFFSET, CENTER - ECLIPSE_CUT_OFFSET, MOON_RADIUS)
          break
        case 'ring':
          on = disc && !inDisc(x, y, CENTER, CENTER, RING_INNER_RADIUS)
          break
        case 'new':
          on = disc && !inDisc(x, y, CENTER, CENTER, NEW_INNER_RADIUS)
          break
      }
      row += on ? '#' : '.'
    }
    rows.push(row)
  }
  return rows
}

/** 相位 → 月相形状。 */
export function phaseToMoon(phase: RoomPhase, opts: { llmFailed?: boolean; awaitingApproval?: boolean } = {}): MoonKind {
  // 出错优先于一切（红月 = 出事了，必须一眼看到）
  if (opts.llmFailed) return 'red'
  // 待批：环食（有东西在等你）
  if (opts.awaitingApproval && phase !== 'stopped') return 'ring'
  switch (phase) {
    case 'standby':
      return 'full'
    case 'running':
      return 'eclipse'
    case 'idle':
      return 'waning'
    default:
      return 'new'
  }
}

/** 相位 → 语气（文字色 + LED/月相色）。语义色优先用项目既有 token（见 globals.css）。 */
export function phaseTone(phase: RoomPhase, opts: { llmFailed?: boolean } = {}): string {
  if (opts.llmFailed) return 'text-danger'
  switch (phase) {
    case 'running':
      return 'text-success'
    case 'idle':
      return 'text-warning'
    case 'standby':
      return 'text-accent'
    default:
      return 'text-fg-muted'
  }
}

/** 相位 → i18n 键（状态栏主文案）。 */
export function phaseLabelKey(phase: RoomPhase): string {
  return `room.phase.${phase}`
}

/**
 * 相位 → 本轮阶段条的下标（0=采集 1=分诊 2=召回 3=规划 4=执行；-1 = 不在阶段中）。
 * 数据来自 `lastTick.phase` / 事件流的 `phase`（LoopPhase）。
 */
export function stageIndex(loopPhase?: string): number {
  switch (loopPhase) {
    case 'collect':
      return 0
    case 'triage':
      return 1
    case 'recall':
      return 2
    case 'plan':
      return 3
    case 'execute':
      return 4
    default:
      return -1
  }
}

/** 阶段条总格数（采集/分诊/召回/规划/执行） */
export const STAGE_COUNT = 5

/** 本轮阶段闭集（与主进程 `LoopPhase` 的五个阶段一致） */
const LOOP_STAGE_SET: ReadonlySet<string> = new Set(['collect', 'triage', 'recall', 'plan', 'execute'])

/**
 * **当前阶段**来自事件环尾部，而不是 `lastTick.phase`。
 *
 * 为什么（0.52.88 架构评审 P0）：`LoopTickResult.phase` 只在**一轮结束时**写入，
 * 值只可能是 `execute`（有动作）或 `idle`（无动作）——`collect/triage/recall/plan`
 * **永远不会出现在 `lastTick` 里**。若渲染侧拿它当阶段，直播镜头里的角色只会去工坊，
 * 另外四个地点永远触发不到。事件环则在每个阶段 `emit` 一次（`loop.ts`），
 * 且每次 `pushEvent` 都会 `notify()`，所以尾事件就是**正在发生的阶段**。
 *
 * 只认闭集：尾部是 `idle`/其它事件时返回 `undefined`（交给「散步」）。
 */
export function stageFromEvents(events: readonly { phase: string }[] | undefined): string | undefined {
  const last = events && events.length > 0 ? events[events.length - 1] : undefined
  return last && LOOP_STAGE_SET.has(last.phase) ? last.phase : undefined
}

/** 快照 → 当前阶段（`StageFromEvents` 的便捷包装） */
export function currentStageOf(state: Pick<RoomRuntimeSnapshot, 'events'>): string | undefined {
  return stageFromEvents(state.events)
}

/**
 * **背景分区**判定（0.53.6 语义化）：AI 走到哪类空间，背景就切到哪。
 *
 * 优先级：
 * 1. AI 显式声明的 `scene.zone`（它自己知道要去哪）；
 * 2. 执行阶段按**本轮工具类别**改判：局域网工具 → 通信室，设备工具 → 设备间；
 * 3. 阶段兜底（collect→设备间 / triage·plan→规划室 / recall→记忆库 / execute→工作间）；
 * 4. 其余（停止 / 待机 / 空闲）→ 房间。
 *
 * 为什么工具类别只在 `execute` 生效：`lastPlan` 会留到下一轮，若一直按它判，
 * 回忆阶段也会停在通信室，背景就不再跟阶段走。
 */
export function activityZone(input: {
  phase: string
  stage?: string
  scene?: RoomSceneDirective | null
  /** 本轮计划里的工具名（可含 undefined——非工具动作） */
  toolNames?: readonly (string | undefined)[]
}): RoomZoneId {
  if (input.scene) return input.scene.zone
  if (input.phase === 'stopped' || input.phase === 'standby' || input.phase === 'error') return 'home'
  if (input.stage === 'execute') {
    for (const name of input.toolNames ?? []) {
      if (!name) continue
      const zone = zoneForToolCategory(TOOL_MAP[name]?.category)
      if (zone) return zone
    }
  }
  if (input.phase === 'running') return zoneForStage(input.stage)
  return 'home'
}

/** 阶段下标 → i18n 键 */
export function stageLabelKey(index: number): string {
  return `room.stage.${['collect', 'triage', 'recall', 'plan', 'execute'][index] ?? 'collect'}`
}

// ===== 运行态快照：全房间**唯一**的状态视图 =====

/** 房间事件（主进程事件环的一条）。事件流与状态栏共用同一形状。 */
export interface RoomEvent {
  phase: string
  ts: number
  detail?: string
  mode?: string
}

/** 采集视图（AI 声明；与主进程 `room/collector-view.ts` 同形） */
export interface RoomCollectorView {
  name: string
  scopes: string[]
  fields: string[]
}

/** 本轮 tick 的界面子集（主进程 `LoopTickResult`） */
export interface RoomTickSummary {
  phase?: string
  acted?: boolean
  mode?: string
  triageReason?: string
  error?: string
  llmFailed?: boolean
  executions?: Array<{ ok: boolean }>
}

/** 最近一次规划的界面子集（主进程 `PlanDecision`） */
export interface RoomPlanSummary {
  decisions: Array<{ toolName?: string; description: string }>
  note?: string
}

/** AI 主动声明的落点（ADR-30 R2）：落在哪棵树、哪个节点 */
export interface RoomLandingSummary {
  tree: 'room' | 'host'
  internalId: string
}

/**
 * 房间运行态的**界面快照**——全房间只有一个（由 `useRoomRuntimeState` 持有并下传）。
 *
 * 为什么是「一个」：此前 `RoomView` 与 `RuntimeZones` **各持一个 3s 轮询**（同一通道被问两遍，
 * 且各自维护一份状态）。收敛成单一快照后，状态栏 / 事件流 / 规划区 / 记忆区看到的**必然是同一时刻**的
 * 同一份数据——不会出现「状态栏说在跑、规划区说已停」这类漂移。
 */
export interface RoomWakeSummary {
  source: 'user-present' | 'monitor' | 'collector' | 'user-action'
  detail?: string
  at: number
}

/** AI 最近一次采集到的内容（截断） */
export interface RoomCollectSummary {
  text: string
  at: number
}

export interface RoomRuntimeSnapshot {
  phase: RoomPhase
  /**
   * 本快照的**采样时刻**（在唯一的取数点写入一次）。
   * 为什么放进快照而不是在组件里 `Date.now()`：① 组件里调时间 = 不可测（每次渲染都变）；
   * ② 同一份快照的所有消费者看到的是**同一个时刻**，待机倒计时不会因渲染次数而漂移。
   */
  sampledAt: number
  running: boolean
  /** 房间自持会话 id（ADR-30 R3：逆生树视角据此切到房间树）；假体/旧状态可不带 */
  sessionId?: string
  /** 像素形象修订号：变化才需要重取规格（`room:avatar-get`） */
  avatarRev: number
  standbyUntil?: number
  lastTick?: RoomTickSummary
  lastPlan?: RoomPlanSummary
  events: RoomEvent[]
  collectorView?: RoomCollectorView
  /** 当前感知策略（AI 自己配置，0.53.3）；缺省 = 全部感知 */
  sensorPolicy?: RoomSensorPolicy
  /** 当前落点（ADR-30 R2）：AI 现在接着哪条线（哪棵树 + 哪个节点） */
  landing?: RoomLandingSummary
  /** AI 直接声明的房间动作（去哪 / 做什么 / 对镜头说什么） */
  scene?: RoomSceneDirective
  /** AI 最近一次对用户/镜头的回应（直播字幕；也会落回会话历史） */
  lastReply?: string
  /** 回应时刻（幂等追加到会话历史用） */
  lastReplyAt?: number
  /** 感知器是否在跑（0.53.1）：空闲且驱动已 park 时为 true */
  sensing?: boolean
  /** 最近一次唤醒（谁 + 原因） */
  lastWake?: RoomWakeSummary
  /** 最近一次采集到的内容 */
  lastCollect?: RoomCollectSummary
}

/** 未取到数时的空快照（**单一**空态，避免各处手拼字面量而漂移）。 */
export const EMPTY_ROOM_SNAPSHOT: RoomRuntimeSnapshot = {
  phase: 'stopped',
  sampledAt: 0,
  running: false,
  avatarRev: 0,
  events: []
}

/** IPC 传来的运行态（主进程可信来源；此处只做形状归一化，不做业务判定） */
interface RawRoomState {
  phase?: RoomPhase
  running?: boolean
  sessionId?: string
  avatarRev?: number
  standbyUntil?: number
  lastTick?: RoomTickSummary
  lastPlan?: RoomPlanSummary
  events?: RoomEvent[]
  collectorView?: RoomCollectorView
  sensorPolicy?: unknown
  landing?: RoomLandingSummary
  scene?: unknown
  lastReply?: string
  lastReplyAt?: number
  sensing?: boolean
  lastWake?: unknown
  lastCollect?: unknown
}

/**
 * 把 IPC 载荷（`room:runtime-state` 的返回值 / `room:state-changed` 的推送）归一化为界面快照。
 * `sampledAt` 由调用方**采样一次**传入（时间只在这里的调用点取，见 `RoomRuntimeSnapshot.sampledAt`）。
 */
export function toRoomSnapshot(raw: unknown, sampledAt: number): RoomRuntimeSnapshot {
  const st = (raw ?? {}) as RawRoomState
  const scene = st.scene !== undefined ? parseRoomScene(st.scene) : null
  const wake = parseWake(st.lastWake)
  const collect = parseCollect(st.lastCollect)
  const sensorPolicy = parseSensorPolicy(st.sensorPolicy)
  return {
    phase: st.phase ?? 'stopped',
    sampledAt,
    running: st.running === true,
    ...(typeof st.sessionId === 'string' && st.sessionId ? { sessionId: st.sessionId } : {}),
    avatarRev: st.avatarRev ?? 0,
    ...(st.standbyUntil != null ? { standbyUntil: st.standbyUntil } : {}),
    ...(st.lastTick ? { lastTick: st.lastTick } : {}),
    ...(st.lastPlan ? { lastPlan: st.lastPlan } : {}),
    events: st.events ?? [],
    ...(st.collectorView ? { collectorView: st.collectorView } : {}),
    ...(sensorPolicy ? { sensorPolicy } : {}),
    ...(st.landing && typeof st.landing.internalId === 'string'
      ? { landing: { tree: st.landing.tree === 'host' ? 'host' : 'room', internalId: st.landing.internalId } }
      : {}),
    ...(scene ? { scene } : {}),
    ...(typeof st.lastReply === 'string' && st.lastReply ? { lastReply: st.lastReply } : {}),
    ...(typeof st.lastReplyAt === 'number' && Number.isFinite(st.lastReplyAt) ? { lastReplyAt: st.lastReplyAt } : {}),
    ...(st.sensing === true ? { sensing: true } : {}),
    ...(wake ? { lastWake: wake } : {}),
    ...(collect ? { lastCollect: collect } : {})
  }
}

const WAKE_SOURCES: ReadonlySet<string> = new Set(['user-present', 'monitor', 'collector', 'user-action'])

/** 唤醒摘要归一化（来源闭集 + 时间必须是有限数；不合法整条丢弃） */
export function parseWake(raw: unknown): RoomWakeSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as { source?: unknown; detail?: unknown; at?: unknown }
  if (typeof o.source !== 'string' || !WAKE_SOURCES.has(o.source)) return undefined
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined
  return {
    source: o.source as RoomWakeSummary['source'],
    ...(typeof o.detail === 'string' && o.detail ? { detail: o.detail } : {}),
    at: o.at
  }
}

/** 采集摘要归一化（空文本丢弃） */
export function parseCollect(raw: unknown): RoomCollectSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as { text?: unknown; at?: unknown }
  if (typeof o.text !== 'string' || !o.text.trim()) return undefined
  if (typeof o.at !== 'number' || !Number.isFinite(o.at)) return undefined
  return { text: o.text, at: o.at }
}

/**
 * 感知策略归一化：主进程是可信来源，但渲染侧仍走**同一份共享校验**（不在这里另抄一套规则）。
 * 非法 → undefined（界面回落「默认全部感知」），不让坏数据把「感知」页画歪。
 */
export function parseSensorPolicy(raw: unknown): RoomSensorPolicy | undefined {
  if (raw == null) return undefined
  const r = parseSensorPolicyPatch(raw)
  return r.ok ? applySensorPolicy(DEFAULT_SENSOR_POLICY, r.patch) : undefined
}
