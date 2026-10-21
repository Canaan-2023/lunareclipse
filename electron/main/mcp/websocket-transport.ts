/**
 * Node 版 MCP WebSocket transport：为什么存在——SDK 自带的 WebSocketClientTransport
 * 在构造/启动时直接调用全局 `new WebSocket(this._url, 'mcp')`（浏览器 API），Node 主进程
 * 没有全局 WebSocket，直接使用会 ReferenceError；本模块用 `ws` 包实现同一 Transport
 * 契约（start/close/send/onclose/onerror/onmessage/setProtocolVersion）。
 * 作用：为 MCP websocket 型 server 提供可用的客户端传输；若配置了 OAuth provider 且已有
 * access token，会在握手时附加 Authorization: Bearer 头（ws 握手无法像 HTTP 一样由 SDK
 * 注入 header，只能在此处带上）。
 */
import WebSocket from 'ws'
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'

const SUBPROTOCOL = 'mcp'

export interface NodeWebSocketClientTransportOptions {
  /** OAuth provider：若已有 access token 则附加到握手头 */
  authProvider?: OAuthClientProvider
}

/** 与 SDK WebSocketClientTransport 对等的 ws 包实现（Node 环境） */
export class NodeWebSocketClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  setProtocolVersion?: (version: string) => void

  private readonly _url: URL
  private readonly _authProvider?: OAuthClientProvider
  private _socket?: WebSocket

  constructor(url: URL, opts?: NodeWebSocketClientTransportOptions) {
    this._url = url
    this._authProvider = opts?.authProvider
  }

  async start(): Promise<void> {
    if (this._socket) {
      throw new Error('NodeWebSocketClientTransport already started! If using Client class, note that connect() calls start() automatically.')
    }
    const headers: Record<string, string> = {}
    try {
      const token = (await this._authProvider?.tokens())?.access_token
      if (token) headers['Authorization'] = `Bearer ${token}`
    } catch {
      // token 读取失败按无 token 连接（远端 401 时上层会提示重新授权）
    }
    const socket = new WebSocket(this._url, SUBPROTOCOL, { headers })
    this._socket = socket
    await new Promise<void>((resolve, reject) => {
      socket.once('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err))
        reject(error)
        this.onerror?.(error)
      })
      socket.once('open', () => resolve())
      socket.on('close', () => {
        this.onclose?.()
      })
      socket.on('message', (data) => {
        let message: JSONRPCMessage
        try {
          message = JSONRPCMessageSchema.parse(JSON.parse(data.toString()))
        } catch (error) {
          this.onerror?.(error as Error)
          return
        }
        this.onmessage?.(message)
      })
    })
  }

  async close(): Promise<void> {
    this._socket?.close()
    this._socket = undefined
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._socket) {
        reject(new Error('Not connected'))
        return
      }
      this._socket.send(JSON.stringify(message), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}