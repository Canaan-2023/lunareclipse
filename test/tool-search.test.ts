import { describe, it, expect } from 'vitest'
import { createToolRegistry } from '../electron/main/tools/index'
import { ToolSearchTool } from '../electron/main/tools/tool-search'
import { NotebookEditTool } from '../electron/main/tools/notebook-edit'

/**
 * tool_search 扩展（内置 deferred 工具披露）：
 * 延迟披露的内置工具（如 NotebookEdit）不进 system prompt 工具清单，AI 用 tool_search
 * 按关键词发现其 schema 后直接调用。本测试覆盖：能搜到延迟工具、参数 schema 完整、
 * 未启用工具不披露、关键词不匹配返回空、MCP 未初始化不影响内置披露。
 */

function makeSearch(): { search: ToolSearchTool; registry: ReturnType<typeof createToolRegistry> } {
  const registry = createToolRegistry({ config: {} } as never, {} as never)
  registry.tools.set('NotebookEdit', new NotebookEditTool())
  const search = new ToolSearchTool(() => null, registry)
  return { search, registry }
}

describe('tool_search × 内置 deferred 工具披露', () => {
  it('按关键词能搜到延迟披露的 NotebookEdit，并返回完整参数 schema', async () => {
    const { search } = makeSearch()
    const r = await search.execute({ query: 'notebook' })
    expect(r.ok).toBe(true)
    const data = r.data as { tools: Array<Record<string, unknown>> }
    expect(data.total).toBeGreaterThanOrEqual(1)
    const nb = data.tools.find((t) => t.id === 'NotebookEdit')
    expect(nb).toBeTruthy()
    expect(nb?.source).toBe('builtin')
    const params = nb?.parameters as {
      type: string
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(params.type).toBe('object')
    expect(Object.keys(params.properties)).toContain('notebook_path')
    expect(params.required).toContain('notebook_path')
  })

  it('不传 query 时列出全部（含内置 deferred 工具）', async () => {
    const { search } = makeSearch()
    const r = await search.execute({})
    const data = r.data as { tools: Array<{ id: string }> }
    expect(data.tools.some((t) => t.id === 'NotebookEdit')).toBe(true)
  })

  it('关键词不匹配时返回空列表', async () => {
    const { search } = makeSearch()
    const r = await search.execute({ query: 'zzz_nonexistent_zzz' })
    const data = r.data as { total: number; tools: unknown[] }
    expect(data.total).toBe(0)
    expect(data.tools).toHaveLength(0)
  })

  it('被策略关闭的 deferred 工具不披露（registry 不含 → 不可发现）', async () => {
    // policy 显式关闭 NotebookEdit：统一池不包含它，tool_search 不应披露
    const registry = createToolRegistry(
      { config: {} } as never,
      { toolsPolicy: { NotebookEdit: { enabled: false } } } as never
    )
    expect(registry.tools.has('NotebookEdit')).toBe(false)
    const search = new ToolSearchTool(() => null, registry)
    const r = await search.execute({ query: 'notebook' })
    const data = r.data as { tools: Array<{ id: string }> }
    expect(data.tools.some((t) => t.id === 'NotebookEdit')).toBe(false)
  })

  it('MCP 未初始化时不报错，内置披露仍可用', async () => {
    const { search } = makeSearch()
    const r = await search.execute({ query: 'notebook' })
    expect(r.ok).toBe(true)
    expect((r.data as { total: number }).total).toBeGreaterThanOrEqual(1)
  })
})