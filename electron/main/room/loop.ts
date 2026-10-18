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
 */
import type { ExecutorDecision, ExecutorResult } from './executor'
import { extractTriageFeatures, suggestMode, type TriageMode } from './triage'

/** 规划产物：一组待执行决策 + 是否收束。 */
export interface PlanDecision {
  decisions: ExecutorDecision[]
  /** 本次是否已收束（无后续动作） */
  done?: boolean
  /** 规划说明（进可观测） */
  note?: string
  /** AI 声明的待机时长（毫秒）：期间采集器不返回；到期回到空闲并重新激活 */
  standbyMs?: number
  /** LLM 未回复（链路未就绪 / 空输出）→ 驱动据此**停止**循环 */
  llmFailed?: boolean
}

export type LoopPhase = 'collect' | 'triage' | 'recall' | 'plan' | 'execute' | 'idle'

/** 本轮 idle 的原因（驱动据此决定「继续」还是「park 等下一次激活」）。 */
export type IdleReason = 'no-input' | 'no-action' | 'standby'

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
  /** 长线模式：先查记忆系统、再查内部管理会话（B6 由调用方接既有记忆/内部会话能力） */
  recall?: (ctx: { text: string; mode: TriageMode }) => Promise<{ text: string; sources?: string[] }>
  /** 规划（AI 决策；返回待执行决策） */
  plan: (ctx: { text: string; mode: TriageMode; recalled?: string }) => Promise<PlanDecision | null>
  /** 执行（B5 执行器；自身过 t1.executor-high-risk 等） */
  execute: (decision: ExecutorDecision) => Promise<ExecutorResult>
  /** 覆盖分诊（用户裁决「AI 自判」——不给即用规则默认值） */
  triage?: (features: ReturnType<typeof extractTriageFeatures>) => { mode: TriageMode; reason: string }
  /** 轮次相位回调（runtime 据此维护 running/idle 状态；**不**用于驱动节奏） */
  onPhase?: (phase: 'running' | 'idle') => void
  /** 每轮结果回调（runtime 据此记录 lastTick / 处理 `llmFailed` 停机） */
  onResult?: (result: LoopTickResult) => void
  onEvent?: (ev: LoopEvent) => void
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

  const tick = async (): Promise<LoopTickResult> => {
    const executions: ExecutorResult[] = []

    emit({ phase: 'collect' })
    const collected = await deps.collect()
    if (!collected.ok || !collected.text) {
      emit({ phase: 'idle', detail: collected.error ?? '无采集输入' })
      return {
        phase: 'idle',
        acted: false,
        executions,
        idleReason: 'no-input',
        ...(collected.error ? { error: collected.error } : {})
      }
    }

    emit({ phase: 'triage' })
    const features = extractTriageFeatures(collected.text, { recentLongTerm, hasOpenPlan: false })
    const triage = deps.triage ? deps.triage(features) : suggestMode(features)
    emit({ phase: 'triage', mode: triage.mode, detail: triage.reason })

    let recalled: string | undefined
    if (triage.mode === 'long-term' && deps.recall) {
      emit({ phase: 'recall', mode: triage.mode })
      const r = await deps.recall({ text: collected.text, mode: triage.mode })
      recalled = r.text
    }

    emit({ phase: 'plan', mode: triage.mode })
    const planned = await deps.plan({ text: collected.text, mode: triage.mode, recalled })
    recentLongTerm = triage.mode === 'long-term'

    // LLM 未回复 = AI 出了问题：立刻停（用户裁决：不要继续）
    if (planned?.llmFailed) {
      emit({ phase: 'idle', mode: triage.mode, detail: planned.note ?? 'LLM 未回复' })
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
      return {
        phase: 'idle',
        acted: false,
        mode: triage.mode,
        triageReason: triage.reason,
        executions,
        idleReason: 'no-action'
      }
    }

    emit({ phase: 'execute', mode: triage.mode, detail: `${planned.decisions.length} 个动作` })
    for (const d of planned.decisions) {
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
      while (alive) {
        deps.onPhase?.('running')
        const r = await tick()
        deps.onResult?.(r)
        deps.onPhase?.('idle')
        // LLM 未回复 → 停止（不再空转）；无输入 / 规划无动作 → park 等下一次激活
        if (r.llmFailed || r.phase !== 'execute') break
      }
    }
    void drive().catch(() => undefined)
    return () => {
      alive = false
    }
  }

  return { tick, start }
}
