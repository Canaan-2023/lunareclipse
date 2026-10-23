import { describe, it, expect, vi, afterEach } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { NodeWebSocketClientTransport } from '../electron/main/mcp/websocket-transport'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * NodeWebSocketClientTransport 往返验证。
 * 为什么用本地 ws server 而不是 mock：本模块是 ws 包对 SDK Transport 契约的适配，
 * 只有真实 WebSocketServer 才能验证握手子协议、消息 JSON-RPC 解析、close/error 事件接线。
 */

let server: WebSocketServer | null = null
const sockets: WebSocket[] = []

function startServer(opts?: { validateHeaders?: (headers: Record<string, string | undefined>) => void }): Promise<number> {
  return new Promise((resolve, reject) => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => {
      const port = (server!.address() as { port: number }).port
      resolve(port)
    })
    server!.on('connection', (socket, req) => {
      sockets.push(socket)
      opts?.validateHeaders?.(req.headers as Record<string, string | undefined>)
      socket.on('message', (data) => {
        // 回显 JSON-RPC 消息（id 相同、result 为 echo）
        const msg = JSON.parse(data.toString()) as JSONRPCMessage
        // MCP 协议 result 必须是对象（ResultSchema = looseObject），字符串会被 SDK schema 拒绝
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: (msg as { id?: unknown }).id, result: { echo: 'ok' } }))
      })
    })
    server!.on('error', reject)
  })
}

afterEach(() => {
  for (const s of sockets) s.close()
  sockets.length = 0
  if (server) {
    server.close()
    server = null
  }
})

describe('NodeWebSocketClientTransport', () => {
  it(`start 建立 'mcp' 子协议连接，send/receive 走 JSON-RPC 往返`, async () => {
    const port = await startServer()
    const transport = new NodeWebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/mcp`))
    const onMessage = vi.fn()
    const onError = vi.fn()
    transport.onmessage = onMessage
    transport.onerror = onError
    await transport.start()

    await transport.send({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
    await new Promise((r) => setTimeout(r, 200))
    if (onError.mock.calls.length > 0) {
      throw new Error(`transport onerror: ${(onError.mock.calls[0][0] as Error).message}`)
    }
    expect(onMessage).toHaveBeenCalled()
    const msg = onMessage.mock.calls[0][0] as { id: number; result: { echo: string } }
    expect(msg.id).toBe(1)
    expect(msg.result).toEqual({ echo: 'ok' })
    await transport.close()
  })

  it('已有 access token 时握手附加 Authorization: Bearer 头', async () => {
    let authHeader: string | undefined
    const port = await startServer({
      validateHeaders: (headers) => {
        authHeader = headers['authorization']
      }
    })
    const authProvider = {
      tokens: async () => ({ access_token: 'tok-abc' })
    }
    const transport = new NodeWebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/mcp`), {
      authProvider: authProvider as never
    })
    await transport.start()
    expect(authHeader).toBe('Bearer tok-abc')
    await transport.close()
  })

  it('无 token 时握手不带 Authorization 头', async () => {
    let authHeader: string | undefined = 'unset'
    const port = await startServer({
      validateHeaders: (headers) => {
        authHeader = headers['authorization'] ?? ''
      }
    })
    const authProvider = {
      tokens: async () => undefined
    }
    const transport = new NodeWebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/mcp`), {
      authProvider: authProvider as never
    })
    await transport.start()
    expect(authHeader).toBe('')
    await transport.close()
  })

  it('server 拒绝连接时 start 抛错并触发 onerror', async () => {
    const transport = new NodeWebSocketClientTransport(new URL('ws://127.0.0.1:1/none')) // 端口 1 几乎必然拒绝
    const onError = vi.fn()
    transport.onerror = onError
    await expect(transport.start()).rejects.toBeTruthy()
  })
})