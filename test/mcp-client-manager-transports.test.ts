import { describe, it, expect, vi, beforeEach } from 'vitest'
import { McpClientManager } from '../electron/main/mcp/client-manager'

/**
 * connectServer 远程传输集成测试（streamable-http / sse / websocket）。
 * 为什么 mock SDK 而不是起真实 server：远程传输构造后会立即发 HTTP/WS 握手与
 * initialize 请求，需要外部 server + TLS/端口环境；这里 mock 三个传输构造器与
 * Client，验证的是 manager 的接线逻辑——传输类型选择、OAuth provider 注入、
 * finishAuth 注册与换码重连、OAuth 错误与连接失败的状态透传。
 * websocket 传输的真实往返已由 mcp-websocket-transport.test.ts 覆盖。
 */

const state = vi.hoisted(() => ({
  httpInstances: [] as Array<Record<string, unknown>>,
  sseInstances: [] as Array<Record<string, unknown>>,
  wsInstances: [] as Array<Record<string, unknown>>,
  oauthProviders: [] as Array<Record<string, unknown>>,
  connectError: null as Error | null
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const Client = vi.fn().mockImplementation(function (this: Record<string, unknown>, info: unknown) {
    const inst: Record<string, unknown> = {
      info,
      transport: undefined,
      connect: vi.fn(async (t: unknown) => {
        if (state.connectError) throw state.connectError
        this.transport = t
      }),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      listResources: vi.fn().mockResolvedValue({ resources: [] }),
      listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      close: vi.fn().mockResolvedValue(undefined),
      onclose: undefined,
      onerror: undefined
    }
    return inst
  })
  return { Client }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  const StreamableHTTPClientTransport = vi.fn().mockImplementation(function (this: Record<string, unknown>, url: URL, opts?: unknown) {
    const inst: Record<string, unknown> = {
      url,
      opts,
      finishAuth: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined
    }
    state.httpInstances.push(inst)
    return inst
  })
  return { StreamableHTTPClientTransport }
})

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
  const SSEClientTransport = vi.fn().mockImplementation(function (this: Record<string, unknown>, url: URL, opts?: unknown) {
    const inst: Record<string, unknown> = {
      url,
      opts,
      finishAuth: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined
    }
    state.sseInstances.push(inst)
    return inst
  })
  return { SSEClientTransport }
})

vi.mock('../electron/main/mcp/websocket-transport', () => {
  const NodeWebSocketClientTransport = vi.fn().mockImplementation(function (this: Record<string, unknown>, url: URL, opts?: unknown) {
    const inst: Record<string, unknown> = {
      url,
      opts,
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      onmessage: undefined
    }
    state.wsInstances.push(inst)
    return inst
  })
  return { NodeWebSocketClientTransport }
})

vi.mock('../electron/main/mcp/oauth-provider', () => {
  class FakeOAuthProvider {
    onAuthorizationCode: ((code: string) => void | Promise<void>) | undefined
    onAuthorizationError: ((message: string) => void | Promise<void>) | undefined
    redirectUrl = ''
  }
  const McpOAuthProvider = vi.fn().mockImplementation(function () {
    const p = new FakeOAuthProvider()
    state.oauthProviders.push(p as unknown as Record<string, unknown>)
    return p
  })
  const findAvailablePort = vi.fn().mockResolvedValue(39888)
  return { McpOAuthProvider, findAvailablePort }
})

describe('McpClientManager remote transports', () => {
  beforeEach(() => {
    state.httpInstances.length = 0
    state.sseInstances.length = 0
    state.wsInstances.length = 0
    state.oauthProviders.length = 0
    state.connectError = null
  })

  it('streamable-http 创建 SDK 传输、注入 OAuth provider 并在授权码回调里 finishAuth + 重连', async () => {
    const manager = new McpClientManager()
    await manager.connectServer({
      name: 'http-srv',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      enabled: true
    })

    expect(state.httpInstances).toHaveLength(1)
    const transport = state.httpInstances[0]
    expect(transport.url).toBeInstanceOf(URL)
    expect((transport.url as URL).toString()).toBe('https://mcp.example.com/')
    expect(transport.opts).toHaveProperty('authProvider')
    expect((transport.opts as { authProvider?: unknown }).authProvider).toBe(state.oauthProviders[0])

    const provider = state.oauthProviders[0]
    expect(typeof provider.onAuthorizationCode).toBe('function')

    // 收到授权码：finishAuth(code) 后自动重连（创建第二个传输实例）
    await (provider.onAuthorizationCode as (code: string) => Promise<void>)('the-code')
    expect((transport.finishAuth as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('the-code')
    expect(state.httpInstances).toHaveLength(2)

    const statuses = manager.getServerStatuses()
    expect(statuses[0].name).toBe('http-srv')
    expect(statuses[0].status).toBe('connected')
  })

  it('sse 创建 SSEClientTransport 并挂接 finishAuth', async () => {
    const manager = new McpClientManager()
    await manager.connectServer({
      name: 'sse-srv',
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      enabled: true
    })

    expect(state.sseInstances).toHaveLength(1)
    const transport = state.sseInstances[0]
    expect((transport.url as URL).toString()).toBe('https://mcp.example.com/sse')
    expect((transport.opts as { authProvider?: unknown }).authProvider).toBe(state.oauthProviders[0])

    const provider = state.oauthProviders[0]
    expect(typeof provider.onAuthorizationCode).toBe('function')
    await (provider.onAuthorizationCode as (code: string) => Promise<void>)('code-2')
    expect((transport.finishAuth as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('code-2')
    expect(state.sseInstances).toHaveLength(2)
  })

  it('websocket 创建 ws 传输并注入 authProvider（无授权码交换）', async () => {
    const manager = new McpClientManager()
    await manager.connectServer({
      name: 'ws-srv',
      transport: 'websocket',
      url: 'ws://127.0.0.1:9001/mcp',
      enabled: true
    })

    expect(state.wsInstances).toHaveLength(1)
    const transport = state.wsInstances[0]
    expect((transport.url as URL).toString()).toBe('ws://127.0.0.1:9001/mcp')
    expect((transport.opts as { authProvider?: unknown }).authProvider).toBe(state.oauthProviders[0])
    // websocket 握手带 Bearer 头，无 finishAuth 授权码流程
    expect(state.oauthProviders[0].onAuthorizationCode).toBeUndefined()
  })

  it('OAuth 错误回调把实例状态置为 error 并记录原因', async () => {
    const manager = new McpClientManager()
    await manager.connectServer({
      name: 'http-srv',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      enabled: true
    })
    const provider = state.oauthProviders[0]
    ;(provider.onAuthorizationError as (msg: string) => void)('access_denied')
    const statuses = manager.getServerStatuses()
    expect(statuses[0].status).toBe('error')
    expect(statuses[0].lastError).toBe('access_denied')
  })

  it('远程连接失败时实例置 error 并透传 lastError（远程不自动重连）', async () => {
    state.connectError = new Error('connection refused')
    const manager = new McpClientManager()
    await manager.connectServer({
      name: 'http-srv',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      enabled: true
    })
    const statuses = manager.getServerStatuses()
    expect(statuses[0].status).toBe('error')
    expect(statuses[0].lastError).toBe('connection refused')
  })

  it('连接时自动发现 tools/resources/prompts 并计入状态摘要', async () => {
    const manager = new McpClientManager()
    await manager.connectServer({
      name: 'http-srv',
      transport: 'streamable-http',
      url: 'https://mcp.example.com',
      enabled: true
    })
    const statuses = manager.getServerStatuses()
    expect(statuses[0].toolCount).toBe(0)
    expect(statuses[0].promptCount).toBe(0)
    expect(statuses[0].lastError).toBeNull()
  })
})