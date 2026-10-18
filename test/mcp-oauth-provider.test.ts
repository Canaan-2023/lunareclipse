import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// mock electron：userData 指向临时目录，shell.openExternal 记录调用
const mockState = vi.hoisted(() => ({ userData: '', openExternal: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => mockState.userData },
  shell: { openExternal: mockState.openExternal }
}))

import { McpOAuthProvider, buildRedirectUri, findAvailablePort } from '../electron/main/mcp/oauth-provider'

describe('buildRedirectUri / findAvailablePort', () => {
  it('buildRedirectUri 生成 loopback 回调 URI', () => {
    expect(buildRedirectUri(39152)).toBe('http://localhost:39152/callback')
    expect(buildRedirectUri()).toBe('http://localhost:3118/callback')
  })

  it('findAvailablePort 优先采用 MCP_OAUTH_CALLBACK_PORT 环境变量', async () => {
    const prev = process.env.MCP_OAUTH_CALLBACK_PORT
    process.env.MCP_OAUTH_CALLBACK_PORT = '39999'
    try {
      expect(await findAvailablePort()).toBe(39999)
    } finally {
      if (prev === undefined) delete process.env.MCP_OAUTH_CALLBACK_PORT
      else process.env.MCP_OAUTH_CALLBACK_PORT = prev
    }
  })

  it('findAvailablePort 无环境变量时返回可用端口', async () => {
    const prev = process.env.MCP_OAUTH_CALLBACK_PORT
    delete process.env.MCP_OAUTH_CALLBACK_PORT
    try {
      const port = await findAvailablePort()
      expect(port).toBeGreaterThan(0)
      expect(port).not.toBeNaN()
    } finally {
      if (prev !== undefined) process.env.MCP_OAUTH_CALLBACK_PORT = prev
    }
  })
})

describe('McpOAuthProvider 持久化与授权流', () => {
  let root: string
  const tokens = { access_token: 'acc-123', token_type: 'Bearer', refresh_token: 'ref-456', scope: 'profile' } as const
  const clientInfo = { client_id: 'cli-1', client_secret: 'sec-1' } as const

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-oauth-'))
    mockState.userData = root
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    mockState.openExternal.mockReset()
  })

  it('clientMetadata / redirectUrl 与端口一致', () => {
    const provider = new McpOAuthProvider('test', 'https://mcp.example.com', 39152)
    expect(provider.redirectUrl).toBe('http://localhost:39152/callback')
    expect(provider.clientMetadata.redirect_uris).toEqual(['http://localhost:39152/callback'])
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none')
  })

  it('tokens / clientInformation / codeVerifier 持久化到 userData/mcp-oauth.json 并按 server 分键', () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39152)
    expect(provider.tokens()).toBeUndefined()
    provider.saveTokens(tokens)
    provider.saveClientInformation(clientInfo)
    provider.saveCodeVerifier('code-verifier-1')
    expect(provider.tokens()).toEqual(tokens)
    expect(provider.codeVerifier()).toBe('code-verifier-1')

    // 文件已落盘
    const path = join(root, 'mcp-oauth.json')
    expect(existsSync(path)).toBe(true)
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    expect(raw['srv-a'].tokens.access_token).toBe('acc-123')

    // 新实例从磁盘恢复（同一 server 名共享状态）
    const provider2 = new McpOAuthProvider('srv-a', 'https://a.example', 39152)
    expect(provider2.tokens()?.access_token).toBe('acc-123')
  })

  it('不同 server 名互不污染', async () => {
    const a = new McpOAuthProvider('srv-a', 'https://a.example', 39152)
    const b = new McpOAuthProvider('srv-b', 'https://b.example', 39153)
    a.saveTokens(tokens)
    expect(b.tokens()).toBeUndefined()
  })

  it('invalidateCredentials 清除对应范围', async () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39152)
    provider.saveTokens(tokens)
    provider.saveCodeVerifier('v')
    provider.saveClientInformation(clientInfo)
    provider.invalidateCredentials('tokens')
    expect(provider.tokens()).toBeUndefined()
    expect(provider.codeVerifier()).toBe('v')
    provider.invalidateCredentials('all')
    expect(provider.clientInformation()).toBeUndefined()
  })

  it('state 复用且超 10 分钟后重新生成', async () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39152)
    const s1 = await provider.state()
    const s2 = await provider.state()
    expect(s1).toBe(s2)
    // 伪造过期时间后应重新生成
    ;(provider as unknown as { _stateSetAt: number })._stateSetAt = Date.now() - 11 * 60 * 1000
    const s3 = await provider.state()
    expect(s3).not.toBe(s1)
  })

  it('回调服务器收到合法 code+state 触发 onAuthorizationCode', async () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39990)
    const state = await provider.state()
    const onCode = vi.fn()
    provider.onAuthorizationCode = onCode
    const onError = vi.fn()
    provider.onAuthorizationError = onError

    await (provider as unknown as { ensureCallbackServer(): Promise<void> }).ensureCallbackServer()

    await new Promise<void>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:39990/callback?code=the-code&state=${state}`, (res) => {
        res.resume()
        resolve()
      })
      req.on('error', reject)
    })

    // 回调是异步函数，等待微任务落定
    await new Promise((r) => setTimeout(r, 100))
    expect(onError).not.toHaveBeenCalled()
    expect(onCode).toHaveBeenCalledWith('the-code')
  })

  it('回调服务器拒绝 state 不匹配（CSRF）', async () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39991)
    await provider.state()
    const onCode = vi.fn()
    provider.onAuthorizationCode = onCode
    const onError = vi.fn()
    provider.onAuthorizationError = onError

    await (provider as unknown as { ensureCallbackServer(): Promise<void> }).ensureCallbackServer()

    await new Promise<void>((resolve) => {
      const req = http.get('http://127.0.0.1:39991/callback?code=evil&state=wrong', (res) => {
        expect(res.statusCode).toBe(400)
        res.resume()
        resolve()
      })
      req.on('error', () => resolve())
    })

    await new Promise((r) => setTimeout(r, 100))
    expect(onCode).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
  })

  it('回调服务器收到 error 参数触发 onAuthorizationError', async () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39992)
    const state = await provider.state()
    const onCode = vi.fn()
    provider.onAuthorizationCode = onCode
    const onError = vi.fn()
    provider.onAuthorizationError = onError

    await (provider as unknown as { ensureCallbackServer(): Promise<void> }).ensureCallbackServer()

    await new Promise<void>((resolve) => {
      const req = http.get(`http://127.0.0.1:39992/callback?error=access_denied&state=${state}`, (res) => {
        expect(res.statusCode).toBe(400)
        res.resume()
        resolve()
      })
      req.on('error', () => resolve())
    })

    await new Promise((r) => setTimeout(r, 100))
    expect(onCode).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalled()
    expect(onError.mock.calls[0][0]).toContain('access_denied')
  })

  it('redirectToAuthorization 打开系统浏览器并持久化 authorizationUrl', async () => {
    const provider = new McpOAuthProvider('srv-a', 'https://a.example', 39993)
    await provider.state()
    const url = new URL('https://auth.example.com/authorize?client_id=x&state=s')
    await provider.redirectToAuthorization(url)
    expect(mockState.openExternal).toHaveBeenCalledWith(url.toString())
    // 浏览器只打开一次
    await provider.redirectToAuthorization(url)
    expect(mockState.openExternal).toHaveBeenCalledTimes(1)
  })
})