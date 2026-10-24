/**
 * ROOM 规划解析 + 运行时（B8）回归测试。
 *
 * 为什么存在：「AI 文本 → 结构化动作」的转换是自主模式的**安全咽喉**——转错一个字段就可能
 * 执行不该执行的动作。工具白名单过滤是这条咽喉的闸门，必须有回归网。
 *
 * 覆盖：JSON 抽取（围栏块 / 裸对象 / 无）/ 解析（合法、白名单外丢弃、缺 tool 丢弃、actions 别名、
 * 无 JSON 报错）/ 召回块与提示词形状 / 运行时（注入 fake 依赖跑通一条链路）。
 */
import { describe, it, expect, vi } from 'vitest'
import { extractJsonObject, parsePlan } from '../electron/main/room/plan'
import {
  buildTreeIndexBlock,
  buildPlanPrompt,
  createRoomRuntime,
  parseLanding,
  type RoomRuntimeDeps,
  type RoomTimers
} from '../electron/main/room/runtime'
import type { Executor } from '../electron/main/room/executor'

const TOOLS = ['read', 'write', 'glob']

/**
 * 这些用例都假设「自主模式已在某个会话里开启」：默认绑定承载会话（0.53.18）。
 * 未绑定时运行时不规划（见 room-landing.test.ts），故不能省。
 */
function makeRuntime(deps: RoomRuntimeDeps) {
  const rt = createRoomRuntime(deps)
  rt.setHostSession('chat-1')
  return rt
}

describe('extractJsonObject', () => {
  it('优先取围栏代码块', () => {
    const t = '前言\n```json\n{"decisions":[]}\n```\n后记'
    expect(JSON.parse(extractJsonObject(t)!)).toEqual({ decisions: [] })
  })

  it('无围栏时取第一个平衡的 {...}', () => {
    const t = '说明 {"note":"a","decisions":[{"tool":"read"}]} 结束'
    expect(JSON.parse(extractJsonObject(t)!)).toEqual({ note: 'a', decisions: [{ tool: 'read' }] })
  })

  it('无 JSON → null', () => {
    expect(extractJsonObject('没有计划')).toBeNull()
  })
})

describe('parsePlan：工具白名单过滤（安全咽喉）', () => {
  it('合法计划 → 逐条结构化（AI 自述的 readOnly 被丢弃，见 P0-2）', () => {
    const r = parsePlan('{"note":"查一下","decisions":[{"tool":"read","params":{"path":"a"},"description":"读 a","readOnly":true}]}', TOOLS)
    expect(r.parseError).toBeUndefined()
    expect(r.note).toBe('查一下')
    expect(r.decisions).toEqual([
      { kind: 'tool', toolName: 'read', params: { path: 'a' }, fromToolZone: false, description: '读 a' }
    ])
    expect(r.dropped).toEqual([])
  })

  it('白名单外的工具被丢弃（不抛错）', () => {
    const r = parsePlan('{"decisions":[{"tool":"rm_rf"},{"tool":"read"}]}', TOOLS)
    expect(r.decisions).toHaveLength(1)
    expect(r.decisions[0].toolName).toBe('read')
    expect(r.dropped[0]).toContain('rm_rf')
  })

  it('缺 tool 字段被丢弃', () => {
    const r = parsePlan('{"decisions":[{"params":{}}]}', TOOLS)
    expect(r.decisions).toHaveLength(0)
    expect(r.dropped[0]).toContain('缺少 tool')
  })

  it('兼容 actions 别名', () => {
    const r = parsePlan('{"actions":[{"tool":"glob"}]}', TOOLS)
    expect(r.decisions[0].toolName).toBe('glob')
  })

  it('无 JSON → parseError，decisions 空', () => {
    const r = parsePlan('我什么也不做', TOOLS)
    expect(r.parseError).toBeTruthy()
    expect(r.decisions).toHaveLength(0)
  })

  it('description 缺省由工具名生成', () => {
    const r = parsePlan('{"decisions":[{"tool":"read"}]}', TOOLS)
    expect(r.decisions[0].description).toContain('read')
  })
})

describe('parsePlan：直播回复 / 房间动作（闭集）', () => {
  const TOOLS = ['read']

  it('reply 去空白并截断；scene 合法时透传', () => {
    const r = parsePlan('{"reply":"  我在。 ","scene":{"zone":"plan","action":"observe"},"decisions":[]}', TOOLS)
    expect(r.reply).toBe('我在。')
    expect(r.scene).toEqual({ zone: 'plan', action: 'observe' })
  })

  it('未知 zone → scene 丢弃（不影响 decisions）；未知 action → 回落 walk', () => {
    expect(parsePlan('{"scene":{"zone":"moon"}}', TOOLS).scene).toBeUndefined()
    expect(parsePlan('{"scene":{"zone":"work","action":"fly"}}', TOOLS).scene).toEqual({ zone: 'work', action: 'walk' })
  })

  it('reply 不是字符串 → 不写；空 reply → 不写', () => {
    expect(parsePlan('{"reply":123}', TOOLS).reply).toBeUndefined()
    expect(parsePlan('{"reply":"   "}', TOOLS).reply).toBeUndefined()
  })
})

describe('会话树索引与规划提示词（ADR-30 / 0.53.18）', () => {
  it('buildTreeIndexBlock：无树 → 空串；有树则列出落点标记 / id / 标题 / 摘要 / 可写与否', () => {
    expect(buildTreeIndexBlock(null)).toBe('')
    const block = buildTreeIndexBlock({
      sessionId: 'chat-1',
      activeId: 'is_a',
      sessions: [
        { id: 'is_a', title: 'T1', summary: 'S1', gen: 2, writableTail: true, updatedAt: 1 },
        { id: 'is_b', title: 'T2', summary: '', writableTail: false, updatedAt: 2 }
      ]
    })
    expect(block).toContain('【会话树】')
    expect(block).toContain('会话树（当前会话的逆生树）')
    expect(block).toContain('★当前落点 is_a')
    expect(block).toContain('第2代')
    expect(block).toContain('只读')
    // 0.53.18：不再有第二棵树
    expect(block).not.toContain('房间树')
  })

  it('buildTreeIndexBlock：空树也渲染（显式告诉 AI 可以用 create 开第一条线）', () => {
    const block = buildTreeIndexBlock({ sessionId: 'chat-1', activeId: null, sessions: [] })
    expect(block).toContain('（空——可用 landing 的 create 开第一条线）')
  })

  it('buildPlanPrompt：含采集输入 / 分诊 / 工具白名单 / 输出契约；带树时才有【会话树】段', () => {
    const p = buildPlanPrompt({ text: '环境正常', mode: 'immediate', allowedTools: ['read'] })
    expect(p).toContain('环境正常')
    expect(p).toContain('即时')
    expect(p).toContain('read')
    expect(p).toContain('decisions')
    // 契约文本本身会提到「【会话树】段」，故按**索引行**判定是否真的注入了树
    expect(p).not.toContain('· 会话树（当前会话的逆生树）')

    const withTree = buildPlanPrompt({
      text: 'x',
      mode: 'immediate',
      allowedTools: [],
      tree: {
        sessionId: 'chat-1',
        activeId: null,
        sessions: [{ id: 'is_a', title: 'T', summary: 'S', writableTail: true, updatedAt: 1 }]
      }
    })
    expect(withTree).toContain('【会话树】')
    expect(withTree).toContain('is_a')

    // 局部更新的前提：AI 必须看到当前策略，否则只能盲改或全量重写
    const withPolicy = buildPlanPrompt({
      text: 'x',
      mode: 'immediate',
      allowedTools: [],
      sensorPolicy: { enabled: true, mute: ['cpu'], intervalMs: 60_000 }
    })
    expect(withPolicy).toContain('【当前感知策略】')
    expect(withPolicy).toContain('屏蔽 CPU')
    expect(withPolicy).toContain('"mute":["cpu"]')
  })
})

describe('parseLanding：落点形状校验（纯函数；语义校验在应用点）', () => {
  it('只认 continue / create；其余形状一律 null', () => {
    expect(parseLanding(null)).toBeNull()
    expect(parseLanding('continue')).toBeNull()
    expect(parseLanding({})).toBeNull()
    expect(parseLanding({ action: 'select' })).toBeNull()
    expect(parseLanding({ action: 'continue' })).toEqual({ action: 'continue' })
  })

  it('按需取字段：空白字符串丢弃、newTopic 仅 true 生效', () => {
    expect(
      parseLanding({ action: 'create', title: '  ', summary: ' 有摘要 ', newTopic: false, internalId: 'is_p' })
    ).toEqual({ action: 'create', summary: '有摘要', internalId: 'is_p' })
    expect(parseLanding({ action: 'create', newTopic: true })).toEqual({ action: 'create', newTopic: true })
  })
})

describe('createRoomRuntime：用户消息 / 直播场景（第一类输入）', () => {
  const executor: Executor = {
    execute: async () => ({
      ok: true,
      decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
    })
  }

  it('stopped 不接收消息（尊重自主开关，渲染侧退回普通会话）', () => {
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '未开启' }),
      plan: async () => '{}',
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    const r = rt.onUserMessage('你好')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('房间未开启')
  })

  it('采集失败也能收到用户消息；reply / scene 落状态并进事件流', async () => {
    const seen: string[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '采集器未开启' }),
      plan: async (prompt) => {
        seen.push(prompt)
        return '{"reply":"我在。","scene":{"zone":"plan","action":"observe"},"decisions":[]}'
      },
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    rt.start()
    expect(rt.onUserMessage('你能看到我吗？').ok).toBe(true)
    await vi.waitFor(() => expect(rt.getState().lastReply).toBe('我在。'))
    const st = rt.getState()
    expect(seen.some((t) => t.includes('【用户刚说的话】') && t.includes('你能看到我吗？'))).toBe(true)
    expect(st.scene).toEqual({ zone: 'plan', action: 'observe' })
    expect(st.lastReplyAt).not.toBeUndefined()
    expect(st.events.some((e) => e.detail?.includes('回复：我在。'))).toBe(true)
    rt.stop()
  })

  it('park 之后收到用户消息仍能重新激活（回归：stopFn 必须在 drive 退出时清掉）', async () => {
    let collectCalls = 0
    const rt = makeRuntime({
      collect: async () => {
        collectCalls += 1
        return { ok: false, error: '无输入' }
      },
      plan: async () => '{"reply":"来了","decisions":[]}',
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    rt.start()
    await vi.waitFor(() => expect(collectCalls).toBeGreaterThanOrEqual(1))
    // 等 drive 把「无动作」的 tick 收尾并 park（onDriveEnd 清 stopFn）
    await new Promise((r) => setTimeout(r, 30))
    expect(rt.onUserMessage('在吗').ok).toBe(true)
    await vi.waitFor(() => expect(rt.getState().lastReply).toBe('来了'))
    rt.stop()
  })
})

describe('关停守卫：stop() 后仍在飞的 plan 不得继续落副作用（SRE P0）', () => {
  it('plan 返回时已 stopped → 不执行 decisions、不重新 arm 待机', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let planned = false
    let executes = 0
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        planned = true
        await gate
        return '{"decisions":[{"tool":"read","params":{}}],"standbyMs":60000}'
      },
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
      now: () => 0
    })
    rt.start()
    await vi.waitFor(() => expect(planned).toBe(true))
    rt.stop()
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(executes).toBe(0)
    expect(rt.getState().phase).toBe('stopped')
    expect(rt.getState().standbyUntil).toBeUndefined()
  })
})

describe('createRoomRuntime：感知器（0.53.1 闭环）', () => {
  const executor: Executor = {
    execute: async () => ({
      ok: true,
      decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
    })
  }

  /** 手动定时器：能按 label 精确驱动感知器（`room-sensor`）/ 待机（`room-standby`） */
  function fakeTimers(): {
    timers: RoomTimers
    fire: (label?: string) => Promise<void>
    size: () => number
  } {
    const pending: Array<{ id: string; cb: () => void; label?: string }> = []
    let seq = 0
    return {
      timers: {
        setTimeout: (cb: () => void, _ms?: number, label?: string) => {
          const id = `t${++seq}`
          pending.push({ id, cb, ...(label ? { label } : {}) })
          return id
        },
        clearTimeout: (h: string) => {
          const i = pending.findIndex((p) => p.id === h)
          if (i >= 0) pending.splice(i, 1)
        }
      },
      fire: async (label?: string) => {
        const all = label ? pending.filter((p) => p.label === label) : [...pending]
        for (const p of all) {
          const i = pending.indexOf(p)
          if (i >= 0) pending.splice(i, 1)
          p.cb()
        }
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      },
      size: () => pending.length
    }
  }

  it('park 后感知器启动（state.sensing=true），变化只上报 collector（不自己激活）', async () => {
    const t = fakeTimers()
    let cpu = 10
    const wakes: string[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '无输入' }),
      plan: async () => '{"decisions":[]}',
      executor,
      allowedTools: () => [],
      timers: t.timers,
      sense: async () => ({ at: 0, cpuPct: cpu }),
      reportWake: (source, detail) => {
        wakes.push(`${source}:${detail ?? ''}`)
        return true
      },
      now: () => 0
    })
    rt.start()
    await vi.waitFor(() => expect(rt.getState().sensing).toBe(true))
    expect(t.size()).toBe(1)

    await t.fire() // 基线 10
    cpu = 90
    await t.fire() // 10 → 90
    expect(wakes.some((w) => w.startsWith('collector:') && w.includes('CPU 10% → 90%'))).toBe(true)

    // 感知器只上报：相位仍是 idle（真正的激活由仲裁器 → rt.wake 完成）
    expect(rt.getState().phase).toBe('idle')
    rt.stop()
    expect(rt.getState().sensing).toBe(false)
    expect(t.size()).toBe(0)
  })

  it('待机仍感知（事件可提前唤醒）；停止才闭眼', async () => {
    const t = fakeTimers()
    let cpu = 10
    const wakes: string[] = []
    // 闭包里需要 runtime 自身（reportWake → wake）；用可变属性而不是 let 变量（lint prefer-const）
    const ref: { rt: ReturnType<typeof createRoomRuntime> | null } = { rt: null }
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '无输入' }),
      plan: async () => '{"decisions":[]}',
      executor,
      allowedTools: () => [],
      timers: t.timers,
      sense: async () => ({ at: 0, cpuPct: cpu }),
      reportWake: (source, detail) => {
        wakes.push(`${source}:${detail ?? ''}`)
        ref.rt?.wake(source, detail)
        return true
      },
      now: () => 0
    })
    ref.rt = rt
    rt.start()
    await vi.waitFor(() => expect(rt.getState().sensing).toBe(true))
    rt.standby(60_000)
    expect(rt.getState().phase).toBe('standby')
    // 待机 ≠ 闭眼：感知器仍在跑（+ 待机到期定时器），事件可以提前把 AI 叫醒
    expect(rt.getState().sensing).toBe(true)
    expect(t.size()).toBe(2)

    await t.fire('room-sensor') // 基线 10
    cpu = 90
    await t.fire('room-sensor') // 待机中感知到变化 → 唤醒并解除待机
    expect(wakes.some((w) => w.startsWith('collector:') && w.includes('CPU 10% → 90%'))).toBe(true)
    expect(rt.getState().phase).not.toBe('standby')
    expect(rt.getState().standbyUntil).toBeUndefined()

    rt.stop()
    expect(rt.getState().sensing).toBe(false)
    expect(t.size()).toBe(0)
  })

  it('AI 的 sensor 策略：写入状态、保存、并决定感知器是否启动', async () => {
    const t = fakeTimers()
    const seen: Array<readonly string[]> = []
    const saved: unknown[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () =>
        '{"decisions":[],"sensor":{"mute":["cpu"],"intervalMs":60000,"thresholds":{"cpuDeltaPct":45}}}',
      executor,
      allowedTools: () => [],
      timers: t.timers,
      sense: async (_view, policy) => {
        seen.push(policy.mute)
        return { at: 0, cpuPct: 10 }
      },
      saveSensorPolicy: (p) => saved.push(p),
      now: () => 0
    })
    rt.start()
    await vi.waitFor(() => expect(rt.getState().sensorPolicy?.mute).toEqual(['cpu']))
    expect(rt.getState().sensorPolicy?.intervalMs).toBe(60000)
    expect(rt.getState().sensorPolicy?.thresholds?.cpuDeltaPct).toBe(45)
    expect(saved).toHaveLength(1)
    // 策略 enabled 默认为 true → 驱动 park 后感知器启动；采样回调拿到的是 AI 的策略
    await vi.waitFor(() => expect(rt.getState().sensing).toBe(true))
    await t.fire('room-sensor')
    expect(seen[0]).toEqual(['cpu'])
    rt.stop()
  })

  it('AI 可以彻底关闭感知：sensing=false，不再排感知定时器', async () => {
    const t = fakeTimers()
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[],"sensor":{"enabled":false}}',
      executor,
      allowedTools: () => [],
      timers: t.timers,
      sense: async () => ({ at: 0, cpuPct: 10 }),
      now: () => 0
    })
    rt.start()
    await vi.waitFor(() => expect(rt.getState().phase).toBe('idle'))
    expect(rt.getState().sensorPolicy?.enabled).toBe(false)
    expect(rt.getState().sensing).toBe(false)
    expect(t.size()).toBe(0)
    rt.stop()
  })

  it('启动时恢复已保存的感知策略', async () => {
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '无输入' }),
      plan: async () => '{"decisions":[]}',
      executor,
      allowedTools: () => [],
      loadSensorPolicy: () => ({ mute: ['lan'], thresholds: { freeMemDeltaGB: 4 } }),
      now: () => 0
    })
    expect(rt.getState().sensorPolicy?.mute).toEqual(['lan'])
    expect(rt.getState().sensorPolicy?.thresholds?.freeMemDeltaGB).toBe(4)
  })

  it('策略文件不存在（load 返回 undefined）→ 默认策略，且**不**误报「恢复失败」', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const rt = makeRuntime({
        collect: async () => ({ ok: false, error: '无输入' }),
        plan: async () => '{"decisions":[]}',
        executor,
        allowedTools: () => [],
        loadSensorPolicy: () => undefined,
        now: () => 0
      })
      expect(rt.getState().sensorPolicy).toEqual({ enabled: true, mute: [] })
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('策略文件损坏（非对象）→ 记错误并回落默认策略', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const rt = makeRuntime({
        collect: async () => ({ ok: false, error: '无输入' }),
        plan: async () => '{"decisions":[]}',
        executor,
        allowedTools: () => [],
        loadSensorPolicy: () => 'not-a-policy',
        now: () => 0
      })
      expect(rt.getState().sensorPolicy).toEqual({ enabled: true, mute: [] })
      expect(errSpy).toHaveBeenCalledWith('[room] 感知策略恢复失败:', expect.any(String))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('用户侧回收：resetSensorPolicy 把 AI 的策略复位为默认并保存', async () => {
    const saved: unknown[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '无输入' }),
      plan: async () => '{"decisions":[]}',
      executor,
      allowedTools: () => [],
      loadSensorPolicy: () => ({ enabled: false, mute: ['cpu', 'memory'] }),
      saveSensorPolicy: (p) => saved.push(p),
      now: () => 0
    })
    expect(rt.getState().sensorPolicy?.enabled).toBe(false)
    const r = rt.resetSensorPolicy()
    expect(r.ok).toBe(true)
    expect(rt.getState().sensorPolicy).toEqual({ enabled: true, mute: [] })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toEqual({ enabled: true, mute: [] })
  })

  it('wake(collector, detail) 记录 lastWake 并进事件流；stopped 时忽略', async () => {
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '无输入' }),
      plan: async () => '{"decisions":[]}',
      executor,
      allowedTools: () => [],
      now: () => 123
    })
    rt.wake('collector', '解锁屏幕') // stopped → 忽略
    expect(rt.getState().lastWake).toBeUndefined()

    rt.start()
    // start 会立即跑一轮（相位先 running）：等它 park 后再唤醒
    await vi.waitFor(() => expect(rt.getState().phase).toBe('idle'))
    rt.wake('collector', 'CPU 10% → 90%')
    const st = rt.getState()
    expect(st.lastWake).toEqual({ source: 'collector', detail: 'CPU 10% → 90%', at: 123 })
    expect(st.events.some((e) => e.detail?.includes('感知到变化') && e.detail.includes('CPU 10% → 90%'))).toBe(true)
    rt.stop()
  })

  it('running 期间到达的唤醒暂存，park 后补跑一轮（不丢事件）', async () => {
    let plans = 0
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        plans += 1
        return '{"decisions":[]}'
      },
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    rt.start()
    // 驱动此刻是 running：事件应被暂存，而不是丢弃
    rt.wake('collector', 'CPU 10% → 90%')
    await vi.waitFor(() => expect(rt.getState().events.some((e) => e.detail?.includes('补发唤醒'))).toBe(true))
    expect(plans).toBeGreaterThanOrEqual(2)
    rt.stop()
  })

  it('唤醒原因会进入下一轮提示词（AI 知道自己为什么醒）', async () => {
    const prompts: string[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async (prompt) => {
        prompts.push(prompt)
        return '{"decisions":[]}'
      },
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    rt.start()
    await vi.waitFor(() => expect(rt.getState().phase).toBe('idle'))
    rt.wake('collector', 'CPU 10% → 90%')
    await vi.waitFor(() => expect(prompts.some((p) => p.includes('【唤醒原因】'))).toBe(true))
    expect(prompts.some((p) => p.includes('CPU 10% → 90%'))).toBe(true)
    rt.stop()
  })

  it('手动 tick 单飞：并发调用只跑一条链路（另一条返回 busy）', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => {
        await gate
        return '{"decisions":[]}'
      },
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    const a = rt.tick()
    const b = await rt.tick()
    expect(b.idleReason).toBe('busy')
    release()
    await a
    rt.stop()
  })
})

describe('createRoomRuntime：链路装配', () => {
  function makeExecutor(): { executor: Executor; executed: string[] } {
    const executed: string[] = []
    return {
      executed,
      executor: {
        execute: async (d) => {
          executed.push(d.toolName ?? '')
          return { ok: true, decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' } }
        }
      }
    }
  }

  it('采集 → 规划 → 执行 跑通，并暴露状态', async () => {
    const { executor, executed } = makeExecutor()
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '现在的状态怎么样' }),
      plan: async () => '```json\n{"note":"看一眼","decisions":[{"tool":"read","params":{"path":"x"}}]}\n```',
      executor,
      allowedTools: () => ['read'],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.phase).toBe('execute')
    expect(r.mode).toBe('immediate')
    expect(executed).toEqual(['read'])
    const st = rt.getState()
    expect(st.running).toBe(false)
    expect(st.lastPlan?.decisions).toHaveLength(1)
    expect(st.events.length).toBeGreaterThan(0)
  })

  it('规划返回非法 JSON → 无动作、不崩', async () => {
    const { executor } = makeExecutor()
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '现在的状态' }),
      plan: async () => '我不会做',
      executor,
      allowedTools: () => ['read'],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.acted).toBe(false)
    expect(rt.getState().lastPlan?.decisions).toHaveLength(0)
  })

  it('规划抛错 → 无动作、不崩', async () => {
    const { executor } = makeExecutor()
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '现在的状态' }),
      plan: async () => {
        throw new Error('LLM 未配置')
      },
      executor,
      allowedTools: () => ['read'],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.acted).toBe(false)
  })

  it('采集失败 → idle', async () => {
    const { executor } = makeExecutor()
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: '采集器未开启' }),
      plan: async () => '{}',
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.phase).toBe('idle')
    expect(r.error).toContain('采集器未开启')
  })
})

/**
 * 状态推送（取代渲染端 3s 轮询）的回归网。
 * 为什么测：推送是渲染端**唯一**的状态来源——少推一次，界面就停在旧状态（且不会报错，只是静默陈旧）。
 * 另锁「单一构造点」：推送载荷必须与 `getState()` 同形，否则推送与 IPC 读取会各拼一份而漂移。
 */
describe('createRoomRuntime：状态推送（取代渲染端轮询）', () => {
  function makeExecutor(): Executor {
    return {
      execute: async () => ({
        ok: true,
        decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
      })
    }
  }

  it('每轮 tick 与启停都会推送；收尾推送的是 tick 之后的完整状态', async () => {
    const phases: string[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '现在的状态' }),
      plan: async () => '```json\n{"note":"看一眼","decisions":[{"tool":"read"}]}\n```',
      executor: makeExecutor(),
      allowedTools: () => ['read'],
      now: () => 0,
      onStateChange: (s) => phases.push(s.phase)
    })
    await rt.tick()
    expect(phases.length).toBeGreaterThan(0)
    expect(rt.getState().events.length).toBeGreaterThan(0)

    rt.stop()
    expect(phases.at(-1)).toBe('stopped')
  })

  it('推送载荷与 getState() 同形（单一构造点，不两处各拼一份）', () => {
    let pushed: unknown
    const rt = makeRuntime({
      collect: async () => ({ ok: false, error: 'x' }),
      plan: async () => '{}',
      executor: makeExecutor(),
      allowedTools: () => [],
      now: () => 0,
      onStateChange: (s) => {
        pushed = s
      }
    })
    rt.stop()
    expect(pushed).toEqual(rt.getState())
  })

  it('推送钩子抛错不打崩循环（但必须留痕，不静默）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const rt = makeRuntime({
        collect: async () => ({ ok: true, text: '现在的状态' }),
        plan: async () => '{}',
        executor: makeExecutor(),
        allowedTools: () => [],
        now: () => 0,
        onStateChange: () => {
          throw new Error('推送目标已销毁')
        }
      })
      await expect(rt.tick()).resolves.toBeDefined()
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
