/**
 * @category 核心
 * @summary 行协议（Row Protocol）：本轮行流状态、rowId 分配、delta 缓冲、轮次头与终态收尾
 *
 * 为什么独立成文件：行协议是「前端按行渲染」的硬格式契约（`row.appended`/`row.delta`/`row.upserted`
 * 三类 op + 行形状），原先散在 1163 行闭包里（状态声明在流开始、终态在 onDone、delta 在 token 回调）。
 * ADR-04 把它收敛为单 owner——行的增改与 rowId 分配只有一处实现，前端契约可整体阅读。
 *
 * 什么作用：`createTurnRows(deps)` 返回本轮的 `nextRow`/`appendRow`/`upsertRow`/`deltaRow`/
 * `openTurn`（轮次头+模型切换标记+用户输入行）/`finalizeTurn`（终态收尾）与 `toolRows` 句柄。
 *
 * 不删理由：删掉即前端失去行流（退化为旧 token 事件渲染，工具卡/思考块/子 agent 卡片无法按行定位）。
 *
 * ⚠️ rowId 契约（ADR-04 §8 风险 1）：rowId 必须**会话内全局唯一且重试不重置**——计数器真源是
 * `deps.rowIdRef`（由 server.ts 持有），本模块**只经它读写、不新建局部计数器**；否则重试时新行 id
 * 与旧行冲突，前端按 rowId 去重会丢行。判据：`test/stream-runner.characterization.test.ts` 的 rowId 用例。
 */
import { WebSocket } from 'ws'
import type {
  AssistantTextRow,
  ChatMessage,
  ConversationRow,
  ReasoningRow,
  RowOp,
  TimelineMarkerRow,
  ToolCallRow,
  TurnHeaderRow
} from '@shared/types'
import type { StreamSession } from '../stream-session'
import { countFileToolChanges } from '../stream-file-changes'
import { BUFFER_INTERVAL_MS } from './output-buffers'

export interface TurnRowsDeps {
  ws: WebSocket
  messageId: string
  streamSession: StreamSession
  /** rowId 计数器真源（会话内全局递增；重试不重置） */
  rowIdRef: { current: number }
  /** 关闭标志读取器：置位后 delta 不再调度/推送（标志由宿主持有，与输出缓冲同源） */
  isClosed: () => boolean
}

export interface TurnRows {
  readonly turnId: string
  readonly turnStartedAt: number
  /** toolCallId → 行（工具行 upsert 用；也供文件变更统计） */
  readonly toolRows: Map<string, ToolCallRow>
  nextRow(): number
  appendRow(row: ConversationRow): number
  upsertRow(row: ConversationRow): void
  deltaRow(rowId: number, path: string[], append: string): void
  /** 正文 token 追加：首 token 建行，后续原地累积 + delta 缓冲 */
  appendTextToken(token: string): void
  /** 思考 token 追加：同上 */
  appendReasoningToken(token: string): void
  /** 工具调用是天然分隔点：封口当前正文/思考行（工具后的新内容开新行） */
  resetStreamingRows(): void
  /** 轮次头 + 模型切换时间线标记 + 用户输入行（仅首次流输出；重试不重复） */
  openTurn(params: {
    messages: ChatMessage[]
    model: string | undefined
    sessionId: string | undefined
    retryCount: number
    lastModelBySession: Map<string, string>
    setLastModel: (sessionId: string, model: string) => void
  }): void
  /** 兜底 flush 未推送的 delta（onDone/onError 收尾调用） */
  flushRowDeltas(): void
  /** 终态收尾：正文/思考 → complete、turnHeader → completedSuccess，返回按 rowId 排序的行数组 */
  finalizeTurn(): ConversationRow[]
}

export function createTurnRows(deps: TurnRowsDeps): TurnRows {
  const { ws, messageId, streamSession, rowIdRef, isClosed } = deps
  const nextRow = (): number => ++rowIdRef.current
  const turnStartedAt = Date.now()
  const turnId = `turn_${turnStartedAt}_${Math.random().toString(36).slice(2, 6)}`
  let textRow: AssistantTextRow | null = null
  let reasoningRow: ReasoningRow | null = null
  const toolRows = new Map<string, ToolCallRow>() // toolCallId → 行（upsert 用）
  /** 本轮全部行（持久化到 ChatMessage.rows 用；upsert 按 rowId 替换，保持终态） */
  const turnRows = new Map<number, ConversationRow>()
  let turnHeaderRowId: number | null = null
  // 行协议 delta 缓冲：row.delta 逐 token 推送会绕过 tokenBuffer 缓冲
  // 高频 set(currentMessages 新数组) 触发前端订阅组件同步重渲染 → 嵌套更新爆栈
  // "Maximum update depth exceeded"（与 TodoPanel set 风暴同类机制）。
  // 这里按 33ms 合并同一行 append 批量推，把前端 set 频率压到 ~30/s。
  const rowDeltaBuffer = new Map<number, { rowId: number; path: string[]; append: string }>()
  let rowDeltaTimer: NodeJS.Timeout | null = null

  const sendRowOp = (op: RowOp): void => {
    if (streamSession.isOpen(ws)) {
      streamSession.push(ws, JSON.stringify({ type: 'row_op', messageId, rowOp: op }))
    }
  }

  const flushRowDeltas = (): void => {
    rowDeltaTimer = null
    if (isClosed() || rowDeltaBuffer.size === 0) return
    for (const d of rowDeltaBuffer.values()) {
      if (d.append && streamSession.isOpen(ws)) {
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'row_op',
            messageId,
            rowOp: { op: 'row.delta', rowId: d.rowId, path: d.path, append: d.append }
          })
        )
      }
    }
    rowDeltaBuffer.clear()
  }

  const scheduleRowDeltaFlush = (): void => {
    if (rowDeltaTimer || isClosed()) return
    rowDeltaTimer = setTimeout(flushRowDeltas, BUFFER_INTERVAL_MS)
  }

  const appendRow = (row: ConversationRow): number => {
    turnRows.set(row.rowId, row)
    sendRowOp({ op: 'row.appended', row })
    return row.rowId
  }

  const upsertRow = (row: ConversationRow): void => {
    turnRows.set(row.rowId, row)
    sendRowOp({ op: 'row.upserted', row })
  }

  const deltaRow = (rowId: number, path: string[], append: string): void => {
    if (!append) return
    // 同步更新本地行（持久化终态完整），delta 累积进缓冲批量推前端（防逐 token set 风暴）
    const local = turnRows.get(rowId)
    if (
      local &&
      path.length === 1 &&
      path[0] === 'text' &&
      (local.kind === 'assistantText' || local.kind === 'reasoning')
    ) {
      const updated = { ...local, text: local.text + append }
      turnRows.set(rowId, updated)
      if (textRow && textRow.rowId === rowId) textRow = updated as AssistantTextRow
      if (reasoningRow && reasoningRow.rowId === rowId) reasoningRow = updated as ReasoningRow
    }
    // 同一行多次 delta 合并 append（流式输出天然高频，33ms 窗口内合并成一次推送）
    const existing = rowDeltaBuffer.get(rowId)
    if (existing) {
      existing.append += append
    } else {
      rowDeltaBuffer.set(rowId, { rowId, path, append })
    }
    scheduleRowDeltaFlush()
  }

  return {
    turnId,
    turnStartedAt,
    toolRows,
    nextRow,
    appendRow,
    upsertRow,
    deltaRow,
    appendTextToken(token: string): void {
      // 行协议：首个正文 token 建行（streaming），后续 delta 追加
      if (textRow === null) {
        textRow = {
          kind: 'assistantText',
          rowId: nextRow(),
          turnId,
          createdAt: Date.now(),
          createdAtSeq: rowIdRef.current,
          text: token,
          state: 'streaming'
        }
        appendRow(textRow)
      } else {
        textRow = { ...textRow, text: textRow.text + token }
        deltaRow(textRow.rowId, ['text'], token)
      }
    },
    appendReasoningToken(token: string): void {
      // 行协议：首个 reasoning token 建行（streaming），后续 delta 追加
      if (reasoningRow === null) {
        reasoningRow = {
          kind: 'reasoning',
          rowId: nextRow(),
          turnId,
          createdAt: Date.now(),
          createdAtSeq: rowIdRef.current,
          text: token,
          state: 'streaming'
        }
        appendRow(reasoningRow)
      } else {
        reasoningRow = { ...reasoningRow, text: reasoningRow.text + token }
        deltaRow(reasoningRow.rowId, ['text'], token)
      }
    },
    resetStreamingRows(): void {
      textRow = null
      reasoningRow = null
    },
    openTurn(params): void {
      // 轮次头 + 用户输入行（仅首次流输出，重试不重复）
      if (params.retryCount !== 0 || ws.readyState !== WebSocket.OPEN) return
      turnHeaderRowId = appendRow({
        kind: 'turnHeader',
        rowId: nextRow(),
        turnId,
        createdAt: turnStartedAt,
        createdAtSeq: rowIdRef.current,
        origin: 'userInput',
        state: 'running',
        startedAt: turnStartedAt
      })
      // 行协议：模型切换时间线标记（该会话上次模型 ≠ 本次模型时可见）
      if (params.sessionId) {
        const prevModel = params.lastModelBySession.get(params.sessionId)
        if (params.model && prevModel && prevModel !== params.model) {
          appendRow({
            kind: 'timelineMarker',
            rowId: nextRow(),
            turnId,
            createdAt: Date.now(),
            createdAtSeq: rowIdRef.current,
            marker: { type: 'modelChange', fromModel: prevModel, toModel: params.model }
          } satisfies TimelineMarkerRow)
        }
        if (params.model) params.setLastModel(params.sessionId, params.model)
      }
      const lastUser = [...params.messages].reverse().find((m) => m.role === 'user')
      if (lastUser?.content) {
        appendRow({
          kind: 'userInput',
          rowId: nextRow(),
          turnId,
          createdAt: turnStartedAt,
          createdAtSeq: rowIdRef.current,
          text: lastUser.content,
          origin: 'realUser'
        })
      }
    },
    flushRowDeltas,
    finalizeTurn(): ConversationRow[] {
      // 行协议：文本/思考行收尾为 complete（streaming → complete 状态迁移，前端停止光标）
      if (textRow) {
        const endedText: AssistantTextRow = { ...textRow, state: 'complete' }
        turnRows.set(endedText.rowId, endedText)
        upsertRow(endedText)
      }
      if (reasoningRow) {
        const endedReasoning: ReasoningRow = { ...reasoningRow, state: 'complete' }
        turnRows.set(endedReasoning.rowId, endedReasoning)
        upsertRow(endedReasoning)
      }
      // 行协议：turn 收尾——turnHeader upsert 为 completedSuccess（activeMs + fileChanges）
      if (turnHeaderRowId !== null) {
        const turnEndedAt = Date.now()
        const endedHeader: TurnHeaderRow = {
          kind: 'turnHeader',
          rowId: turnHeaderRowId,
          turnId,
          createdAt: turnStartedAt,
          createdAtSeq: turnHeaderRowId,
          origin: 'userInput',
          state: 'completedSuccess',
          startedAt: turnStartedAt,
          endedAt: turnEndedAt,
          activeMs: turnEndedAt - turnStartedAt,
          // 文件变更近似统计：文件写入类工具成功数（Write/Edit/MoveFile/CopyFile/DeleteFile）
          fileChanges: countFileToolChanges(toolRows)
        }
        upsertRow(endedHeader)
      }
      // 行流持久化：assistantText/reasoning 收尾为 complete（delta 已同步本地，这里补终态）
      return [...turnRows.values()]
        .sort((a, b) => a.rowId - b.rowId)
        .map((r) => {
          if (r.kind === 'assistantText' && r.state === 'streaming')
            return { ...r, state: 'complete' as const }
          if (r.kind === 'reasoning' && r.state === 'streaming')
            return { ...r, state: 'complete' as const }
          return r
        })
    }
  }
}
