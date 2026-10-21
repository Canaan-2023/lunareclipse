import { describe, it, expect } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import { extractResourceParts } from '../electron/main/mcp/client-manager'
import type { McpClientManager } from '../electron/main/mcp/client-manager'

/**
 * MCP resources 工具（list_mcp_resources / read_mcp_resource）
 * 为什么存在：MCP 服务器除工具外还暴露 resources（配置/文档/模板），AI 应先列出再按
 * uri 读取。本测试覆盖：列表全量/过滤/空态、未注入管理器 fail-closed、读取文本/二进制
 * 元信息/参数校验/错误透传，以及内容提取纯函数（text 直通、blob 转元信息）。
 */

interface FakeResourceEntry {
  serverName: string
  resources: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
}

function makeFakeManager(opts: { all?: FakeResourceEntry[]; read?: (server: string, uri: string) => unknown }): McpClientManager {
  return {
    getAllResources: () => opts.all ?? [],
    readResource: opts.read ??
      (async (server: string, uri: string) => ({ ok: true, data: `content of ${uri} from ${server}` }))
  } as unknown as McpClientManager
}

function makeRegistry(manager: McpClientManager | null): ReturnType<typeof createToolRegistry> {
  // 默认工具池已含 list_mcp_resources / read_mcp_resource（agents=['frontend']、defaultEnabled）
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.ctx.sessionId = 's-mcp'
  r.ctx.getMcpClientManager = manager ? () => manager : undefined
  return r
}

describe('list_mcp_resources', () => {
  it('未注入 MCP 管理器时 fail-closed 报错', async () => {
    const registry = makeRegistry(null)
    const r = await executeTool(registry, 'list_mcp_resources', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不支持 MCP 资源查询')
  })

  it('列出全部服务器资源（含 server/uri/name/description/mimeType）', async () => {
    const manager = makeFakeManager({
      all: [
        {
          serverName: 'files',
          resources: [
            { uri: 'file:///config.json', name: '配置', description: '应用配置', mimeType: 'application/json' },
            { uri: 'file:///readme.md', name: 'README' }
          ]
        },
        { serverName: 'docs', resources: [{ uri: 'docs:///guide', description: '使用指南' }] }
      ]
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'list_mcp_resources', {})
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; server: string; resources: Array<{ server: string; uri: string }> }
    expect(data.total).toBe(3)
    expect(data.server).toBe('(全部)')
    expect(data.resources[0].server).toBe('files')
    expect(data.resources[0].uri).toBe('file:///config.json')
    expect(data.resources[2].server).toBe('docs')
  })

  it('按 server 过滤只返回该服务器资源', async () => {
    const manager = makeFakeManager({
      all: [
        { serverName: 'files', resources: [{ uri: 'file:///a' }] },
        { serverName: 'docs', resources: [{ uri: 'docs:///b' }] }
      ]
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'list_mcp_resources', { server: 'docs' })
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; server: string; resources: Array<{ server: string; uri: string }> }
    expect(data.server).toBe('docs')
    expect(data.total).toBe(1)
    expect(data.resources[0].uri).toBe('docs:///b')
  })

  it('无可用资源时返回空列表与引导信息', async () => {
    const registry = makeRegistry(makeFakeManager({ all: [] }))
    const r = await executeTool(registry, 'list_mcp_resources', {})
    expect(r.ok).toBe(true)
    const data = r.data as { total: number; resources: unknown[]; message: string }
    expect(data.total).toBe(0)
    expect(data.resources).toEqual([])
    expect(data.message).toContain('未找到资源')
  })
})

describe('read_mcp_resource', () => {
  it('未注入 MCP 管理器时 fail-closed 报错', async () => {
    const registry = makeRegistry(null)
    const r = await executeTool(registry, 'read_mcp_resource', { server: 's', uri: 'u' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不支持 MCP 资源读取')
  })

  it('文本资源直接返回内容', async () => {
    const manager = makeFakeManager({
      read: async () => ({ ok: true, data: '全文内容' } as const)
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'read_mcp_resource', { server: 'files', uri: 'file:///readme.md' })
    expect(r.ok).toBe(true)
    expect(r.data).toBe('全文内容')
  })

  it('二进制资源返回元信息（sizeBytes 估算、不含 base64 字节）', async () => {
    const manager = makeFakeManager({
      read: async () =>
        ({ ok: true, data: { binary: { uri: 'file:///img.png', mimeType: 'image/png', sizeBytes: 100 } } } as const)
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'read_mcp_resource', { server: 'files', uri: 'file:///img.png' })
    expect(r.ok).toBe(true)
    const data = r.data as { binary: { uri: string; mimeType?: string; sizeBytes: number } }
    expect(data.binary.sizeBytes).toBe(100)
    expect(data.binary.mimeType).toBe('image/png')
  })

  it('缺参数时明确报错', async () => {
    const registry = makeRegistry(makeFakeManager({}))
    const noServer = await executeTool(registry, 'read_mcp_resource', { uri: 'u' })
    expect(noServer.ok).toBe(false)
    expect(noServer.error).toContain('server 必填')
    const noUri = await executeTool(registry, 'read_mcp_resource', { server: 's' })
    expect(noUri.ok).toBe(false)
    expect(noUri.error).toContain('uri 必填')
  })

  it('底层读取失败时透传错误（资源不存在/服务器未连接）', async () => {
    const manager = makeFakeManager({
      read: async () => ({ ok: false, error: '资源不存在' } as const)
    })
    const registry = makeRegistry(manager)
    const r = await executeTool(registry, 'read_mcp_resource', { server: 'files', uri: 'file:///missing' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('资源不存在')
  })
})

describe('extractResourceParts（内容提取纯函数）', () => {
  it('text 型内容直接返回原文', () => {
    const parts = extractResourceParts([{ uri: 'a', text: 'hello' }])
    expect(parts).toEqual(['hello'])
  })

  it('blob 型内容转元信息并估算字节数（base64 长度 × 3/4）', () => {
    // base64 'QUJD' = 'ABC'（3 字节）
    const parts = extractResourceParts([{ uri: 'img', mimeType: 'image/png', blob: 'QUJD' }])
    expect(parts).toHaveLength(1)
    const entry = parts[0] as { binary: { uri: string; mimeType?: string; sizeBytes: number } }
    expect(entry.binary.uri).toBe('img')
    expect(entry.binary.mimeType).toBe('image/png')
    expect(entry.binary.sizeBytes).toBe(3)
  })

  it('text 与 blob 混合时按序返回；空内容返回空数组', () => {
    expect(extractResourceParts([{ uri: 'a', text: 't' }, { uri: 'b', blob: 'QUJD' }])).toEqual([
      't',
      { binary: { uri: 'b', mimeType: undefined, sizeBytes: 3 } }
    ])
    expect(extractResourceParts([{ uri: 'e', text: '' }])).toEqual([])
  })
})