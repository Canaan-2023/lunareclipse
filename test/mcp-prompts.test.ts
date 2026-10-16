import { describe, it, expect } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import type { McpClientManager } from '../electron/main/mcp/client-manager'

/**
 * MCP prompts 工具（list_mcp_prompts / get_mcp_prompt）
 * 为什么存在：MCP 服务器除工具/资源外还暴露 prompts（提示模板，可带参数展开为消息序列），
 * AI 应先列出再按名获取展开内容。本测试覆盖：列表全量/过滤/空态、未注入管理器 fail-closed、
 * 获取文本/参数透传/错误透传、参数校验。
 */

interface FakePromptEntry {
  serverName: string
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>
}

function makeFakeManager(opts: {
  all?: FakePromptEntry[]
  get?: (server: string, name: string, args?: Record<string, string>) => unknown
}): McpClientManager {
  return {
    getAllPrompts: () => opts.all ?? [],
    getPrompt: opts.get ??
      (async (server: string, name: string) => ({
        ok: true,
        data: {
          description: `template ${name} from ${server}`,
          messages: [{ role: 'user', text: `hello from ${name}` }]
        }
      } as const))
  } as unknown as McpClientManager
}

function makeRegistry(manager: McpClientManager | null): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.ctx.sessionId = 's-mcp'
  r.ctx.getMcpClientManager = manager ? () => manager : undefined
  return r
}

describe('list_mcp_prompts', () => {
  it('未注入 MCP 管理器时 fail-closed 报错', async () => {
    const registry = makeRegistry(null)
    const r = await executeTool(registry, 'list_mcp_prompts', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不支持 MCP prompt 查询')
  })

  it('列出全部服务器 prompt 模板（含 server/name/description/arguments）', async () => {
    const manager = makeFakeManager({
      all: [
        {
          serverName: 'code',
          prompts: [
            {
              name: 'review',
              description: '代码审查模板',
              arguments: [{ name: 'language', description: '语言', required: true }]
            },
            { name: 'daily' }
          ]
        },
        { serverName: 'docs', prompts: [{ name: 'summarize', description: '总结模板' }] }
      ]
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'list_mcp_prompts', {})
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; server: string; prompts: Array<{ server: string; name: string; arguments: unknown[] }> }
    expect(data.total).toBe(3)
    expect(data.server).toBe('(全部)')
    expect(data.prompts[0].server).toBe('code')
    expect(data.prompts[0].name).toBe('review')
    expect(data.prompts[0].arguments).toEqual([{ name: 'language', description: '语言', required: true }])
    expect(data.prompts[1].arguments).toEqual([])
    expect(data.prompts[2].server).toBe('docs')
  })

  it('按 server 过滤只返回该服务器模板', async () => {
    const manager = makeFakeManager({
      all: [
        { serverName: 'code', prompts: [{ name: 'review' }] },
        { serverName: 'docs', prompts: [{ name: 'summarize' }] }
      ]
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'list_mcp_prompts', { server: 'docs' })
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; server: string; prompts: Array<{ name: string }> }
    expect(data.server).toBe('docs')
    expect(data.total).toBe(1)
    expect(data.prompts[0].name).toBe('summarize')
  })

  it('无可用模板时返回空列表与引导信息', async () => {
    const registry = makeRegistry(makeFakeManager({ all: [] }))
    const r = await executeTool(registry, 'list_mcp_prompts', {})
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; prompts: unknown[]; message: string }
    expect(data.total).toBe(0)
    expect(data.prompts).toEqual([])
    expect(data.message).toContain('未找到 prompt 模板')
  })
})

describe('get_mcp_prompt', () => {
  it('未注入 MCP 管理器时 fail-closed 报错', async () => {
    const registry = makeRegistry(null)
    const r = await executeTool(registry, 'get_mcp_prompt', { server: 's', name: 'p' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不支持 MCP prompt 获取')
  })

  it('成功返回展开后的消息序列（description + role/text）', async () => {
    const manager = makeFakeManager({
      get: async () => ({
        ok: true,
        data: {
          description: '审查模板',
          messages: [
            { role: 'user', text: '请审查以下代码' },
            { role: 'assistant', text: '收到，开始审查' }
          ]
        }
      } as const)
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'get_mcp_prompt', { server: 'code', name: 'review' })
    expect(r.ok).toBe(true)
    const data = r.data as { description: string; messages: Array<{ role: string; text: string }> }
    expect(data.description).toBe('审查模板')
    expect(data.messages).toHaveLength(2)
    expect(data.messages[0]).toEqual({ role: 'user', text: '请审查以下代码' })
  })

  it('arguments 键值对透传给底层 getPrompt', async () => {
    let passedArgs: Record<string, string> | undefined
    const manager = makeFakeManager({
      get: async (_server: string, _name: string, args?: Record<string, string>) => {
        passedArgs = args
        return { ok: true, data: { messages: [{ role: 'user', text: 'ok' }] } } as const
      }
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'get_mcp_prompt', {
      server: 'code',
      name: 'review',
      arguments: { language: 'ts', style: 'strict' }
    })
    expect(r.ok).toBe(true)
    expect(passedArgs).toEqual({ language: 'ts', style: 'strict' })
  })

  it('缺参数时明确报错', async () => {
    const registry = makeRegistry(makeFakeManager({}))
    const noServer = await executeTool(registry, 'get_mcp_prompt', { name: 'p' })
    expect(noServer.ok).toBe(false)
    expect(noServer.error).toContain('server 必填')
    const noName = await executeTool(registry, 'get_mcp_prompt', { server: 's' })
    expect(noName.ok).toBe(false)
    expect(noName.error).toContain('name 必填')
  })

  it('底层获取失败时透传错误（模板不存在/服务器未连接）', async () => {
    const manager = makeFakeManager({
      get: async () => ({ ok: false, error: '模板不存在' } as const)
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'get_mcp_prompt', { server: 'code', name: 'missing' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('模板不存在')
  })
})