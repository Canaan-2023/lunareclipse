/**
 * @category ROOM
 * @summary ROOM 自主循环：采集（感官）→ 分诊 → （长线先召回）→ 规划 → 执行 → 回传
 *
 * 为什么存在：交接单 §7 的 ROOM 记忆区链路是「采集数据 → 先查记忆系统 → 再查内部管理会话 →
 * 再规划执行」，且分诊规则为「短期的直接做，可以长期的再长思考」。本模块把这条链路做成
 * **可测的单步 tick**（而不是一个黑箱常驻循环）：每一步都是注入的依赖，因此可单测、可替换。
 *
 * 不删理由：删掉即自主模式没有编排层，各子系统（采集器 / 执行器 / 记忆）无法串成一条闭环。
 *
 * 边界：本模块**不含**任何权限判断——采集与执行各自在自己的入口过 `evaluatePolicy`
 * （ADR-16 / ADR-17）。循环只负责顺序与状态，避免权限判断散落两处。
 *
 * **驱动方式（2026-10-18 用户裁决，勿回退）**：采集器是 AI 的**感官**（像眼睛），
 * **不是定时器**。因此本模块**不使用任何 `setInterval`**：
 * - 每次「激活」= 采集一次 → 跑一轮；有实质动作才继续下一轮，否则 park 等下一次激活；
 * - 采集器在**运行中不返回**（正在处理时不需要再看），待机时也不返回（由 runtime 停驱动）；
 * - **LLM 未回复即停止**——那是 AI 出了问题，继续空转只会烧 token。
 * 待机到期是唯一允许的定时，且时长由 **AI 自己声明**（见 `runtime.standby`），不是系统轮询。
 *
 * **没有计数上限（2026-10-20 用户裁决）**：不再用「连续 3 次相同动作」「单次激活 12 轮」
 * 这类系统魔法。重复动作由 AI **显式声明** `repeat:'continue'` 才继续；否则转入空闲，
 * 把控制权交回环境/用户。循环能跑多久由 AI 的动作与判断决定，系统只保留语义刹车
 * （无输入 / 无动作 / LLM 失败 / AI 声明 stop）。
 */
import type { ExecutorDecision, ExecutorResult } from './executor'
import type { RoomSceneDirective } from '@shared/room/room-scene'
import { extractTriageFeatures, suggestMode, type TriageMode } from './triage'

/** 规划产物：一组待执行决策 + 是否收束。 */
export interface PlanDecision {
  decisions: ExecutorDecision[]
  /** 本次是否已收束（无后续动作） */
  done?: boolean
  /** 规划说明（进可观测） */
  note?: string
  /** AI 声明的待机时长（毫秒）：期间不主动做事；到期回到空闲并重新激活 */
  standbyMs?: number
  /** AI 对重复动作的自决：省略 = 重复即停；continue = 显式同意再做一次；stop = 主动收束 */
  repeat?: 'continue' | 'stop'
  /** LLM 未回复（链路未就绪 / 空输出）→ 驱动据此**停止**循环 */
  llmFailed?: boolean
  /** AI 对用户/镜头说的一句话（直播字幕） */
  reply?: string
  /** AI 直接声明的房间动作（去哪 / 做什么） */
  scene?: RoomSceneDirective
}

export type LoopPhase = 'collect' | 'triage' | 'recall' | 'plan' | 'execute' | 'idle'

/** 本轮 idle 的原因（驱动据此决定「继续」还是「park 等下一次激活」）。 */
export type IdleReason = 'no-input' | 'no-action' | 'standby' | 'repeat' | 'busy'

/**
 * 重复动作的上下文：**在规划之前**告诉 AI「你上一轮已经提出过同一个计划」。
 * 为什么不是计数刹车：用户 2026-10-20 裁决「不是三次这种魔法」——重复与否是
 * AI 的判断，系统只负责把事实摆到它面前；要继续就必须显式写 `repeat:'continue'`。
 */
export interface RepeatContext {
  /** 上一轮计划的签名（工具名 + 参数；用于 AI 自己比对，不暴露内部循环） */
  signature: string
  /** 已经连续出现多少次（从 1 开始；1 = 上一轮是第一次） */
  count: number
}

/**
 * 稳定序列化：对象键排序后再拼，避免 `{a:1,b:2}` 与 `{b:2,a:1}` 被当成不同计划。
 * 为什么必须稳定：重复判定若对键序敏感，AI 只要换个参数顺序就能绕过「显式 continue」，
 * 系统说的「已连续 N 次」也会与真实重复动作不一致。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** 计划签名（工具名 + 参数，键序无关）。导出以便单测直接锁住语义。 */
export function planSignature(
  decisions: ReadonlyArray<{ toolName?: string; params?: Record<string, unknown> }>
): string {
  return stableStringify(decisions.map((d) => [d.toolName ?? '', d.params ?? {}]))
}

export interface LoopEvent {
  phase: LoopPhase
  ts: number
  detail?: string
  mode?: TriageMode
}

export interface LoopTickResult {
  phase: LoopPhase
  /** 本轮是否有实质动作 */
  acted: boolean
  mode?: TriageMode
  /** 分诊理由（可观测） */
  triageReason?: string
  /** 执行结果（逐条） */
  executions: ExecutorResult[]
  error?: string
  /** idle 原因：'no-input' 采集器未返回（无新视觉 / 未开启 / 未授予） */
  idleReason?: IdleReason
  /** LLM 未回复 → 驱动停止循环（不再空转） */
  llmFailed?: boolean
}

export interface AutonomousLoopDeps {
  /** 采集本轮输入（B4 采集器；自身过 t1.collector）。**感官**：只在被激活时调用一次，不轮询 */
  collect: () => Promise<{ ok: boolean; text?: string; error?: string }>
  /**
   * 取走用户在房间视图里发的消息（**第一类输入**，与采集器并列）。
   * 为什么独立：采集器未授权 / 未开启时，用户的消息仍然必须到达 AI；
   * 不能因为「感官闭眼」就连用户说的话也听不到。
   */
  consumeUserInput?: () => string | null
  /** 是否还有未消费的用户消息（驱动据此在「本轮无动作」时继续跑一轮，而不是 park） */
  hasPendingInput?: () => boolean
  /** 长线模式：先查记忆系统、再查内部管理会话（B6 由调用方接既有记忆/内部会话能力） */
  recall?: (ctx: { text: string; mode: TriageMode }) => Promise<{ text: string; sources?: string[] }>
  /** 规划（AI 决策；返回待执行决策）。`repeat` 仅在检测到连续相同计划时提供。 */
  plan: (ctx: {
    text: string
    mode: TriageMode
    recalled?: string
    repeat?: RepeatContext
  }) => Promise<PlanDecision | null>
  /** 执行（B5 执行器；自身过 t1.executor-high-risk 等） */
  execute: (decision: ExecutorDecision) => Promise<ExecutorResult>
  /** 覆盖分诊（用户裁决「AI 自判」——不给即用规则默认值） */
  triage?: (features: ReturnType<typeof extractTriageFeatures>) => { mode: TriageMode; reason: string }
  /**
   * 房间是否已被用户关停（可选）。驱动在**规划返回后**与**每条执行前**检查：
   * `stop()` 只能 disarm 循环，不能中断在飞的 `plan`/`execute`；没有这道检查，
   * 关停后仍会把计划里的工具跑完（幽灵副作用）。
   */
  isStopped?: () => boolean
  /** 轮次相位回调（runtime 据此维护 running/idle 状态；**不**用于驱动节奏） */
  onPhase?: (phase: 'running' | 'idle') => void
  /** 每轮结果回调（runtime 据此记录 lastTick / 处理 `llmFailed` 停机） */
  onResult?: (result: LoopTickResult) => void
  onEvent?: (ev: LoopEvent) => void
  /**
   * 驱动**已退出**（park / 停止 / llmFailed）时回调。
   * 为什么必须有：`start()` 返回的 stop 函数在 drive 内部 break 后仍然非空，
   * 若 runtime 只把它当作「驱动仍在跑」的标记，`activate()` 会永远早退——
   * 表现就是「park 之后用户再发消息 / 再唤醒，房间再也不动」。
   */
  onDriveEnd?: () => void
  now?: () => number
}

export interface AutonomousLoop {
  /** 单步：跑完一轮链路并返回结构化结果（可单测） */
  tick: () => Promise<LoopTickResult>
  /**
   * 条件驱动启动（**无定时器**）：每调用一次 = 一次「激活」。
   * 内部循环：跑一轮 → 有实质动作则继续下一轮（AI 空闲即再采集一次），
   * 否则 park（无输入 / 规划无动作）；`llmFailed` 则**立即停止**。
   * 返回停止函数（disarm）。
   */
  start: () => () => void
}

export function createAutonomousLoop(deps: AutonomousLoopDeps): AutonomousLoop {
  const now = deps.now ?? (() => Date.now())
  const emit = (ev: Omit<LoopEvent, 'ts'>): void => {
    deps.onEvent?.({ ...ev, ts: now() })
  }

  let recentLongTerm = false
  /**
   * 上一轮计划的签名与连续次数（**永不重置于 start**）：
   * 重复刹车不再按次数，而是「同签名必须显式声明 continue」。
   * 保留跨激活的状态，AI 被重新唤醒后仍有机会看到「你上一轮已经提过同一动作」并决定是否继续。
   */
  let lastSignature = ''
  let samePlanCount = 0

  const tick = async (): Promise<LoopTickResult> => {
    const executions: ExecutorResult[] = []

    emit({ phase: 'collect' })
    const userText = (deps.consumeUserInput?.() ?? '').trim()
    if (userText) emit({ phase: 'collect', detail: '收到你的消息' })
    const collected = await deps.collect()
    const chunks: string[] = []
    if (userText) chunks.push(`【用户刚说的话】\n${userText}`)
    if (collected.ok && collected.text) chunks.push(collected.text)
    const text = chunks.join('\n\n').trim()
    if (!text) {
      emit({ phase: 'idle', detail: collected.error ?? '无采集输入' })
      return {
        phase: 'idle',
        acted: false,
        executions,
        idleReason: 'no-input',
        ...(collected.error ? { error: collected.error } : {})
      }
    }
    // 采集失败但用户说了话：错误仍要看得见，但本轮继续（AI 要回应用户）
    if (!collected.ok && collected.error) {
      emit({ phase: 'collect', detail: `采集未完成：${collected.error}` })
    }

    emit({ phase: 'triage' })
    const features = extractTriageFeatures(text, { recentLongTerm, hasOpenPlan: false })
    const triage = deps.triage ? deps.triage(features) : suggestMode(features)
    emit({ phase: 'triage', mode: triage.mode, detail: triage.reason })

    let recalled: string | undefined
    if (triage.mode === 'long-term' && deps.recall) {
      emit({ phase: 'recall', mode: triage.mode })
      const r = await deps.recall({ text, mode: triage.mode })
      recalled = r.text
    }

    emit({ phase: 'plan', mode: triage.mode })
    const planned = await deps.plan({
      text,
      mode: triage.mode,
      ...(recalled ? { recalled } : {}),
      ...(samePlanCount > 0 ? { repeat: { signature: lastSignature, count: samePlanCount } } : {})
    })
    recentLongTerm = triage.mode === 'long-term'

    // 用户可能在 await plan 期间关停：计划返回后先判相位，避免把副作用继续落下去
    if (deps.isStopped?.()) {
      emit({ phase: 'idle', mode: triage.mode, detail: '房间已停止，丢弃本轮计划' })
      lastSignature = ''
      samePlanCount = 0
      return {
        phase: 'idle',
        acted: false,
        mode: triage.mode,
        triageReason: triage.reason,
        executions,
        idleReason: 'no-action'
      }
    }

    // LLM 未回复 = AI 出了问题：立刻停（用户裁决：不要继续）
    if (planned?.llmFailed) {
      emit({ phase: 'idle', mode: triage.mode, detail: planned.note ?? 'LLM 未回复' })
      lastSignature = ''
      samePlanCount = 0
      return {
        phase: 'idle',
        acted: false,
        mode: triage.mode,
        triageReason: triage.reason,
        executions,
        llmFailed: true,
        error: planned.note ?? 'LLM 未回复'
      }
    }

    if (!planned || planned.decisions.length === 0) {
      emit({ phase: 'idle', mode: triage.mode, detail: planned?.note ?? '规划无动作' })
      // 无动作 = 一段连续执行结束：重复上下文归零（下一次被唤醒是新的开始）
      lastSignature = ''
      samePlanCount = 0
      return {
        phase: 'idle',
        acted: false,
        mode: triage.mode,
        triageReason: triage.reason,
        executions,
        idleReason: 'no-action'
      }
    }

    // AI 显式收束：不执行这批动作，转入空闲（这是它自己的判断，不是系统刹车）
    if (planned.repeat === 'stop') {
      emit({ phase: 'idle', mode: triage.mode, detail: planned.note ?? 'AI 声明结束这一段' })
      lastSignature = ''
      samePlanCount = 0
      return {
        phase: 'idle',
        acted: false,
        mode: triage.mode,
        triageReason: triage.reason,
        executions,
        idleReason: 'no-action'
      }
    }

    // 相同计划：**不按次数刹车**。只有 AI 显式写 `repeat:'continue'` 才继续执行；
    // 否则把控制权交回环境/用户（感知器会在真的变化时再叫醒它）。
    const signature = planSignature(planned.decisions)
    if (signature === lastSignature) samePlanCount += 1
    else {
      lastSignature = signature
      samePlanCount = 1
    }
    if (samePlanCount > 1 && planned.repeat !== 'continue') {
      emit({
        phase: 'idle',
        mode: triage.mode,
        detail: `与上一轮相同的动作（第 ${samePlanCount} 次）；未声明 repeat=continue，转入空闲等待变化`
      })
      return {
        phase: 'idle',
        acted: false,
        mode: triage.mode,
        triageReason: triage.reason,
        executions,
        idleReason: 'repeat'
      }
    }

    emit({ phase: 'execute', mode: triage.mode, detail: `${planned.decisions.length} 个动作` })
    for (const d of planned.decisions) {
      // 关停后不再启动新的工具执行（已在飞的那一条无法中断，但不会有第二条）
      if (deps.isStopped?.()) break
      executions.push(await deps.execute(d))
    }
    return {
      phase: 'execute',
      acted: executions.some((e) => e.ok),
      mode: triage.mode,
      triageReason: triage.reason,
      executions
    }
  }

  const start = (): (() => void) => {
    let alive = true
    const drive = async (): Promise<void> => {
      try {
        while (alive) {
          deps.onPhase?.('running')
          const r = await tick()
          deps.onResult?.(r)
          deps.onPhase?.('idle')
          // LLM 未回复 → 停止（不再空转）；
          // 有实质动作才继续下一轮（**全部被拒 / 全部失败也算没进展**，不能每轮换个参数硬烧）；
          // 无输入 / 规划无动作 / 全部被拒 → park；但**有用户消息待处理**时继续跑一轮（不能把用户的话吞掉）。
          // 没有「单次激活最多几轮」——循环多久由 AI 的动作与 repeat 判断决定。
          if (r.llmFailed) break
          if (!r.acted && !deps.hasPendingInput?.()) break
          // 让出宏任务：collect/plan 同步 resolve 时，纯微任务链会饿住定时器与 IPC
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
      } catch (err) {
        /**
         * **未捕获异常不能静默**（0.53.5）：
         * 采集实现抛错 / 执行器抛错 / 宿主回调抛错以前会被 `drive().catch(() => undefined)` 吞掉，
         * 表现是「状态栏还显示 running，但房间再也不动」——一个看不见的幽灵驱动。
         * 这里如实落一条事件、把相位交回 idle，再走 `finally` 的 `onDriveEnd`（清 stopFn / 恢复感知）。
         */
        const message = err instanceof Error ? err.message : String(err)
        emit({ phase: 'idle', detail: `驱动异常退出：${message}` })
        deps.onPhase?.('idle')
        deps.onResult?.({ phase: 'idle', acted: false, executions: [], error: message })
      } finally {
        // 驱动已退出：runtime 据此清掉 stopFn，下一次 activate 才不会被早退挡掉
        deps.onDriveEnd?.()
      }
    }
    void drive().catch(() => undefined)
    return () => {
      alive = false
    }
  }

  return { tick, start }
}
