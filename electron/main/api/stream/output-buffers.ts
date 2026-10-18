/**
 * @category 核心
 * @summary 流式缓冲：正文 / 思考 token 的累积与 33ms 批量推送（含定时器生命周期）
 *
 * 为什么独立成文件：缓冲策略（BUFFER_INTERVAL_MS=33 / BUFFER_MAX_CHARS=64 / 首 token 立即 flush）
 * 是「UI 渲染跟不上」的直接对策，原先与行协议、落盘、错误分派同处 1163 行闭包。
 * ADR-04 把它外移——缓冲只管「何时把已累积文本推给前端」，不碰行协议与业务语义。
 *
 * 什么作用：`createOutputBuffers(deps)` 返回 `pushText`/`pushReasoning`/`flushAll`/`clearTimers`；
 * 同时维护 `streamSession` 的运行快照（takeover 重放数据源）。
 *
 * 不删理由：删掉即退化为逐 token 推帧——前端每 token 一次 set，长回复下渲染卡顿/更新风暴。
 *
 * 与 `turn-rows.ts` 的关系：两者共用同一 33ms 节流窗口常量（`BUFFER_INTERVAL_MS` 由本模块导出，
 * 行 delta 缓冲 import 使用）——原实现里两者共用一个窗口，属既有语义，拆后保持同源。
 */
import { WebSocket } from 'ws'
import type { StreamSession } from '../stream-session'

/** 批量推送窗口（ms）：正文/思考缓冲与行 delta 缓冲共用 */
export const BUFFER_INTERVAL_MS = 33
/** 缓冲达到该字符数立即 flush（不等窗口） */
const BUFFER_MAX_CHARS = 64

export interface OutputBuffersDeps {
  ws: WebSocket
  messageId: string
  streamSession: StreamSession
  /** 关闭标志读取器：onDone/onError 置位后缓冲不再累积与推送（标志由宿主持有） */
  isClosed: () => boolean
}

export interface OutputBuffers {
  pushText(token: string): void
  pushReasoning(token: string): void
  /** 推送残留正文缓冲并清其定时器（受关闭标志约束；工具开始前同步刷新用） */
  flushText(): void
  /** 推送残留思考缓冲并清其定时器（受关闭标志约束） */
  flushReasoning(): void
  /**
   * 收尾残留推送：**不受关闭标志约束**（onDone/onError 在置位关闭标志后仍需把最后一批推给前端）。
   * 与 `flushText`/`flushReasoning` 的区别即原实现里「收尾直推」与「定时器/首 token flush」两段代码的差别。
   */
  flushResidualText(): void
  flushResidualReasoning(): void
  /** 仅清两个定时器（不推送） */
  clearTimers(): void
}

export function createOutputBuffers(deps: OutputBuffersDeps): OutputBuffers {
  const { ws, messageId, streamSession, isClosed } = deps
  let tokenBuffer = ''
  let bufferTimer: NodeJS.Timeout | null = null
  let firstTokenFlushed = false
  let reasoningBuffer = ''
  let reasoningTimer: NodeJS.Timeout | null = null
  let firstReasoningFlushed = false

  const flushBuffer = (): void => {
    bufferTimer = null
    if (isClosed()) return
    if (tokenBuffer && streamSession.isOpen(ws)) {
      streamSession.push(ws, JSON.stringify({ type: 'token', payload: tokenBuffer, messageId }))
    }
    tokenBuffer = ''
  }

  const flushReasoning = (): void => {
    reasoningTimer = null
    if (isClosed()) return
    if (reasoningBuffer && streamSession.isOpen(ws)) {
      streamSession.push(
        ws,
        JSON.stringify({ type: 'reasoning', reasoning: reasoningBuffer, messageId })
      )
    }
    reasoningBuffer = ''
  }

  const clearTimers = (): void => {
    if (bufferTimer) {
      clearTimeout(bufferTimer)
      bufferTimer = null
    }
    if (reasoningTimer) {
      clearTimeout(reasoningTimer)
      reasoningTimer = null
    }
  }

  /** 收尾直推（不受关闭标志约束，见接口注释） */
  const flushResidualText = (): void => {
    if (tokenBuffer && streamSession.isOpen(ws)) {
      streamSession.push(ws, JSON.stringify({ type: 'token', payload: tokenBuffer, messageId }))
    }
    tokenBuffer = ''
  }
  const flushResidualReasoning = (): void => {
    if (reasoningBuffer && streamSession.isOpen(ws)) {
      streamSession.push(
        ws,
        JSON.stringify({ type: 'reasoning', reasoning: reasoningBuffer, messageId })
      )
    }
    reasoningBuffer = ''
  }

  return {
    pushText(token: string): void {
      tokenBuffer += token
      streamSession.appendOutput(messageId, token)
      // 首个 token 立即 flush（用户即刻看到开头，不等 33ms 窗口）
      if (!firstTokenFlushed) {
        firstTokenFlushed = true
        if (bufferTimer) {
          clearTimeout(bufferTimer)
          bufferTimer = null
        }
        flushBuffer()
        return
      }
      if (tokenBuffer.length >= BUFFER_MAX_CHARS) {
        if (bufferTimer) {
          clearTimeout(bufferTimer)
          bufferTimer = null
        }
        flushBuffer()
      } else if (!bufferTimer) {
        bufferTimer = setTimeout(flushBuffer, BUFFER_INTERVAL_MS)
      }
    },
    pushReasoning(token: string): void {
      reasoningBuffer += token
      streamSession.appendReasoning(messageId, token)
      if (!firstReasoningFlushed) {
        firstReasoningFlushed = true
        if (reasoningTimer) {
          clearTimeout(reasoningTimer)
          reasoningTimer = null
        }
        flushReasoning()
        return
      }
      if (reasoningBuffer.length >= BUFFER_MAX_CHARS) {
        if (reasoningTimer) {
          clearTimeout(reasoningTimer)
          reasoningTimer = null
        }
        flushReasoning()
      } else if (!reasoningTimer) {
        reasoningTimer = setTimeout(flushReasoning, BUFFER_INTERVAL_MS)
      }
    },
    flushText: flushBuffer,
    flushReasoning,
    flushResidualText,
    flushResidualReasoning,
    clearTimers
  }
}
