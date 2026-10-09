import { describe, it, expect, beforeEach } from 'vitest'
import { ExtensionRegistry } from '../electron/main/kernel/registry'
import type { ExtensionHandle } from '../electron/main/kernel/extension'

describe('内核扩展注册表', () => {
  let reg: ExtensionRegistry

  beforeEach(() => {
    reg = new ExtensionRegistry()
  })

  it('注册 → get 取回', () => {
    reg.register('prompt', { kind: 'builtin' }, { name: 'a', content: 'x' })
    reg.register('prompt', { kind: 'plugin', pluginName: 'p1' }, { name: 'b', content: 'y' })
    const prompts = reg.get<{ name: string }>('prompt')
    expect(prompts.map((p) => p.name)).toEqual(['a', 'b'])
  })

  it('dispose 后不再返回', () => {
    const h = reg.register('tool', { kind: 'builtin' }, { name: 't1' })
    expect(reg.get('tool')).toHaveLength(1)
    h.dispose()
    expect(reg.get('tool')).toHaveLength(0)
  })

  it('dispose 幂等（重复调用无副作用）', () => {
    const h = reg.register('command', { kind: 'builtin' }, { id: 'c1', description: '', run: async () => ({ ok: true }) })
    h.dispose()
    expect(h.disposed).toBe(true)
    h.dispose()
    expect(reg.getHandles('command')).toHaveLength(0)
  })

  it('disposeBySource 批量回滚插件注册', () => {
    reg.register('tool', { kind: 'plugin', pluginName: 'p1' }, { name: 't1' })
    reg.register('hook', { kind: 'plugin', pluginName: 'p1' }, { event: 'PreToolUse', matcher: '.*', fn: async () => ({ action: 'continue' as const }) })
    reg.register('tool', { kind: 'builtin' }, { name: 't2' })
    const count = reg.disposeBySource({ kind: 'plugin', pluginName: 'p1' })
    expect(count).toBe(2)
    expect(reg.get('tool')).toHaveLength(1)
    expect(reg.get('hook')).toHaveLength(0)
  })

  it('同 kind 不同插件互不影响', () => {
    reg.register('tool', { kind: 'plugin', pluginName: 'p1' }, { name: 't1' })
    reg.register('tool', { kind: 'plugin', pluginName: 'p2' }, { name: 't2' })
    reg.disposeBySource({ kind: 'plugin', pluginName: 'p1' })
    const tools = reg.get<{ name: string }>('tool')
    expect(tools.map((t) => t.name)).toEqual(['t2'])
  })

  it('onChanged 订阅/退订', () => {
    const events: string[] = []
    const off = reg.onChanged('tool', (kind) => events.push(kind))
    reg.register('tool', { kind: 'builtin' }, { name: 't1' })
    reg.register('prompt', { kind: 'builtin' }, { name: 'a', content: 'x' })
    expect(events).toEqual(['tool'])
    off()
    reg.register('tool', { kind: 'builtin' }, { name: 't2' })
    expect(events).toEqual(['tool'])
  })

  it('inspect 快照统计', () => {
    reg.register('tool', { kind: 'builtin' }, { name: 't1' })
    reg.register('tool', { kind: 'plugin', pluginName: 'p1' }, { name: 't2' })
    reg.register('hook', { kind: 'plugin', pluginName: 'p1' }, { event: 'PreToolUse', matcher: 'write', fn: async () => ({ action: 'continue' as const }) })
    reg.register('prompt', { kind: 'builtin' }, { name: 'a', content: 'x' })
    reg.register('configPatch', { kind: 'patch' }, { lilith: {} })
    reg.register('command', { kind: 'builtin' }, { id: 'cmd1', description: '', run: async () => ({ ok: true }) })

    const snap = reg.inspect()
    expect(snap.counts.tool).toBe(2)
    expect(snap.counts.hook).toBe(1)
    expect(snap.counts.prompt).toBe(1)
    expect(snap.counts.configPatch).toBe(1)
    expect(snap.counts.command).toBe(1)
    expect(snap.bySource['plugin:p1']).toBe(2)
    expect(snap.bySource.builtin).toBe(3)
    expect(snap.bySource.patch).toBe(1)
    expect(snap.hooks[0].event).toBe('PreToolUse')
  })

  it('getBySource 过滤', () => {
    reg.register('tool', { kind: 'builtin' }, { name: 't1' })
    reg.register('tool', { kind: 'plugin', pluginName: 'p1' }, { name: 't2' })
    const pluginTools = reg.getBySource<{ name: string }>('tool', { kind: 'plugin', pluginName: 'p1' })
    expect(pluginTools.map((t) => t.name)).toEqual(['t2'])
  })

  it('自定义 id 注册（幂等防重）', () => {
    reg.register('tool', { kind: 'builtin' }, { name: 't1' }, 'tool:builtin:fixed')
    reg.register('tool', { kind: 'builtin' }, { name: 't2' }, 'tool:builtin:fixed')
    expect(reg.getHandles('tool')).toHaveLength(2)
    // 两个句柄 dispose 各自生效
    reg.disposeBySource({ kind: 'builtin' })
    expect(reg.get('tool')).toHaveLength(0)
  })

  it('句柄类型泛型保持', () => {
    const h: ExtensionHandle<{ name: string }> = reg.register('prompt', { kind: 'builtin' }, { name: 'a', content: 'x' })
    expect(h.value.name).toBe('a')
  })
})
