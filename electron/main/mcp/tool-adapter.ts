/**
 * MCP 工具适配层：为什么存在——MCP 工具（JSON Schema 入参）与月蚀原生工具
 * （ToolParameter）形态不同，外部工具必须先翻译成统一形态才能进工具池调度。
 * 作用：把 MCP Tool 转换为月蚀 AnyTool 参数结构与元信息（含类别推断、命名空间 ID），
 * 供 tool-search / registry 消费。
 * 不删理由：client-manager 将 MCP 工具接入工具池的唯一转换入口，
 * 删除后 MCP 动态工具无法进入统一调度面。
 */
import type { AnyTool, ToolResult, ToolContext, ToolParameter } from '../tools/base-tool'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpToolMeta } from '@shared/tools/registry'
import type { McpCallResult } from './types'
import type { ToolCategory } from '@shared/types'

/**
 * MCP 工具适配器

 * 将 MCP 协议的 Tool 转换为月蚀内部的 AnyTool 格式，
 * 使 MCP 工具能无缝注册到统一工具注册表，被 AI 通过 call_tool 调用。

 * 命名空间设计：mcp:{serverName}:{toolName}，保证全局唯一，
 * 避免不同 MCP server 的同名工具冲突。
 */

/** MCP 工具 → 月蚀 ToolCategory 映射（按工具名/描述关键词推断） */
function inferCategory(tool: Tool): ToolCategory {
  const name = tool.name.toLowerCase()
  const desc = (tool.description ?? '').toLowerCase()
  // 按关键词推断分类
  if (name.includes('search') || name.includes('web') || desc.includes('search') || desc.includes('network')) {
    return 'network'
  }
  if (name.includes('write') || name.includes('edit') || name.includes('create') || name.includes('delete') || name.includes('move')) {
    return 'file-write'
  }
  if (name.includes('file') || name.includes('read') || name.includes('list') || name.includes('glob') || name.includes('grep')) {
    return 'file-read'
  }
  if (name.includes('browser') || name.includes('navigate') || name.includes('click') || name.includes('screenshot')) {
    return 'browser'
  }
  if (name.includes('exec') || name.includes('command') || name.includes('shell') || name.includes('run')) {
    return 'system'
  }
  // 默认归入 system（MCP 工具多为外部服务调用，system 最通用）
  return 'system'
}

/** JSON Schema type 字符串 → 月蚀 ToolParameter type */
function mapJsonSchemaType(jsonType: unknown): ToolParameter['type'] {
  switch (jsonType) {
    case 'number':
    case 'integer':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array':
      return 'array'
    case 'object':
      return 'object'
    default:
      return 'string'
  }
}

/** MCP inputSchema → 月蚀 ToolParameter[] */
export function convertSchemaToParams(inputSchema: Tool['inputSchema']): ToolParameter[] {
  if (!inputSchema || inputSchema.type !== 'object') return []
  const properties = (inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
  const required = (inputSchema as { required?: string[] }).required ?? []
  return Object.entries(properties).map(([name, schema]) => {
    const s = schema as { type?: string; description?: string }
    return {
      name,
      type: mapJsonSchemaType(s.type),
      description: s.description ?? '',
      required: required.includes(name)
    }
  })
}

/** MCP 工具 → 月蚀 AnyTool */
export function adaptMcpTool(
  serverName: string,
  tool: Tool,
  callMcpTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<McpCallResult>
): AnyTool {
  const namespacedId = `mcp:${serverName}:${tool.name}`
  return {
    name: namespacedId,
    description: `[MCP:${serverName}] ${tool.description ?? tool.name}`,
    parameters: convertSchemaToParams(tool.inputSchema),
    async execute(params: Record<string, unknown>, _ctx?: ToolContext): Promise<ToolResult> {
      const result = await callMcpTool(serverName, tool.name, params)
      if (result.ok) {
        return { ok: true, data: result.data }
      }
      return { ok: false, error: result.error }
    }
  }
}

/** MCP 工具 → 月蚀 ToolMeta（扩展为 McpToolMeta） */
export function adaptMcpToolMeta(serverName: string, tool: Tool): McpToolMeta {
  return {
    id: `mcp:${serverName}:${tool.name}`,
    name: tool.name,
    category: inferCategory(tool),
    description: tool.description ?? tool.name,
    defaultEnabled: true,
    riskLevel: 'medium', // MCP 工具默认中等风险（外部服务，行为不可预测）
    agents: ['frontend', 'dmn'], // MCP 工具前端 AI 和 DMN 都可用
    source: 'mcp',
    mcpServer: serverName,
    mcpToolName: tool.name
  }
}
