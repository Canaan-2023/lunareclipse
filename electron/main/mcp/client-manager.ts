/**
 * MCP 客户端管理器：为什么存在——月蚀需要接入外部 MCP 工具服务器（stdio / streamable-http）
 * 来扩展工具池，而不是把所有能力都内置；本模块负责这些外部连接的生命周期。
 * 作用：多 server 并发管理（连接/断开/指数退避重连），连接成功后自动 tools/list 发现工具，
 * tools/call 按命名空间路由到对应 server（只处理 MCP Tools）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type {
  McpServerConfig,
  McpServerInstance,
  McpServerStatus,
  McpServerStatusSummary,
  McpCallResult
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

 * 月蚀的缓存注入已覆盖 MCP resources 的需求（不做 resources/read），
 * 月蚀的 copyPrompts 已覆盖 MCP prompts 的需求（不做 prompts/get），
 * 因此本管理器只处理 MCP Tools。
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
      lastError: null,
      reconnectAttempts: 0
    }
    this.servers.set(config.name, instance)
    this.setStatus(config.name, 'connecting')

    try {
let transport
      if (config.transport === 'stdio') {
        transport = new StdioClientTransport({
          command: config.command!,
          args: config.args ?? [],
          env: config.env
        })
      } else {
        transport = new StreamableHTTPClientTransport(new URL(config.url!))
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
