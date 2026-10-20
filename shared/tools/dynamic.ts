/**
 * @category 工具
 * @summary MCP / 插件 动态工具注册（shared，运行时可变）
 *
 * 为什么存在：MCP server 连接后与插件加载后注册的工具元数据不在静态目录内，需要一处运行时可变的状态表与读写函数，并与静态目录合并查询。
 * 不删理由：本模块由 `shared/tools/registry.ts` 按 ADR-06 拆分而来，宿主降级为 barrel
 * 保全部消费方零改动；职责单一化后，改动面互不干扰（原单文件同时承载类型/目录/动态注册/
 * 策略/标签五类职责，任一处改动都会与其它职责在 merge 上冲突）。
 */

import type { McpToolMeta, PluginToolMeta, ToolMeta } from './meta'
import { TOOL_REGISTRY, TOOL_MAP } from './catalog'

// ===== MCP / 插件 动态工具注册（运行时可变，与 TOOL_REGISTRY 合并查询） =====

/** 动态工具元数据（MCP server 连接后 / 插件加载后注册，断开/卸载后移除） */
const dynamicToolMetas: Array<McpToolMeta | PluginToolMeta> = []

/** 注册 MCP 工具元数据（运行时动态注册）。同 server 的旧元数据会先被移除 */
export function registerMcpToolMetas(metas: McpToolMeta[]): void {
  if (metas.length === 0) return
  // 先移除同 server 的旧元数据
  const servers = new Set(metas.map((m) => m.mcpServer).filter(Boolean) as string[])
  for (const server of servers) {
    for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
      const m = dynamicToolMetas[i]
      if (m.source === 'mcp' && m.mcpServer === server) {
        dynamicToolMetas.splice(i, 1)
      }
    }
  }
  // 追加新元数据
  dynamicToolMetas.push(...metas)
}

/** 注销指定 server 的所有工具元数据 */
export function unregisterMcpServerTools(serverName: string): void {
  for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
    const m = dynamicToolMetas[i]
    if (m.source === 'mcp' && m.mcpServer === serverName) {
      dynamicToolMetas.splice(i, 1)
    }
  }
}

/** 注册插件工具元数据（运行时动态注册）。同插件的旧元数据会先被移除 */
export function registerPluginToolMetas(metas: PluginToolMeta[]): void {
  if (metas.length === 0) return
  // 先移除同插件的旧元数据
  const plugins = new Set(metas.map((m) => m.plugin).filter(Boolean) as string[])
  for (const plugin of plugins) {
    for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
      const m = dynamicToolMetas[i]
      if (m.source === 'plugin' && m.plugin === plugin) {
        dynamicToolMetas.splice(i, 1)
      }
    }
  }
  // 追加新元数据
  dynamicToolMetas.push(...metas)
}

/** 注销指定插件的所有工具元数据 */
export function unregisterPluginTools(plugin: string): void {
  for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
    const m = dynamicToolMetas[i]
    if (m.source === 'plugin' && m.plugin === plugin) {
      dynamicToolMetas.splice(i, 1)
    }
  }
}

/** 清空全部动态元数据（重启/测试用） */
export function clearDynamicToolMetas(): void {
  dynamicToolMetas.length = 0
}

/** 注销所有 MCP 动态工具元数据（全量同步时使用，不碰插件元数据） */
export function unregisterAllMcpTools(): void {
  for (let i = dynamicToolMetas.length - 1; i >= 0; i--) {
    if (dynamicToolMetas[i].source === 'mcp') {
      dynamicToolMetas.splice(i, 1)
    }
  }
}

/** 获取所有工具元数据（内置 + MCP 动态注册） */
export function getAllToolMetas(): ToolMeta[] {
  return [...TOOL_REGISTRY, ...dynamicToolMetas]
}


/** 查工具元数据（静态 TOOL_MAP + MCP 动态注册，新增——MCP 工具运行时注册，静态表查不到）。
 * 导出供 `policies.ts` 使用（宿主 barrel **不** re-export 它，保持导出面与拆分前等价）。 */
export function findToolMeta(toolId: string): ToolMeta | undefined {
  return TOOL_MAP[toolId] ?? dynamicToolMetas.find((m) => m.id === toolId)
}
