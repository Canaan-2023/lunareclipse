/**
 * @category 核心
 * @summary 子 agent 过程事件转发器：SubAgentManager 事件 → WS `subagent_*` 帧 + SubagentRow 行流
 *
 * 为什么独立成文件：转发器原内联在 `stream-runner.ts` 的 `runStream` 开头（约 90 行 switch），
 * 是「子 agent 过程可见」的唯一实现，却与主对话流的行协议/缓冲/落盘混在同一 1163 行闭包里。
 * ADR-04 把它外移为工厂——只依赖行协议的 3 个方法与连接上下文，与其余流逻辑无耦合。
 *
 * 什么作用：`createSubagentForwarder(deps)` 返回可直接交给 `streamSession.setForwarder` 的回调；
 * 事件同时映射为两条通道——旧 `subagent_*` 帧（兼容兜底）与 `SubagentRow` 行流（前端优先按行渲染）。
 *
 * 不删理由：删掉即子 agent 过程在前端不可见（Agent 工具卡不再挂载子任务进度）。
 */
import { WebSocket } from 'ws'
import type { ConversationRow, SubagentRow } from '@shared/types'
import type { StreamSession } from '../stream-session'
import type { SubAgentEvent } from '../../sub-agent'

export interface SubagentForwarderDeps {
  ws: WebSocket
  messageId: string
  streamSession: StreamSession
  turnId: string
  nextRow: () => number
  appendRow: (row: ConversationRow) => number
  upsertRow: (row: ConversationRow) => void
  /** rowId 计数器真源（createdAtSeq 记录用；经容器读写，模块内不新建计数器） */
  rowIdRef: { current: number }
}

export function createSubagentForwarder(deps: SubagentForwarderDeps): (evt: SubAgentEvent) => void {
  const { ws, messageId, streamSession, turnId, nextRow, appendRow, upsertRow, rowIdRef } = deps
  const subagentRows = new Map<string, SubagentRow>() // agentId → 行
  const subagentTypeOf = (mode?: 'serial' | 'parallel'): string =>
    mode === 'parallel' ? 'parallel-agent' : 'sub-agent'

  return (evt: SubAgentEvent) => {
    if (ws.readyState !== WebSocket.OPEN) return
    const base = { messageId, parentToolCallId: evt.parentToolCallId, agentId: evt.agentId }
    switch (evt.type) {
      case 'start': {
        const row: SubagentRow = {
          kind: 'subagent',
          rowId: nextRow(),
          turnId,
          createdAt: Date.now(),
          createdAtSeq: rowIdRef.current,
          parentToolCallId: evt.parentToolCallId,
          subagentType: subagentTypeOf(evt.mode),
          status: 'running',
          summaryText: evt.prompt.slice(0, 120),
          startedAt: Date.now()
        }
        subagentRows.set(evt.agentId, row)
        appendRow(row)
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'subagent_start',
            ...base,
            prompt: evt.prompt,
            mode: evt.mode,
            index: evt.index,
            total: evt.total
          })
        )
        break
      }
      case 'tool_start':
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'subagent_tool_start',
            ...base,
            toolName: evt.toolName,
            toolCallId: evt.toolCallId,
            toolArgs: JSON.stringify(evt.args)
          })
        )
        break
      case 'tool_end':
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'subagent_tool_end',
            ...base,
            toolName: evt.toolName,
            toolCallId: evt.toolCallId,
            toolResult: evt.result
          })
        )
        break
      case 'output':
        streamSession.push(
          ws,
          JSON.stringify({ type: 'subagent_output', ...base, text: evt.text })
        )
        break
      case 'done': {
        const row = subagentRows.get(evt.agentId)
        if (row) {
          const ended: SubagentRow = {
            ...row,
            status: evt.error ? 'failed' : evt.timedOut ? 'cancelled' : 'success',
            summaryText: evt.error ? `❌ ${evt.error.slice(0, 200)}` : evt.output.slice(0, 160),
            endedAt: Date.now()
          }
          subagentRows.set(evt.agentId, ended)
          upsertRow(ended)
        }
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'subagent_done',
            ...base,
            output: evt.output,
            error: evt.error,
            timedOut: evt.timedOut
          })
        )
        break
      }
    }
  }
}
