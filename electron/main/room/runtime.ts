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
import type { ExecutorDecision, ExecutorResult } from './executor'
import { createAutonomousLoop, type AutonomousLoop, type LoopTickResult, type PlanDecision } from './loop'
import { parsePlan } from './plan'
import { buildPlanPrompt } from './plan-prompt'
import { recordPreplanTickToHistory, runPreplanTurn } from './preplan-turn'
import { defaultCollectorView, validateCollectorView, type CollectorView } from './collector-view'
import { WAKE_SOURCE_LABEL, type WakeSource } from './wake'
import { createRoomSensor, type RoomSensor } from './sensor'
import type { TreeIndex } from './tree-index'
import { parseLanding } from './landing'
import type { RoomSceneDirective } from '@shared/room/room-scene'
import { ROOM_SCENE_ACTION_LABEL } from '@shared/room/room-scene'
import {
  DEFAULT_SENSOR_POLICY,
  applySensorPolicy,
  describeSensorPolicy,
  parseSensorPolicyPatch,
  type RoomSensorPolicy
} from '@shared/room/sensor-policy'

// 会话树索引 / 落点解析的纯函数已拆出；此处再导出保兼容。
export { TREE_INDEX_MAX, buildTreeIndexBlock, type TreeSessionLine, type TreeIndex } from './tree-index'
export { parseLanding, type RoomLanding } from './landing'

import type {
  RoomEvent,
  RoomPhase,
  RoomRuntime,
  RoomRuntimeDeps,
  RoomRuntimeState
} from './runtime-types'

// 运行时公共类型已拆出；此处再导出保兼容（消费方 import 路径不变）。
export type {
  RoomEvent,
  RoomPhase,
  RoomRuntime,
  RoomRuntimeDeps,
  RoomRuntimeState,
  RoomTimers
} from './runtime-types'

const EVENT_RING_MAX = 50

/**
 * JS `setTimeout` 的 32 位毫秒上限（2^31-1 ≈ 24.8 天）。
 * 这是**引擎技术限制**，不是产品上限：AI 声明的待机总时长可以更长，运行时按这个上限
 * 分片续排，累计到 `standbyUntil` 才真正到期。
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * ECMAScript `Date` 能表示的最大时间戳（8.64e15，约公元 275760 年）。
 * 同样不是产品上限：AI 声明的待机时长若把 `standbyUntil` 推到这之后，时间戳/界面格式化
 * 都会失去意义；运行时把「到期时刻」夹到这里，并据此计算可等待的毫秒数。
 */
const MAX_DATE_MS = 8.64e15


// 规划提示词的实现已拆到 `./plan-prompt`（0.53.5 体量红线）；此处再导出保兼容，
// 消费方（runtime 内部 / 测试 / bootstrap）的 import 路径保持不变。
export { buildPlanPrompt }

export function createRoomRuntime(deps: RoomRuntimeDeps): RoomRuntime {
  const now = deps.now ?? (() => Date.now())
  const events: RoomEvent[] = []
  let phase: RoomPhase = 'stopped'
  let standbyUntil: number | undefined
  let lastTick: LoopTickResult | undefined
  let lastPlan: PlanDecision | undefined
  let stopFn: (() => void) | null = null
  let clearStandbyTimer: (() => void) | null = null
  let avatarRev = 0
  /** 当前采集视图（AI 声明；未声明 = 默认全字段，行为与改造前一致） */
  let collectorView: CollectorView = defaultCollectorView()
  /**
   * 感知策略（AI 自己配置，0.53.3）：启动时从本房间的持久化恢复；
   * 读不到 / 非法 → 默认（全部信号都看）。AI 每轮都可用 `sensor` 字段局部更新。
   */
  let sensorPolicy: RoomSensorPolicy = { ...DEFAULT_SENSOR_POLICY, mute: [] }
  if (deps.loadSensorPolicy) {
    try {
      const loaded = deps.loadSensorPolicy()
      // **文件不存在 ≠ 恢复失败**（0.53.4 修复）：`SensorPolicyStore.load` 对「还没配过」
      // 返回 undefined。此前直接丢给解析器，于是每次首次启动都会打一条「sensor 必须是对象」，
      // 把「默认策略」误报成损坏。只有真读到东西才校验。
      if (loaded != null) {
        const parsed = parseSensorPolicyPatch(loaded)
        if (parsed.ok) sensorPolicy = applySensorPolicy(DEFAULT_SENSOR_POLICY, parsed.patch)
        else console.error('[room] 感知策略恢复失败:', parsed.error)
      }
    } catch (err) {
      console.error('[room] 感知策略读取失败:', (err as Error).message)
    }
  }
  /**
   * 承载会话（0.53.18）：**在哪个会话窗口开启自主，就用哪个会话已有的逆生树**。
   * 不再有「房间自持树」这一路——规划轮、树索引、落点全部作用在它身上，与普通对话同一棵树。
   * **房间配置**（采集视图、形象、ARM 状态）仍挂在 (uid, aiId) 上：换会话不动，换 AI 才是另一个房间。
   */
  let hostSessionId: string | null = null
  /** 当前落点（AI 主动声明，ADR-30）；未声明过 = 沿用 `session_select` 侧的承接指针 */
  let landing: { internalId: string } | undefined
  /** AI 直接声明的房间动作（直播里「去哪 / 做什么」） */
  let scene: RoomSceneDirective | undefined
  /** AI 最近一次回应（直播字幕 + 落回会话历史） */
  let lastReply: string | undefined
  let lastReplyAt: number | undefined
  /** 最近一次唤醒（谁 + 原因）与最近一次采集（它看到了什么） */
  let lastWake: { source: WakeSource; detail?: string; at: number } | undefined
  let lastCollect: { text: string; at: number } | undefined
  /**
   * 本轮 tick 期间到达的唤醒（`running` 时不能打断，但**不能丢**）。
   * 驱动退出（park）时若仍有它，就再激活一轮——与用户消息同一范式。
   */
  let pendingWake: { source: WakeSource; detail?: string } | null = null
  /** 下一次规划提示词要带的「你为什么醒」（消费一次即清） */
  let wakeForPlan: { source: WakeSource; detail?: string } | null = null
  /**
   * AI 在 plan 里声明的待机：**本轮 tick 完整结束后**才应用。
   * 为什么不能当场 `standby()`：plan 回调执行时 execute 还没跑完，提前把 `phase` 改成
   * `standby`、把 `stopFn` 置空，会让感知器/用户消息在 tick 在飞时再起一条驱动
   * （两条链路并发采集/执行）。先记下来，`onResult` / 手动 tick 收尾时统一应用。
   */
  let pendingStandbyMs: number | null = null
  /**
   * 本轮 tick 生效的前置规划指令（两段式第一段产出）。
   * plan 回调里设置，tick 收尾（onResult / 手动 tick 两处）写入前置规划历史环后清零；
   * null = 本轮没有前置规划参与——历史环只记「前置规划真的给了方向」的轮次。
   */
  let preplanInstructionForTick: string | null = null
  /** 手动 tick 单飞：一轮未结束时不允许第二条链路并发采集/规划 */
  let ticking = false
  /**
   * 「谁在这轮 tick 期间把房间重新 arm 了」的代号（0.53.5）。
   * 手动 tick 从 `stopped` 发起时，收尾要回到 stopped；但如果用户在 tick 在飞时点了
   * 「开启自主」（或事件唤醒 / 用户消息触发 `activate`），收尾就**不能再按回 stopped**——
   * 否则会出现「驱动在跑、状态却显示已停止」。用单调代号判定，比看 `stopFn` 可靠：
   * 新驱动可能已经 park（stopFn 被 `onDriveEnd` 清空），但用户的开启意图仍然有效。
   */
  let armEpoch = 0
  /**
   * 感知器（0.53.1）：驱动 park 后在 idle / standby 里按 AI 策略采样，只在环境变化时上报 `collector`。
   * **不调用模型**；`running` / `stopped` 停（见 `syncSensor`）；AI 可用 `sensor.enabled=false` 关掉。
   */
  let sensor: RoomSensor | null = null
  let sensing = false
  /**
   * 用户在房间视图里发的消息（待下一轮消费）。
   * 与采集器**并列**：采集未授权 / 未开启时，用户的话仍然要到达 AI。
   */
  const pendingUserMessages: string[] = []
  const MAX_PENDING_USER_MESSAGES = 8
  const consumeUserInput = (): string | null => {
    if (pendingUserMessages.length === 0) return null
    const text = pendingUserMessages.splice(0).join('\n')
    return text.slice(0, 4000)
  }
  const hasPendingInput = (): boolean => pendingUserMessages.length > 0
  /**
   * 取**承载会话**的树索引（ADR-30 / 0.53.18）：只有这一棵。
   * 未绑定承载会话 → null（不注入；**绝不回落到房间自持会话**，否则又会长出旧房间树）。
   */
  const collectTreeIndex = (): TreeIndex | null => {
    if (!deps.listTreeSessions || !hostSessionId) return null
    return deps.listTreeSessions(hostSessionId)
  }

  /**
   * 当前状态（**单一构造点**）：推送与 IPC 读取共用同一形状，避免两处各拼一份而漂移。
   */
  const getState = (): RoomRuntimeState => {
    // 规划者徽标与历史条数同源：实时读路由——配置即时生效，UI 不显示过期身份
    const route = deps.plannerRoute?.() ?? ({ kind: 'self' } as const)
    return {
      running: phase !== 'stopped',
      phase,
      ...(hostSessionId ? { hostSessionId } : {}),
      ...(standbyUntil != null ? { standbyUntil } : {}),
      ...(lastTick ? { lastTick } : {}),
      ...(lastPlan ? { lastPlan } : {}),
      events: [...events],
      avatarRev,
      collectorView,
      // 返回副本：状态会被推送 / 序列化给渲染侧，任何消费者都不应能改到运行时的策略对象
      sensorPolicy: {
        ...sensorPolicy,
        mute: [...sensorPolicy.mute],
        ...(sensorPolicy.thresholds ? { thresholds: { ...sensorPolicy.thresholds } } : {})
      },
      ...(landing ? { landing } : {}),
      ...(scene ? { scene } : {}),
      ...(lastReply ? { lastReply } : {}),
      ...(lastReplyAt != null ? { lastReplyAt } : {}),
      // `sensing` 对用户要诚实：被闸门拦下时感知器仍在排期，但**看不到任何东西**——
      // 界面不能显示「感知中」，否则「未感知原因」提示永远不可达（0.53.1 评审 P1）。
      sensing: sensing && deps.senseAllowed?.() !== false,
      ...(lastWake ? { lastWake } : {}),
      ...(lastCollect ? { lastCollect } : {}),
      planner: { kind: route.kind },
      // 前置规划历史条数随快照下发（界面免开 IPC）；仅 preplan 路由读这一次——self 模式零额外读盘
      ...(route.kind === 'preplan' ? { preplanHistoryCount: deps.loadPreplanHistory?.().length ?? 0 } : {})
    }
  }

  /** 状态变了就推（安静期零开销）；推送失败不阻断循环，但必须留痕。 */
  const notify = (): void => {
    try {
      deps.onStateChange?.(getState())
    } catch (err) {
      console.error('[room] 状态推送失败:', (err as Error).message)
    }
  }

  /** 事件入环（带裁剪）。提成函数是因为「重画形象」也要进事件流（不只 loop 的相位事件）。 */
  const pushEvent = (ev: RoomEvent): void => {
    events.push(ev)
    if (events.length > EVENT_RING_MAX) events.splice(0, events.length - EVENT_RING_MAX)
    try {
      deps.onEvent?.(ev)
    } catch (err) {
      // 不静默：落盘失败要看得见（不阻断循环，但绝不装作没发生）
      console.error('[room] 事件落盘失败:', (err as Error).message)
    }
    notify()
  }

  /**
   * 感知器（0.53.1）：只在「驱动已 park 且相位为 idle」时运行。
   * 为什么放在这里而不是渲染进程：唤醒必须走主进程单 owner（`./wake`），渲染进程只表达「用户来了」。
   * 采样本身**不调用模型**；`standby`（AI 主动说别吵）与 `running`（正在采集）都不采样。
   */
  const ensureSensor = (): RoomSensor | null => {
    if (!deps.sense) return null
    if (!sensor) {
      sensor = createRoomSensor({
        sample: async () =>
          deps.senseAllowed?.() === false ? null : deps.sense!(collectorView, sensorPolicy),
        // 上报走仲裁器（生产注入 `reportRoomWake`）；缺省直接唤醒（单测 / 未装配兜底）。
        // **把接受/拒绝原样返回**：被去抖拦下时感知器保留基线，下一次重试。
        onChange: (reasons) => {
          const detail = reasons.join('；')
          if (deps.reportWake) return deps.reportWake('collector', detail) !== false
          wake('collector', detail)
          return true
        },
        ...(deps.timers ? { timers: deps.timers } : {}),
        // AI 的初始策略：enabled / mute / 间隔 / 阈值。运行时后续用 configure 更新。
        enabled: sensorPolicy.enabled,
        muted: sensorPolicy.mute,
        ...(sensorPolicy.intervalMs != null ? { intervalMs: sensorPolicy.intervalMs } : {}),
        ...(sensorPolicy.thresholds ? { thresholds: sensorPolicy.thresholds } : {}),
        onError: (err) => console.error('[room] 感知采样失败:', err.message)
      })
    }
    return sensor
  }

  /**
   * 让感知器的开关与相位一致（幂等；只在真的变了时推状态）。
   *
   * **`standby` 也要感知**（用户 2026-10-20 纠正）：待机是 AI 说「先别主动做事」，
   * 不是「把眼睛闭上」——采集器仍应感知事件，真的有事时把 AI 叫醒；
   * `standbyMs` 只是「最迟多久后主动醒一次」的兜底。
   * 只有 `running`（正在采集）与 `stopped`（用户关停）不采样。
   */
  const syncSensor = (): void => {
    const sensingPhase = phase === 'idle' || phase === 'standby'
    // AI 可以完全关掉感知（sensor.enabled=false）：此时只剩待机到期这一条兜底。
    const shouldSense = sensingPhase && sensorPolicy.enabled && stopFn == null && deps.sense != null
    if (shouldSense === sensing) return
    if (shouldSense) ensureSensor()?.start()
    else sensor?.stop()
    sensing = shouldSense
    notify()
  }

  /**
   * 前置规划历史环落笔：一轮 tick 收尾时把「指令 + 执行结果摘要」写入滚动环。
   * 两条收尾路径（驱动 `onResult` / 手动 `tick` 的 try 块）共用——手动 tick 不走 onResult，
   * 只挂一处会让手动触发的轮次在历史里凭空消失。
   */
  const recordPreplanTick = (r: LoopTickResult): void => {
    if (preplanInstructionForTick == null) return
    const instruction = preplanInstructionForTick
    preplanInstructionForTick = null
    recordPreplanTickToHistory(deps, instruction, r, lastPlan?.decisions, now)
  }

  const loop: AutonomousLoop = createAutonomousLoop({
    // 每轮读**当时**的采集视图（AI 可能在上一轮改了它）；
    // 顺手记下「它看到了什么」（截断），界面「感知」页与排障都靠这句
    collect: async () => {
      const r = await deps.collect(collectorView)
      if (r.ok && r.text) lastCollect = { text: r.text.slice(0, 400), at: now() }
      return r
    },
    consumeUserInput,
    hasPendingInput,
    // 关停守卫：stop() 只 disarm，不中断在飞的 plan/execute；驱动在关键点自检
    isStopped: () => phase === 'stopped',
    // **不再接线 `recall`**（ADR-30）：原先它只在「长线」轮注入一份「最近内部会话摘要」，
    // 那是「宿主替 AI 列全部」。现在**承载会话的树索引每轮都注入**（见 `buildPlanPrompt` 的
    // 【会话树】段），候选清单与「长线先召回内部会话」的诉求一并被覆盖；
    // 记忆系统那一跳本就由 AI 在 plan 里用自己的记忆工具完成（ADR-20）。
    // `loop.ts` 的 `recall` 保留为可选扩展点（其契约与单测不变）。
    plan: async ({ text, mode, repeat }) => {
      // 规划者路由（前置规划功能）：每轮实时读，配置即时生效。
      const route = deps.plannerRoute?.() ?? { kind: 'self' as const }
      // 没有承载会话 = 自主模式还没在任何一个会话里开启（0.53.18：不再有房间自持会话兜底）。
      // 不调 LLM：没有树可继承时规划出来的落点无处落地，调了只会长出一棵没人要的旧房间树。
      // 前置规划轮同理跳过：主AI都不会动，给方向没有意义。
      if (!hostSessionId) {
        const unbound: PlanDecision = {
          decisions: [],
          note: '未绑定会话：自主模式需在某个会话里开启（继承该会话的逆生树）'
        }
        lastPlan = unbound
        return unbound
      }
      // 两段式第一段（前置规划轮）：前置规划看**同一轮采集输入**给出方向性指令。
      // 失败/未接线 = 本轮无指令、回落主AI自规划——前置规划的故障不许弄停主AI（不传播 llmFailed）。
      const preplanInstruction =
        route.kind === 'preplan' ? await runPreplanTurn(deps, text, pushEvent, now) : null
      preplanInstructionForTick = preplanInstruction
      // 唤醒原因只喂**这一轮**（消费一次即清），不然后续轮次会一直以为自己是刚被叫醒的
      const wake = wakeForPlan
      wakeForPlan = null
      const prompt = buildPlanPrompt({
        text,
        mode,
        tree: collectTreeIndex(),
        allowedTools: deps.allowedTools(),
        sensorPolicy,
        ...(wake ? { wake } : {}),
        ...(repeat ? { repeat } : {}),
        ...(preplanInstruction ? { preplanInstruction } : {})
      })
      let reply: string | null = null
      try {
        reply = await deps.plan(prompt, hostSessionId)
      } catch (err) {
        // **不吞成「LLM 未回复」**——那是误诊（用户裁决：报错比兜底好）。
        // 规划链路故障（含上下文解析抛错）要如实上报并停循环，而不是静默降级。
        const failed: PlanDecision = {
          decisions: [],
          note: `规划调用失败：${(err as Error).message}`,
          llmFailed: true
        }
        lastPlan = failed
        return failed
      }
      // 用户可能在 await plan 期间关停：先判相位，不把 reply/scene/sensor/execute 继续落下去
      if (phase === 'stopped') {
        const stopped: PlanDecision = { decisions: [], note: '房间已停止，丢弃本轮计划' }
        lastPlan = stopped
        return stopped
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
        ...(parsed.dropped.length > 0 ? { note: `${parsed.note ?? ''}（丢弃 ${parsed.dropped.length} 个动作）`.trim() } : {}),
        ...(parsed.reply ? { reply: parsed.reply } : {}),
        ...(parsed.scene ? { scene: parsed.scene } : {}),
        ...(parsed.repeat ? { repeat: parsed.repeat } : {})
      }
      lastPlan = decision
      // 对用户/镜头说的话：进输出流 + 直播字幕；渲染侧按 `lastReplyAt` 幂等落回会话历史
      if (parsed.reply) {
        lastReply = parsed.reply
        lastReplyAt = now()
        pushEvent({ phase: 'plan', ts: now(), detail: `回复：${parsed.reply}` })
      }
      // AI 直接控制小人：去哪 / 做什么（渲染侧的 actorIntent 以它优先）
      if (parsed.scene) {
        scene = parsed.scene
        pushEvent({
          phase: 'plan',
          ts: now(),
          detail: `镜头：${ROOM_SCENE_ACTION_LABEL[parsed.scene.action]}${parsed.scene.say ? ` · ${parsed.scene.say}` : ''}`
        })
      }
      // AI 主动声明待机：先记下，等本轮 tick 收尾再应用（避免 tick 在飞时改相位）
      if (typeof parsed.standbyMs === 'number' && parsed.standbyMs > 0) {
        decision.standbyMs = parsed.standbyMs
        pendingStandbyMs = parsed.standbyMs
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
      // AI 控制感知器（0.53.3）：屏蔽信号 / 改阈值或间隔 / 完全关闭。
      // 校验在共享解析层；非法策略整条拒绝并留痕，旧策略继续生效（不把房间弄瞎）。
      if (parsed.sensor !== undefined) {
        const p = parseSensorPolicyPatch(parsed.sensor)
        if (!p.ok) {
          pushEvent({ phase: 'plan', ts: now(), detail: `感知策略未更新：${p.error}` })
        } else {
          sensorPolicy = applySensorPolicy(sensorPolicy, p.patch)
          sensor?.configure(sensorPolicy)
          try {
            deps.saveSensorPolicy?.(sensorPolicy)
          } catch (err) {
            console.error('[room] 感知策略保存失败:', (err as Error).message)
            pushEvent({ phase: 'plan', ts: now(), detail: `感知策略已生效，但保存失败：${(err as Error).message}` })
          }
          pushEvent({ phase: 'plan', ts: now(), detail: `感知策略：${describeSensorPolicy(sensorPolicy)}` })
          // enabled 变化要立刻体现在排期上；mute/阈值变化下一次采样即生效
          syncSensor()
        }
      }
      // AI 主动落点（ADR-30）：在**承载会话的逆生树**里承接节点 / 开新线（0.53.18 起只有这一棵）。
      // 形状非法 = 丢弃留痕；语义非法由 applyLanding 回传原因。
      if (parsed.landing !== undefined) {
        const l = parseLanding(parsed.landing)
        if (!l) {
          pushEvent({ phase: 'plan', ts: now(), detail: '落点未更新：形状非法（需要 action=continue|create）' })
        } else {
          const r = await deps.applyLanding?.(hostSessionId, l)
          if (r?.ok && r.internalId) {
            landing = { internalId: r.internalId }
            pushEvent({
              phase: 'plan',
              ts: now(),
              detail: `落点：会话树 → ${l.action === 'create' ? '新线' : '承接'} ${r.internalId}`
            })
          } else {
            pushEvent({ phase: 'plan', ts: now(), detail: `落点未更新：${r?.error ?? '未接线'}` })
          }
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
      notify()
    },
    onResult: (r) => {
      lastTick = r
      recordPreplanTick(r)
      // LLM 未回复 = AI 出了问题：停驱动 + 回 stopped（不再空转），状态里留痕供 UI 显示
      if (r.llmFailed) {
        stopFn?.()
        stopFn = null
        clearStandby()
        pendingWake = null
        wakeForPlan = null
        pendingStandbyMs = null
        phase = 'stopped'
      } else if (pendingStandbyMs != null) {
        // 本轮完整结束后才进入待机：execute 已经跑完，不会再出现「tick 在飞 + 新驱动」的并发
        const ms = pendingStandbyMs
        pendingStandbyMs = null
        standby(ms)
      }
      notify()
    },
    /**
     * 驱动退出（park / 停止 / llmFailed）时清掉 `stopFn`。
     * 不清就会「park 之后 activate 永远早退」——用户消息与 wake 都无法重新拉起房间。
     * 若退出时还有待处理用户消息（例如消息在 tick 收尾时才到），立刻再激活一轮。
     */
    onDriveEnd: () => {
      stopFn = null
      // 唤醒原因只服务「被唤醒的那一轮」；驱动退出即失效，避免下一轮误以为自己是刚被叫醒的
      wakeForPlan = null
      if (pendingUserMessages.length > 0 && phase !== 'stopped') {
        // 用户消息这一轮本身就会完整采集，暂存的唤醒无需再补一轮
        pendingWake = null
        // 待机中收到消息 = 用户介入：结束待机（与 onUserMessage 同口径）
        if (phase === 'standby') clearStandby()
        activate()
        return
      }
      // 跑本轮期间到达的唤醒不能丢：park 后补跑一轮（多源合并，最多多一次 collect）
      if (pendingWake && (phase === 'idle' || phase === 'standby')) {
        const w = pendingWake
        pendingWake = null
        if (phase === 'standby') clearStandby()
        pushEvent({
          phase: 'idle',
          ts: now(),
          detail: `补发唤醒（${w.source} / ${WAKE_SOURCE_LABEL[w.source]}）${w.detail ? `：${w.detail}` : ''}`
        })
        activate()
        return
      }
      // **AI 静默后由采集器接管**（0.53.1）：驱动一 park，感知器就开始睁眼等变化
      syncSensor()
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
    // 记一次「重新 arm」：手动 tick 收尾据此判断是否还能按回 stopped
    armEpoch += 1
    phase = 'idle'
    stopFn = loop.start()
    // 相位变了就要推：待机到期（`onExpire` → 本函数）不是事件，没有 pushEvent 兜底，
    // 少这一推界面会停在「待机中」直到下一轮事件——那正是轮询在补的洞。
    notify()
    // 正在跑（或即将跑）就不需要感知器：这一轮自己会采集
    syncSensor()
  }

  const start = (): void => {
    clearStandby()
    pendingWake = null
    wakeForPlan = null
    pendingStandbyMs = null
    pushEvent({ phase: 'idle', ts: now(), detail: '自主开启' })
    activate()
  }

  const stop = (): void => {
    stopFn?.()
    stopFn = null
    clearStandby()
    pendingWake = null
    wakeForPlan = null
    pendingStandbyMs = null
    phase = 'stopped'
    pushEvent({ phase: 'idle', ts: now(), detail: '自主关闭' })
    syncSensor()
  }

  const standby = (ms: number): void => {
    // 用户已关停：待机不得把房间重新 arm（stop() 后仍在飞的 plan 会走到这里）
    if (phase === 'stopped') return
    // AI 自己决定待机多久：**不设产品上限**，只要求正有限数。
    if (!Number.isFinite(ms) || ms <= 0) return
    // 到期时刻受 ECMAScript Date 可表示范围约束（技术限制，不是产品规则）
    const until = Math.min(now() + Math.floor(ms), MAX_DATE_MS)
    const wait = Math.max(1, until - now())
    // 先 park 驱动（不再主动做事），到期再回到 idle 并重新激活
    stopFn?.()
    stopFn = null
    clearStandbyTimer?.()
    standbyUntil = until
    phase = 'standby'
    // 待机 ≠ 闭眼：驱动 park，但感知器继续看（除非 AI 用 sensor.enabled=false 关掉）；事件可提前唤醒
    syncSensor()
    const onExpire = (): void => {
      clearStandbyTimer = null
      standbyUntil = undefined
      if (phase === 'standby') activate()
    }
    /**
     * 分片续排：把剩余时长拆成不超过引擎上限的若干段。
     * 不用 `standbyUntil - now()` 计算剩余，是因为假时钟（单测）不会推进 `now`；
     * 用本地 `remaining` 累计更可测，也更直接表达「总时长 = 各段之和」。
     */
    let remaining = wait
    const arm = (): void => {
      const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS)
      const onChunk = (): void => {
        remaining -= chunk
        if (remaining > 0) {
          arm()
          return
        }
        onExpire()
      }
      if (deps.timers) {
        const handle = deps.timers.setTimeout(onChunk, chunk, 'room-standby')
        clearStandbyTimer = () => deps.timers?.clearTimeout(handle)
      } else {
        const handle = setTimeout(onChunk, chunk)
        if (typeof handle.unref === 'function') handle.unref()
        clearStandbyTimer = () => clearTimeout(handle)
      }
    }
    arm()
  }

  /**
   * 事件唤醒（由 `./wake` 的仲裁器调用）：用户到达 / 监控命中 / 感知到变化 → 让房间重新感知一次。
   * 语义见接口注释：`stopped` 忽略（**不自动拉起已关停的房间**）；
   * `running` **不打断但会暂存**（`pendingWake`），本轮 park 后补跑一轮——事件不能被黑洞吞掉。
   */
  const wake = (reason: WakeSource, detail?: string): void => {
    if (phase === 'stopped') return
    if (phase === 'running') {
      pendingWake = { source: reason, ...(detail ? { detail } : {}) }
      return
    }
    pendingWake = null
    clearStandby()
    lastWake = { source: reason, at: now(), ...(detail ? { detail } : {}) }
    // 下一轮规划要告诉 AI「你为什么醒」：否则它只看到一段新采集，分不清是变化还是上一轮的延续
    wakeForPlan = { source: reason, ...(detail ? { detail } : {}) }
    const label = WAKE_SOURCE_LABEL[reason]
    // 事件流同时带**机器可读的源**与**人可读的标签**：排障要 grep 源，用户要知道发生了什么
    pushEvent({ phase: 'idle', ts: now(), detail: `唤醒（${reason} / ${label}）${detail ? `：${detail}` : ''}` })
    activate()
  }

  const tick = async (): Promise<LoopTickResult> => {
    // 单飞：驱动正在跑 / 上一轮手动 tick 未结束时，不允许第二条链路并发采集与执行
    if (ticking || stopFn) {
      return { phase: 'idle', acted: false, executions: [], idleReason: 'busy' }
    }
    ticking = true
    // 手动「立即行动」= 用户/AI 主动介入：结束待机（否则 phase 与 standbyUntil 会并存）
    if (phase === 'standby') clearStandby()
    const wasStopped = phase === 'stopped'
    const epochAtStart = armEpoch
    // **这一轮在语义上必须是 running**，包括从 stopped 发起的一次性动作。
    // 否则 `plan` 回调里的关停守卫（`phase === 'stopped'`）会把「用户点了立即行动」
    // 误判成「房间已关停」，把整份计划连同 avatar / collectorView / landing 一起丢掉
    // （0.53.5 回归：15 个用例失败，全部是这条守卫的假阳性）。
    phase = 'running'
    notify()
    try {
      const r = await loop.tick()
      lastTick = r
      recordPreplanTick(r)
      if (r.llmFailed) {
        // 手动「立即行动」也走同一处置：LLM 出问题就停，不空转
        // （进入本函数时已保证没有驱动在跑，故不需要 stopFn）
        clearStandby()
        pendingWake = null
        wakeForPlan = null
        pendingStandbyMs = null
        phase = 'stopped'
      } else if (pendingStandbyMs != null) {
        const ms = pendingStandbyMs
        pendingStandbyMs = null
        // 从 stopped 发起的一次性动作**不 arm 待机**：用户并没有开启自主模式，
        // 一次「立即行动」不该让房间在后台自己醒来。
        if (!wasStopped) standby(ms)
      }
      return r
    } finally {
      ticking = false
      if (wasStopped && armEpoch === epochAtStart && !stopFn) {
        // 一次性动作结束仍回到 stopped（若中途 stop() 已是 stopped 则保持），
        // 并清掉本轮可能排上的待机定时器与暂存唤醒（stopped 的语义是「别自己动」）。
        // **若期间有人重新 arm**（armEpoch 变了：开启自主 / 唤醒 / 用户消息），则保持新状态。
        if (phase !== 'stopped') phase = 'stopped'
        clearStandby()
        pendingWake = null
      } else if (phase === 'running' && !stopFn) {
        // 手动 tick 结束：没有驱动接手时回到 idle（待机 / 停止不覆盖）
        phase = 'idle'
      }
      notify()
      syncSensor()
    }
  }

  return {
    start,
    stop,
    standby,
    resetSensorPolicy: () => {
      sensorPolicy = { ...DEFAULT_SENSOR_POLICY, mute: [] }
      sensor?.configure(sensorPolicy)
      try {
        deps.saveSensorPolicy?.(sensorPolicy)
      } catch (err) {
        const message = (err as Error).message
        pushEvent({ phase: 'idle', ts: now(), detail: `感知策略已复位，但保存失败：${message}` })
        return { ok: false, error: message }
      }
      pushEvent({ phase: 'idle', ts: now(), detail: '感知策略已由用户复位为默认' })
      syncSensor()
      return {
        ok: true,
        policy: {
          ...sensorPolicy,
          mute: [...sensorPolicy.mute],
          ...(sensorPolicy.thresholds ? { thresholds: { ...sensorPolicy.thresholds } } : {})
        }
      }
    },
    wake,
    /**
     * 绑定承载会话（0.53.18）：**在哪个会话开启自主，就继承哪个会话的逆生树**。
     * 运行中不重新绑定——否则同一轮上下文会突然换树；换窗口必须先关停再开
     * （`room:start-loop` 在启动前显式绑定）。
     */
    setHostSession: (sid) => {
      if (phase !== 'stopped') return
      hostSessionId = sid
    },
    /**
     * 用户消息：第一类输入。`stopped` 不自动拉起（尊重开关），返回 false 让渲染侧退回普通会话；
     * 其余相位入队：idle/standby 立刻激活，running 由驱动在 tick 结束后检查 `hasPendingInput`。
     */
    onUserMessage: (content, hostSid) => {
      const text = content.trim().slice(0, 4000)
      if (!text) return { ok: false, error: '消息为空' }
      if (phase === 'stopped') return { ok: false, error: '房间未开启（自主模式未启动）' }
      // 兜底：启动路径忘了绑定时，用发消息的窗口补上；**已绑定则不动**（不静默换树）
      if (!hostSessionId && hostSid) hostSessionId = hostSid
      if (pendingUserMessages.length >= MAX_PENDING_USER_MESSAGES) pendingUserMessages.shift()
      pendingUserMessages.push(text)
      if (phase === 'standby') {
        clearStandby()
        activate()
      } else if (phase === 'idle' && !stopFn) {
        activate()
      }
      return { ok: true }
    },
    isRunning: () => phase !== 'stopped',
    tick,
    getState
  }
}

// ===== 运行时持有者（按 (uid, aiId) 分实例）=====
// 0.53.1 起物理拆到 `./runtime-registry`（`runtime.ts` 逼近 800 行硬红线）；此处**只做再导出**，
// 消费方（bootstrap / loop-supervisor / test）的 import 路径保持不变。
export {
  roomScopeKey,
  roomSessionId,
  setRoomRuntimeFactory,
  ensureRoomRuntime,
  setRoomRuntime,
  getRoomRuntime,
  peekRoomRuntime,
  listRoomRuntimeAiIds,
  stopRoomRuntimeForAi,
  stopAllRoomRuntimes,
  type RoomScope,
  type RoomRuntimeFactory
} from './runtime-registry'

// ===== 工具区步骤工具的可用集合（由组合根注入；缺省空 = 一切步骤被拒，安全默认）=====
let allowedToolsProvider: (() => readonly string[]) | null = null

export function setRoomAllowedTools(provider: (() => readonly string[]) | null): void {
  allowedToolsProvider = provider
}

export function getRoomAllowedTools(): readonly string[] {
  return allowedToolsProvider?.() ?? []
}
