import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { ConfigStore, getByPath, deepEqual } from '../electron/main/api/config-store'

const ROOT = join(process.cwd(), 'tmp', 'config-subscribekey-test')
const CFG = join(ROOT, 'config.json')

function mkConfig(): ConfigStore {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  writeFileSync(
    CFG,
    JSON.stringify({ capabilityPolicy: { enabled: false }, browser: { useSystemBrowser: false } }),
    'utf-8'
  )
  return new ConfigStore(CFG)
}

describe('ConfigStore 键级订阅 subscribeKey（2026-08-18，对齐 Cordis notify）', () => {
  it('getByPath / deepEqual 基础正确', () => {
    const o = { a: { b: 1 }, arr: [{ x: 2 }] }
    expect(getByPath(o, 'a.b')).toBe(1)
    expect(getByPath(o, 'arr.0.x')).toBe(2)
    expect(getByPath(o, 'a.missing')).toBeUndefined()
    expect(getByPath(o, 'nope')).toBeUndefined()
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual(null, null)).toBe(true)
    expect(deepEqual(undefined, undefined)).toBe(true)
  })

  it('subscribeKey 只在目标 path 值变化时回调（newVal/oldVal 正确）', () => {
    const store = mkConfig()
    const calls: Array<[unknown, unknown]> = []
    const unsub = store.subscribeKey('capabilityPolicy', (n, o) => calls.push([n, o]))
    // 改 capabilityPolicy → 触发
    const cfg = store.get()
    store.save({ ...cfg, capabilityPolicy: { enabled: true, denyTools: ['x'] } })
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toEqual({ enabled: true, denyTools: ['x'] })
    expect(calls[0][1]).toEqual({ enabled: false })
    // 改 browser（无关 path）→ 不触发
    store.save({ ...store.get(), browser: { useSystemBrowser: true } })
    expect(calls.length).toBe(1)
    // 改回无关后再改 capabilityPolicy → 触发第二次
    store.save({ ...store.get(), capabilityPolicy: { enabled: false } })
    expect(calls.length).toBe(2)
    unsub()
  })

  it('退订后不再触发', () => {
    const store = mkConfig()
    let n = 0
    const unsub = store.subscribeKey('browser', () => n++)
    unsub()
    store.save({ ...store.get(), browser: { useSystemBrowser: true } })
    expect(n).toBe(0)
  })

  it('同 path 多订阅者互不影响', () => {
    const store = mkConfig()
    let a = 0
    let b = 0
    const ua = store.subscribeKey('capabilityPolicy', () => a++)
    store.subscribeKey('capabilityPolicy', () => b++)
    store.save({ ...store.get(), capabilityPolicy: { enabled: true } })
    expect(a).toBe(1)
    expect(b).toBe(1)
    ua() // 退订 a
    store.save({ ...store.get(), capabilityPolicy: { enabled: false } })
    expect(a).toBe(1) // 不再触发
    expect(b).toBe(2)
  })
})
