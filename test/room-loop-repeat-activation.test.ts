/**
 * 重复动作的**跨激活上下文** + 无轮数上限下的驱动收束（0.53.3 补测）。
 *
 * 缺口背景：`room-loop.test.ts` 验证的是**同一次激活内**连续 tick 的 repeat 语义；
 * 但 `samePlanCount` 明确「永不重置于 start」，这条设计只有在**跨激活**时才体现价值：
 * AI 被感知器重新叫醒后，仍应看到「你上一轮已经提过同一动作（第 N 次）」，
 * 否则它每次醒来都以为是新开始，会重复烧同样的动作。
 *
 * 同时补一个死循环边界：去掉 12 轮上限后，驱动必须**停得住且不饿死宏任务**
 * （`stop()` 后 setTimeout 能跑、轮次不再增长），否则「无上限」会变成「卡死事件循环」。
 */
import { describe, it, expect, vi } from 'vitest'
import { createAutonomousLoop } from '../electron/main/room/loop'
import type { ExecutorDecision } from '../electron/main/room/executor'

const OK = { ok: true, decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' } } as const
const SAME: ExecutorDecision = { kind: 'tool', toolName: 'read', params: { path: 'a' }, description: '读 a' }

describe('repeat 上下文跨激活保留（不是「每次醒来都重新开始」）', () => {
  it('第一次激活 park 后，第二次激活仍收到 repeat 事实；显式 continue 才执行', async () => {
    const repeatSeen: Array<number | undefined> = []
    let calls = 0
    let executed = 0
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async ({ repeat }) => {
        calls += 1
        repeatSeen.push(repeat?.count)
        if (calls <= 2) return { decisions: [SAME] } // 第 1 轮执行；第 2 轮相同 → park(repeat)
        if (calls === 3) return { decisions: [SAME], repeat: 'continue' } // 新激活：显式同意再做一次
        return { decisions: [], note: '这一段做完了' }
      },
      execute: async () => {
        executed += 1
        return { ok: true, decision: OK.decision }
      },
      now: () => 0
    })

    loop.start()
    await vi.waitFor(() => expect(calls).toBe(2))
    await new Promise((r) => setTimeout(r, 20)) // 驱动应已 park（不会再自己跑第 3 轮）
    expect(calls).toBe(2)
    expect(executed).toBe(1)
    expect(repeatSeen[1]).toBe(1)

    loop.start() // 第二次激活
    await vi.waitFor(() => expect(calls).toBe(4))

    // 跨激活保留：新激活的第一轮就带着「上一段是第 2 次相同」的事实
    expect(repeatSeen[2]).toBe(2)
    expect(executed).toBe(2) // continue 才执行（第二次相同动作没有被系统偷偷执行）
  })

  it('repeat=stop 不执行动作，并把上下文清零（下一次是新的开始）', async () => {
    const repeatSeen: Array<number | undefined> = []
    let calls = 0
    let executed = 0
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async ({ repeat }) => {
        calls += 1
        repeatSeen.push(repeat?.count)
        if (calls === 3) return { decisions: [SAME], repeat: 'stop' } // 第 2 次激活：主动收束
        return { decisions: [SAME] }
      },
      execute: async () => {
        executed += 1
        return { ok: true, decision: OK.decision }
      },
      now: () => 0
    })

    loop.start() // 第 1 次激活：执行 → 相同 → park(repeat)
    await vi.waitFor(() => expect(calls).toBe(2))
    await new Promise((r) => setTimeout(r, 20))
    expect(executed).toBe(1)

    loop.start() // 第 2 次激活：AI 写 repeat=stop
    await vi.waitFor(() => expect(calls).toBe(3))
    await new Promise((r) => setTimeout(r, 20))
    expect(executed).toBe(1) // stop 的动作**没有执行**
    expect(repeatSeen[2]).toBe(2)

    loop.start() // 第 3 次激活：上下文已清零
    await vi.waitFor(() => expect(executed).toBe(2))
    await new Promise((r) => setTimeout(r, 20)) // 让它自己跑到「再相同 → park(repeat)」
    expect(repeatSeen[3]).toBeUndefined() // stop 之后不再带「重复」事实
    expect(repeatSeen[4]).toBe(1) // 新的一段从第 1 次重新计
    expect(executed).toBe(2)
  })
})

describe('无轮数上限：驱动停得住、不饿死宏任务', () => {
  it('跑到第 50 轮由 stop() 收束：没有 12 轮上限，且 setTimeout 能正常执行', async () => {
    let calls = 0
    let executed = 0
    let macrotaskRan = false
    const disarm: { fn: (() => void) | null } = { fn: null }
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        calls += 1
        // 每轮参数不同（这是「有进展」的正常动作），第 50 轮由外部收束
        if (calls >= 50) disarm.fn?.()
        return { decisions: [{ kind: 'tool', toolName: 'read', params: { i: calls }, description: '读' }] }
      },
      execute: async () => {
        executed += 1
        return { ok: true, decision: OK.decision }
      },
      now: () => 0
    })

    // 驱动整条链路都在微任务里推进：只有它 park/停下，这个宏任务才会执行
    setTimeout(() => {
      macrotaskRan = true
    }, 0)
    disarm.fn = loop.start()

    await vi.waitFor(() => expect(macrotaskRan).toBe(true), { timeout: 5_000 })
    const settled = calls
    expect(settled).toBe(50) // 越过旧的 12 轮上限（上限已被删除）
    expect(executed).toBe(50)

    await new Promise((r) => setTimeout(r, 20))
    expect(calls).toBe(settled) // stop 之后轮次不再增长（没有失控续跑）
  })

  it('重复动作未声明 continue：驱动 park 后不再自己续轮（无上限 ≠ 无限空转）', async () => {
    let calls = 0
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        calls += 1
        return { decisions: [SAME] }
      },
      execute: async () => ({ ok: true, decision: OK.decision }),
      now: () => 0
    })
    loop.start()
    await vi.waitFor(() => expect(calls).toBe(2))
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(2) // 第 2 次相同 → idle(repeat) → park
  })
})
