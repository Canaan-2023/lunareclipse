/**
 * ROOM 自主循环 + 迁移（B6）回归测试。
 *
 * 为什么存在：分诊规则（「不能所有的都跑长线不看即时性」）与迁移白名单（越界即拒）都是
 * 静默坏掉的类型——跑偏了不会有任何报错，只会让自主模式行为不对。必须有回归网。
 *
 * 覆盖：分诊规则优先级 / 特征提取 / 循环链路（采集失败→idle、即时不召回、长线先召回、
 * 规划空→idle、有动作→逐条执行）/ 迁移门控（未授予、白名单内、越界、传输失败）。
 */
import { describe, it, expect, vi } from 'vitest'
import type { PolicyDecision, PolicyRequest, SecurityGrants } from '../shared/types/permission'
import { suggestMode, extractTriageFeatures, LONG_TERM_INPUT_CHARS } from '../electron/main/room/triage'
import { createAutonomousLoop } from '../electron/main/room/loop'
import { migrateTask, type MigrationPlan } from '../electron/main/room/migration'
import type { ExecutorDecision } from '../electron/main/room/executor'

const BASE = {
  inputChars: 10,
  longTermIntent: false,
  immediateIntent: false,
  recentLongTerm: false,
  hasOpenPlan: false
}

describe('分诊：即时/长线规则优先级', () => {
  it('默认即时', () => {
    expect(suggestMode(BASE).mode).toBe('immediate')
  })

  it('即时意图优先于长期意图（「不能所有的都跑长线不看即时性」）', () => {
    const r = suggestMode({ ...BASE, immediateIntent: true, longTermIntent: true })
    expect(r.mode).toBe('immediate')
    expect(r.reason).toContain('即时')
  })

  it('刚做过长线 → 本次即时（防连续长思考）', () => {
    expect(suggestMode({ ...BASE, recentLongTerm: true, longTermIntent: true }).mode).toBe('immediate')
  })

  it('长期意图 / 大体积 / 有未完成计划 → 长线', () => {
    expect(suggestMode({ ...BASE, longTermIntent: true }).mode).toBe('long-term')
    expect(suggestMode({ ...BASE, inputChars: LONG_TERM_INPUT_CHARS + 1 }).mode).toBe('long-term')
    expect(suggestMode({ ...BASE, hasOpenPlan: true }).mode).toBe('long-term')
  })

  it('extractTriageFeatures：词表命中与体积', () => {
    const f = extractTriageFeatures('帮我分析一下这个方案的长期影响')
    expect(f.longTermIntent).toBe(true)
    expect(f.inputChars).toBeGreaterThan(0)
    const g = extractTriageFeatures('现在的状态怎么样')
    expect(g.immediateIntent).toBe(true)
  })
})

describe('自主循环：链路与分诊联动', () => {
  function makeLoop(opts: { text?: string; planDecisions?: number } = {}) {
    const events: string[] = []
    const executed: ExecutorDecision[] = []
    let recallCalled = 0
    const loop = createAutonomousLoop({
      collect: async () => (opts.text === undefined ? { ok: false, error: '采集被拒' } : { ok: true, text: opts.text }),
      recall: async () => {
        recallCalled++
        return { text: '记忆召回内容' }
      },
      plan: async ({ mode, recalled }) => {
        events.push(`plan:${mode}:${recalled ? 'recalled' : 'norecall'}`)
        const n = opts.planDecisions ?? 0
        return n === 0 ? { decisions: [], note: '无动作' } : { decisions: Array.from({ length: n }, (_, i) => ({ kind: 'tool' as const, description: `动作${i}` })) }
      },
      execute: async (d) => {
        executed.push(d)
        return { ok: true, decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' } }
      },
      onEvent: (ev) => events.push(ev.phase),
      now: () => 0
    })
    return { loop, events, executed, recallCalls: () => recallCalled }
  }

  it('采集失败 → idle，不进入规划', async () => {
    const h = makeLoop()
    const r = await h.loop.tick()
    expect(r.phase).toBe('idle')
    expect(r.acted).toBe(false)
    expect(h.events).not.toContain('plan')
  })

  it('用户消息与采集器并列：采集失败也能进入规划（文本含【用户刚说的话】）', async () => {
    let planned = ''
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: false, error: '采集被拒' }),
      consumeUserInput: () => '你能看到我吗？',
      hasPendingInput: () => false,
      plan: async ({ text }) => {
        planned = text
        return { decisions: [], note: '收到' }
      },
      execute: async () => ({
        ok: true,
        decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
      }),
      now: () => 0
    })
    const r = await loop.tick()
    expect(planned).toContain('【用户刚说的话】')
    expect(planned).toContain('你能看到我吗？')
    expect(r.phase).toBe('idle')
  })

  it('即时模式 → 不召回记忆', async () => {
    const h = makeLoop({ text: '现在的状态怎么样', planDecisions: 1 })
    const r = await h.loop.tick()
    expect(r.mode).toBe('immediate')
    expect(h.recallCalls()).toBe(0)
    expect(h.events).toContain('plan:immediate:norecall')
  })

  it('长线模式 → 先召回记忆再规划', async () => {
    const h = makeLoop({ text: '帮我分析这个方案的长期影响', planDecisions: 1 })
    const r = await h.loop.tick()
    expect(r.mode).toBe('long-term')
    expect(h.recallCalls()).toBe(1)
    expect(h.events).toContain('recall')
    expect(h.events).toContain('plan:long-term:recalled')
  })

  it('规划无动作 → idle', async () => {
    const h = makeLoop({ text: '现在的状态怎么样', planDecisions: 0 })
    const r = await h.loop.tick()
    expect(r.phase).toBe('idle')
    expect(r.acted).toBe(false)
  })

  it('有动作 → 逐条执行并回传结果', async () => {
    const h = makeLoop({ text: '现在的状态怎么样', planDecisions: 3 })
    const r = await h.loop.tick()
    expect(r.phase).toBe('execute')
    expect(r.acted).toBe(true)
    expect(h.executed).toHaveLength(3)
    expect(r.executions).toHaveLength(3)
  })

  it('连续长线后自动回落即时（recentLongTerm 生效）', async () => {
    const h = makeLoop({ text: '帮我分析这个方案的长期影响', planDecisions: 0 })
    const first = await h.loop.tick()
    expect(first.mode).toBe('long-term')
    // 第二次同样的长线文本，但上一轮已长线 → 本次即时
    const second = await h.loop.tick()
    expect(second.mode).toBe('immediate')
    expect(second.triageReason).toContain('刚做过长线')
  })
})

describe('自主循环：重复动作由 AI 自决（0.53.3，去掉计数魔法）', () => {
  const okDecision = { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' } as const

  function makeLoop(
    plan: (repeat?: { signature: string; count: number }) => {
      decisions: ExecutorDecision[]
      repeat?: 'continue' | 'stop'
    }
  ): { loop: ReturnType<typeof createAutonomousLoop>; executed: () => number } {
    let n = 0
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async ({ repeat }) => plan(repeat),
      execute: async () => {
        n += 1
        return { ok: true, decision: okDecision }
      },
      now: () => 0
    })
    return { loop, executed: () => n }
  }

  it('相同计划第二次没有 repeat=continue → 不执行，转入 idle(repeat)', async () => {
    const same: ExecutorDecision = { kind: 'tool', toolName: 'read', params: { path: 'a' }, description: '读 a' }
    const h = makeLoop(() => ({ decisions: [same] }))
    expect((await h.loop.tick()).phase).toBe('execute')
    const r = await h.loop.tick()
    expect(r.phase).toBe('idle')
    expect(r.idleReason).toBe('repeat')
    expect(h.executed()).toBe(1)
  })

  it('参数键序不同仍是同一动作（稳定签名，不能靠换键序绕过）', async () => {
    let n = 0
    const h = makeLoop(() => {
      n += 1
      return {
        decisions: [
          {
            kind: 'tool',
            toolName: 'read',
            params: n === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 },
            description: '读'
          }
        ]
      }
    })
    expect((await h.loop.tick()).phase).toBe('execute')
    expect((await h.loop.tick()).idleReason).toBe('repeat')
    expect(h.executed()).toBe(1)
  })

  it('相同计划显式 repeat=continue → 继续执行（次数由 AI 决定，不是系统阈值）', async () => {
    const same: ExecutorDecision = { kind: 'tool', toolName: 'read', params: { path: 'a' }, description: '读 a' }
    const h = makeLoop(() => ({ decisions: [same], repeat: 'continue' }))
    for (let i = 0; i < 6; i += 1) expect((await h.loop.tick()).phase).toBe('execute')
    expect(h.executed()).toBe(6)
  })

  it('规划前收到事实：上一轮相同签名 + 连续次数', async () => {
    const same: ExecutorDecision = { kind: 'tool', toolName: 'read', params: {}, description: '读' }
    const seen: Array<{ signature: string; count: number } | undefined> = []
    const h = makeLoop((repeat) => {
      seen.push(repeat)
      return { decisions: [same] }
    })
    await h.loop.tick()
    await h.loop.tick()
    expect(seen[0]).toBeUndefined()
    expect(seen[1]?.count).toBe(1)
    expect(seen[1]?.signature).toContain('read')
  })

  it('计划变化就重新开始（不同参数是不同动作）', async () => {
    let i = 0
    const h = makeLoop(() => ({
      decisions: [{ kind: 'tool', toolName: 'read', params: { path: `f${(i += 1)}` }, description: '读' }]
    }))
    for (let k = 0; k < 6; k += 1) expect((await h.loop.tick()).phase).toBe('execute')
    expect(h.executed()).toBe(6)
  })

  it('中间出现无动作 → 重复上下文归零（下一次是新的开始）', async () => {
    let mode: 'same' | 'none' = 'same'
    const same: ExecutorDecision = { kind: 'tool', toolName: 'read', params: {}, description: '读' }
    const h = makeLoop(() => (mode === 'none' ? { decisions: [] } : { decisions: [same] }))
    await h.loop.tick()
    mode = 'none'
    expect((await h.loop.tick()).idleReason).toBe('no-action')
    mode = 'same'
    expect((await h.loop.tick()).phase).toBe('execute')
    expect(h.executed()).toBe(2)
  })

  it('AI 显式 repeat=stop → 不执行并收束', async () => {
    const h = makeLoop(() => ({
      decisions: [{ kind: 'tool', toolName: 'read', params: {}, description: '读' }],
      repeat: 'stop'
    }))
    const r = await h.loop.tick()
    expect(r.phase).toBe('idle')
    expect(r.idleReason).toBe('no-action')
    expect(h.executed()).toBe(0)
  })

  it('执行全部被拒（没有实质动作）→ 驱动不再续轮', async () => {
    let plans = 0
    let executes = 0
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        plans += 1
        // 每轮换个参数，绕开「相同签名」判断——但执行全被拒
        return { decisions: [{ kind: 'tool', toolName: 'write', params: { i: plans }, description: '写' }] }
      },
      execute: async () => {
        executes += 1
        return {
          ok: false,
          error: 'denied',
          decision: { allowed: false, tier: 'T1', code: 't1_not_granted', reason: 'denied', auditId: 'a' }
        }
      },
      now: () => 0
    })
    const stop = loop.start()
    await vi.waitFor(() => expect(executes).toBeGreaterThanOrEqual(1))
    // 留一个事件循环节拍：若驱动会续轮，第二次执行会在这里发生
    await new Promise((r) => setTimeout(r, 20))
    stop()
    expect(executes).toBe(1)
    expect(plans).toBe(1)
  })

  it('没有「单次激活最多几轮」：动作一直有进展就一直跑（AI 自己决定何时停）', async () => {
    let executes = 0
    const loop = createAutonomousLoop({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        executes += 1
        // 第 21 轮主动收束（AI 自己的判断）；若仍有旧 12 轮上限，这里到不了 21
        if (executes > 20) return { decisions: [], note: '这一段做完了' }
        return { decisions: [{ kind: 'tool', toolName: 'read', params: { i: executes }, description: '读' }] }
      },
      execute: async () => ({ ok: true, decision: okDecision }),
      now: () => 0
    })
    loop.start()
    // 驱动每轮会让出宏任务；给它一个窗口自行收束
    await new Promise((r) => setTimeout(r, 100))
    expect(executes).toBe(21)
    expect(executes).toBeGreaterThan(12)
  })
})

describe('迁移：t1.migrate 门控（白名单越界即拒）', () => {
  const PLAN: MigrationPlan = { taskId: 't1', fromNode: 1, toNode: 2, payload: { step: 3 } }

  function makeDeps(grants: SecurityGrants, sendOk = true) {
    const calls: PolicyRequest[] = []
    const sent: MigrationPlan[] = []
    const evaluate = (req: PolicyRequest): PolicyDecision => {
      calls.push(req)
      const g = grants.grants['t1.migrate']
      const node = req.scope?.nodes?.[0]
      const inScope = g != null && node != null && (g.scope?.nodes ?? []).includes(node)
      return {
        allowed: inScope,
        tier: 'T1',
        code: inScope ? 'allowed' : g ? 't1_out_of_scope' : 't1_not_granted',
        reason: inScope ? 'ok' : g ? `越界：nodes 中的 ${String(node)} 不在授权范围内` : 't1.migrate 未授予',
        auditId: 'a'
      }
    }
    return {
      deps: { evaluate, send: async (p: MigrationPlan) => { sent.push(p); return { ok: sendOk, error: sendOk ? undefined : '网络失败' } } },
      calls,
      sent
    }
  }

  it('未授予 → 拒绝且不发送', async () => {
    const h = makeDeps({ grants: {} })
    const r = await migrateTask(PLAN, h.deps)
    expect(r.ok).toBe(false)
    expect(h.sent).toHaveLength(0)
  })

  it('白名单内 → 发送成功', async () => {
    const h = makeDeps({ grants: { 't1.migrate': { key: 't1.migrate', grantedAt: 1, scope: { nodes: ['2', '3'] } } } })
    const r = await migrateTask(PLAN, h.deps)
    expect(r.ok).toBe(true)
    expect(h.sent).toHaveLength(1)
  })

  it('越界（目标不在白名单）→ 拒绝且不发送', async () => {
    const h = makeDeps({ grants: { 't1.migrate': { key: 't1.migrate', grantedAt: 1, scope: { nodes: ['9'] } } } })
    const r = await migrateTask(PLAN, h.deps)
    expect(r.ok).toBe(false)
    expect(r.decision.code).toBe('t1_out_of_scope')
    expect(h.sent).toHaveLength(0)
  })

  it('传输失败 → 保留放行裁决 + 错误原因', async () => {
    const h = makeDeps({ grants: { 't1.migrate': { key: 't1.migrate', grantedAt: 1, scope: { nodes: ['2'] } } } }, false)
    const r = await migrateTask(PLAN, h.deps)
    expect(r.ok).toBe(false)
    expect(r.decision.allowed).toBe(true)
    expect(r.error).toContain('网络失败')
  })
})
