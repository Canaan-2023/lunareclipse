/**
 * MCP 类型定义：为什么存在——前端 UI 与主进程需要共享同一份 MCP 配置/状态/工具 ID 类型，
 * 避免两端各自定义导致漂移。
 * 作用：复用 shared 层纯类型，并补充主进程侧 McpServerInstance / NamespacedToolId 等定义。
 */
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
// 纯数据类型从 shared 共享层导入（前端 UI 与主进程共享同一份定义）
export type {
  McpTransportType,
  McpServerConfig,
  McpConfig,
  McpServerStatus,
  McpServerStatusSummary,
  McpCallResult
} from '@shared/types'
import type { McpServerConfig, McpServerStatus } from '@shared/types'

/** MCP server 运行时实例（主进程私有，含 SDK Client，不入 shared） */
export interface McpServerInstance {
  config: McpServerConfig
  status: McpServerStatus
  /** SDK 的 Client 实例 */
  client: Client | null
  /** 已发现的工具列表（MCP 原始格式） */
  tools: Tool[]
  /** 最后错误信息 */
  lastError: string | null
  /** 重连次数（用于指数退避） */
  reconnectAttempts: number
}

/** MCP 工具的命名空间 ID（builtin:Read / mcp:files:read） */
export type NamespacedToolId = `builtin:${string}` | `mcp:${string}:${string}`
