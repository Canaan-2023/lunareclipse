/**
 * MCP OAuth 授权 provider：为什么存在——远程 MCP server（streamable-http / sse）通常要求
 * OAuth 2.0（RFC 9728 资源元数据 + 动态客户端注册 PKCE + Authorization Code），月蚀需要
 * 一个能持久化凭据、在桌面端引导用户完成授权的客户端 provider。
 * 作用：实现 @modelcontextprotocol/sdk 的 OAuthClientProvider 接口——
 * - loopback 回调服务器（RFC 8252，127.0.0.1 + 随机空闲端口）接收授权码
 * - 系统浏览器打开授权页（shell.openExternal），桌面应用无需内嵌 webview
 * - PKCE code verifier / 客户端注册信息 / token / 发现状态持久化到 userData/mcp-oauth.json
 * - state 校验防 CSRF，收到授权码后经 onAuthorizationCode 通知 client-manager 完成换 token 并重连
 *
 * 安全说明：token 以明文落在 userData 目录（与 .mcp.json 同级）。这是桌面应用本地凭据的
 * 常见取舍（VS Code 等亦落盘），如需更高安全等级可后续接入系统凭据库（keytar / safeStorage）。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app, shell } from 'electron'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'

// Windows 动态端口范围 49152-65535 被系统保留，参考生态惯例在其下方随机挑端口
const REDIRECT_PORT_RANGE = { min: 39152, max: 49151 }
const REDIRECT_PORT_FALLBACK = 3118

/** 构建 loopback 回调 URI（RFC 8252：任意端口、固定路径均可匹配） */
export function buildRedirectUri(port: number = REDIRECT_PORT_FALLBACK): string {
  return `http://localhost:${port}/callback`
}

/**
 * 找一个当前空闲的 loopback 端口用于 OAuth 回调。
 * 随机挑选（百万分之一碰撞概率的随机性要求来自 RFC 8252 §7.3），
 * 随机失败后回退到固定兜底端口；仍不可用则抛错。
 */
export function findAvailablePort(): Promise<number> {
  const configured = parseInt(process.env.MCP_OAUTH_CALLBACK_PORT || '', 10)
  if (configured > 0) return Promise.resolve(configured)

  const { min, max } = REDIRECT_PORT_RANGE
  const range = max - min + 1
  const maxAttempts = Math.min(range, 100)
  const tryPort = (port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const testServer = createServer()
      testServer.once('error', reject)
      testServer.listen(port, () => {
        testServer.close(() => resolve())
      })
    })

  const randomTry = async (): Promise<number | null> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const port = min + Math.floor(Math.random() * range)
      try {
        await tryPort(port)
        return port
      } catch {
        // 端口被占用，换一个随机端口重试
      }
    }
    return null
  }

  return (async () => {
    const picked = await randomTry()
    if (picked !== null) return picked
    try {
      await tryPort(REDIRECT_PORT_FALLBACK)
      return REDIRECT_PORT_FALLBACK
    } catch {
      throw new Error(`没有可用端口用于 MCP OAuth 回调（已尝试 39152-49151 与 ${REDIRECT_PORT_FALLBACK}）`)
    }
  })()
}

/** 每个 server 的持久化状态（按 server 名分键存 userData/mcp-oauth.json） */
interface PersistedServerState {
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  codeVerifier?: string
  discoveryState?: OAuthDiscoveryState
}

/** OAuth 回调服务器收到的结果（授权码或错误） */
interface CallbackResult {
  code?: string
  error?: string
  errorDescription?: string
}

/** 状态读取/清理的公开只读对象（供 client-manager 判断是否需要授权） */
export interface McpOAuthStatus {
  needsAuth: boolean
  lastError: string | null
}

/**
 * 月蚀版 MCP OAuth client provider（精简自参考项目 Claude AuthProvider 的设计：
 * loopback 回调 + PKCE + token 持久化；月蚀侧用 shell.openExternal 打开系统浏览器，
 * 由主进程内 http server 接收授权码回调）。
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private server?: Server
  private _state?: string
  private _stateSetAt?: number
  private _authorizationUrl?: string
  private _browserOpened = false

  /** 授权码就绪回调（client-manager 注入：收到 code 后调 transport.finishAuth 并重连） */
  onAuthorizationCode?: (code: string) => void
  /** 授权流程出错回调（CSRF 校验失败/服务器返回 error 参数） */
  onAuthorizationError?: (message: string) => void

  constructor(
    private readonly serverName: string,
    private readonly serverUrl: string,
    private readonly port = REDIRECT_PORT_FALLBACK
  ) {}

  // ===== OAuthClientProvider 接口 =====

  get redirectUrl(): string {
    return buildRedirectUri(this.port)
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `LunarEclipse (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none' // 公开客户端：PKCE 已足够
    }
  }

  async state(): Promise<string> {
    // 同一授权流程内复用 state（SDK 可能会调用多次）；
    // 超过 10 分钟视为新流程重新生成，防止陈旧 state 通过 CSRF 校验
    if (!this._state || (this._stateSetAt && Date.now() - this._stateSetAt > 10 * 60 * 1000)) {
      this._state = randomBytes(32).toString('base64url')
      this._stateSetAt = Date.now()
    }
    return this._state
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.readState().clientInformation
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.patchState({ clientInformation })
  }

  tokens(): OAuthTokens | undefined {
    return this.readState().tokens
  }

  saveTokens(tokens: OAuthTokens): void {
    this.patchState({ tokens })
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.patchState({ codeVerifier })
  }

  codeVerifier(): string {
    return this.readState().codeVerifier ?? ''
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.patchState({ discoveryState })
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.readState().discoveryState
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const current = this.readState()
    const next: PersistedServerState = { ...current }
    if (scope === 'all' || scope === 'client') delete next.clientInformation
    if (scope === 'all' || scope === 'tokens') delete next.tokens
    if (scope === 'all' || scope === 'verifier') delete next.codeVerifier
    if (scope === 'all' || scope === 'discovery') delete next.discoveryState
    this.writeServerState(next)
  }

  /**
   * 打开系统浏览器引导用户授权，并保持 loopback 回调服务器监听。
   * SDK 调用本方法时 authorizationUrl 已包含 PKCE challenge 与 state；
   * 本方法不等待用户操作（SDK 会立即抛 UnauthorizedError 通知上层），
   * 授权完成后由回调服务器触发 onAuthorizationCode。
   */
  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this._authorizationUrl = authorizationUrl.toString()
    await this.ensureCallbackServer()
    if (!this._browserOpened) {
      this._browserOpened = true
      await shell.openExternal(authorizationUrl.toString())
    }
  }

  // ===== 内部实现 =====

  /** 启动/复用 loopback 回调服务器（127.0.0.1，unref 不钉住事件循环） */
  private ensureCallbackServer(): Promise<void> {
    if (this.server) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const expectedState = this._state ?? ''
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        void this.handleCallback(req, res, expectedState)
      })
      server.on('error', (err: NodeJS.ErrnoException) => {
        this.server = undefined
        const message = err.code === 'EADDRINUSE'
          ? `MCP OAuth 回调端口 ${this.port} 已被占用，请释放后重试或设置 MCP_OAUTH_CALLBACK_PORT 指定端口`
          : `MCP OAuth 回调服务器失败: ${err.message}`
        this.onAuthorizationError?.(message)
        reject(new Error(message))
      })
      server.listen(this.port, '127.0.0.1', () => {
        this.server = server
        resolve()
      })
      server.unref()
    })
  }

  private async handleCallback(req: IncomingMessage, res: ServerResponse, expectedState: string): Promise<void> {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404).end('Not Found')
      return
    }
    const result: CallbackResult = {
      code: typeof url.searchParams.get('code') === 'string' ? url.searchParams.get('code')! : undefined,
      error: url.searchParams.get('error') ?? undefined,
      errorDescription: url.searchParams.get('error_description') ?? undefined
    }
    const stateParam = url.searchParams.get('state')

    // state 校验防 CSRF：缺失/不匹配一律拒绝并终止回调
    if (!result.error && stateParam !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>授权失败</h1><p>state 参数不匹配（可能存在 CSRF 攻击），授权已终止。请关闭窗口重试。</p>')
      this.closeServer()
      this.onAuthorizationError?.('OAuth state 不匹配（可能的 CSRF 攻击），授权已终止')
      return
    }

    if (result.error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<h1>授权失败</h1><p>${escapeHtml(result.error)}${result.errorDescription ? `: ${escapeHtml(result.errorDescription)}` : ''}</p><p>可以关闭此窗口。</p>`)
      this.closeServer()
      this.onAuthorizationError?.(`OAuth 授权失败: ${result.error}${result.errorDescription ? ` - ${result.errorDescription}` : ''}`)
      return
    }

    if (result.code) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>授权成功</h1><p>可以关闭此窗口，返回 LunarEclipse。</p>')
      this.closeServer()
      this.onAuthorizationCode?.(result.code)
      return
    }

    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1>授权失败</h1><p>回调缺少 code 参数。</p>')
  }

  private closeServer(): void {
    if (this.server) {
      const s = this.server
      this.server = undefined
      s.close()
    }
  }

  // ===== 持久化（userData/mcp-oauth.json，按 server 名分键） =====

  private storagePath(): string {
    return join(app.getPath('userData'), 'mcp-oauth.json')
  }

  private readAll(): Record<string, PersistedServerState> {
    const path = this.storagePath()
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, PersistedServerState>
    } catch {
      // 损坏的持久化文件按空状态处理（不阻塞连接，下次授权会重新写入）
      return {}
    }
  }

  private writeAll(data: Record<string, PersistedServerState>): void {
    writeFileSync(this.storagePath(), JSON.stringify(data, null, 2), 'utf-8')
  }

  private readState(): PersistedServerState {
    return this.readAll()[this.serverName] ?? {}
  }

  private patchState(patch: Partial<PersistedServerState>): void {
    const all = this.readAll()
    all[this.serverName] = { ...(all[this.serverName] ?? {}), ...patch }
    this.writeAll(all)
  }

  private writeServerState(state: PersistedServerState): void {
    const all = this.readAll()
    if (Object.keys(state).length === 0) {
      delete all[this.serverName]
    } else {
      all[this.serverName] = state
    }
    this.writeAll(all)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}