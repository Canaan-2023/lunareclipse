/**
 * 感知采样**字段裁剪**回归（0.53.3 补测，用注入 mock）。
 *
 * 为什么必须测到「读没读」，而不是「字段在不在」：
 * 感知器的成本口径是「廉价采样 = 只读进程内 / os 读数」。AI 屏蔽了 cpu / memory 或
 * lan / relay 之后，对应字段**根本不该被读**——否则「屏蔽」只省了唤醒，没有省采样代价；
 * 反过来，LAN / relay 又必须与 `collectorView` **解耦**：AI 为了省 token 把视图收窄到
 * 不看 network，不能顺手把自己的唤醒源关掉（0.53.1 架构评审 P1）。
 *
 * 这里把 `collect-environment` 换成 spy（`collectEnvironment` / `getCollectorAppTransfers`），
 * 于是「有没有真的去读」是可断言的，而不是只断言返回值字符串。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildRoomSensorSample } from '../electron/main/bootstrap/room-runtime'
import { defaultCollectorView, type CollectorView } from '../electron/main/room/collector-view'
import type { RoomSensorPolicy } from '../shared/room/sensor-policy'

const spy = vi.hoisted(() => ({
  env: vi.fn(),
  transfers: vi.fn()
}))

vi.mock('../electron/main/tools/collect-environment', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    collectEnvironment: (...args: unknown[]) => spy.env(...args),
    getCollectorAppTransfers: (...args: unknown[]) => spy.transfers(...args)
  }
})

const ENV = {
  platform: 'win32',
  cpuModel: 'test-cpu',
  logicalCores: 8,
  physicalCores: 4,
  totalMemGB: 16,
  freeMemGB: 5.1,
  cpuUsagePct: 42,
  sampledAt: 0
}

/** 视图：默认全字段，或只选指定字段（模拟 AI 收窄 collectorView） */
const viewWith = (fields: string[] | null): CollectorView =>
  fields == null ? defaultCollectorView() : { ...defaultCollectorView(), fields }

const policy = (over: Partial<RoomSensorPolicy> = {}): RoomSensorPolicy => ({
  enabled: true,
  mute: [],
  ...over
})

beforeEach(() => {
  spy.env.mockReset()
  spy.transfers.mockReset()
  spy.env.mockReturnValue(ENV)
  spy.transfers.mockReturnValue({ activeLanStreams: 2, relayPending: 3 })
})

describe('屏蔽 cpu / memory：对应字段不产出（不代表「没被读到」）', () => {
  it('mute=[cpu] → 没有 cpuPct 键；freeMemGB 仍在', () => {
    const s = buildRoomSensorSample(defaultCollectorView(), policy({ mute: ['cpu'] }))!
    expect(s).not.toBeNull()
    expect('cpuPct' in s).toBe(false)
    expect(s.cpuPct).toBeUndefined()
    expect(s.freeMemGB).toBe(5.1)
    expect(spy.env).toHaveBeenCalledTimes(1) // 廉价快照只读一次
  })

  it('mute=[cpu,memory] → 两个键都不产出，但仍是一次快照读取', () => {
    const s = buildRoomSensorSample(defaultCollectorView(), policy({ mute: ['cpu', 'memory'] }))!
    expect('cpuPct' in s).toBe(false)
    expect('freeMemGB' in s).toBe(false)
    expect(Number.isFinite(s.at)).toBe(true)
    expect(spy.env).toHaveBeenCalledTimes(1)
  })
})

describe('LAN / relay：屏蔽即不读；且与 collectorView 解耦', () => {
  it('mute=[lan,relay] → 完全不读本应用传输（连 network 视图也不读）', () => {
    const s = buildRoomSensorSample(viewWith(['network']), policy({ mute: ['lan', 'relay'] }))!
    expect(spy.transfers).not.toHaveBeenCalled()
    expect('lanStreams' in s).toBe(false)
    expect('relayPending' in s).toBe(false)
  })

  it('只屏蔽 lan → relay 仍读；lanStreams 不产出', () => {
    const s = buildRoomSensorSample(defaultCollectorView(), policy({ mute: ['lan'] }))!
    expect(spy.transfers).toHaveBeenCalledTimes(1)
    expect('lanStreams' in s).toBe(false)
    expect(s.relayPending).toBe(3)
  })

  it('有策略时与 collectorView 解耦：视图只选 cpu，局域网流/中继照样采', () => {
    const s = buildRoomSensorSample(viewWith(['cpu']), policy())!
    expect(spy.transfers).toHaveBeenCalledTimes(1)
    expect(s.lanStreams).toBe(2)
    expect(s.relayPending).toBe(3)
    // 视图没选 memory 也不影响 cpu/memory 的产出（否则收窄视图会关掉唤醒源）
    expect(s.cpuPct).toBe(42)
    expect(s.freeMemGB).toBe(5.1)
  })

  it('视图字段为空表（极端收窄）→ 感知仍拿到全部未屏蔽信号', () => {
    const s = buildRoomSensorSample(viewWith([]), policy())!
    expect(s.cpuPct).toBe(42)
    expect(s.freeMemGB).toBe(5.1)
    expect(s.lanStreams).toBe(2)
    expect(s.relayPending).toBe(3)
  })
})

describe('未传策略（0.53.1 旧调用）保持旧行为：LAN 跟随 network 视图', () => {
  it('视图不含 network → 不读本应用传输', () => {
    const s = buildRoomSensorSample(viewWith(['cpu', 'memory']))!
    expect(spy.transfers).not.toHaveBeenCalled()
    expect('lanStreams' in s).toBe(false)
    expect('relayPending' in s).toBe(false)
    expect(s.cpuPct).toBe(42)
  })

  it('视图含 network → 读本应用传输（lan + relay 都给）', () => {
    const s = buildRoomSensorSample(viewWith(['cpu', 'network']))!
    expect(spy.transfers).toHaveBeenCalledTimes(1)
    expect(s.lanStreams).toBe(2)
    expect(s.relayPending).toBe(3)
  })
})
