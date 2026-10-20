/**
 * scope 级调度队列（ADR-25 §3.5.2/3.5.3）契约测试。
 *
 * 为什么存在：记忆工作流的并发单位 = 一个 (uid, aiId) scope——同 scope 串行、跨 scope 公平轮转
 * （FIFO，修掉「第一个有批次的 scope 永远优先」的饿死）、排队等待**不丢弃**。本文件钉住这些语义。
 * 并行度恒 1（`SCOPE_CONCURRENCY`）的原因见 `monitor/scope-queue.ts` 文件头（全局 workflow 作用域）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ScopeQueue, collectScopedBatches, scopeKeyOf, SCOPE_CONCURRENCY } from '../electron/main/monitor/scope-queue'
import { buildDataPaths } from '../electron/main/models/paths'

const S1 = { uid: 1, aiId: 1 }
const S2 = { uid: 1, aiId: 2 }

function payload(scope: { uid: number; aiId: number }) {
  return { scope, batch: [], nextProgress: { 最后处理日期: '', 最后处理序号: 0 } }
}

describe('ScopeQueue：同 scope 串行 / 跨 scope 轮转 / 排队不丢弃', () => {
  it('并行度缺省 1（全局 workflow 作用域为单值，放开会串味）', () => {
    expect(SCOPE_CONCURRENCY).toBe(1)
  })

  it('scope 键 = {uid}_{aiId}', () => {
    expect(scopeKeyOf(S1)).toBe('1_1')
    expect(scopeKeyOf(S2)).toBe('1_2')
    expect(scopeKeyOf(S1)).not.toBe(scopeKeyOf(S2))
  })

  it('同 scope 重复入队被忽略（同 scope 绝不并发）', () => {
    const q = new ScopeQueue()
    q.offer(scopeKeyOf(S1), payload(S1))
    q.offer(scopeKeyOf(S1), payload(S1))
    expect(q.waitingCount).toBe(1)
    expect(q.take()).toHaveLength(1)
    // 已在跑 → 再 offer 同 key 也被忽略
    q.offer(scopeKeyOf(S1), payload(S1))
    expect(q.waitingCount).toBe(0)
  })

  it('并行度 1：取一个后不再取，release 后取下一个（FIFO 轮转，排队不丢弃）', () => {
    const q = new ScopeQueue()
    q.offer(scopeKeyOf(S1), payload(S1))
    q.offer(scopeKeyOf(S2), payload(S2))
    const first = q.take()
    expect(first.map((p) => scopeKeyOf(p.scope))).toEqual([scopeKeyOf(S1)])
    // 槽位被占 → 再取为空（排队项保留，不丢弃）
    expect(q.take()).toHaveLength(0)
    expect(q.waitingCount).toBe(1)
    expect(q.idle).toBe(false)
    q.releaseActive()
    const second = q.take()
    expect(second.map((p) => scopeKeyOf(p.scope))).toEqual([scopeKeyOf(S2)])
    q.releaseActive()
    expect(q.idle).toBe(true)
  })

  it('并行度 2（机制就位）：一次可取两个 scope', () => {
    const q = new ScopeQueue(2)
    q.offer(scopeKeyOf(S1), payload(S1))
    q.offer(scopeKeyOf(S2), payload(S2))
    expect(q.take()).toHaveLength(2)
  })

  it('has 覆盖在跑与排队；clear 清空', () => {
    const q = new ScopeQueue()
    q.offer(scopeKeyOf(S1), payload(S1))
    q.offer(scopeKeyOf(S2), payload(S2))
    q.take()
    expect(q.has(scopeKeyOf(S1))).toBe(true) // 在跑
    expect(q.has(scopeKeyOf(S2))).toBe(true) // 排队
    expect(q.has('9_9')).toBe(false)
    q.clear()
    expect(q.idle).toBe(true)
    expect(q.has(scopeKeyOf(S1))).toBe(false)
  })
})

describe('collectScopedBatches：逐 scope 独立取批入队', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'le-scope-queue-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seedRaw(uid: number, aiId: number, date: string): void {
    const [y, m, d] = date.split('-')
    const dir = join(root, 'abyssac_data', 'memory', `U${uid}`, `AI${aiId}`, 'raw_memory', y, m, d)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1.md'), `# RAW 记忆 #1\n\n- 时间戳：${date}T00:00:00.000Z\n\n## 用户\n甲\n\n## AI\n乙\n`)
  }

  it('两个 scope 各有封口 RAW → 各自入队（互不覆盖）', () => {
    const paths = buildDataPaths(root)
    seedRaw(1, 1, '2020-01-01')
    seedRaw(1, 2, '2020-01-01')
    const q = new ScopeQueue()
    collectScopedBatches(paths, 1, q)
    expect(q.waitingCount).toBe(2)
    const taken = q.take()
    expect(taken).toHaveLength(1)
    q.releaseActive()
    const rest = q.take()
    expect(rest).toHaveLength(1)
    expect([...taken, ...rest].map((p) => scopeKeyOf(p.scope)).sort()).toEqual(['1_1', '1_2'])
    for (const p of [...taken, ...rest]) expect(p.batch.length).toBeGreaterThan(0)
  })

  it('无封口 RAW → 不入队', () => {
    const q = new ScopeQueue()
    collectScopedBatches(buildDataPaths(root), 1, q)
    expect(q.idle).toBe(true)
  })
})
