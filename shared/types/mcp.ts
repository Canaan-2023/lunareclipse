// ===== MCP（Model Context Protocol）共享类型 =====
// 纯数据类型，不依赖 SDK，供前端 UI 和主进程共享。
// 含 SDK Client 的 McpServerInstance 留在 electron/main/mcp/types.ts（主进程私有）。
// 为什么存在：MCP server 配置由用户在前端编辑、主进程加载连接，两端必须共享同一配置与
// 状态契约；依赖 SDK 的实现类型不外泄到 shared。

/** MCP server 传输类型 */
export type McpTransportType = 'stdio' | 'streamable-http'

/** MCP server 配置（.mcp.json 的一项） */
export interface McpServerConfig {
  /** server 名称（唯一标识，用作工具命名空间） */
  name: string
  /** 传输类型 */
  transport: McpTransportType
  /** stdio 模式：要执行的命令 */
  command?: string
  /** stdio 模式：命令参数 */
  args?: string[]
  /** stdio 模式：环境变量 */
  env?: Record<string, string>
  /** streamable-http 模式：server URL */
  url?: string
  /** 启用状态 */
  enabled: boolean
  /** 自动重启（stdio 模式，默认 true） */
  autoRestart?: boolean
}

/** .mcp.json 配置文件格式 */
export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
}

/** MCP server 运行时状态 */
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'reconnecting'

/** MCP server 状态摘要（前端 UI 用） */
export interface McpServerStatusSummary {
  name: string
  status: McpServerStatus
  toolCount: number
  lastError: string | null
}

/** MCP 工具调用结果 */
export interface McpCallResult {
  ok: boolean
  data?: unknown
  error?: string
}