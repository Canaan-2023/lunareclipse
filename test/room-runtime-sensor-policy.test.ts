/**
 * 感知策略的**持久化与生效边界**回归（0.53.3 补测）。
 *
 * 缺口背景：`room-runtime.test.ts` 只覆盖「策略写进状态 / 保存被调用一次 / 启动恢复合法策略」。
 * 真正会静默出问题的三类边界没有用例：
 *
 * 1. **落盘失败**（磁盘只读 / EACCES）不能让这一轮策略失效——否则 AI 配了不算数；
 *    也不能把循环打崩（它是每轮都可能发生的 I/O 故障）；
 * 2. **策略文件损坏 / 读取抛错**必须 fail-closed 回落到默认（全部感知），而不是把房间弄瞎；
 * 3. **`enabled:false → true`** 时运行时必须重新启动感知器（否则「AI 关掉一次感知后
 *    再也不看了」——这是 0.53.3 最典型的静默故障）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRoomRuntime, type RoomRuntimeDeps, type RoomTimers } from '../electron/main/room/runtime'
import { SensorPolicyStore } from '../electron/main/room/sensor-policy-store'

const OK_EXECUTOR: RoomRuntimeDeps['executor'] = {
  execute: async () => ({
    ok: true,
    decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
  })
}

interface Pending {
  id: string
  label?: string
  cb: () => void
}

/** 手动定时器（带 label）：能区分「感知排期」与「待机续排」 */
function manualTimers(): { timers: RoomTimers; fire: (label?: string) => Promise<void>; size: () => number } {
  const pending: Pending[] = []
  let seq = 0
  return {
    timers: {
      setTimeout: (cb: () => void, _ms: number, label?: string) => {
        const id = `t${++seq}`
        pending.push({ id, label, cb })
        return id
      },
      clearTimeout: (h: string) => {
        const i = pending.findIndex((p) => p.id === h)
        if (i >= 0) pending.splice(i, 1)
      }
    },
    fire: async (label?: string) => {
      const target = label ? pending.filter((p) => p.label === label) : [...pending]
      for (const p of target) {
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

function makeRt(over: Partial<RoomRuntimeDeps> & Pick<RoomRuntimeDeps, 'plan'>) {
  const rt = createRoomRuntime({
    collect: async () => ({ ok: true, text: '平台 win32 · CPU 5%' }),
    executor: OK_EXECUTOR,
    allowedTools: () => ['read'],
    now: () => 0,
    ...over
  })
  // 0.53.18：未绑定承载会话则不规划
  rt.setHostSession('chat-1')
  return rt
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('策略落盘失败：本轮照常生效，循环不崩', () => {
  it('save 抛错 → sensorPolicy 已更新、事件留痕、本轮结果正常', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined) // 本用例断言的是事件流留痕，不是 stderr
    const rt = makeRt({
      plan: async () => '{"decisions":[],"sensor":{"mute":["cpu"],"intervalMs":60000}}',
      saveSensorPolicy: () => {
        throw new Error('EACCES: 磁盘只读')
      }
    })
    rt.start()
    await vi.waitFor(() => expect(rt.getState().sensorPolicy?.mute).toEqual(['cpu']))

    const st = rt.getState()
    expect(st.sensorPolicy?.intervalMs).toBe(60_000) // 已生效（不是「保存失败就丢弃」）
    expect(st.events.some((e) => e.detail?.includes('感知策略已生效，但保存失败') && e.detail.includes('EACCES'))).toBe(true)
    expect(st.lastTick?.idleReason).toBe('no-action') // 循环没有被异常打崩
    expect(st.phase).toBe('idle')
    rt.stop()
  })

  it('save 抛错后，感知器实际拿到的仍是新策略（不是只改了状态字段）', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const t = manualTimers()
    const seen: string[][] = []
    const rt = makeRt({
      plan: async () => '{"decisions":[],"sensor":{"mute":["cpu"]}}',
      saveSensorPolicy: () => {
        throw new Error('EACCES')
      },
      timers: t.timers,
      sense: async (_view, policy) => {
        seen.push([...policy.mute])
        return { at: 0, cpuPct: 10 }
      }
    })
    rt.start()
    await vi.waitFor(() => expect(rt.getState().sensing).toBe(true))
    await t.fire('room-sensor')
    expect(seen[0]).toEqual(['cpu']) // 落盘失败不影响本轮采样口径
    rt.stop()
  })
})

describe('策略恢复：损坏 / 抛错 → 回落默认（全部感知）', () => {
  const DEFAULT = { enabled: true, mute: [] }

  it('形状非法（enabled 非布尔 / mute 含未知信号）→ 整条拒绝，回落默认', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const rt = makeRt({
      plan: async () => '{"decisions":[]}',
      loadSensorPolicy: () => ({ enabled: 'yes', mute: ['cpu', 'gpu'], intervalMs: -5 })
    })
    expect(rt.getState().sensorPolicy).toEqual(DEFAULT)
  })

  it('读取抛错 → 回落默认且不静默（console.error 留痕）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const rt = makeRt({
      plan: async () => '{"decisions":[]}',
      loadSensorPolicy: () => {
        throw new Error('EIO: 文件损坏')
      }
    })
    expect(rt.getState().sensorPolicy).toEqual(DEFAULT)
    expect(spy.mock.calls.some((c) => String(c[0]).includes('[room] 感知策略读取失败'))).toBe(true)
  })

  it('读到 null / 字符串（非对象）→ 回落默认', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(makeRt({ plan: async () => '{"decisions":[]}', loadSensorPolicy: () => null }).getState().sensorPolicy).toEqual(
      DEFAULT
    )
    expect(
      makeRt({ plan: async () => '{"decisions":[]}', loadSensorPolicy: () => '{"mute":["cpu"]' }).getState().sensorPolicy
    ).toEqual(DEFAULT)
  })

  it('合法的部分策略被恢复，并真的用于采样（不是只进状态）', async () => {
    const t = manualTimers()
    const seen: string[][] = []
    const rt = makeRt({
      plan: async () => '{"decisions":[]}',
      loadSensorPolicy: () => ({ mute: ['relay'], thresholds: { cpuDeltaPct: 5 } }),
      timers: t.timers,
      sense: async (_view, policy) => {
        seen.push([...policy.mute])
        return { at: 0, cpuPct: 10 }
      }
    })
    expect(rt.getState().sensorPolicy?.mute).toEqual(['relay'])
    expect(rt.getState().sensorPolicy?.thresholds?.cpuDeltaPct).toBe(5)

    rt.start()
    await vi.waitFor(() => expect(rt.getState().sensing).toBe(true))
    await t.fire('room-sensor')
    expect(seen[0]).toEqual(['relay'])
    rt.stop()
  })
})

describe('SensorPolicyStore：真实文件（原子写 / 损坏回落）', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'room-sensor-policy-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const SID = 'room-autonomous-U1-AI1'

  it('save → load 往返：运行时能恢复完整策略', () => {
    const store = new SensorPolicyStore(tmp())
    const policy = {
      enabled: true,
      mute: ['lan' as const],
      intervalMs: 30_000,
      thresholds: { cpuDeltaPct: 45, freeMemDeltaGB: 1 }
    }
    store.save(SID, policy)
    const rt = makeRt({ plan: async () => '{"decisions":[]}', loadSensorPolicy: () => store.load(SID) })
    expect(rt.getState().sensorPolicy).toEqual(policy)
  })

  it('文件内容损坏（JSON 解析失败）→ load 返回 undefined → 运行时回落默认', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const d = tmp()
    const store = new SensorPolicyStore(d)
    writeFileSync(join(d, `${SID}.json`), '{ "mute": ["cpu",', 'utf-8')

    expect(store.load(SID)).toBeUndefined()
    const rt = makeRt({ plan: async () => '{"decisions":[]}', loadSensorPolicy: () => store.load(SID) })
    expect(rt.getState().sensorPolicy).toEqual({ enabled: true, mute: [] })
  })

  it('文件不存在 → undefined → 默认（不抛）', () => {
    const store = new SensorPolicyStore(tmp())
    expect(store.load('room-autonomous-U9-AI9')).toBeUndefined()
  })
})

describe('enabled:false → true：运行时重新启动感知器', () => {
  it('AI 先关掉感知，下一轮再打开 → sensing 恢复、排期恢复（不需重启房间）', async () => {
    const t = manualTimers()
    const replies = ['{"decisions":[],"sensor":{"enabled":false}}', '{"decisions":[],"sensor":{"enabled":true}}']
    let calls = 0
    const rt = makeRt({
      plan: async () => replies[calls++] ?? '{"decisions":[]}',
      timers: t.timers,
      sense: async () => ({ at: 0, cpuPct: 10 })
    })

    rt.start()
    await vi.waitFor(() => expect(rt.getState().phase).toBe('idle'))
    expect(rt.getState().sensorPolicy?.enabled).toBe(false)
    expect(rt.getState().sensing).toBe(false)
    expect(t.size()).toBe(0) // 闭眼 = 不排期

    rt.wake('user-present', '房间视图可见') // 再激活一次
    await vi.waitFor(() => expect(rt.getState().sensing).toBe(true))
    expect(rt.getState().sensorPolicy?.enabled).toBe(true)
    expect(t.size()).toBe(1) // 感知器真的重新排期了

    // 排期真的在工作：一次采样后继续排下一次
    await t.fire('room-sensor')
    expect(t.size()).toBe(1)
    rt.stop()
    expect(rt.getState().sensing).toBe(false)
    expect(t.size()).toBe(0)
  })
})
