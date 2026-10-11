/**
 * mission-store 单测（2026-08-19 自主 AGENT ①④）
 * 覆盖：跨段累计预算 / 失败分类(transient可重试 vs truly-blocked要人) /
 *       failure_limit 防死循环 / 原子写持久化 / 剩余预算续接
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { MissionStore } from '../app/electron/main/tools/sub-agent-engine/mission-store'

let dir: string
let store: MissionStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mission-store-'))
  store = new MissionStore(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MissionStore 长期目标（2026-08-19）', () => {
  it('create / get / list 基本生命周期 + 默认值', () => {
    const rec = store.create('m1', '把月蚀做成自主 AGENT')
    expect(rec.status).toBe('active')
    expect(rec.iterationsUsed).toBe(0)
    // 2026-10-02 取消迭代预算上限：默认 MAX_SAFE_INTEGER 表示不限制
    expect(rec.maxIterations).toBe(Number.MAX_SAFE_INTEGER)
    expect(rec.attemptCount).toBe(0)
    expect(rec.failureLimit).toBe(2)
    const got = store.get('m1')!
    expect(got.goal).toBe('把月蚀做成自主 AGENT')
    // 持久化到磁盘：list 能读到
    expect(store.list().map((m) => m.id)).toContain('m1')
  })

  it('completeSegment 成功：跨段累计预算 + 重置失败计数', () => {
    store.create('m1', 'goal')
    store.completeSegment('m1', { usedThisSegment: 3, ok: true })
    store.completeSegment('m1', { usedThisSegment: 5, ok: true })
    const got = store.get('m1')!
    expect(got.iterationsUsed).toBe(8) // 跨段累计
    expect(got.segments).toBe(2)
  })

  it('completeSegment done=true → status=done', () => {
    store.create('m1', 'goal')
    store.completeSegment('m1', { usedThisSegment: 2, ok: true, done: true })
    expect(store.get('m1')!.status).toBe('done')
  })

  it('④ transient 失败且未超 limit → 保持 active 可重试（attemptCount 累计）', () => {
    store.create('m1', 'goal', { failureLimit: 2 })
    store.completeSegment('m1', { usedThisSegment: 1, ok: false, error: 'network timeout', blockKind: 'transient' })
    expect(store.get('m1')!.status).toBe('active') // 可重试
    expect(store.get('m1')!.attemptCount).toBe(1)
    store.completeSegment('m1', { usedThisSegment: 1, ok: false, error: 'still timeout', blockKind: 'transient' })
    // attemptCount=2 >= failureLimit=2 → blocked（防死循环）
    expect(store.get('m1')!.status).toBe('blocked')
    expect(store.get('m1')!.blockKind).toBe('transient')
  })

  it('④ truly-blocked（capability/needs_input）→ 直接 blocked 不重试', () => {
    store.create('m1', 'goal')
    store.completeSegment('m1', { usedThisSegment: 1, ok: false, error: 'no access', blockKind: 'capability' })
    const got = store.get('m1')!
    expect(got.status).toBe('blocked')
    expect(got.blockKind).toBe('capability')
    expect(got.attemptCount).toBe(0) // 不累计可重试次数——它根本不是可重试的
  })

  it('retry 重置 attemptCount 重新激活（仅对非 blocked）', () => {
    store.create('m1', 'goal')
    store.completeSegment('m1', { usedThisSegment: 1, ok: false, error: 'x', blockKind: 'transient' })
    expect(store.retry('m1')!.attemptCount).toBe(0)
    // blocked 不可 retry
    store.completeSegment('m1', { usedThisSegment: 1, ok: false, error: 'x', blockKind: 'transient' }) // attempt 2
    store.completeSegment('m1', { usedThisSegment: 1, ok: false, error: 'x', blockKind: 'transient' }) // blocked
    expect(store.retry('m1')).toBeNull()
  })

  it('remainingBudget 跨段累计：超限归 0', () => {
    store.create('m1', 'goal', { maxIterations: 10 })
    expect(store.remainingBudget('m1')).toBe(10)
    store.completeSegment('m1', { usedThisSegment: 6, ok: true })
    expect(store.remainingBudget('m1')).toBe(4)
    store.completeSegment('m1', { usedThisSegment: 7, ok: true })
    expect(store.remainingBudget('m1')).toBe(0) // 超限归 0
  })

  it('持久化跨实例可见（文件即真相源）+ 原子写', () => {
    store.create('m1', 'goal', { maxIterations: 20 })
    store.completeSegment('m1', { usedThisSegment: 4, ok: true })
    // 新 store 实例（模拟重启）读同一目录
    const store2 = new MissionStore(dir)
    const rec = store2.get('m1')!
    expect(rec.iterationsUsed).toBe(4)
    expect(rec.maxIterations).toBe(20)
    // 不残留 .tmp
    expect(readdirSync(dir + '/mission')).not.toContain('m1.json.tmp')
  })
})
