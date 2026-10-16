/**
 * MCP 客户端管理器：为什么存在——月蚀需要接入外部 MCP 工具服务器
 * （stdio / streamable-http / sse / websocket）来扩展工具池，而不是把所有能力都内置；
 * 本模块负责这些外部连接的生命周期。
 * 作用：多 server 并发管理（连接/断开/指数退避重连），连接成功后自动 tools/list 发现工具、
 * resources/list 发现资源、prompts/list 发现 prompt 模板，tools/call 按命名空间路由到对应
 * server（处理 MCP Tools/Resources/Prompts）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { NodeWebSocketClientTransport } from './websocket-transport'
import { McpOAuthProvider, findAvailablePort } from './oauth-provider'
import type {
  McpServerConfig,
  McpServerInstance,
  McpServerStatus,
  McpServerStatusSummary,
  McpCallResult,
  McpResourceSummary,
  McpReadResourceData,
  McpPromptSummary
} from './types'
import { computeBackoffDelay } from '@shared/utils/backoff'

/** 最大重连次数 */
const MAX_RECONNECT_ATTEMPTS = 5
/** 重连基础延迟（毫秒），指数退避：delay = base * 2^(attempt-1) */
const RECONNECT_BASE_DELAY = 1000

/**
 * MCP 客户端管理器

 * 桌面 MCP 集成模式参考：
 * - 多 server 并发管理，每个 server 独立连接/断开/重连
 * - 工具发现（tools/list）在连接成功后自动执行
 * - 工具调用（tools/call）通过命名空间路由到对应 server
 * - 断线重连用指数退避（1s/2s/4s/8s/16s，最多 5 次）

 * 月蚀的缓存注入已覆盖 MCP resources 的部分需求，但保持协议原生能力以便
 * AI 直接按 uri 读取服务器资源（listResources 连接时自动发现，readResource
 * 按需读取）；MCP prompts 同样协议原生支持（listPrompts 连接时自动发现，
 * getPrompt 按名获取模板），供 AI 主动发现/套用服务器提供的提示模板。
 * 远程传输（streamable-http / sse / websocket）支持 OAuth 2.0 授权流（PKCE +
 * loopback 回调 + token 持久化，见 oauth-provider.ts）。
 */
export class McpClientManager {
  private servers = new Map<string, McpServerInstance>()
  /** 待执行的重连定时器（server name → timer），用于 disconnect 时清理 */
  private reconnectTimers = new Map<string, NodeJS.Timeout>()
  /** 手动断开标记（阻止自动重连） */
  private manualDisconnect = new Set<string>()
  private onStatusChange?: (serverName: string, status: McpServerStatus) => void

  /** 设置状态变更回调（前端 UI 用于显示连接状态） */
  setStatusCallback(cb: (serverName: string, status: McpServerStatus) => void): void {
    this.onStatusChange = cb
  }

  private setStatus(name: string, status: McpServerStatus, lastError?: string): void {
    const instance = this.servers.get(name)
    if (instance) {
      instance.status = status
      if (lastError !== undefined) instance.lastError = lastError
    }
    this.onStatusChange?.(name, status)
  }

  /** 连接单个 MCP server */
  async connectServer(config: McpServerConfig): Promise<void> {
    // 已存在则先断开（清理旧连接和定时器）
    if (this.servers.has(config.name)) {
      await this.disconnectServer(config.name)
    }
    // 清除手动断开标记（新连接允许自动重连）
    this.manualDisconnect.delete(config.name)

    const instance: McpServerInstance = {
      config,
      status: 'connecting',
      client: null,
      tools: [],
      resources: [],
      prompts: [],
      lastError: null,
      reconnectAttempts: 0
    }
    this.servers.set(config.name, instance)
    this.setStatus(config.name, 'connecting')

    try {
      let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport | NodeWebSocketClientTransport
      if (config.transport === 'stdio') {
        transport = new StdioClientTransport({
          command: config.command!,
          args: config.args ?? [],
          env: config.env
        })
      } else {
        // 远程传输：构造 OAuth provider（token/客户端注册信息持久化在 userData/mcp-oauth.json）。
        // 每次连接都新建 provider 实例，状态从磁盘恢复；授权码回调按 server 绑定到本次传输。
        const oauthProvider = new McpOAuthProvider(config.name, config.url!, await findAvailablePort())
        const onAuthError = (message: string) => {
          this.setStatus(config.name, 'error', message)
        }
        if (config.transport === 'streamable-http') {
          const httpTransport = new StreamableHTTPClientTransport(new URL(config.url!), { authProvider: oauthProvider })
          // 换取 access token（SDK transport.finishAuth 内部用 provider 持久化的
          // clientInformation + codeVerifier 完成 code 交换），成功后重连（新传输自带 token）
          oauthProvider.onAuthorizationCode = async (code: string) => {
            try {
              await httpTransport.finishAuth(code)
              await this.connectServer(config)
            } catch (err) {
              console.error(`[MCP] ${config.name} OAuth 换 token/重连失败:`, (err as Error).message)
              this.setStatus(config.name, 'error', `OAuth 授权完成但连接失败: ${(err as Error).message}`)
            }
          }
          oauthProvider.onAuthorizationError = onAuthError
          transport = httpTransport
        } else if (config.transport === 'sse') {
          const sseTransport = new SSEClientTransport(new URL(config.url!), { authProvider: oauthProvider })
          oauthProvider.onAuthorizationCode = async (code: string) => {
            try {
              await sseTransport.finishAuth(code)
              await this.connectServer(config)
            } catch (err) {
              console.error(`[MCP] ${config.name} OAuth 换 token/重连失败:`, (err as Error).message)
              this.setStatus(config.name, 'error', `OAuth 授权完成但连接失败: ${(err as Error).message}`)
            }
          }
          oauthProvider.onAuthorizationError = onAuthError
          transport = sseTransport
        } else {
          // websocket：ws 握手只能手动附加 Bearer 头（见 NodeWebSocketClientTransport），
          // 无 SDK finishAuth 授权码交换流程——token 过期时远端 401 会在 start 报错并提示重新配置。
          transport = new NodeWebSocketClientTransport(new URL(config.url!), { authProvider: oauthProvider })
        }
      }

// 注册 onclose 回调，运行时进程崩溃（kill）触发自动重连
      // 手动断开（disconnectServer）时 manualDisconnect 集合会阻止 onclose 触发的重连
      const client = new Client({ name: 'yue-shi', version: '1.0.0' })
      // onclose/onerror 是 Protocol 类的实例属性（非构造函数 options）
      client.onclose = () => {
        // 连接关闭（进程崩溃/退出/网络断开）时触发重连
        // scheduleReconnect 内部检查 manualDisconnect，手动断开不会重连
        if (config.transport === 'stdio' && config.autoRestart !== false) {
          this.scheduleReconnect(config.name)
        }
      }
      client.onerror = (error: Error) => {
        console.error(`[MCP] ${config.name} 传输错误:`, error.message)
      }
      await client.connect(transport)

      instance.client = client
      instance.status = 'connected'

      // 发现工具
      const { tools } = await client.listTools()
      instance.tools = tools

      // 发现资源（resources/list；server 未声明 resources 能力时 SDK 抛错）：
      // 资源发现失败不允许把已成功的连接标记为 error——工具照常可用，只留空资源列表。
      try {
        const res = await client.listResources()
        instance.resources = Array.isArray(res?.resources) ? res.resources.map(toResourceSummary) : []
      } catch {
        instance.resources = []
      }

      // 发现 prompt 模板（prompts/list；策略同上：失败静默留空，不把已成功的连接标记为 error）
      try {
        const res = await client.listPrompts()
        instance.prompts = Array.isArray(res?.prompts) ? res.prompts.map(toPromptSummary) : []
      } catch {
        instance.prompts = []
      }

      this.setStatus(config.name, 'connected')
    } catch (err) {
      const errMsg = (err as Error).message
      instance.lastError = errMsg
      this.setStatus(config.name, 'error', errMsg)
      // 自动重连（仅 stdio 模式且 autoRestart !== false）
      if (config.transport === 'stdio' && config.autoRestart !== false) {
        this.scheduleReconnect(config.name)
      }
    }
  }

  /** 断开单个 MCP server（手动断开，阻止自动重连） */
  async disconnectServer(name: string): Promise<void> {
    this.manualDisconnect.add(name)
    // 清理待执行的重连定时器
    const timer = this.reconnectTimers.get(name)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(name)
    }
    const instance = this.servers.get(name)
    if (!instance) return
    if (instance.client) {
      await instance.client.close()
    }
    this.servers.delete(name)
    this.setStatus(name, 'disconnected')
  }

  /** 断开所有 MCP server */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.servers.keys())
    await Promise.all(names.map((name) => this.disconnectServer(name)))
  }

/**
   * 调度重连（指数退避）。

   * 为什么存在：stdio 型 MCP server 进程意外退出时需自动拉起，但无条件重连会
   * 形成风暴，因此限定最大次数并以递增延迟退避。
   * 作用：为指定 server 登记一个「到期后重新 connect」的定时器；登记前先清理该
   * 名字下已存在的旧定时器——修复前重复调用会叠加多个定时器导致同一 server
   * 被并发重连（评审 m2），且 reconnectAttempts 只在一个定时器内自增，多余定时器
   * 会让退避计数失真。
   */
  private scheduleReconnect(name: string): void {
    // 手动断开的 server 不重连
    if (this.manualDisconnect.has(name)) return
    const instance = this.servers.get(name)
    if (!instance) return
    if (instance.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus(name, 'error', `重连失败（已超过最大重试次数 ${MAX_RECONNECT_ATTEMPTS}）`)
      return
    }
    // 清理旧定时器，保证同名的重连任务唯一
    const existing = this.reconnectTimers.get(name)
    if (existing) clearTimeout(existing)
    instance.reconnectAttempts++
    const delay = computeBackoffDelay({
      attempt: instance.reconnectAttempts - 1,
      baseDelayMs: RECONNECT_BASE_DELAY
    })
    this.setStatus(name, 'reconnecting')
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(name)
      void this.connectServer(instance.config)
    }, delay)
    this.reconnectTimers.set(name, timer)
  }

  /** 获取所有已连接 server 的工具列表（合并） */
  getAllTools(): Array<{ serverName: string; tool: Tool }> {
    const result: Array<{ serverName: string; tool: Tool }> = []
    for (const [name, instance] of this.servers) {
      if (instance.status === 'connected' && instance.tools.length > 0) {
        for (const tool of instance.tools) {
          result.push({ serverName: name, tool })
        }
      }
    }
    return result
  }

  /** 获取所有已连接 server 的资源列表（合并；不带资源的 server 不出现） */
  getAllResources(): Array<{ serverName: string; resources: McpResourceSummary[] }> {
    const result: Array<{ serverName: string; resources: McpResourceSummary[] }> = []
    for (const [name, instance] of this.servers) {
      if (instance.status === 'connected' && instance.resources.length > 0) {
        result.push({ serverName: name, resources: instance.resources })
      }
    }
    return result
  }

  /** 获取所有已连接 server 的 prompt 模板列表（合并；不带 prompts 的 server 不出现） */
  getAllPrompts(): Array<{ serverName: string; prompts: McpPromptSummary[] }> {
    const result: Array<{ serverName: string; prompts: McpPromptSummary[] }> = []
    for (const [name, instance] of this.servers) {
      if (instance.status === 'connected' && instance.prompts.length > 0) {
        result.push({ serverName: name, prompts: instance.prompts })
      }
    }
    return result
  }

  /**
   * 获取 MCP server 上的 prompt 模板内容（prompts/get；可传模板参数并得到展开后的消息序列）。
   * 返回约定：成功返回 { description?, messages: [{ role, content }] }，失败返回错误信息。
   */
  async getPrompt(
    serverName: string,
    name: string,
    args?: Record<string, string>
  ): Promise<
    | { ok: true; data: { description?: string; messages: Array<{ role: string; text: string }> } }
    | { ok: false; error: string }
  > {
    const instance = this.servers.get(serverName)
    if (!instance || !instance.client) {
      return { ok: false, error: `MCP server ${serverName} 未连接` }
    }
    try {
      const result = await instance.client.getPrompt({ name, arguments: args })
      // GetPromptResult.messages: [{ role: 'user'|'assistant', content: TextContent|ImageContent|... }]
      // 只提取 text 型内容（与 readResource 的 blob 拦截同理，不把二进制注入纯文本通道）。
      const messages = ((result as { messages?: Array<{ role: string; content?: { type?: string; text?: string } }> }).messages ?? []).map(
        (m) => ({
          role: m.role,
          text: typeof m.content?.text === 'string' ? m.content.text : `[非文本内容: ${m.content?.type ?? 'unknown'}]`
        })
      )
      if (messages.length === 0) {
        return { ok: false, error: `prompt ${name} 无内容` }
      }
      return { ok: true, data: { description: (result as { description?: string }).description, messages } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /**
   * 读取 MCP server 上的资源。
   * 返回约定：text 型资源返回文本内容（单段直接给字符串、多段给数组）；
   * blob 型资源只返回元信息（尺寸/类型），不把 base64 字节注入纯文本通道。
   * 大文本结果统一由执行链（execute-tool）的大结果落盘机制处理，本层不重复落盘。
   */
  async readResource(serverName: string, uri: string): Promise<{ ok: true; data: McpReadResourceData | string | Array<string | McpReadResourceData> } | { ok: false; error: string }> {
    const instance = this.servers.get(serverName)
    if (!instance || !instance.client) {
      return { ok: false, error: `MCP server ${serverName} 未连接` }
    }
    try {
      const result = await instance.client.readResource({ uri })
      const parts = extractResourceParts(
        (result as { contents?: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }> }).contents ?? []
      )
      if (parts.length === 0) {
        return { ok: false, error: `资源 ${uri} 无内容` }
      }
      return { ok: true, data: parts.length === 1 ? parts[0] : parts }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** 调用 MCP 工具 */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const instance = this.servers.get(serverName)
    if (!instance || !instance.client) {
      return { ok: false, error: `MCP server ${serverName} 未连接` }
    }
    try {
      const result = await instance.client.callTool({ name: toolName, arguments: args })
      // MCP 返回 { content: [{ type: 'text', text: '...' }], isError: false }
      const isError = (result as { isError?: boolean }).isError
      const content = (result as { content: Array<{ type: string; text?: string }> }).content
      // 提取文本内容
      const textParts = content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!)
      const data = textParts.length === 1 ? textParts[0] : textParts
      if (isError) {
        return { ok: false, error: typeof data === 'string' ? data : JSON.stringify(data) }
      }
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** 获取所有 server 状态摘要（前端 UI 用） */
  getServerStatuses(): McpServerStatusSummary[] {
    return Array.from(this.servers.entries()).map(([name, instance]) => ({
      name,
      status: instance.status,
      toolCount: instance.tools.length,
      promptCount: instance.prompts.length,
      lastError: instance.lastError
    }))
  }

  /** 根据配置重新加载所有 server（热重载） */
  async reloadFromConfig(config: { mcpServers: Record<string, McpServerConfig> }): Promise<void> {
    const newNames = new Set(Object.keys(config.mcpServers).filter((k) => config.mcpServers[k].enabled))
    const currentNames = new Set(this.servers.keys())

    // 断开已移除或禁用的 server
    for (const name of currentNames) {
      if (!newNames.has(name)) {
        await this.disconnectServer(name)
      }
    }

    // 连接新增的 server + 重连配置变更的 server
    for (const name of newNames) {
      const newServerConfig = config.mcpServers[name]
      if (!currentNames.has(name)) {
        // 新增
        await this.connectServer(newServerConfig)
      } else {
        // 已存在：检测配置是否变更（深比较关键字段）
        const instance = this.servers.get(name)
        if (instance && isConfigChanged(instance.config, newServerConfig)) {
          // 配置变更：先断开再重连
          await this.disconnectServer(name)
          await this.connectServer(newServerConfig)
        }
      }
    }
  }
}

/**
 * 从 ReadResourceResult.contents 提取可返回部分（导出纯函数便于单测）：
 * text 型内容直接返回文本；blob 型内容只返回元信息（base64 不注入纯文本通道）。
 */
export function extractResourceParts(
  contents: Array<{ uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown }>
): Array<string | McpReadResourceData> {
  const parts: Array<string | McpReadResourceData> = []
  for (const c of contents) {
    if (typeof c.text === 'string' && c.text.length > 0) {
      parts.push(c.text)
    } else if (typeof c.blob === 'string' && c.blob.length > 0) {
      // base64 长度 → 原始字节数（base64 每 4 字符编码 3 字节）
      parts.push({
        binary: {
          uri: typeof c.uri === 'string' ? c.uri : '',
          mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
          sizeBytes: Math.floor((c.blob.length * 3) / 4)
        }
      })
    }
  }
  return parts
}

/**
 * 把协议 Resource 投影为月蚀资源摘要（手工字段提取而非 zod parse：
 * 避免引入 zod 依赖；字段形状是 MCP 协议稳定部分，缺失字段安全省略）。
 */
function toResourceSummary(r: {
  uri?: unknown
  name?: unknown
  description?: unknown
  mimeType?: unknown
}): McpResourceSummary {
  const summary: McpResourceSummary = { uri: String(r.uri ?? '') }
  if (typeof r.name === 'string' && r.name) summary.name = r.name
  if (typeof r.description === 'string' && r.description) summary.description = r.description
  if (typeof r.mimeType === 'string' && r.mimeType) summary.mimeType = r.mimeType
  return summary
}

/**
 * 把协议 Prompt 投影为月蚀 prompt 摘要（手工字段提取而非 zod parse：
 * 避免引入 zod 依赖；字段形状是 MCP 协议稳定部分，缺失字段安全省略）。
 */
function toPromptSummary(p: {
  name?: unknown
  description?: unknown
  arguments?: Array<{ name?: unknown; description?: unknown; required?: unknown }>
}): McpPromptSummary {
  const summary: McpPromptSummary = { name: String(p.name ?? '') }
  if (typeof p.description === 'string' && p.description) summary.description = p.description
  if (Array.isArray(p.arguments)) {
    const args = p.arguments
      .map((a): { name: string; description?: string; required?: boolean } | null => {
        if (typeof a.name !== 'string' || !a.name) return null
        const arg: { name: string; description?: string; required?: boolean } = { name: a.name }
        if (typeof a.description === 'string' && a.description) arg.description = a.description
        if (typeof a.required === 'boolean') arg.required = a.required
        return arg
      })
      .filter((x): x is { name: string; description?: string; required?: boolean } => x !== null)
    if (args.length > 0) summary.arguments = args
  }
  return summary
}

/**
 * 检测 server 配置是否变更（深比较关键字段）。
 * 用于 reloadFromConfig 决定是否需要重连：配置变了才重连，避免无谓的重置连接。
 */
function isConfigChanged(oldCfg: McpServerConfig, newCfg: McpServerConfig): boolean {
  if (oldCfg.transport !== newCfg.transport) return true
  if (oldCfg.command !== newCfg.command) return true
  if (oldCfg.url !== newCfg.url) return true
  if (oldCfg.autoRestart !== newCfg.autoRestart) return true
  // args/env 用 JSON 序列化比较（数组/对象顺序敏感，但配置场景顺序即用户意图）
  if (JSON.stringify(oldCfg.args) !== JSON.stringify(newCfg.args)) return true
  if (JSON.stringify(oldCfg.env) !== JSON.stringify(newCfg.env)) return true
  return false
}
