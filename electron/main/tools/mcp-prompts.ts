/**
 * MCP prompt 工具：为什么存在——MCP 服务器除工具/资源外还按协议暴露 prompts
 * （提示模板，可带参数展开为消息序列），AI 应能先列出、再按名获取展开内容，
 * 而不是只能调工具。作用：list_mcp_prompts 列出已连接服务器的可用 prompt 模板，
 * get_mcp_prompt 按名获取模板内容（可传参，返回展开后的 role/text 消息序列）。
 * 与执行链的关系：两个工具都是只读（behavior.readOnly=true），经统一执行链调度，
 * 大文本结果由 execute-tool 的大结果落盘机制处理。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

/** 列出已连接 MCP 服务器的可用 prompt 模板（name/描述/参数） */
export class ListMcpPromptsTool implements Tool {
  name = 'list_mcp_prompts'
  description =
    '列出已连接 MCP 服务器的可用 prompt 模板（名称/描述/参数）。何时用：需要套用外部 MCP 服务器提供的提示模板（代码审查、日报生成、对话开场等）时，先调用本工具查看有哪些模板，再按返回的 name 用 get_mcp_prompt 获取展开内容。可选参数 server 按服务器名过滤，不传则列出全部。没有已连接服务器或服务器未开放 prompts 能力时返回空列表。'
  parameters = [
    {
      name: 'server',
      type: 'string' as const,
      description: 'MCP 服务器名（选填；不传列出全部服务器模板）',
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
      return { ok: false, error: '当前环境不支持 MCP prompt 查询（MCP 客户端未初始化）' }
    }
    const server = typeof params.server === 'string' && params.server.trim() ? params.server.trim() : undefined
    const all = manager.getAllPrompts()
    const filtered = server ? all.filter((e) => e.serverName === server) : all
    const prompts = filtered.flatMap((e) =>
      e.prompts.map((p) => ({
        server: e.serverName,
        name: p.name,
        description: p.description ?? null,
        arguments: (p.arguments ?? []).map((a) => ({
          name: a.name,
          description: a.description ?? null,
          required: a.required ?? false
        }))
      }))
    )
    return {
      ok: true,
      data: {
        server: server ?? '(全部)',
        total: prompts.length,
        message:
          prompts.length > 0
            ? '找到以下 prompt 模板，用 get_mcp_prompt 按 server + name 获取展开内容'
            : '未找到 prompt 模板：服务器可能未开放 prompts 能力、未连接，或无可用模板',
        prompts
      }
    }
  }
}

/** 获取指定 MCP 服务器的 prompt 模板内容（可传参，返回展开后的消息序列） */
export class GetMcpPromptTool implements Tool {
  name = 'get_mcp_prompt'
  description =
    '获取指定 MCP 服务器的 prompt 模板内容：传入 server（服务器名）与 name（模板名，来自 list_mcp_prompts 的返回）；可选 arguments 传模板参数（键值对）。返回模板展开后的消息序列（role + text）。何时用：已通过 list_mcp_prompts 找到目标模板后，用其返回的 server + name 获取内容并套用到当前任务。'
  parameters = [
    {
      name: 'server',
      type: 'string' as const,
      description: 'MCP 服务器名（来自 list_mcp_prompts 返回的 server 字段）',
      required: true
    },
    {
      name: 'name',
      type: 'string' as const,
      description: 'prompt 模板名（来自 list_mcp_prompts 返回的 name 字段）',
      required: true
    },
    {
      name: 'arguments',
      type: 'object' as const,
      description: '模板参数（键值对，选填；按模板声明的 arguments 传入）',
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
      return { ok: false, error: '当前环境不支持 MCP prompt 获取（MCP 客户端未初始化）' }
    }
    const server = typeof params.server === 'string' ? params.server.trim() : ''
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    if (!server) return { ok: false, error: '参数 server 必填（MCP 服务器名）' }
    if (!name) return { ok: false, error: '参数 name 必填（prompt 模板名）' }
    let args: Record<string, string> | undefined
    if (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) {
      args = {}
      for (const [k, v] of Object.entries(params.arguments as Record<string, unknown>)) {
        if (typeof v === 'string') args[k] = v
      }
    }
    const result = await manager.getPrompt(server, name, args)
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, data: result.data }
  }
}