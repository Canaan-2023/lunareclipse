/**
 * MCP 资源工具：为什么存在——MCP 服务器除工具外还按协议暴露 resources
 * （配置/文档/模板等结构化数据），AI 应能像读文件一样先列出、再按 URI 读取，
 * 而不是只能调工具。作用：list_mcp_resources 列出已连接服务器的可读资源，
 * read_mcp_resource 读取单个资源（文本直接返回；二进制返回类型与大小元信息）。
 * 与执行链的关系：两个工具都是只读（behavior.readOnly=true），经统一执行链调度，
 * 大文本结果由 execute-tool 的大结果落盘机制处理。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

/** 列出已连接 MCP 服务器的可用资源（uri/名称/描述/类型） */
export class ListMcpResourcesTool implements Tool {
  name = 'list_mcp_resources'
  description =
    '列出已连接 MCP 服务器的可读资源（uri/名称/描述/类型）。何时用：需要读取外部 MCP 服务器提供的数据（配置、文档、模板等）时，先调用本工具查看有哪些可读资源，再按返回的 uri 用 read_mcp_resource 读取。可选参数 server 按服务器名过滤，不传则列出全部。没有已连接服务器或服务器未开放资源时返回空列表。'
  parameters = [
    {
      name: 'server',
      type: 'string' as const,
      description: 'MCP 服务器名（选填；不传列出全部服务器资源）',
      required: false
    }
  ]
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const manager = ctx?.getMcpClientManager?.()
    if (!manager) {
      return { ok: false, error: '当前环境不支持 MCP 资源查询（MCP 客户端未初始化）' }
    }
    const server = typeof params.server === 'string' && params.server.trim() ? params.server.trim() : undefined
    const all = manager.getAllResources()
    const filtered = server ? all.filter((e) => e.serverName === server) : all
    const resources = filtered.flatMap((e) =>
      e.resources.map((r) => ({
        server: e.serverName,
        uri: r.uri,
        name: r.name ?? null,
        description: r.description ?? null,
        mimeType: r.mimeType ?? null
      }))
    )
    return {
      ok: true,
      data: {
        server: server ?? '(全部)',
        total: resources.length,
        message:
          resources.length > 0
            ? '找到以下可读资源，用 read_mcp_resource 按 server + uri 读取'
            : '未找到资源：服务器可能未开放 resources 能力、未连接，或无可用资源',
        resources
      }
    }
  }
}

/** 读取指定 MCP 服务器的资源内容（文本直接返回；二进制返回元信息） */
export class ReadMcpResourceTool implements Tool {
  name = 'read_mcp_resource'
  description =
    '读取指定 MCP 服务器的资源内容：传入 server（服务器名）与 uri（资源地址，来自 list_mcp_resources 的返回）。文本资源返回内容全文；二进制资源返回类型与大小元信息（不进文本通道，按需另取）。何时用：已通过 list_mcp_resources 找到目标资源后，用其返回的 server + uri 读取。'
  parameters = [
    {
      name: 'server',
      type: 'string' as const,
      description: 'MCP 服务器名（来自 list_mcp_resources 返回的 server 字段）',
      required: true
    },
    {
      name: 'uri',
      type: 'string' as const,
      description: '资源地址（来自 list_mcp_resources 返回的 uri 字段）',
      required: true
    }
  ]
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const manager = ctx?.getMcpClientManager?.()
    if (!manager) {
      return { ok: false, error: '当前环境不支持 MCP 资源读取（MCP 客户端未初始化）' }
    }
    const server = typeof params.server === 'string' ? params.server.trim() : ''
    const uri = typeof params.uri === 'string' ? params.uri.trim() : ''
    if (!server) return { ok: false, error: '参数 server 必填（MCP 服务器名）' }
    if (!uri) return { ok: false, error: '参数 uri 必填（资源地址）' }
    const result = await manager.readResource(server, uri)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, data: result.data }
  }
}