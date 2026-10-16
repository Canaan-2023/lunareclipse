import { describe, it, expect, vi } from 'vitest'
import { McpClientManager } from '../electron/main/mcp/client-manager'
import type { McpServerInstance } from '../electron/main/mcp/types'

/**
 * client-manager prompts 方法单测（getAllPrompts / getPrompt / getServerStatuses.promptCount）。
 * 为什么注入 fake client：SDK Client 需要真实 MCP server 才能返回结果，prompts 方法只
 * 依赖 instance.client 的 listPrompts/getPrompt 契约，用薄 fake 验证聚合/降级/错误透传逻辑。
 */

function makeInstance(overrides: Partial<McpServerInstance> = {}): McpServerInstance {
  return {
    config: { name: 'srv', transport: 'stdio', command: 'echo', enabled: true },
    status: 'connected',
    client: null,
    tools: [],
    resources: [],
    prompts: [],
    lastError: null,
    reconnectAttempts: 0,
    ...overrides
  } as McpServerInstance
}

function inject(manager: McpClientManager, instances: Record<string, McpServerInstance>): void {
  const servers = (manager as unknown as { servers: Map<string, McpServerInstance> }).servers
  servers.clear()
  for (const [name, inst] of Object.entries(instances)) servers.set(name, inst)
}

describe('McpClientManager prompts', () => {
  it('getAllPrompts 只返回已连接且带模板的 server', () => {
    const manager = new McpClientManager()
    inject(manager, {
      a: makeInstance({ status: 'connected', prompts: [{ name: 'review' }] }),
      b: makeInstance({ status: 'connected', prompts: [] }),
      c: makeInstance({ status: 'error', prompts: [{ name: 'stale' }] })
    })
    const all = manager.getAllPrompts()
    expect(all).toHaveLength(1)
    expect(all[0].serverName).toBe('a')
    expect(all[0].prompts[0].name).toBe('review')
  })

  it('getServerStatuses 返回 promptCount', () => {
    const manager = new McpClientManager()
    inject(manager, {
      a: makeInstance({ status: 'connected', prompts: [{ name: 'x' }, { name: 'y' }] })
    })
    const statuses = manager.getServerStatuses()
    expect(statuses[0].promptCount).toBe(2)
    expect(statuses[0].toolCount).toBe(0)
  })

  it('getPrompt 未连接时返回错误', async () => {
    const manager = new McpClientManager()
    inject(manager, {})
    const r = await manager.getPrompt('missing', 'review')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未连接')
  })

  it('getPrompt 成功时透传 description 与 text 消息', async () => {
    const manager = new McpClientManager()
    const client = {
      getPrompt: vi.fn().mockResolvedValue({
        description: '模板描述',
        messages: [
          { role: 'user', content: { type: 'text', text: 'hello' } },
          { role: 'assistant', content: { type: 'text', text: 'world' } }
        ]
      })
    }
    inject(manager, { srv: makeInstance({ client: client as never }) })
    const r = await manager.getPrompt('srv', 'review', { lang: 'ts' })
    expect(client.getPrompt).toHaveBeenCalledWith({ name: 'review', arguments: { lang: 'ts' } })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.description).toBe('模板描述')
      expect(r.data.messages).toEqual([
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'world' }
      ])
    }
  })

  it('getPrompt 非文本内容降级为占位说明（不进文本通道）', async () => {
    const manager = new McpClientManager()
    const client = {
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          { role: 'user', content: { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' } }
        ]
      })
    }
    inject(manager, { srv: makeInstance({ client: client as never }) })
    const r = await manager.getPrompt('srv', 'img')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.messages[0].text).toContain('非文本内容')
      expect(r.data.messages[0].text).toContain('image')
    }
  })

  it('getPrompt 底层报错时透传错误', async () => {
    const manager = new McpClientManager()
    const client = {
      getPrompt: vi.fn().mockRejectedValue(new Error('模板不存在'))
    }
    inject(manager, { srv: makeInstance({ client: client as never }) })
    const r = await manager.getPrompt('srv', 'missing')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('模板不存在')
  })

  it('getPrompt 空消息时明确报错', async () => {
    const manager = new McpClientManager()
    const client = {
      getPrompt: vi.fn().mockResolvedValue({ messages: [] })
    }
    inject(manager, { srv: makeInstance({ client: client as never }) })
    const r = await manager.getPrompt('srv', 'empty')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('无内容')
  })
})