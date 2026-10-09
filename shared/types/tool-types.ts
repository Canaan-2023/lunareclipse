// ===== 工具调用可视化类型 =====
// 为什么存在：工具调用的参数、状态与结果需要在会话流中按分类与状态结构化展示（卡片化渲染），
// 前端视图与主进程下发共用同一形状。

export type ToolCategory =
  | 'file-read'
  | 'file-write'
  | 'browser'
  | 'self-shape'
  | 'account'
  | 'system'
  | 'network'
  | 'graph'
  | 'mechanism'
  | 'dmn-exclusive'
  | 'workflow'
  | 'plugin'
  | 'task-mode'
  | 'generation'
  | 'lan'
  | 'device'

export type ToolCallStatus = 'running' | 'done' | 'error'

export interface ToolCall {
  id: string
  toolName: string
  toolLabel: string
  category: ToolCategory
  args: Record<string, unknown>
  result?: ToolCallResult
  status: ToolCallStatus
  startedAt: number
  endedAt?: number
  /** 子 agent 执行详情（仅 Agent 工具）。主进程推送 subagent_* 事件填充，
   *  运行中实时更新，结束后可展开查看子 agent 内部工具调用与输出。*/
  subAgents?: SubAgentInfo[]
}

/** 子 agent 执行信息（子 agent 过程可见，一等公民而非黑盒） */
export interface SubAgentInfo {
  /** 子 agent 唯一 id（主进程生成，sa_ 前缀） */
  agentId: string
  /** 子任务指令（Agent 工具 tasks[].prompt） */
  prompt: string
  /** 执行模式：serial（顺序，前一个输出作为后一个上下文）/ parallel（并行） */
  mode: 'serial' | 'parallel'
  /** 序号（任务数组中的下标，从 0 开始） */
  index: number
  /** 任务总数（Agent 工具 tasks 数组长度） */
  total: number
  status: 'running' | 'done' | 'error'
  /** 子 agent 内部工具调用（subagent_tool_start/end 填充，复用 ToolCall 结构） */
  toolCalls?: ToolCall[]
  /** 子 agent 最终输出（subagent_done 携带，可截断） */
  output?: string
  /** 错误信息（子 agent 执行失败/超时时） */
  error?: string
  startedAt: number
  endedAt?: number
}

export interface ToolCallResult {
  ok: boolean
  data?: unknown
  error?: string
  summary: ToolCallSummary
}

export interface ToolCallSummary {
  primary: string
  secondary?: string
  addedLines?: number
  removedLines?: number
  terminalOutput?: string
  exitCode?: number
  /** 联网搜索结果（web_search 专用，UI 渲染为可点击的标题+URL+摘要列表） */
  searchResults?: Array<{
    title?: string
    url?: string
    snippet?: string
    source?: string
  }>
}