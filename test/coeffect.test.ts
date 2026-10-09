import { describe, it, expect } from 'vitest'
import { CoeffectRegistry } from '../electron/main/kernel/coeffect'
import { createRegistrar, kernelRegistry } from '../electron/main/kernel'

describe('CoeffectRegistry 反应式服务表（2026-08-18，对齐 Cordis）', () => {
  it('provide/get/has：提供后可读取、缺省 undefined', () => {
    const r = new CoeffectRegistry()
    r.provide('storage', { v: 1 }, { kind: 'builtin' })
    expect(r.has('storage')).toBe(true)
    expect(r.get('storage')).toEqual({ v: 1 })
    expect(r.has('nope')).toBe(false)
    expect(r.get('nope')).toBeUndefined()
  })

  it('同 key 多提供者：后提供生效', () => {
    const r = new CoeffectRegistry()
    r.provide('db', 'a', { kind: 'plugin', pluginName: 'p1' })
    r.provide('db', 'b', { kind: 'plugin', pluginName: 'p2' })
    expect(r.get('db')).toBe('b')
  })

  it('dispose 可逆；移除生效者回退上一个提供者（provider 换主）', () => {
    const r = new CoeffectRegistry()
    const a = r.provide('svc', 'a', { kind: 'plugin', pluginName: 'p1' })
    const b = r.provide('svc', 'b', { kind: 'plugin', pluginName: 'p2' })
    expect(r.get('svc')).toBe('b')
    b.dispose()
    expect(r.get('svc')).toBe('a') // 回退到 a
    a.dispose()
    expect(r.has('svc')).toBe(false) // 全清
    expect(r.listKeys()).toEqual([])
  })

  it('onChanged：provide/dispose 触发，退订后不再收到', () => {
    const r = new CoeffectRegistry()
    const events: Array<[string, string]> = []
    const unsub = r.onChanged((key, kind) => events.push([key, kind]))
    r.provide('k', 1, { kind: 'builtin' })
    r.provide('k', 2, { kind: 'builtin' }).dispose()
    expect(events).toEqual([['k', 'provide'], ['k', 'provide'], ['k', 'dispose']])
    unsub()
    r.provide('k2', 1, { kind: 'builtin' })
    expect(events.length).toBe(3) // 未再收到
  })

  it('createRegistrar 的 reg.provide 落到注册表，且纳入句柄回滚', () => {
    const r = new CoeffectRegistry()
    const { reg, handles } = createRegistrar(kernelRegistry, { kind: 'plugin', pluginName: 'co-test' }, r)
    reg.provide('api', { x: 1 })
    expect(r.get('api')).toEqual({ x: 1 })
    // 回滚：dispose 全部句柄 → 服务被移除
    for (const h of handles) if (!h.disposed) h.dispose()
    expect(r.has('api')).toBe(false)
  })
})
