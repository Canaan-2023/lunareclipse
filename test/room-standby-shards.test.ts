/**
 * 待机超长时长的**分片续排**回归（0.53.3 补测）。
 *
 * 缺口背景：`room-standby.test.ts` 只验证了「第一片到期不提前结束」（1 次分片）。
 * 但真实故障点在**多片累计**：只要分片求和不等、或每片超过 JS 32 位上限，
 * 表现就是「AI 说待机 50 天，结果 24.8 天就醒了」/「立刻到期」——静默、且只在超长待机时出现。
 *
 * 本文件锁四件事：
 * 1. 每片 delay **不超过 2^31-1**（超过就会被引擎截断成「立刻执行」）；
 * 2. 各片之和 **等于 AI 声明的总时长**（不是近似，不是首个分片）；
 * 3. 只有最后一片到期才真正回到 idle 并重新激活；
 * 4. 中途 `stop()` 能清掉续排链（不留残留定时器、不再到期激活）。
 */
import { describe, it, expect, vi } from 'vitest'
import { createRoomRuntime, type RoomTimers } from '../electron/main/room/runtime'

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
/** ECMAScript Date 可表示上界（运行时把 `standbyUntil` 夹到这里） */
const MAX_DATE_MS = 8.64e15

interface Pending {
  id: string
  ms: number
  label?: string
  cb: () => void
}

function recordingTimers(): {
  timers: RoomTimers
  size: () => number
  /** 摘下**唯一**一个待触发定时器（产品在到期分支不调 clearTimeout，故必须由夹具摘除） */
  take: () => Pending
} {
  const pending: Pending[] = []
  let seq = 0
  return {
    timers: {
      setTimeout: (cb: () => void, ms: number, label?: string) => {
        const id = `t${++seq}`
        pending.push({ id, ms, label, cb })
        return id
      },
      clearTimeout: (h: string) => {
        const i = pending.findIndex((p) => p.id === h)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    size: () => pending.length,
    take: () => {
      expect(pending).toHaveLength(1)
      return pending.shift()!
    }
  }
}

/**
 * 最小运行时：不注入 `sense`（感知器不会建，定时器表里只有待机），
 * `now` 固定为 0 —— 分片必须按「本地累计剩余」推进，而不是靠时钟前进。
 */
function makeRuntime(timers: RoomTimers) {
  const collects: number[] = []
  const rt = createRoomRuntime({
    collect: async () => {
      collects.push(1)
      return { ok: true, text: '平台 win32 · CPU 5%' }
    },
    plan: async () => '{"decisions":[]}',
    executor: {
      execute: async () => ({
        ok: true,
        decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
      })
    },
    allowedTools: () => ['read'],
    timers,
    now: () => 0
  })
  return { rt, collects }
}

/** 起一个已 park 在 idle 的房间（待机从这里开始最干净） */
async function ready(timers: RoomTimers) {
  const h = makeRuntime(timers)
  h.rt.start()
  await vi.waitFor(() => expect(h.rt.getState().phase).toBe('idle'))
  return h
}

describe('超长待机：分片续排（放到多次分片才到期）', () => {
  it('3 片：每片 ≤ 2^31-1，求和 = 声明时长，最后一片才到期', async () => {
    const ft = recordingTimers()
    const h = await ready(ft.timers)
    const total = MAX_TIMER_DELAY_MS * 2 + 1_234

    h.rt.standby(total)
    expect(h.rt.getState().phase).toBe('standby')

    const delays: number[] = []
    // 前两片：到期后必须续排，相位仍是 standby
    for (let i = 0; i < 2; i += 1) {
      const p = ft.take()
      delays.push(p.ms)
      p.cb()
      expect(ft.size()).toBe(1) // 续排了下一片
      expect(h.rt.getState().phase).toBe('standby') // 不能提前结束
      expect(h.rt.getState().standbyUntil).toBe(total)
    }
    // 第三片：剩余 1234ms，到期即激活
    const last = ft.take()
    delays.push(last.ms)
    last.cb()

    expect(delays).toEqual([MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, 1_234])
    expect(delays.reduce((a, b) => a + b, 0)).toBe(total) // 不是「只排了第一片」
    expect(delays.every((d) => d > 0 && d <= MAX_TIMER_DELAY_MS)).toBe(true) // 不触发 32 位截断
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('idle'))
    expect(ft.size()).toBe(0) // 没有多余续排
    expect(h.rt.getState().standbyUntil).toBeUndefined()
    h.rt.stop()
  })

  it('边界：恰好 2^31-1 → 单片；2^31 → 两片（第二片 1ms）', async () => {
    const ft = recordingTimers()
    const h = await ready(ft.timers)

    h.rt.standby(MAX_TIMER_DELAY_MS)
    const only = ft.take()
    expect(only.ms).toBe(MAX_TIMER_DELAY_MS)
    only.cb()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('idle')) // 恰好一片就到期
    expect(ft.size()).toBe(0)

    h.rt.standby(MAX_TIMER_DELAY_MS + 1)
    const first = ft.take()
    expect(first.ms).toBe(MAX_TIMER_DELAY_MS)
    first.cb()
    expect(h.rt.getState().phase).toBe('standby') // 还差 1ms，不能提前醒
    const second = ft.take()
    expect(second.ms).toBe(1)
    second.cb()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('idle'))
    h.rt.stop()
  })

  it('4 片：约 74 天（6.44×10^9 毫秒）按 4 片累计，前 3 片都不醒', async () => {
    const ft = recordingTimers()
    const h = await ready(ft.timers)
    const total = MAX_TIMER_DELAY_MS * 3 + 500_000

    h.rt.standby(total)
    const delays: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const p = ft.take()
      delays.push(p.ms)
      p.cb()
      expect(h.rt.getState().phase).toBe('standby')
    }
    const last = ft.take()
    delays.push(last.ms)
    last.cb()

    expect(delays).toEqual([MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS, 500_000])
    expect(delays.reduce((a, b) => a + b, 0)).toBe(total)
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('idle'))
    h.rt.stop()
  })

  it('超过 Date 可表示范围 → standbyUntil 夹到 8.64e15，且首片仍是 32 位上限', async () => {
    const ft = recordingTimers()
    const h = await ready(ft.timers)

    h.rt.standby(Number.MAX_SAFE_INTEGER)
    expect(h.rt.getState().standbyUntil).toBe(MAX_DATE_MS) // 时间戳有意义（不是 Infinity/NaN）
    const p = ft.take()
    expect(p.ms).toBe(MAX_TIMER_DELAY_MS) // 不是 8.64e15（那会被引擎当成「立刻」）
    h.rt.stop()
  })

  it('非有限 / 非正时长被忽略：不进 standby、不排期（不拿 NaN 去排定时器）', async () => {
    const ft = recordingTimers()
    const h = await ready(ft.timers)
    const before = h.collects.length

    h.rt.standby(Number.NaN)
    h.rt.standby(Number.POSITIVE_INFINITY)
    h.rt.standby(0)
    h.rt.standby(-1)

    expect(h.rt.getState().phase).toBe('idle')
    expect(h.rt.getState().standbyUntil).toBeUndefined()
    expect(ft.size()).toBe(0)
    expect(h.collects.length).toBe(before)
    h.rt.stop()
  })

  it('续排中途 stop()：清掉剩余分片，不再到期激活（不留残留定时器）', async () => {
    const ft = recordingTimers()
    const h = await ready(ft.timers)
    const before = h.collects.length

    h.rt.standby(MAX_TIMER_DELAY_MS * 3)
    ft.take().cb() // 第一片走完，还剩两片
    expect(h.rt.getState().phase).toBe('standby')
    expect(ft.size()).toBe(1)

    h.rt.stop()
    expect(ft.size()).toBe(0)
    expect(h.rt.getState().phase).toBe('stopped')
    expect(h.rt.getState().standbyUntil).toBeUndefined()
    expect(h.collects.length).toBe(before) // 分片不触发任何采集
  })
})
