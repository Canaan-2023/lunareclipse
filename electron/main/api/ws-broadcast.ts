/**
 * @category 核心
 * @summary WS 广播面：活跃流集合 + 背压保护发送 + 流状态广播
 * @note 为什么存在：`activeStreams` / `safeWsSend` / `broadcastStreamStatus` 三者互为一体
 * （广播遍历活跃流、发送走背压保护），且只依赖 `streamSession` 一个注入点；从宿主 `server.ts` 外移（ADR-02 第二轮）。
 * @note 不删理由：背压保护是「前端连接被大 payload 撑爆后进入 [连接中断] 循环」的唯一防线。
 */
import { WebSocket } from 'ws'
import type { StreamSession } from './stream-session'

/** WS 发送背压上限（超过则跳过发送，避免 bufferedAmount 无限增长拖垮连接） */
const WS_BACKPRESSURE_LIMIT = 2 * 1024 * 1024

export interface WsBroadcast {
  /** 当前活跃流连接（key = streamId） */
  activeStreams: Map<string, WebSocket>
  /** 背压保护发送：非 OPEN 或超背压上限时返回 false 且不发送 */
  safeWsSend: (ws: WebSocket, data: string) => boolean
  /** 广播当前流状态（只发轻量元信息，不带 output 全文） */
  broadcastStreamStatus: () => void
}

export function createWsBroadcast(deps: { streamSession: StreamSession }): WsBroadcast {
  const { streamSession } = deps

  function safeWsSend(ws: WebSocket, data: string): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false
    if (ws.bufferedAmount > WS_BACKPRESSURE_LIMIT) {
      console.warn('[ws] 背压限制：跳过发送（bufferedAmount=%d）', ws.bufferedAmount)
      return false
    }
    ws.send(data)
    return true
  }

  const activeStreams = new Map<string, WebSocket>()

  // LLMClient 是单实例单请求设计，但多条并发路径（多 WS 连接、后端续接、外部消息）都会调
  // streamWithTools，并发会互相覆盖 controller。串行语义：所有流式请求经 streamSession.enqueue
  // 排队（同一时刻只有一个 stream）；流归属/快照/接管宽限/子代理转发均由 streamSession 统一持有。
  // WS close 只中止自己发起的请求（不误杀其他连接的 stream）。
  // 运行中流的信息快照：前端重载/断线后查询真实状态用。
  // 前端是投影，消息终态由后端决定——重载后从磁盘读旧快照会与真实状态脱节
  // 需要告知"后端此刻是否还在跑、跑的是哪条流"。
  // 流状态广播：只广播轻量元信息（active/sessionId/messageId），不带 output 全文（防 maxPayload 超限）。
  // 内容由接管重放或磁盘落盘提供。
  const broadcastStreamStatus = (): void => {
    const snap = streamSession.current()
    const payload = JSON.stringify(
      snap
        ? {
            type: 'stream_status',
            active: true,
            sessionId: snap.sessionId,
            messageId: snap.messageId,
            startedAt: snap.startedAt
          }
        : { type: 'stream_status', active: false }
    )
    for (const [, client] of activeStreams) {
      safeWsSend(client, payload)
    }
  }

  return { activeStreams, safeWsSend, broadcastStreamStatus }
}
