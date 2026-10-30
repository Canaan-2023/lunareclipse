/**
 * @category 工具
 * @summary 统一工具池元数据注册表（shared）——宿主 barrel。
 *
 * 为什么存在：本文件原为 639 行单文件（同时承载类型/内置目录/动态注册/策略/标签五类职责），
 * 按 ADR-06 拆分后降级为 barrel，**显式命名 re-export** 五个兄弟模块，使 36 处消费方
 * （主进程 + 渲染端 + CLI）的 import 路径与符号零改动。
 * 不用 `export *`：避免模块私有符号（如 `findToolMeta`）外泄，
 * 保持导出面与拆分前**逐字等价**。
 *
 * 各模块职责：`meta` 类型 / `catalog` 内置目录与派生类型 / `dynamic` 运行时动态注册 /
 * `policies` 策略与过滤 / `labels` 分类展示标签。
 * 新增代码请直接 import 对应子模块；仅既有消费方沿用本 barrel。
 */

// 类型
export type { ToolVisibleConfig, ToolMeta, McpToolMeta, PluginToolMeta } from './meta'
export type { BuiltinToolId } from './catalog'

// 内置目录（唯一真源）与 O(1) 查找表
export { TOOL_REGISTRY, TOOL_MAP } from './catalog'

// 运行时动态注册（MCP / 插件）
export {
  registerMcpToolMetas,
  unregisterMcpServerTools,
  registerPluginToolMetas,
  unregisterPluginTools,
  clearDynamicToolMetas,
  unregisterAllMcpTools,
  getAllToolMetas
} from './dynamic'

// 策略与过滤
export {
  getFrontendTools,
  getWorkflowTools,
  isToolEnabled,
  isToolForAgent,
  buildWorkflowToolPolicy,
  DEFAULT_WORKFLOW_TOOL_POLICIES,
  mergeWorkflowToolPolicies
} from './policies'

// 分类展示标签
export { CATEGORY_LABELS, CATEGORY_ICONS } from './labels'
