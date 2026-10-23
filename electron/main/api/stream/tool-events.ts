/**
 * @category 核心
 * @summary 工具事件处理：onToolStart / onToolEnd（行协议工具行 + WS 工具帧 + 失败收集 + 落盘裁剪）
 *
 * 为什么独立成文件：工具事件的副作用面很宽——行协议建行/收尾、工具结果**落盘裁剪**（8KB 头尾）、
 * 失败收集（供 onDone 的「输出纪律」真实性校验）、任务清单快照。原先内联在 `stream-runner.ts`
 * 的 1163 行闭包里，与流解析、落盘、错误分派混居。ADR-04 外移为工厂。
 *
 * 什么作用：`createToolEventHandlers(deps)` 返回 `onToolStart`/`onToolEnd`，可直接展开进
 * `streamWithTools` 的回调对象。
 *
 * 不删理由：删掉即工具调用在前端不可见（无工具卡行、无计划气泡更新），且「AI 声称完成但隐瞒
 * 工具失败」的输出纪律校验失去失败来源。
 *
 * ⚠️ 落盘裁剪阈值（8KB / 头 4KB / 尾 2KB）不可去掉：真实案例——77.9MB 会话文件，
 * 75 个 120-190KB 的 run_command 输出累积成 42.8MB。UI 不消费 output.text（卡片显示 summary），
 * 故超限只留头尾。推送前端的 `tool_end` 帧仍用**完整** result（用户要看完整结果）。
 */
import { WebSocket } from 'ws'
import type { ToolCallRow } from '@shared/types'
import type { StreamSession } from '../stream-session'
import { buildToolCallSummary } from '../tool-bridge'
import { getTodos } from '../../tools/todo-write'
import type { OutputBuffers } from './output-buffers'
import type { TurnRows } from './turn-rows'

// 工具输出持久化裁剪（onToolEnd 内）：output.text 全量落盘会让 session 文件膨胀到几十 MB
// （真实案例：77.9MB 会话文件 / 200KB 阈值仍让 75 个 120-190KB 的 run_command 输出累积成
// 42.8MB 再爆）。UI 不消费 output.text（ToolCallCard 显示消息级 summary），超 MAX 时
// 只保留头 HEAD / 尾 TAIL。
const OUTPUT_TEXT_MAX = 8 * 1024
const OUTPUT_TEXT_HEAD = 4 * 1024
const OUTPUT_TEXT_TAIL = 2 * 1024

export interface ToolEventDeps {
  ws: WebSocket
  messageId: string
  streamSession: StreamSession
  rows: TurnRows
  buffers: OutputBuffers
  rowIdRef: { current: number }
  /** 本轮工具失败收集（onDone 的编码模式输出纪律校验用；宿主持有） */
  toolFailures: Array<{ toolName: string; error: string }>
}

export interface ToolEventHandlers {
  onToolStart(toolName: string, toolCallId: string, args: Record<string, unknown>): void
  onToolEnd(toolName: string, toolCallId: string, result: string): void
}

export function createToolEventHandlers(deps: ToolEventDeps): ToolEventHandlers {
  const { ws, messageId, streamSession, rows, buffers, rowIdRef, toolFailures } = deps

  return {
    onToolStart(toolName, toolCallId, args): void {
      // 工具开始前，先同步刷新残留的 reasoning/token buffer
      // 修复 Bug：onToolStart 之前未刷新 buffer，残留 reasoning 文本会在工具执行期间
      // （33ms 定时器触发）才推给前端，造成"边思考边执行工具"的视觉错觉
      buffers.clearTimers()
      buffers.flushReasoning()
      buffers.flushText()
      // 思考/正文按段隔离：工具调用是天然分隔点——封口当前行，工具后的新思考/正文开新行。
      rows.resetStreamingRows()
      // 行协议：工具调用建行（running）
      if (streamSession.isOpen(ws)) {
        const tcRow: ToolCallRow = {
          kind: 'toolCall',
          rowId: rows.nextRow(),
          turnId: rows.turnId,
          createdAt: Date.now(),
          createdAtSeq: rowIdRef.current,
          toolCallId,
          toolName,
          status: 'running',
          inputText: JSON.stringify(args ?? {}),
          input: args,
          startedAt: Date.now()
        }
        rows.toolRows.set(toolCallId, tcRow)
        rows.appendRow(tcRow)
      }
      if (streamSession.isOpen(ws)) {
        // 附带当前任务清单快照（payload.todos 驱动计划气泡实时更新）
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'tool_start',
            messageId,
            toolName,
            toolCallId,
            toolArgs: JSON.stringify(args),
            todos: getTodos()
          })
        )
      }
    },
    onToolEnd(toolName, toolCallId, result): void {
      // 收集工具失败（编码模式输出纪律用：onDone 时校验 AI 是否如实报告失败）
      try {
        const parsed = JSON.parse(result) as { ok?: boolean; error?: string }
        if (parsed?.ok === false || parsed?.error) {
          toolFailures.push({ toolName, error: parsed.error ?? '未知错误' })
        }
      } catch {
        // 结果非 JSON（如纯文本输出）不算失败
      }
      // 行协议：工具调用收尾（success/error）
      const tcRow = rows.toolRows.get(toolCallId)
      if (tcRow) {
        let status: ToolCallRow['status'] = 'success'
        let error: { code: string; message: string } | undefined
        try {
          const parsed = JSON.parse(result) as { ok?: boolean; error?: string }
          if (parsed?.ok === false || parsed?.error) {
            status = 'error'
            error = { code: 'tool_error', message: parsed.error ?? '未知错误' }
          }
        } catch {
          // 非 JSON 结果视为成功输出
        }
        // 持久化裁剪（阈值见模块头部注释）
        let outputText = result
        const outputTruncated = result.length > OUTPUT_TEXT_MAX
        if (outputTruncated) {
          outputText =
            result.slice(0, OUTPUT_TEXT_HEAD) +
            `\n\n... [已截断：完整结果 ${result.length} 字符，仅保留头尾] ...\n\n` +
            result.slice(result.length - OUTPUT_TEXT_TAIL)
        }
        const endedRow: ToolCallRow = {
          ...tcRow,
          status,
          ...(error ? { error } : {}),
          output: { text: outputText, truncated: outputTruncated },
          endedAt: Date.now()
        }
        rows.toolRows.set(toolCallId, endedRow)
        rows.upsertRow(endedRow)
      }
      if (streamSession.isOpen(ws)) {
        // 不截断工具结果——用户要看完整结果，截断会让用户以为模型只读到一半
        const summary = buildToolCallSummary(toolName, result)
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'tool_end',
            messageId,
            toolName,
            toolCallId,
            toolResult: result,
            toolSummary: JSON.stringify(summary),
            // 任务清单快照（tool.complete payload.todos 驱动计划气泡）
            todos: getTodos()
          })
        )
      }
    }
  }
}
