/**
 * 批次 B4：重试退避统一骨架测试。
 *
 * 验收判据（计划书）：各调用点的退避参数逐处记录在测试里——
 * 参数不同是刻意的，合并不得改变任一处的参数。
 *
 * 已收敛到 shared/utils/backoff.ts（computeBackoffDelay）的 5 处指数退避：
 * 1. server.ts                  base=isTimeout?500:1500  cap=30000  attempt=retryCount
 * 2. dmn-runner.ts              base=1500               cap=30000  attempt=retryCount
 * 3. client-manager.ts          base=1000               无 cap     attempt=reconnectAttempts-1
 * 4. diary-workflow-scheduler.ts base=60000             cap=86400000 attempt=count-1
 * 5. appStore.ts                base=1000               cap=30000  attempt=_wsRetryCount
 *
 * 刻意不同源、不强行合并的三处（保留独立实现）：
 * - sync-engine.ts：连续状态倍增（base 是每次累乘后的当前值，非固定 base），cap 300s
 * - ai-collaboration-scheduler.ts：随机 jitter 抖动（防多实例同刻唤醒）
 * - web-search.ts humanJitter：模拟人类操作随机抖动
 */
import { describe, it, expect } from 'vitest'
import { computeBackoffDelay, sleep, sleepWithBackoff } from '../shared/utils/backoff'

describe('批次 B4：computeBackoffDelay 数学等价性', () => {
  it('attempt=0 返回 base（所有调用点首退即 base）', () => {
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: 500 })).toBe(500)
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: 1500 })).toBe(1500)
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: 1000 })).toBe(1000)
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: 60000 })).toBe(60000)
  })

  it('倍增：delay = base * 2^attempt（默认 multiplier=2）', () => {
    expect(computeBackoffDelay({ attempt: 1, baseDelayMs: 1500 })).toBe(3000)
    expect(computeBackoffDelay({ attempt: 2, baseDelayMs: 1500 })).toBe(6000)
    expect(computeBackoffDelay({ attempt: 3, baseDelayMs: 1500 })).toBe(12000)
    expect(computeBackoffDelay({ attempt: 4, baseDelayMs: 1500 })).toBe(24000)
  })

  it('封顶生效：达到 max 后不再倍增', () => {
    expect(computeBackoffDelay({ attempt: 4, baseDelayMs: 1500, maxDelayMs: 30000 })).toBe(24000)
    expect(computeBackoffDelay({ attempt: 5, baseDelayMs: 1500, maxDelayMs: 30000 })).toBe(30000)
    expect(computeBackoffDelay({ attempt: 10, baseDelayMs: 1500, maxDelayMs: 30000 })).toBe(30000)
  })

  it('无 max 时不封顶', () => {
    expect(computeBackoffDelay({ attempt: 10, baseDelayMs: 1000 })).toBe(1024000)
  })

  it('自定义 multiplier 生效', () => {
    expect(computeBackoffDelay({ attempt: 2, baseDelayMs: 1000, multiplier: 3 })).toBe(9000)
  })
})

describe('批次 B4：调用点参数逐处记录', () => {
  it('server.ts 断流重试：base=isTimeout?500:1500，cap=30000，attempt=retryCount', () => {
    const isTimeout = false
    const baseDelay = isTimeout ? 500 : 1500
    const MAX_RETRY_DELAY_MS = 30000
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: baseDelay, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(1500)
    expect(computeBackoffDelay({ attempt: 4, baseDelayMs: baseDelay, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(24000)
    expect(computeBackoffDelay({ attempt: 5, baseDelayMs: baseDelay, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(30000)
    // 超时分支 base=500
    const timeoutBase = 500
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: timeoutBase, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(500)
    expect(computeBackoffDelay({ attempt: 6, baseDelayMs: timeoutBase, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(30000)
  })

  it('dmn-runner.ts 调用重试：base=1500，cap=30000，attempt=retryCount', () => {
    const BASE_RETRY_DELAY_MS = 1500
    const MAX_RETRY_DELAY_MS = 30000
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: BASE_RETRY_DELAY_MS, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(1500)
    expect(computeBackoffDelay({ attempt: 3, baseDelayMs: BASE_RETRY_DELAY_MS, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(12000)
    expect(computeBackoffDelay({ attempt: 5, baseDelayMs: BASE_RETRY_DELAY_MS, maxDelayMs: MAX_RETRY_DELAY_MS })).toBe(30000)
  })

  it('client-manager.ts 重连：base=1000，无 cap，attempt=reconnectAttempts-1', () => {
    const RECONNECT_BASE_DELAY = 1000
    // 第 1 次重连（reconnectAttempts=1 → attempt=0）等 1s
    expect(computeBackoffDelay({ attempt: 1 - 1, baseDelayMs: RECONNECT_BASE_DELAY })).toBe(1000)
    // 第 3 次重连 → attempt=2 → 4s
    expect(computeBackoffDelay({ attempt: 3 - 1, baseDelayMs: RECONNECT_BASE_DELAY })).toBe(4000)
    // 无 cap：长期重连持续倍增（不再封顶，保持原有行为）
    expect(computeBackoffDelay({ attempt: 10, baseDelayMs: RECONNECT_BASE_DELAY })).toBe(1024000)
  })

  it('diary-workflow-scheduler.ts 日记工作流背压：base=60000，cap=86400000，attempt=count-1', () => {
    const BASE_BACKOFF_MS = 60000
    const MAX_BACKOFF_MS = 86400000
    // 首次失败（count=1 → attempt=0）等 60s
    expect(computeBackoffDelay({ attempt: 1 - 1, baseDelayMs: BASE_BACKOFF_MS, maxDelayMs: MAX_BACKOFF_MS })).toBe(60000)
    // 第 2 次（count=2 → attempt=1）等 120s
    expect(computeBackoffDelay({ attempt: 2 - 1, baseDelayMs: BASE_BACKOFF_MS, maxDelayMs: MAX_BACKOFF_MS })).toBe(120000)
    // 一天上限：86400000 = 24h
    expect(computeBackoffDelay({ attempt: 11, baseDelayMs: BASE_BACKOFF_MS, maxDelayMs: MAX_BACKOFF_MS })).toBe(86400000)
  })

  it('appStore.ts WS 重连：base=1000，cap=30000，attempt=_wsRetryCount', () => {
    const WS_RECONNECT_MAX_DELAY_MS = 30000
    expect(computeBackoffDelay({ attempt: 0, baseDelayMs: 1000, maxDelayMs: WS_RECONNECT_MAX_DELAY_MS })).toBe(1000)
    expect(computeBackoffDelay({ attempt: 4, baseDelayMs: 1000, maxDelayMs: WS_RECONNECT_MAX_DELAY_MS })).toBe(16000)
    expect(computeBackoffDelay({ attempt: 5, baseDelayMs: 1000, maxDelayMs: WS_RECONNECT_MAX_DELAY_MS })).toBe(30000)
  })
})

describe('批次 B4：sleep 与 sleepWithBackoff', () => {
  it('sleep 等待后 resolve', async () => {
    const t0 = Date.now()
    await sleep(20)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15)
  })

  it('sleepWithBackoff 返回实际延迟且等待约等于该延迟', async () => {
    const t0 = Date.now()
    const actual = await sleepWithBackoff({ attempt: 2, baseDelayMs: 20 })
    expect(actual).toBe(80)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70)
  })
})