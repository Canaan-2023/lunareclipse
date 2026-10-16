/**
 * 动态工具检索工具：为什么存在——MCP/插件工具较多（>8）时全量注入会撑爆上下文，改为
 * 按需渐进披露：AI 用关键词找出当前可用的动态工具。
 * 作用：tool_search 在 MCP/插件工具元信息中按关键词检索，返回符合启用策略的候选工具。
 *
 * 2026-10-15 扩展：同时披露内置 deferred 工具（低频/特化工具不进 system prompt 清单，
 * 如 NotebookEdit——AI 需要时用 tool_search 查到它的 schema 后直接调用）。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import type { McpClientManager } from '../mcp/client-manager'
import type { ToolRegistry } from './tool-registry'
import { adaptMcpToolMeta } from '../mcp/tool-adapter'
import { getFrontendTools, isToolEnabled } from '@shared/tools/registry'

/**
 * tool_search：
 * 渐进式披露桥——两类工具不全量注入 system prompt 时，AI 用本工具按关键词查找：
 * 1) MCP/插件工具较多（>8）时（渐进披露）；
 * 2) 内置 deferred 工具（延迟披露，如 NotebookEdit）。
 * 返回候选工具的名称/描述/参数 schema，找到后直接调用。
 *
 * 用法：tool_search(query) → 返回匹配的动态工具列表；不传 query 则列出全部。
 * 工具本身是桥，不执行目标工具——只披露。
 */
export class ToolSearchTool implements Tool {
  name = 'tool_search'
  // 行为声明：纯只读查询（只披露元信息，不执行目标工具、无副作用）。
  // 必须显式声明 readOnly=true：否则计划模式只读闸（execute-tool）不豁免本工具，
  // AI 在计划阶段无法检索 MCP/延迟披露工具，渐进披露链路断裂。
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  description = `搜索并返回当前可用的动态工具列表（名称/用途/参数说明）：包括 MCP/插件工具，以及不在工具清单中的内置特化工具（如 NotebookEdit）。
触发时机：系统提示里的工具清单没有包含某些可用动态工具时——按关键词搜索，找到目标工具后直接调用它；不传 query 则列出全部动态工具。
用法：tool_search(query) 如 "tool_search: notebook" 列出 Notebook 编辑相关工具。`
  parameters = [
    {
      name: 'query',
      type: 'string' as const,
      description: '搜索关键词（匹配工具名/描述，不传则列出全部）',
      required: false
    }
  ]

  private getMcpClientManager: () => McpClientManager | null
  /** 统一工具池（按 policy/visible 过滤后的启用工具），用于披露内置 deferred 工具的 schema */
  private registry: ToolRegistry | null

  constructor(
    getMcpClientManager: () => McpClientManager | null,
    registry: ToolRegistry | null = null
  ) {
    this.getMcpClientManager = getMcpClientManager
    this.registry = registry
  }

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const query = String(params.query ?? '').trim().toLowerCase()
    const policy = (ctx?.config as { frontendToolPolicy?: { tools?: Record<string, { enabled: boolean }> } } | undefined)
      ?.frontendToolPolicy?.tools

    // 内置 deferred 工具：注册表声明 deferred 且当前统一池实际包含（policy+visible 已过滤）
    const builtinDeferred = (this.registry ? getFrontendTools() : [])
      .filter((meta) => meta.deferred && this.registry!.tools.has(meta.id))
      .map((meta) => {
        const inst = this.registry!.tools.get(meta.id)!
        return {
          id: meta.id,
          name: inst.name,
          server: '',
          source: 'builtin' as const,
          description: inst.description,
          parameters: toolParametersToJsonSchema(inst.parameters)
        }
      })

    // MCP/插件工具：适配成 meta + 按 policy 过滤
    const mcp = this.getMcpClientManager()
    const mcpTools = mcp?.getAllTools() ?? []
    const dynamic = mcpTools.map(({ serverName, tool }) => adaptMcpToolMeta(serverName, tool))
    const enabledDynamic = dynamic.filter((meta) => !policy || isToolEnabled(meta.id, policy))
    const dynamicMapped = enabledDynamic.map((m) => ({
      id: m.id,
      name: m.name,
      server: m.mcpServer ?? '',
      source: 'mcp' as const,
      description: m.description ?? '',
      // 参数 schema 从原始 MCP tool 取（按 server+toolName 直查，避免重复适配）
      parameters: mcpTools.find((t) => m.mcpServer === t.serverName && m.mcpToolName === t.tool.name)?.tool.inputSchema ?? undefined
    }))

    const all = [...builtinDeferred, ...dynamicMapped]

    // 关键词匹配（工具名 / 描述 / server 名）
    const matched = query
      ? all.filter(
          (m) =>
            m.id.toLowerCase().includes(query) ||
            (m.description ?? '').toLowerCase().includes(query) ||
            (m.server ?? '').toLowerCase().includes(query)
        )
      : all

    return {
      ok: true,
      data: {
        query: query || '(全部)',
        total: matched.length,
        message: matched.length > 0
          ? '找到以下动态工具，直接按 id 调用即可'
          : `未找到匹配 "${query}" 的动态工具`,
        tools: matched
      }
    }
  }
}

/** 把 AnyTool 的数组式 parameters 转成 JSON schema（同 tool-bridge 口径） */
function toolParametersToJsonSchema(
  params: Array<{ name: string; type: string; description: string; required?: boolean }>
): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const p of params) {
    properties[p.name] = {
      type: p.type,
      description: p.description
    }
    if (p.required) required.push(p.name)
  }
  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined
  }
}

/**
 * 把 tool_search 桥注册到统一工具池。启动路径（server.ts startApiServer）与热更新路径
 * （server-assembly.ts rebuildToolExecutors）共用同一实现，避免两处注册逻辑漂移——
 * 历史上热更新重建 registry 后漏注册本工具，导致切换工具策略后 tool_search 悬空引用
 * （工具还在描述里提示可用，但执行器列表里没有它，AI 一调就 404）。
 */
export function installToolSearchBridge(
  toolRegistry: ToolRegistry,
  mcpClientManager?: McpClientManager | null
): void {
  const toolSearch = new ToolSearchTool(() => mcpClientManager ?? null, toolRegistry)
  toolRegistry.tools.set('tool_search', toolSearch)
}
