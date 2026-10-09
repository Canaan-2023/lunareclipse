/**
 * MCP IPC：前端管理 MCP server 配置与查看运行时状态的通道
 * （读/写 .mcp.json、热重载、连接/断开）；manager 用 getter 注入，
 * 初始化失败时不阻塞其他 handler 注册。
 */
import type { ipcMain as ipcMainType, BrowserWindow } from 'electron'
import type { McpClientManager } from '../../mcp/client-manager'
import { loadMcpConfig, writeMcpConfig } from '../../mcp/config-loader'
import type { McpConfig, McpServerStatusSummary } from '@shared/types'
import { safeHandle } from './safe-handle'

/**
 * MCP IPC 处理器

 * 前端通过 IPC 管理 MCP server 配置和查看运行时状态。
 * 通道设计（遵循项目 ipcMain.handle 命名约定）：
 * - mcp:getConfig：读取 .mcp.json 配置
 * - mcp:saveConfig：写入 .mcp.json 并触发热重载（增删改 server 后调用）
 * - mcp:getStatuses：查询所有 server 运行时状态摘要
 * - mcp:connect：手动连接指定 server（按 name 查配置）
 * - mcp:disconnect：手动断开指定 server（阻止自动重连）

 * getMcpClientManager 用 getter 形式：handler 调用时读取最新值，
 * 避免 MCP 初始化失败（manager 为 null）时阻塞其他 handler 注册。
 */
export function registerMcpHandlers(
  ipc: typeof ipcMainType,
  getMcpClientManager: () => McpClientManager | null,
  _mainWindow: BrowserWindow | null
): void {
  /** 读取 .mcp.json 配置 */
  ipc.handle('mcp:getConfig', () => loadMcpConfig())

  /** 写入 .mcp.json 并触发热重载（增删改 server） */
  safeHandle(
    ipc, 'mcp:saveConfig',
    async (_event, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> => {
      const config = args[0]
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return { ok: false, error: '配置格式无效' }
      }
      const cfg = config as Record<string, unknown>
      if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object' || Array.isArray(cfg.mcpServers)) {
        return { ok: false, error: 'mcpServers 必须为对象' }
      }
      writeMcpConfig(cfg as unknown as McpConfig)
      const manager = getMcpClientManager()
      if (manager) {
        await manager.reloadFromConfig(cfg as unknown as McpConfig)
      }
      return { ok: true }
    },
    { ok: false, error: '保存 MCP 配置失败' }
  )

  /** 查询所有 server 运行时状态摘要 */
  safeHandle(ipc, 'mcp:getStatuses', () => {
    const manager = getMcpClientManager()
    if (!manager) throw new Error('MCP manager not initialized')
    return manager.getServerStatuses()
  }, [] as McpServerStatusSummary[])

  /** 手动连接指定 server（按 name 查 .mcp.json 配置） */
  safeHandle(
    ipc, 'mcp:connect',
    async (_event, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> => {
      const name = args[0] as string
      const manager = getMcpClientManager()
      if (!manager) return { ok: false, error: 'MCP 管理器未初始化' }
      const config = loadMcpConfig()
      const serverConfig = config.mcpServers[name]
      if (!serverConfig) return { ok: false, error: `未找到 server 配置: ${name}` }
      await manager.connectServer(serverConfig)
      return { ok: true }
    },
    { ok: false, error: '连接 MCP server 失败' }
  )

  /** 手动断开指定 server（阻止自动重连） */
  safeHandle(
    ipc, 'mcp:disconnect',
    async (_event, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> => {
      const name = args[0] as string
      const manager = getMcpClientManager()
      if (!manager) return { ok: false, error: 'MCP 管理器未初始化' }
      await manager.disconnectServer(name)
      return { ok: true }
    },
    { ok: false, error: '断开 MCP server 失败' }
  )
}
