/**
 * 为什么存在：多开实例"发现即直连"需要客户端侧统一封装建连、握手与超时，并把未就绪时的信封暂存待发。
 * 作用：openLanConnection 以 WebSocket 向对端发起连接并交换 LanHello，返回带待发缓冲的连接句柄。
 */

import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import type { LanEnvelope, LanHello } from './lan-types'
import { LAN_MAX_PAYLOAD } from './lan-types'

/**
 * 局域网出站连接（lan-server 之外的主动建连方）：
 * - 连接对端 lanIp:lanPort，先发 hello 自报身份，等待对端回 hello 完成握手
 * - 握手成功后 socket 由调用方（lan-server）登记为可发送通道
 * - 对端不可达/握手超时（5s）返回失败，调用方决定入 outbox
 */
export interface LanClientResult {
  socket: WebSocket
  /** 对端 hello（uid/用户名/lanPort 等身份声明） */
  peer: LanHello
  /**
   * 握手 resolve 前后到达的业务消息缓冲：
   * TCP 段可能同时携带 hello 与业务消息，而正式监听由 lan-server 注册（microtask 延迟），
   * 这段窗口内到达的消息必须缓冲，交由 registerOutbound 回放，避免静默丢失。
   */
  pending: LanEnvelope[]
  /** 优雅关闭（先 close code 4000 再 terminate 兜底） */
  close: () => void
}

export function openLanConnection(hello: LanHello, host: string, port: number): Promise<LanClientResult> {
  return new Promise((resolve, reject) => {
    let settled = false
    const pending: LanEnvelope[] = []
    const socket = new WebSocket(`ws://${host}:${port}`, { maxPayload: LAN_MAX_PAYLOAD })
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      try {
        socket.terminate()
      } catch {
        // 忽略
      }
      reject(err)
    }

    // 握手超时：5s 未收到对端 hello 视为失败
    const handshakeTimer = setTimeout(() => {
      fail(new Error(`握手超时：${host}:${port}`))
    }, 5000)

    socket.on('open', () => {
      socket.send(JSON.stringify({ id: randomUUID(), type: 'hello', from: hello.uid, to: hello.uid, ts: Date.now(), payload: hello } satisfies LanEnvelope))
    })

    socket.on('message', (raw) => {
      let env: LanEnvelope
      try {
        env = JSON.parse(raw.toString()) as LanEnvelope
      } catch {
        return // 非 JSON 消息忽略
      }
      if (env.type === 'hello') {
        clearTimeout(handshakeTimer)
        if (settled) return
        settled = true
        const peer = env.payload as LanHello
        resolve({ socket, peer, pending, close: () => { try { socket.close(4000, 'bye') } catch { /* 忽略 */ } } })
        return
      }
      if (settled) {
        // 握手完成后、正式监听接管前到达的业务消息：缓冲待回放
        pending.push(env)
      }
      // 握手完成前到达的非 hello 消息（对端不应发）忽略
    })

    socket.on('error', (err) => {
      clearTimeout(handshakeTimer)
      fail(err instanceof Error ? err : new Error(String(err)))
    })

    socket.on('close', (_code, _reason) => {
      clearTimeout(handshakeTimer)
      fail(new Error(`对端关闭连接（${host}:${port}）`))
    })
  })
}