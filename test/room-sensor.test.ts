/**
 * 感知器（0.53.1）回归：AI 静默后由采集器在**环境变化**时唤醒它。
 *
 * 用户裁决：「自主模式不是时间轮询驱动，也不是让 AI 就那么静默…采集器，待机状态事件激活，
 * 其余状态是 AI 静默后激活」。本文件锁住四件事：
 * 1. **首次采样只建基线**（不会一进 idle 就唤醒）；
 * 2. 阈值以下的抖动不唤醒；越线才唤醒并给出人可读原因；
 * 3. **条件触发、不设上限**（用户裁决）：每次真实跃迁都会唤醒；没有小时预算 / 冷却。
 * 4. 不可感知（null）时清基线；stop 后不再采样。
 */
import { describe, it, expect } from 'vitest'
import { createRoomSensor, diffSensor, SENSOR_DEFAULTS, SENSOR_INTERVAL_FLOOR_MS, type RoomSensorSnapshot } from '../electron/main/room/sensor'
import type { RoomTimers } from '../electron/main/room/runtime'

/** 手动定时器假体：`fire()` 触发当前挂起的那一次采样。 */
function manualTimers(): { timers: RoomTimers; fire: () => Promise<void>; size: () => number } {
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
    fire: async () => {
      const all = pending.splice(0)
      for (const p of all) p.cb()
      // 采样是 async：把微任务队列排空（不依赖真实时间）
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    },
    size: () => pending.length
  }
}

const snap = (cpu: number): RoomSensorSnapshot => ({ at: 0, cpuPct: cpu })

describe('diffSensor：阈值差分（只比较两边都有值的字段）', () => {
  const base: RoomSensorSnapshot = { at: 0, cpuPct: 10, freeMemGB: 8, lanStreams: 0, relayPending: 0 }

  it('阈值以下不触发', () => {
    expect(diffSensor(base, { ...base, cpuPct: 20 }).changed).toBe(false)
    expect(diffSensor(base, { ...base, freeMemGB: 7 }).changed).toBe(false)
  })

  it('CPU / 内存越线 → 给出人可读原因', () => {
    const cpu = diffSensor(base, { ...base, cpuPct: 50 })
    expect(cpu.changed).toBe(true)
    expect(cpu.reasons[0]).toContain('CPU 10% → 50%')

    const mem = diffSensor(base, { ...base, freeMemGB: 3 })
    expect(mem.changed).toBe(true)
    expect(mem.reasons[0]).toContain('可用内存')
  })

  it('本应用传输计数变化即触发（局域网流 / 中继待取件）', () => {
    const r = diffSensor(base, { ...base, lanStreams: 2, relayPending: 1 })
    expect(r.changed).toBe(true)
    expect(r.reasons.join(' ')).toContain('局域网流 0 → 2')
    expect(r.reasons.join(' ')).toContain('中继待取件 0 → 1')
  })

  it('缺字段不参与判定（视图没选就不看）', () => {
    expect(diffSensor({ at: 0, cpuPct: 10 }, { at: 0, freeMemGB: 1 }).changed).toBe(false)
  })

  it('非有限值（NaN / Infinity）视为缺字段：不毒化基线、不每次触发', () => {
    const base: RoomSensorSnapshot = { at: 0, cpuPct: 10 }
    expect(diffSensor(base, { at: 0, cpuPct: Number.NaN }).changed).toBe(false)
    expect(diffSensor({ at: 0, cpuPct: Number.NaN }, { at: 0, cpuPct: 90 }).changed).toBe(false)
    expect(diffSensor(base, { at: 0, cpuPct: Number.POSITIVE_INFINITY }).changed).toBe(false)
  })

  it('阈值可注入（默认值仍是 30 个百分点 / 2GB）', () => {
    expect(SENSOR_DEFAULTS.cpuDeltaPct).toBe(30)
    expect(SENSOR_DEFAULTS.freeMemDeltaGB).toBe(2)
    expect(diffSensor(base, { ...base, cpuPct: 20 }, { cpuDeltaPct: 5, freeMemDeltaGB: 2 }).changed).toBe(true)
  })
})

describe('createRoomSensor：生命周期（条件触发，不设上限）', () => {
  it('首次采样只建基线，不唤醒；stop 后不再采样', async () => {
    const t = manualTimers()
    let fires = 0
    const s = createRoomSensor({
      sample: async () => snap(10),
      onChange: () => {
        fires += 1
      },
      timers: t.timers,
      intervalMs: 1000
    })
    s.start()
    expect(t.size()).toBe(1)
    await t.fire()
    expect(fires).toBe(0)
    expect(t.size()).toBe(1) // 继续排下一次
    s.stop()
    expect(t.size()).toBe(0)
    await t.fire()
    expect(fires).toBe(0)
  })

  it('越过阈值 → 唤醒并带原因；之后同值不再重复唤醒', async () => {
    const t = manualTimers()
    const values = [10, 90, 90]
    const reasons: string[] = []
    const s = createRoomSensor({
      sample: async () => snap(values.shift() ?? 90),
      onChange: (r) => {
        reasons.push(r.join('；'))
      },
      timers: t.timers
    })
    s.start()
    await t.fire() // 基线 10
    await t.fire() // 10 → 90
    await t.fire() // 90 → 90（不变）
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('CPU 10% → 90%')
    s.stop()
  })

  it('每次真实跃迁都会唤醒（用户裁决：条件触发，不加上限）', async () => {
    const t = manualTimers()
    const values = [10, 90, 10, 90, 10, 90]
    let fires = 0
    const s = createRoomSensor({
      sample: async () => snap(values.shift() ?? 90),
      onChange: () => {
        fires += 1
      },
      timers: t.timers
    })
    s.start()
    await t.fire() // 基线 10
    for (let i = 0; i < 5; i += 1) await t.fire() // 5 次跃迁
    expect(fires).toBe(5)
    s.stop()
  })

  it('被仲裁器拒绝（onChange=false）时保留基线并重试', async () => {
    const t = manualTimers()
    const values = [10, 90, 90]
    let calls = 0
    let fires = 0
    const s = createRoomSensor({
      sample: async () => snap(values.shift() ?? 90),
      onChange: () => {
        calls += 1
        if (calls === 1) return false // 第一次被同源去抖拦下
        fires += 1
        return true
      },
      timers: t.timers
    })
    s.start()
    await t.fire() // 基线 10
    await t.fire() // 10 → 90，被拒 → 保留基线
    await t.fire() // 仍是 90 vs 10 → 重试，被接受
    expect(calls).toBe(2)
    expect(fires).toBe(1)
    s.stop()
  })


  it('不可感知（null）清基线：授权恢复后的第一眼不算「变化」', async () => {
    const t = manualTimers()
    const seq: Array<RoomSensorSnapshot | null> = [snap(10), null, snap(90), snap(90)]
    let fires = 0
    const s = createRoomSensor({
      sample: async () => seq.shift() ?? null,
      onChange: () => {
        fires += 1
      },
      timers: t.timers
    })
    s.start()
    await t.fire() // 基线 10
    await t.fire() // null → 清基线
    await t.fire() // 90 成为新基线
    await t.fire() // 90 → 90
    expect(fires).toBe(0)
    s.stop()
  })

  it('采样抛错不打断感知：报错后继续排下一次', async () => {
    const t = manualTimers()
    const errors: string[] = []
    let first = true
    const s = createRoomSensor({
      sample: async () => {
        if (first) {
          first = false
          throw new Error('boom')
        }
        return snap(10)
      },
      onChange: () => undefined,
      timers: t.timers,
      onError: (e) => errors.push(e.message)
    })
    s.start()
    await t.fire()
    expect(errors).toEqual(['boom'])
    expect(t.size()).toBe(1)
    s.stop()
  })

  it('start 幂等（不会排两个定时器）', () => {
    const t = manualTimers()
    const s = createRoomSensor({ sample: async () => snap(1), onChange: () => undefined, timers: t.timers })
    s.start()
    s.start()
    expect(t.size()).toBe(1)
    s.stop()
  })
})

describe('感知策略（0.53.3）：AI 屏蔽信号 / 关闭感知 / 改间隔与阈值', () => {
  const base: RoomSensorSnapshot = { at: 0, cpuPct: 10, freeMemGB: 8, lanStreams: 0, relayPending: 0 }

  it('被屏蔽的信号不参与差分（CPU 跃迁不再唤醒）', () => {
    const cpuOnly = diffSensor(base, { ...base, cpuPct: 90 }, undefined, ['cpu'])
    expect(cpuOnly.changed).toBe(false)
    const memStill = diffSensor(base, { ...base, freeMemGB: 2 }, undefined, ['cpu'])
    expect(memStill.changed).toBe(true)
    expect(memStill.reasons[0]).toContain('可用内存')
  })

  it('屏蔽多个信号：只留下 AI 想看的那个', () => {
    const r = diffSensor(
      base,
      { ...base, cpuPct: 90, freeMemGB: 1, lanStreams: 3, relayPending: 2 },
      undefined,
      ['cpu', 'memory', 'lan']
    )
    expect(r.reasons).toHaveLength(1)
    expect(r.reasons[0]).toContain('中继待取件')
  })

  it('configure：屏蔽即时生效，无需重启感知器', async () => {
    const t = manualTimers()
    let cpu = 10
    let fires = 0
    const s = createRoomSensor({
      sample: async () => ({ at: 0, cpuPct: cpu }),
      onChange: () => {
        fires += 1
      },
      timers: t.timers
    })
    s.start()
    await t.fire() // 基线 10
    s.configure({ enabled: true, mute: ['cpu'] })
    cpu = 90
    await t.fire() // CPU 被屏蔽 → 不唤醒
    expect(fires).toBe(0)
    s.stop()
  })

  it('configure(enabled=false)：停止排期并清基线；重新开启由运行时 start', async () => {
    const t = manualTimers()
    const s = createRoomSensor({
      sample: async () => snap(10),
      onChange: () => undefined,
      timers: t.timers
    })
    s.start()
    expect(s.isRunning()).toBe(true)
    expect(t.size()).toBe(1)
    s.configure({ enabled: false, mute: [] })
    expect(s.isRunning()).toBe(false)
    expect(t.size()).toBe(0)
    // 关闭状态下 start 不排期（运行时 syncSensor 也会拦住，这里是第二道保险）
    s.start()
    expect(t.size()).toBe(0)
  })

  it('采样间隔下限是运行时快照 TTL（不是产品魔法）：5s', () => {
    expect(SENSOR_INTERVAL_FLOOR_MS).toBe(5_000)
  })
})
