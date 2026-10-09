// ===== 行协议（Row Protocol）=====
// 硬格式：AI 输出不是整段 markdown，而是类型化行流（row.appended / row.delta / row.upserted），
// 前端按 kind 渲染部件。
// 为什么存在：流式输出需要逐条增量渲染（而非等整段文本），且工具调用、子代理等结构化事件
// 无法用纯文本表达；行流让前后端按固定协议增量同步会话视图。

export type RowKind =
  | 'turnHeader' | 'userInput' | 'assistantText' | 'reasoning'
  | 'toolCall' | 'subagent' | 'timelineMarker'

/** 行公共字段 */
export interface RowBase {
  /** 全局递增行 id（会话内唯一） */
  rowId: number
  /** 所属轮次 id */
  turnId: string
  /** 创建时间戳（ms） */
  createdAt: number
  /** 行创建序号（同轮内递增） */
  createdAtSeq: number
}

export interface TurnHeaderRow extends RowBase {
  kind: 'turnHeader'
  origin: 'userInput' | 'backgroundResult' | 'goalContinuation'
  state: 'running' | 'completedSuccess' | 'completedInterrupted' | 'failed'
  startedAt: number
  endedAt?: number
  activeMs?: number
  fileChanges?: { additions: number; deletions: number; files: number }
}

export interface UserInputRow extends RowBase {
  kind: 'userInput'
  text: string
  origin: 'realUser' | 'backgroundResult' | 'goalContinuation' | 'mailbox' | 'synthetic'
}

export interface AssistantTextRow extends RowBase {
  kind: 'assistantText'
  text: string
  state: 'streaming' | 'complete' | 'interrupted' | 'failed'
  model?: string
}

export interface ReasoningRow extends RowBase {
  kind: 'reasoning'
  text: string
  state: 'streaming' | 'complete' | 'interrupted'
  durationMs?: number
}

export interface ToolCallRow extends RowBase {
  kind: 'toolCall'
  toolCallId: string
  toolName: string
  status: 'inputStreaming' | 'pendingApproval' | 'running' | 'success' | 'error' | 'cancelled'
  inputText: string
  input?: unknown
  output?: { text: string; truncated?: boolean }
  error?: { code: string; message: string }
  startedAt?: number
  endedAt?: number
}

export interface SubagentRow extends RowBase {
  kind: 'subagent'
  parentToolCallId?: string
  subagentType: string
  status: 'running' | 'success' | 'failed' | 'cancelled'
  summaryText: string
  childSessionId?: string
  startedAt?: number
  endedAt?: number
}

export type TimelineMarkerPayload =
  | {
      type: 'compact'
      origin: 'manual' | 'auto'
      status: 'running' | 'success' | 'failed' | 'noop' | 'cancelled'
      tokensBefore?: number
      tokensAfter?: number
    }
  | { type: 'modelChange'; fromModel?: string; toModel: string }
  | { type: 'retryNotice'; attempt: number; reasonCode: string }

export interface TimelineMarkerRow extends RowBase {
  kind: 'timelineMarker'
  marker: TimelineMarkerPayload
}

export type ConversationRow =
  | TurnHeaderRow | UserInputRow | AssistantTextRow | ReasoningRow
  | ToolCallRow | SubagentRow | TimelineMarkerRow

/** 行操作（增量流，row.delta 驱动流式渲染） */
export type RowOp =
  | { op: 'row.appended'; row: ConversationRow }
  | { op: 'row.upserted'; row: ConversationRow }
  | { op: 'row.removed'; fromRowId: number }
  | { op: 'row.delta'; rowId: number; path: string[]; append: string }