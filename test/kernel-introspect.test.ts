import { describe, it, expect, beforeEach } from 'vitest'
import { buildSelfAwarenessSection, SELF_AWARENESS_RULES } from '../electron/main/kernel/introspection'
import { kernelRegistry, createRegistrar } from '../electron/main/kernel'
import { KernelInspectTool } from '../electron/main/tools/kernel-introspect'

beforeEach(() => {
  kernelRegistry.disposeBySource({ kind: 'builtin' })
  kernelRegistry.disposeBySource({ kind: 'plugin', pluginName: 'aware-plugin' })
})

describe('自我认知段', () => {
  it('包含修改边界 + 正规通道指引 + 系统认知', () => {
    const section = buildSelfAwarenessSection('/data')
    expect(section).toContain('正规通道')
    expect(section).toContain('plugin')
    expect(section).toContain('config_patch')
    expect(section).toContain('kernel_inspect')
    expect(section).toContain('系统构造')
    expect(section).toContain('修改边界')
    expect(SELF_AWARENESS_RULES).toContain('记忆工作流')
    expect(SELF_AWARENESS_RULES).toContain('typecheck')
  })

  it('不注入 ABYSS 用户资料/自我认知（USER.md/AI.md 移到 prompt 最后按 user_md/ai_md 段注入，不再进 kernel 段）', () => {
    const section = buildSelfAwarenessSection('/data')
    expect(section).not.toContain('我是月蚀')
    expect(section).not.toContain('USER.md')
    expect(section).not.toContain('AI.md')
  })

  it('不含注册数量统计（数量随 AI 改造变化，对 AI 无用）', () => {
    const { reg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
    reg.registerTool(
      { name: 'demo_tool', description: '', parameters: [], execute: async () => ({ ok: true }) },
      { id: 'demo_tool', name: 'demo_tool', category: 'custom', description: '', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] }
    )
    const section = buildSelfAwarenessSection('/data')
    expect(section).not.toContain('当前注册统计')
    expect(section).not.toContain('工具 1 个')
  })

  it('插件 prompt 段追加进自我认知', () => {
    kernelRegistry.register('prompt', { kind: 'plugin', pluginName: 'aware-plugin' }, { name: '插件须知', content: '用 my_* 工具前先看说明', order: 100 })
    const section = buildSelfAwarenessSection('/data')
    expect(section).toContain('插件须知')
    expect(section).toContain('用 my_* 工具前先看说明')
  })
})

describe('自我检视工具', () => {
  it('kernel_inspect action=overview 返回统计', async () => {
    const { reg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
    reg.registerTool(
      { name: 'demo_tool', description: '', parameters: [], execute: async () => ({ ok: true }) },
      { id: 'demo_tool', name: 'demo_tool', category: 'custom', description: '', defaultEnabled: true, riskLevel: 'low', agents: ['frontend'] }
    )
    const tool = new KernelInspectTool()
    const res = await tool.execute({ action: 'overview' }, undefined) as { ok: boolean; data: { counts: Record<string, number>; bySource: Record<string, number> } }
    expect(res.ok).toBe(true)
    expect(res.data.counts.tool).toBeGreaterThan(0)
    expect(res.data.bySource.builtin).toBeGreaterThan(0)
  })

  it('kernel_inspect action=detail 支持 kind 过滤', async () => {
    const { reg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
    reg.registerPrompt({ name: 'p1', content: 'x' })
    const tool = new KernelInspectTool()
    const all = await tool.execute({ action: 'detail' }, undefined) as { ok: boolean; data: Record<string, unknown> }
    expect(all.data.prompts).toBeDefined()
    const hooksOnly = await tool.execute({ action: 'detail', kind: 'hook' }, undefined) as { ok: boolean; data: Record<string, unknown> }
    expect(hooksOnly.data.hooks).toBeDefined()
    expect(hooksOnly.data.tools).toBeUndefined()
  })

  it('kernel_inspect action=effective 返回关键配置 + key 过滤', async () => {
    const tool = new KernelInspectTool()
    const ctx = { config: { frontendToolPolicy: { tools: {} }, aiName: '月蚀', theme: 'dark' } } as never
    const all = await tool.execute({ action: 'effective' }, ctx) as { ok: boolean; data: Record<string, unknown> }
    expect(all.ok).toBe(true)
    expect(all.data.aiName).toBe('月蚀')
    const filtered = await tool.execute({ action: 'effective', key: 'theme' }, ctx) as { ok: boolean; data: Record<string, unknown> }
    expect(filtered.data.theme).toBe('dark')
    expect(filtered.data.aiName).toBeUndefined()
  })

  it('kernel_inspect action=effective 无 ctx.config 报错', async () => {
    const tool = new KernelInspectTool()
    const res = await tool.execute({ action: 'effective' }, undefined)
    expect(res.ok).toBe(false)
  })
})