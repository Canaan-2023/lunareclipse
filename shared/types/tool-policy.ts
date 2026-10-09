/**
 * 工具启用策略共享类型。
 * 为什么存在：各 AI 端点（前端 AI/DMN/莉莉丝）的工具启停由主进程按 policy 过滤、前端配置
 * 面板编辑，需要两端共用的最小契约。
 * 作用：导出 ToolPolicy、FrontendToolPolicy。
 */
/** 单个工具的启用策略 */
export interface ToolPolicy {
  enabled: boolean
}

/** 前端 AI 工具策略 */
export interface FrontendToolPolicy {
  /** per-tool 启用配置（key=工具 id） */
  tools: Record<string, ToolPolicy>
}