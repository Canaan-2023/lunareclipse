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
  McpCallResult,
  McpPromptSummary
} from '@shared/types'
import type { McpServerConfig, McpServerStatus, McpPromptSummary } from '@shared/types'

/** MCP server 运行时实例（主进程私有，含 SDK Client，不入 shared） */
export interface McpServerInstance {
  config: McpServerConfig
  status: McpServerStatus
  /** SDK 的 Client 实例 */
  client: Client | null
  /** 已发现的工具列表（MCP 原始格式） */
  tools: Tool[]
  /** 已发现的资源列表（协议 Resource 的月蚀侧投影；server 未声明 resources 能力时为空） */
  resources: McpResourceSummary[]
  /** 已发现的 prompt 模板列表（协议 Prompt 的月蚀侧投影；server 未声明 prompts 能力时为空） */
  prompts: McpPromptSummary[]
  /** 最后错误信息 */
  lastError: string | null
  /** 重连次数（用于指数退避） */
  reconnectAttempts: number
}

/**
 * MCP resource 摘要：协议 Resource 的月蚀侧投影。
 * 为什么自定义而不直接用 SDK 类型：@modelcontextprotocol/sdk 未导出 Resource 类型
 * （仅导出 ListResourcesResultSchema / ReadResourceResultSchema 两个 z 对象），
 * 自定义投影形状稳定、不随 SDK 类型定义漂移，只保留前端 UI / AI 消费所需字段。
 */
export interface McpResourceSummary {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

/** MCP 资源读取结果：文本内容直接返回；二进制（blob）只返回元信息，不注入字节 */
export interface McpReadResourceData {
  /** 资源主体文本（text 型资源返回；纯文本通道不进二进制字节） */
  text?: string
  /** 二进制资源元信息（blob 型资源返回，内容请按需另取） */
  binary?: { uri: string; mimeType?: string; sizeBytes: number }
}

/** MCP 工具的命名空间 ID（builtin:Read / mcp:files:read） */
export type NamespacedToolId = `builtin:${string}` | `mcp:${string}:${string}`
