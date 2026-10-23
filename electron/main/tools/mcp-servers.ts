/**
 * MCP 服务器管理工具：为什么存在——AI 在决定调用某个 mcp_<server>__<tool> 之前，
 * 需要先看清各 MCP 服务器本身的运行时状态（是否已连接、暴露了多少工具、最近连接错误），
 * 而不是盲目调用导致得到"服务器未连接"类错误。作用：mcp_list_servers 列出全部已启用
 * MCP 服务器的状态摘要（name/status/toolCount/lastError），与 list_mcp_resources 形成互补
 * （一个是看"服务器有哪些工具/资源可用"，一个是看"服务器本身连接得怎么样"）。
 * 与执行链的关系：只读（behavior.readOnly=true），经统一执行链调度；连接/断开等写操作
 * 由前端 UI 经 IPC（mcp:connect / mcp:disconnect）管理，工具面不重复建设。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

/** 列出已启用 MCP 服务器的运行状态摘要（连接状态/工具数/最近错误） */
export class ListMcpServersTool implements Tool {
  name = 'mcp_list_servers'
  description =
    '列出已启用 MCP 服务器的运行状态摘要（连接状态/工具数/最近错误）。何时用：需要调用外部 MCP 服务器工具或读取其资源前，或调用 mcp_<server>__<tool> 失败后，先调用本工具确认服务器是否已连接；status=error 或 disconnected 时不要直接调用该服务器工具，应先提示用户通过前端 MCP 面板重连。没有启用任何服务器时返回空列表。'
  parameters = []
  behavior = {
    readOnly: true,
    concurrencySafe: true
  }
  async execute(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const manager = ctx?.getMcpClientManager?.()
    if (!manager) {
      return { ok: false, error: '当前环境不支持 MCP 服务器查询（MCP 客户端未初始化）' }
    }
    const statuses = manager.getServerStatuses()
    return {
      ok: true,
      data: {
        total: statuses.length,
        servers: statuses,
        message:
          statuses.length > 0
            ? '调用 MCP 服务器工具前先核对 status：connected 才可调用；error/disconnected/reconnecting 请先让用户在前端 MCP 面板处理'
            : '没有已启用的 MCP 服务器：如需外部工具/资源，请先在前端 MCP 面板添加并启用服务器'
      }
    }
  }
}