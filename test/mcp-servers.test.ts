import { describe, it, expect } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import type { McpClientManager } from '../electron/main/mcp/client-manager'
import type { McpServerStatusSummary } from '../shared/types'

/**
 * MCP 服务器状态工具（mcp_list_servers）
 * 为什么存在：AI 在调用 mcp_<server>__<tool> 前应先确认服务器连接状态（status/toolCount/
 * lastError），而不是盲目调用得到"服务器未连接"类错误。本测试覆盖：未注入管理器 fail-closed、
 * 列出全部状态摘要、空态引导、以及只读行为声明。
 */

function makeFakeManager(statuses: McpServerStatusSummary[]): McpClientManager {
  return {
    getServerStatuses: () => statuses
  } as unknown as McpClientManager
}

function makeRegistry(manager: McpClientManager | null): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.ctx.sessionId = 's-mcp'
  r.ctx.getMcpClientManager = manager ? () => manager : undefined
  return r
}

describe('mcp_list_servers', () => {
  it('未注入 MCP 管理器时 fail-closed 报错', async () => {
    const registry = makeRegistry(null)
    const r = await executeTool(registry, 'mcp_list_servers', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不支持 MCP 服务器查询')
  })

  it('列出全部服务器状态摘要（status/toolCount/lastError）', async () => {
    const manager = makeFakeManager([
      { name: 'files', status: 'connected', toolCount: 3, promptCount: 0, lastError: null },
      { name: 'docs', status: 'error', toolCount: 0, promptCount: 0, lastError: 'connection refused' }
    ])
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'mcp_list_servers', {})
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; servers: McpServerStatusSummary[]; message?: string }
    expect(data.total).toBe(2)
    expect(data.servers[0]).toEqual({ name: 'files', status: 'connected', toolCount: 3, promptCount: 0, lastError: null })
    expect(data.servers[1]).toEqual({ name: 'docs', status: 'error', toolCount: 0, promptCount: 0, lastError: 'connection refused' })
    expect(data.message).toContain('connected')
  })

  it('未配置任何服务器时返回空列表与引导信息', async () => {
    const registry = makeRegistry(makeFakeManager([]))
    const r = await executeTool(registry, 'mcp_list_servers', {})
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; servers: unknown[]; message: string }
    expect(data.total).toBe(0)
    expect(data.servers).toEqual([])
    expect(data.message).toContain('没有已启用的 MCP 服务器')
  })

  it('工具声明为只读且并发安全（behavior 契约）', async () => {
    const registry = makeRegistry(null)
    const tool = registry.tools.get('mcp_list_servers')
    expect(tool).toBeDefined()
    expect(tool?.behavior?.readOnly).toBe(true)
    expect(tool?.behavior?.concurrencySafe).toBe(true)
  })
})