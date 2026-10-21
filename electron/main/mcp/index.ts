/**
 * @category 工具
 * @summary MCP 客户端：外部工具服务器连接与工具合并
 * @note 为什么存在：通过 MCP 协议接入外部工具服务器并把第三方工具并入月蚀工具池，
 * 是"工具能力可扩展"这一设计目标的核心承接模块。
 */
/**
 * MCP 模块导出
 *
 * 统一导出 MCP 相关类型、配置加载器、客户端管理器、工具适配器，
 * 供主进程和工具注册表引用。
 */
export type {
  McpTransportType,
  McpServerConfig,
  McpConfig,
  McpServerStatus,
  McpServerInstance,
  NamespacedToolId,
  McpServerStatusSummary,
  McpCallResult
} from './types'

export {
  getDefaultMcpConfigPath,
  loadMcpConfig,
  writeMcpConfig,
  watchMcpConfig,
  ensureMcpConfigExists
} from './config-loader'

export { McpClientManager } from './client-manager'

export {
  adaptMcpTool,
  adaptMcpToolMeta,
  convertSchemaToParams
} from './tool-adapter'

export { registerBuiltinToolsToMcp, startBuiltinMcpServer } from './expose-builtin'
