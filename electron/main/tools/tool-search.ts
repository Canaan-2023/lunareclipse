/**
 * 动态工具检索工具：为什么存在——MCP/插件工具较多（>8）时全量注入会撑爆上下文，改为
 * 按需渐进披露：AI 用关键词找出当前可用的动态工具。
 * 作用：tool_search 在 MCP/插件工具元信息中按关键词检索，返回符合启用策略的候选工具。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import type { McpClientManager } from '../mcp/client-manager'
import { adaptMcpToolMeta } from '../mcp/tool-adapter'
import { isToolEnabled } from '@shared/tools/registry'

/**
 * tool_search：
 * 渐进式披露桥——MCP/插件工具较多（>8）时不全量注入，AI 用本工具按关键词查找可用动态工具
 * 及其参数 schema，找到后直接调用。
 *
 * 用法：tool_search(query) → 返回匹配的 MCP/插件工具列表（名称 + 描述 + 参数 schema）。
 * 工具本身是桥，不执行目标工具——只披露。
 */
export class ToolSearchTool implements Tool {
  name = 'tool_search'
  description = `搜索并返回当前可用的 MCP/插件动态工具列表（名称/用途/参数说明）。
触发时机：系统提示里的工具清单没有包含某些可用动态工具时——按关键词搜索，找到目标工具后直接调用它；不传 query 则列出全部动态工具。
用法：tool_search(query) 如 "tool_search: export" 列出所有导出相关工具。`
  parameters = [
    {
      name: 'query',
      type: 'string' as const,
      description: '搜索关键词（匹配工具名/描述，不传则列出全部）',
      required: false
    }
  ]

  private getMcpClientManager: () => McpClientManager | null

  constructor(getMcpClientManager: () => McpClientManager | null) {
    this.getMcpClientManager = getMcpClientManager
  }

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const query = String(params.query ?? '').trim().toLowerCase()
    const mcp = this.getMcpClientManager()
    if (!mcp) {
      return { ok: true, data: { message: 'MCP 客户端未初始化', tools: [] } }
    }

    const mcpTools = mcp.getAllTools()
    // 适配成 meta + 按 policy 过滤
    const all = mcpTools.map(({ serverName, tool }) => adaptMcpToolMeta(serverName, tool))
    const policy = (ctx?.config as { frontendToolPolicy?: { tools?: Record<string, { enabled: boolean }> } } | undefined)
      ?.frontendToolPolicy?.tools
    const enabled = all.filter((meta) => !policy || isToolEnabled(meta.id, policy))

    // 关键词匹配（工具名 / 描述 / server 名）
    const matched = query
      ? enabled.filter(
          (m) =>
            m.id.toLowerCase().includes(query) ||
            (m.description ?? '').toLowerCase().includes(query) ||
            (m.mcpServer ?? '').toLowerCase().includes(query)
        )
      : enabled

    const tools = matched.map((m) => ({
      id: m.id,
      name: m.name,
      server: m.mcpServer ?? '',
      description: m.description ?? '',
      // 参数 schema 从原始 MCP tool 取
      parameters: mcpTools.find((t) => adaptMcpToolMeta(t.serverName, t.tool).id === m.id)?.tool.inputSchema ?? undefined
    }))

    return {
      ok: true,
      data: {
        query: query || '(全部)',
        total: matched.length,
        message: matched.length > 0
          ? '找到以下动态工具，直接按 id 调用即可'
          : `未找到匹配 "${query}" 的动态工具`,
        tools
      }
    }
  }
}
