/**
 * 感知器 `configure` 的**排期语义**回归（0.53.3 补测）。
 *
 * 为什么单独一个文件：`room-sensor.test.ts` 只锁了「mute 即时生效」与「enabled=false 停排期」，
 * 这三件事一旦坏掉**不会报错**，只会表现为「AI 改了间隔却还是按老节奏看」或
 * 「关掉再打开就再也不看了」——静默故障，必须有能真正失败的用例：
 *
 * 1. `intervalMs` 变化 → **必须真的重排定时器**（旧排期丢弃 + 新 delay 生效），
 *    而不是只改一个变量让下一次 finally 才碰巧用上；
 * 2. 间隔低于运行时快照 TTL 的技术下限 → 夹到 5s（否则反复读同一份 CPU 差分）；
 * 3. 只改 mute → **不重排**（否则 AI 每轮改屏蔽信号都会把采样周期清零，等于永远不采样）；
 * 4. `enabled=false → true` 时 configure **不自己启**（由运行时 `syncSensor` 决定），
 *    随后 `start()` 按**当前策略**的间隔排期；
 * 5. `stop()` 期间在飞的采样必须按「代际」丢弃：否则上一代的样本会成为新会话的基线，
 *    把「新会话第一眼」误判成一次跃迁（跨代污染）。
 */
import { describe, it, expect } from 'vitest'
import {
  createRoomSensor,
  SENSOR_DEFAULTS,
  SENSOR_INTERVAL_FLOOR_MS,
  type RoomSensorSnapshot
} from '../electron/main/room/sensor'
import type { RoomTimers } from '../electron/main/room/runtime'

interface Pending {
  id: string
  ms: number
  label?: string
  cb: () => void
}

/** 记录 delay / label 的手动定时器假体：排期语义（谁被清、新 delay 是多少）可断言。 */
function recordingTimers(): {
  timers: RoomTimers
  pending: () => Pending[]
  fire: () => Promise<void>
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
    pending: () => pending,
    fire: async () => {
      const all = pending.splice(0)
      for (const p of all) p.cb()
      // 采样是 async：排空微任务（不依赖真实时间）
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

const snap = (cpu: number, freeMemGB?: number): RoomSensorSnapshot =>
  freeMemGB == null ? { at: 0, cpuPct: cpu } : { at: 0, cpuPct: cpu, freeMemGB }

describe('configure：间隔变化必须真的重排定时器', () => {
  it('start 用默认间隔；改 intervalMs → 旧排期被清、按新间隔重排一次', () => {
    const t = recordingTimers()
    const s = createRoomSensor({ sample: async () => snap(10), onChange: () => undefined, timers: t.timers })
    s.start()
    expect(t.pending()).toHaveLength(1)
    expect(t.pending()[0].ms).toBe(SENSOR_DEFAULTS.intervalMs)
    expect(t.pending()[0].label).toBe('room-sensor')
    const firstId = t.pending()[0].id

    s.configure({ enabled: true, mute: [], intervalMs: 60_000 })

    expect(t.pending()).toHaveLength(1) // 不是两个（旧排期没有残留）
    expect(t.pending()[0].id).not.toBe(firstId) // 旧排期被丢弃
    expect(t.pending()[0].ms).toBe(60_000) // 新 delay 真的生效
    s.stop()
    expect(t.pending()).toHaveLength(0)
  })

  it('间隔低于快照 TTL 下限 → 夹到 5s（技术上读不到新信息）', () => {
    const t = recordingTimers()
    const s = createRoomSensor({ sample: async () => snap(10), onChange: () => undefined, timers: t.timers })
    s.start()
    s.configure({ enabled: true, mute: [], intervalMs: 1_000 })
    expect(t.pending()).toHaveLength(1)
    expect(t.pending()[0].ms).toBe(SENSOR_INTERVAL_FLOOR_MS)

    // 再调回长间隔：仍然只有一个定时器、且用新值
    s.configure({ enabled: true, mute: [], intervalMs: 120_000 })
    expect(t.pending()).toHaveLength(1)
    expect(t.pending()[0].ms).toBe(120_000)
    s.stop()
  })

  it('只改 mute 不重排：定时器 id 不变，且下一样本立刻按新屏蔽集判定', async () => {
    const t = recordingTimers()
    let cpu = 10
    let mem = 8
    const reasons: string[] = []
    const s = createRoomSensor({
      sample: async () => snap(cpu, mem),
      onChange: (r) => {
        reasons.push(r.join('；'))
      },
      timers: t.timers
    })
    s.start()
    await t.fire() // 基线 {cpu:10, mem:8}
    const idBefore = t.pending()[0].id

    s.configure({ enabled: true, mute: ['cpu'] })
    expect(t.pending()[0].id).toBe(idBefore) // 屏蔽信号不该把采样周期清零

    cpu = 90
    await t.fire() // CPU 跃迁，但已被屏蔽
    expect(reasons).toHaveLength(0)

    mem = 1
    await t.fire() // 内存跃迁 → 唤醒（证明新策略真的进了差分，不是只存了个字段）
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('可用内存')
    s.stop()
  })
})

describe('configure：enabled 开关与运行时接管', () => {
  it('关闭 → 清排期；再打开不自己启；start() 按当前策略间隔排期', () => {
    const t = recordingTimers()
    const s = createRoomSensor({ sample: async () => snap(10), onChange: () => undefined, timers: t.timers })
    s.start()
    expect(t.pending()).toHaveLength(1)

    s.configure({ enabled: false, mute: [], intervalMs: 30_000 })
    expect(s.isRunning()).toBe(false)
    expect(t.pending()).toHaveLength(0)

    // 重新打开：configure 只改策略，**不**自己排期（否则与运行时 syncSensor 争 owner）
    s.configure({ enabled: true, mute: [], intervalMs: 30_000 })
    expect(t.pending()).toHaveLength(0)

    s.start()
    expect(s.isRunning()).toBe(true)
    expect(t.pending()).toHaveLength(1)
    expect(t.pending()[0].ms).toBe(30_000) // 用的是关掉期间配置的间隔
    s.stop()
  })

  it('stop 期间在飞的采样跨代丢弃：不会成为新会话的基线', async () => {
    const t = recordingTimers()
    const pendingResolvers: Array<(v: RoomSensorSnapshot | null) => void> = []
    const queue: Array<number | 'defer'> = [10, 'defer', 10, 100]
    let fires = 0
    const s = createRoomSensor({
      sample: () => {
        const v = queue.shift()
        if (v === 'defer') {
          return new Promise<RoomSensorSnapshot | null>((res) => {
            pendingResolvers.push(res)
          })
        }
        return Promise.resolve(snap(v ?? 100))
      },
      onChange: () => {
        fires += 1
      },
      timers: t.timers
    })

    s.start()
    await t.fire() // 基线 10
    await t.fire() // 第二次采样挂起（在飞）
    s.stop() // 代际 +1
    s.start() // 新会话，正排期（基线已清）

    pendingResolvers[0]?.(snap(90)) // 上一代的 90 迟到
    await Promise.resolve()
    await Promise.resolve()

    await t.fire() // 新会话第一眼 = 10
    // 若没有代际保护，90 会成为基线 → 10 被当成「90 → 10」的跃迁而唤醒（跨代污染）
    expect(fires).toBe(0)

    await t.fire() // 10 → 100 才是真跃迁
    expect(fires).toBe(1)
    s.stop()
  })
})
