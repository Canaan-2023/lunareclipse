/**
 * WebSocket 协议消息类型（shared）。
 * 为什么存在：前端与 API server 的 WS 通道承载流式 token、行协议增量、子 agent 与 mission
 * 事件，消息形状必须两端严格一致才能正确渲染。
 * 作用：导出 WSMessage、MessagePair 与 DmnEvent 等协议类型。
 */
import type { RowOp } from './row-protocol'

export interface WSMessage {
  type:
    | 'token' | 'done' | 'error' | 'abort' | 'tool_start' | 'tool_end' | 'reasoning' | 'continuous_start'
    // 子 agent 过程事件（subagent_start/tool_start/tool_end/done）
    | 'subagent_start' | 'subagent_tool_start' | 'subagent_tool_end' | 'subagent_done'
    // 行协议：增量操作流（row.appended/row.delta/row.upserted/row.removed/timelineMarker）
    | 'row_op'
    | 'takeover' | 'takeover_ok'
    // 评论家审查结果（critic 事件）
    | 'critic'
    // 自主 mission（异步委托）
    | 'mission_start' | 'mission_started' | 'mission_done'
    // 子 agent 控制
    | 'interrupt_subagent' | 'subagent_interrupted'
    | 'steer_subagent' | 'subagent_steered'
    | 'list_subagents' | 'subagents_list'
    | 'list_missions' | 'missions_list'
  payload?: string
  messageId?: string
  tokens?: number
  budget?: number | null
  dropped?: number
  activation?: boolean
  /** 本轮真实 token 用量（type=done 时有效，input 不含缓存命中） */
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  /** 评论家审查结果（type=critic 时有效） */
  score?: number
  pass?: boolean
  issues?: string[]
  /** 行操作（type=row_op 时有效） */
  rowOp?: RowOp
  /** 工具调用相关（type=tool_start/tool_end 时有效） */
  toolName?: string
  toolCallId?: string
  toolArgs?: string
  toolResult?: string
  toolError?: string
  /** 工具调用摘要（type=tool_end 时有效，ToolCallSummary JSON） */
  toolSummary?: string
  /** 深度思考内容（type=reasoning 时有效，增量推送） */
  reasoning?: string
  /** 子 agent 相关（type=subagent_* 时有效） */
  agentId?: string
  /** 父工具调用 id（主对话 Agent 工具的 toolCallId，子 agent 事件挂载定位用） */
  parentToolCallId?: string
  /** 子 agent 任务指令（subagent_start） */
  prompt?: string
  /** 执行模式（subagent_start） */
  mode?: 'serial' | 'parallel'
  /** 任务序号（subagent_start） */
  index?: number
  /** 任务总数（subagent_start） */
  total?: number
  /** 子 agent 最终输出（subagent_done，可截断） */
  output?: string
  /** 子 agent 错误信息（subagent_done 失败/超时时） */
  error?: string
  /** 目标子 agent ID（interrupt_subagent/steer_subagent） */
  subagentId?: string
  /** 中断原因（interrupt_subagent） */
  reason?: string
  /** 引导指令（steer_subagent） */
  instruction?: string
  /** 任务描述（mission_start） */
  task?: string
  /** 父 mission ID（mission_start） */
  parentId?: string
  /** 最大迭代数（mission_start，默认 50） */
  maxIterations?: number
  /** mission ID（mission_started 响应） */
  missionId?: string
  /** 操作是否成功（mission_started/subagent_interrupted/subagent_steered 响应） */
  ok?: boolean
  /** 活跃子 agent 列表（subagents_list 响应） */
  subagents?: unknown[]
  /** 全部 mission 列表（missions_list 响应） */
  missions?: unknown[]
}

export interface MessagePair {
  userText: string
  assistantText: string
  timestamp: string
}

export type DmnEvent =
  | { type: 'dmn:output'; dmnId: string; text: string }
  | { type: 'dmn:start'; dmnId: string }
  | { type: 'dmn:complete'; dmnId: string }
  | { type: 'dmn:crash'; dmnId: string; reason: string }
  | { type: 'dmn:continueHint'; dmnId: string }
  | { type: 'dmn:stopped'; dmnId: string; reason: string }
  | { type: 'dmn:cycleStart' }
  | { type: 'dmn:cycleComplete' }
  | { type: 'dmn:noMemory' }
  | { type: 'dmn:conditionWait'; reason: string }
  | { type: 'dmn:askUser'; dmnId: string; question: string; context?: string; sessionId?: string }