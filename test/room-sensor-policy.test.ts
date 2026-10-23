/**
 * 感知策略（0.53.3）：AI 自己配置「看什么 / 多久看 / 多大变化才算有事」。
 *
 * 为什么测：这是 AI 与系统之间的**契约**——非法策略必须在入口被拒（fail-closed），
 * 局部更新必须保留未写字段（否则 AI 只改 mute 就会把阈值重置）。错了不会报错，
 * 只会让 AI 被噪声反复叫醒，或反过来把自己的唤醒源关掉。
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SENSOR_POLICY,
  SENSOR_SIGNALS,
  applySensorPolicy,
  describeSensorPolicy,
  mutedSignals,
  parseSensorPolicyPatch
} from '../shared/room/sensor-policy'

describe('parseSensorPolicyPatch：AI 声明 → 局部更新', () => {
  it('空对象 = 不改任何字段', () => {
    expect(parseSensorPolicyPatch({})).toEqual({ ok: true, patch: {} })
  })

  it('合法字段原样解析；mute 去重', () => {
    const r = parseSensorPolicyPatch({
      enabled: false,
      mute: ['cpu', 'lan', 'cpu'],
      intervalMs: 60_000,
      thresholds: { cpuDeltaPct: 45, freeMemDeltaGB: 1.5 }
    })
    expect(r).toEqual({
      ok: true,
      patch: {
        enabled: false,
        mute: ['cpu', 'lan'],
        intervalMs: 60_000,
        thresholds: { cpuDeltaPct: 45, freeMemDeltaGB: 1.5 }
      }
    })
  })

  it('非法值整条拒绝（不做「坏字段丢弃、好字段保留」的半吊子合并）', () => {
    expect(parseSensorPolicyPatch(null).ok).toBe(false)
    expect(parseSensorPolicyPatch([]).ok).toBe(false)
    expect(parseSensorPolicyPatch({ enabled: 'yes' }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ mute: ['moon'] }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ mute: 'cpu' }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ intervalMs: 0 }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ intervalMs: Number.NaN }).ok).toBe(false)
    // 超过 JS setTimeout 32 位上限会被 Node 静默改成 1ms（忙循环），入口必须拒绝
    expect(parseSensorPolicyPatch({ intervalMs: 2 ** 31 }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ thresholds: { cpuDeltaPct: 0 } }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ thresholds: { cpuDeltaPct: 0.5 } }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ thresholds: { cpuDeltaPct: 101 } }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ thresholds: { freeMemDeltaGB: 0.05 } }).ok).toBe(false)
    expect(parseSensorPolicyPatch({ thresholds: { freeMemDeltaGB: -1 } }).ok).toBe(false)
  })
})

describe('applySensorPolicy：局部更新而不是整份覆盖', () => {
  const current = applySensorPolicy(DEFAULT_SENSOR_POLICY, {
    mute: ['lan'],
    intervalMs: 30_000,
    thresholds: { cpuDeltaPct: 20, freeMemDeltaGB: 3 }
  })

  it('未写字段保持当前值', () => {
    const next = applySensorPolicy(current, { enabled: false })
    expect(next).toEqual({ ...current, enabled: false })
  })

  it('mute 是替换（AI 说只屏蔽 CPU 就是只屏蔽 CPU，能解除旧屏蔽）', () => {
    expect(applySensorPolicy(current, { mute: ['cpu'] }).mute).toEqual(['cpu'])
    expect(applySensorPolicy(current, { mute: [] }).mute).toEqual([])
  })

  it('thresholds 按字段合并（只改 CPU 阈值不动内存阈值）', () => {
    const next = applySensorPolicy(current, { thresholds: { cpuDeltaPct: 50 } })
    expect(next.thresholds).toEqual({ cpuDeltaPct: 50, freeMemDeltaGB: 3 })
    expect(next.intervalMs).toBe(30_000)
  })

  it('默认策略：全部感知、不屏蔽', () => {
    expect(DEFAULT_SENSOR_POLICY).toEqual({ enabled: true, mute: [] })
    expect(mutedSignals(DEFAULT_SENSOR_POLICY)).toEqual([])
  })
})

describe('describeSensorPolicy：事件流/界面共用的摘要', () => {
  it('只写 AI 真正声明过的部分；关闭时只说关闭', () => {
    expect(describeSensorPolicy(DEFAULT_SENSOR_POLICY)).toBe('感知开')
    expect(
      describeSensorPolicy(
        applySensorPolicy(DEFAULT_SENSOR_POLICY, {
          mute: ['cpu', 'relay'],
          intervalMs: 60_000,
          thresholds: { cpuDeltaPct: 45 }
        })
      )
    ).toBe('感知开 · 屏蔽 CPU、中继待取件 · 间隔 60s · CPU 阈值 45pp')
    expect(describeSensorPolicy(applySensorPolicy(DEFAULT_SENSOR_POLICY, { enabled: false }))).toBe('感知关')
  })

  it('信号闭集固定为四个（新增信号必须同时更新这里与采样实现）', () => {
    expect(SENSOR_SIGNALS).toEqual(['cpu', 'memory', 'lan', 'relay'])
  })
})
