/**
 * 评测类型定义：评测子系统作为“能力验收 + 回归防护”的门禁，
 * 需要统一的任务/轨迹/评分数据模型供 Harness、评分器、前端 IPC 与测试共用，
 * 避免各环节各定义一套结构导致数据对不上。

 * 任务模型与评分机制：Task / Trial / Grader / Transcript / Outcome / Eval Suite / Harness

 * 纯数据类型，主进程和测试共用。前端通过 IPC 接收/发送。
 */

/** 评测轴（4 轴） */
export type EvalAxis = 'task_completion' | 'tool_selection' | 'trajectory_quality' | 'cost_latency'

/** 评分器类型（三分类） */
export type GraderType = 'code' | 'model' | 'human'

/** 评分结果（单轴单次） */
export interface GradeResult {
  axis: EvalAxis
  grader: GraderType
  /** 二进制 verdict（COLM 2026 推荐）：true=通过，false=失败 */
  pass: boolean
  /** 0-1 分（供聚合用，verdict 的连续化表达） */
  score: number
  /** 评分理由（模型型必填，代码型可空） */
  reason?: string
  /** 耗时（毫秒） */
  durationMs: number
}

/** 单步轨迹（一个角色的一条消息 + 可选工具调用/结果） */
export interface TrajectoryStep {
  /** 角色：user=用户消息 / assistant=AI 输出 / tool=工具结果 */
  role: 'user' | 'assistant' | 'tool'
  /** 消息内容 */
  content: string
  /** 工具调用（assistant 角色时，AI 发起的调用） */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>
  /** 工具结果（tool 角色时，工具执行返回） */
  toolResult?: { ok: boolean; data?: unknown; error?: string }
  /** tool 步骤关联的 tool_call_id（与 assistant 步骤 toolCalls[].id 对应） */
  toolCallId?: string
  /** 时间戳（ms） */
  timestamp: number
}

/** 完整轨迹（一次 trial 的记录，即 Transcript） */
export interface Transcript {
  /** 任务 ID */
  taskId: string
  /** 试验序号（同任务多次试验，从 1 开始） */
  trial: number
  /** 会话 ID（关联 session-store，可选） */
  sessionId?: string
  /** 步骤序列 */
  steps: TrajectoryStep[]
  /** 总 token 数估算（input + output） */
  totalTokens: number
  /** 总耗时（毫秒） */
  totalDurationMs: number
  /** 估计成本（USD） */
  estimatedCost: number
}

/** 评测任务（单条测试用例，即 Task） */
export interface EvalTask {
  /** 任务 ID（套件内唯一） */
  id: string
  /** 人类可读描述 */
  description: string
  /** 评测套件名（如 'frontend-ai-baseline' / 'dmn-regression'） */
  suite: string
  /** 任务类型：能力评估（quality）或回归评估（regression） */
  kind: 'quality' | 'regression'
  /** 输入消息（用户 prompt） */
  input: string
  /** 初始上下文（可选） */
  initialContext?: {
    workspacePath?: string
    attachedFiles?: string[]
  }
  /** 期望的工具调用序列（可选，用于 tool_selection 轴） */
  expectedToolCalls?: Array<{
    name: string
    /** 参数子集匹配：期望的 key-value 必须在实际参数中找到 */
    argumentsMatch?: Record<string, unknown>
  }>
  /** 期望的最终状态（可选，用于 task_completion 轴） */
  expectedOutcome?: {
    /** AI 输出包含的关键词（大小写敏感） */
    outputContains?: string[]
    /** 工具调用结果是否全部成功 */
    toolResultOk?: boolean
    /** 文件存在检查（相对工作区或绝对路径） */
    fileExists?: string[]
    /** 文件内容正则匹配检查 */
    fileContentMatches?: Array<{ path: string; pattern: string }>
  }
  /** Pass@k / Pass^k 的 k 值（默认 1） */
  k?: number
  /** Pass 模式：'any'=Pass@k（k 次至少 1 次成功），'all'=Pass^k（k 次全部成功） */
  passMode?: 'any' | 'all'
}

/** 试验结果（一次 trial 的完整评分） */
export interface TrialResult {
  taskId: string
  trial: number
  transcript: Transcript
  grades: GradeResult[]
  /** 4 轴综合 pass（全部轴 pass 才算 trial pass） */
  passed: boolean
}

/** 评测套件运行结果 */
export interface SuiteResult {
  suite: string
  kind: 'quality' | 'regression'
  results: TrialResult[]
  /** trial 级通过率（quality 期望 30-50%，regression 期望 ~100%） */
  passRate: number
  /** 任务级通过率（Pass@k 或 Pass^k 聚合后） */
  taskPassRate: number
  /** 总成本（USD） */
  totalCost: number
  /** 总耗时（ms） */
  totalDurationMs: number
  /** 运行时间戳（ISO） */
  runAt: string
}
