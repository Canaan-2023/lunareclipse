/**
 * ROOM 采集器语义回归（2026-10-18 用户裁决）：**感官，不是定时器**。
 *
 * 用户原话要点：采集器「只能是条件激活，不能是定时激活」——只有自主模式开启且 AI 空闲时才激活；
 * AI 运行时、待机时都不返回；「采集器就是 AI 的眼睛」；且「如果 LLM 未回复就不要继续了，说明 AI 出了问题」。
 *
 * 覆盖：
 * 1. **无定时激活**：start 后驱动跑轮次，但**不注册任何 interval**（注册表里只有 AI 自设的待机到期）；
 * 2. 有实质动作才继续下一轮，规划无动作即 park（不再采集）；
 * 3. 采集器未返回（未开启 / 未授予）→ 一轮即 park，`idleReason='no-input'`；
 * 4. **LLM 未回复 → 停止**（相位回 stopped，不再空转）；
 * 5. **待机**：AI 声明 `standbyMs` → 进入 standby、期间零主动采集；到期回到 idle 并重新激活；
 *    时长由 AI 决定（无产品上限，超长则分片续排）；用户 stop 清定时器。
 */
import { describe, it, expect, vi } from 'vitest'
import { createRoomRuntime, type RoomTimers } from '../electron/main/room/runtime'
import { TimerRegistry } from '../electron/main/monitor/timer-registry'

/** 手动触发的定时器假体：能精确断言「待机到期」与「没有多余定时器」。 */
function makeFakeTimers(): { timers: RoomTimers; fire: () => void; size: () => number } {
  const pending: Array<{ id: string; cb: () => void }> = []
  let seq = 0
  return {
    timers: {
      setTimeout: (cb: () => void) => {
        const id = `t${++seq}`
        pending.push({ id, cb })
        return id
      },
      clearTimeout: (h: string) => {
        const i = pending.findIndex((p) => p.id === h)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    fire: () => {
      const all = pending.splice(0)
      for (const p of all) p.cb()
    },
    size: () => pending.length
  }
}

const NO_ACTION = '{"decisions":[]}'

/** 采集假体（不含 view 参数——本文件不关心采集视图，见 room-collector-view.test.ts）。 */
type CollectFn = () => Promise<{ ok: boolean; text?: string; error?: string }>

function makeHarness(over: { collect?: CollectFn; timers?: RoomTimers } = {}) {
  const collects: string[] = []
  let round = 0
  let replyOf: (n: number) => string | null = () => NO_ACTION
  const rt = createRoomRuntime({
    collect: async () => {
      collects.push('c')
      return over.collect ? await over.collect() : { ok: true, text: '平台 win32 · CPU 5%' }
    },
    plan: async () => {
      round += 1
      return replyOf(round)
    },
    executor: {
      execute: async () => ({
        ok: true,
        decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
      })
    },
    allowedTools: () => ['read'],
    ...(over.timers ? { timers: over.timers } : {})
  })
  // 0.53.18：自主模式继承承载会话；未绑定则运行时不规划
  rt.setHostSession('chat-1')
  return { rt, collects, setReply: (f: (n: number) => string | null) => { replyOf = f } }
}

/** 让事件循环空转一小会儿（驱动是 fire-and-forget 的异步循环） */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 25))

describe('ROOM 条件驱动（无定时激活）', () => {
  it('start 后驱动跑轮次，但**不注册任何 interval**（采集不是定时激活）', async () => {
    const reg = new TimerRegistry()
    const h = makeHarness({ timers: reg })
    h.rt.start()
    await vi.waitFor(() => expect(h.collects.length).toBeGreaterThan(0))
    await settle()
    // 采集/规划/执行都不产生定时器；非待机时注册表必须为空
    expect(reg.size()).toBe(0)
    h.rt.stop()
  })

  it('有实质动作才继续下一轮；规划无动作即 park（不再采集）', async () => {
    const h = makeHarness()
    // 每轮换参数：相同动作现在需要 AI 显式 repeat=continue（见 room-loop.test.ts）
    h.setReply((n) => (n <= 2 ? `{"decisions":[{"tool":"read","params":{"i":${n}}}]}` : NO_ACTION))
    h.rt.start()
    await vi.waitFor(() => expect(h.collects.length).toBeGreaterThanOrEqual(3))
    const settled = h.collects.length
    await settle()
    expect(h.collects.length).toBe(settled)
    expect(h.rt.getState().phase).toBe('idle')
    h.rt.stop()
  })

  it('采集器未返回（未开启 / 未授予）→ 一轮即 park，idleReason=no-input', async () => {
    const h = makeHarness({ collect: async () => ({ ok: false, error: '采集器未开启' }) })
    h.rt.start()
    await vi.waitFor(() => expect(h.rt.getState().lastTick?.idleReason).toBe('no-input'))
    await settle()
    expect(h.collects.length).toBe(1)
    h.rt.stop()
  })
})

describe('ROOM LLM 未回复 → 停止（不空转）', () => {
  it('规划返回空串 → llmFailed 且相位回 stopped', async () => {
    const h = makeHarness()
    h.setReply(() => '')
    h.rt.start()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('stopped'))
    expect(h.rt.getState().lastTick?.llmFailed).toBe(true)
    const settled = h.collects.length
    await settle()
    expect(h.collects.length).toBe(settled)
  })

  it('规划抛错同样按「未回复」处理 → 停止', async () => {
    const h = makeHarness()
    const rt = h.rt
    // 用抛错的 plan 重建一个（harness 的 plan 不抛）
    const rt2 = createRoomRuntime({
      collect: async () => ({ ok: true, text: 'x' }),
      plan: async () => {
        throw new Error('LLM 挂了')
      },
      executor: {
        execute: async () => ({ ok: true, decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' } })
      },
      allowedTools: () => []
    })
    rt2.setHostSession('chat-1')
    void rt
    rt2.start()
    await vi.waitFor(() => expect(rt2.getState().phase).toBe('stopped'))
    expect(rt2.getState().lastTick?.llmFailed).toBe(true)
  })
})

describe('ROOM 待机（AI 自设时长；感知器仍可看）', () => {
  it('AI 声明 standbyMs → 进入 standby，期间零采集；唯一的定时器 = 待机到期', async () => {
    const ft = makeFakeTimers()
    const h = makeHarness({ timers: ft.timers })
    h.setReply(() => '{"note":"待机","decisions":[],"standbyMs":60000}')
    h.rt.start()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('standby'))
    const settled = h.collects.length
    await settle()
    expect(h.collects.length).toBe(settled)
    expect(ft.size()).toBe(1)
    expect(h.rt.getState().standbyUntil).toBeTypeOf('number')
    h.rt.stop()
  })

  it('待机到期 → 回到 idle 并重新激活（再采集一次）', async () => {
    const ft = makeFakeTimers()
    const h = makeHarness({ timers: ft.timers })
    h.setReply((n) => (n === 1 ? '{"decisions":[],"standbyMs":1000}' : NO_ACTION))
    h.rt.start()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('standby'))
    const before = h.collects.length
    ft.fire()
    await vi.waitFor(() => expect(h.collects.length).toBeGreaterThan(before))
    h.rt.stop()
  })

  it('stop 清掉待机定时器（不留残留）', async () => {
    const ft = makeFakeTimers()
    const h = makeHarness({ timers: ft.timers })
    h.setReply(() => '{"decisions":[],"standbyMs":60000}')
    h.rt.start()
    await vi.waitFor(() => expect(ft.size()).toBe(1))
    h.rt.stop()
    expect(ft.size()).toBe(0)
    expect(h.rt.getState().phase).toBe('stopped')
  })

  it('同一轮既有动作又有 standbyMs：执行完才待机，不会并发第二条驱动', async () => {
    const ft = makeFakeTimers()
    let collects = 0
    let executes = 0
    const rt = createRoomRuntime({
      collect: async () => {
        collects += 1
        return { ok: true, text: '有输入' }
      },
      plan: async () => '{"decisions":[{"tool":"read","params":{"i":1}}],"standbyMs":60000}',
      executor: {
        execute: async () => {
          executes += 1
          return {
            ok: true,
            decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
          }
        }
      },
      allowedTools: () => ['read'],
      timers: ft.timers
    })
    rt.setHostSession('chat-1')
    rt.start()
    await vi.waitFor(() => expect(rt.getState().phase).toBe('standby'))
    await settle()
    // 只跑了一轮：standby 在本轮 tick 收尾才应用，不会在 execute 期间再起一条驱动
    expect(collects).toBe(1)
    expect(executes).toBe(1)
    rt.stop()
  })

  it('AI 可声明的待机时长**没有产品上限**（不再夹到 24h）', async () => {
    const ft = makeFakeTimers()
    const h = makeHarness({ timers: ft.timers })
    const longMs = 99_999_999_999
    h.setReply(() => `{"decisions":[],"standbyMs":${longMs}}`)
    h.rt.start()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('standby'))
    expect(h.rt.getState().lastPlan?.standbyMs).toBe(longMs)
    expect(h.rt.getState().standbyUntil).toBeGreaterThan(Date.now() + 24 * 3600_000)
    h.rt.stop()
  })

  it('超过 JS 定时器上限的待机：分片续排，第一片到期不提前结束', async () => {
    const ft = makeFakeTimers()
    const h = makeHarness({ timers: ft.timers })
    const longMs = 2 ** 31 - 1 + 60_000
    h.setReply(() => `{"decisions":[],"standbyMs":${longMs}}`)
    h.rt.start()
    await vi.waitFor(() => expect(h.rt.getState().phase).toBe('standby'))
    expect(ft.size()).toBe(1)
    ft.fire() // 第一片（≈24.8 天）到期 → 还剩 60s，必须重新排期而不是激活
    expect(h.rt.getState().phase).toBe('standby')
    expect(ft.size()).toBe(1)
    h.rt.stop()
  })
})
