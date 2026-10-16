import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TimerRegistry } from '../electron/main/monitor/timer-registry'

describe('TimerRegistry', () => {
  let registry: TimerRegistry

  beforeEach(() => {
    registry = new TimerRegistry()
  })

  afterEach(() => {
    registry.stopAll()
  })

  it('setTimeout 注册定时器并返回 handle', () => {
    const handle = registry.setTimeout(() => {}, 1000, 'test')
    expect(handle).toBeTruthy()
    expect(registry.size()).toBe(1)
  })

  it('setTimeout 回调执行后自动从注册表移除', async () => {
    const cb = vi.fn()
    registry.setTimeout(cb, 10, 'quick')
    expect(registry.size()).toBe(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(cb).toHaveBeenCalledTimes(1)
    expect(registry.size()).toBe(0)
  })

  it('clearTimeout 在触发前取消定时器', () => {
    const cb = vi.fn()
    const handle = registry.setTimeout(cb, 1000, 'cancelled')
    expect(registry.size()).toBe(1)
    registry.clearTimeout(handle)
    expect(registry.size()).toBe(0)
    expect(cb).not.toHaveBeenCalled()
  })

  it('clearTimeout 对不存在的 handle 静默忽略', () => {
    registry.clearTimeout('nonexistent')
    expect(registry.size()).toBe(0)
  })

  it('setInterval 注册周期定时器', () => {
    const handle = registry.setInterval(() => {}, 100, 'interval')
    expect(handle).toBeTruthy()
    expect(registry.size()).toBe(1)
  })

  it('setInterval 按间隔重复执行', async () => {
    const cb = vi.fn()
    const handle = registry.setInterval(cb, 20, 'recurring')
    await new Promise((r) => setTimeout(r, 100))
    registry.clearInterval(handle)
    expect(cb.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('clearInterval 停止周期定时器', async () => {
    const cb = vi.fn()
    const handle = registry.setInterval(cb, 20, 'stopped')
    await new Promise((r) => setTimeout(r, 50))
    registry.clearInterval(handle)
    const countAfterStop = cb.mock.calls.length
    expect(registry.size()).toBe(0)
    await new Promise((r) => setTimeout(r, 50))
    expect(cb.mock.calls.length).toBe(countAfterStop)
  })

  it('stopAll 清理所有注册的定时器', () => {
    registry.setTimeout(() => {}, 5000, 't1')
    registry.setTimeout(() => {}, 5000, 't2')
    registry.setInterval(() => {}, 1000, 'i1')
    expect(registry.size()).toBe(3)
    return registry.stopAll().then(() => {
      expect(registry.size()).toBe(0)
    })
  })

  it('stopAll 在空注册表上无操作', async () => {
    await registry.stopAll()
    expect(registry.size()).toBe(0)
  })

  it('list 返回所有定时器信息', () => {
    registry.setTimeout(() => {}, 1000, 'timeout-a')
    registry.setInterval(() => {}, 1000, 'interval-b')
    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map((l) => l.label)).toContain('timeout-a')
    expect(list.map((l) => l.label)).toContain('interval-b')
    expect(list.every((l) => l.id && l.kind && l.createdAt > 0)).toBe(true)
  })

  it('label 默认为 anonymous', () => {
    const handle = registry.setTimeout(() => {}, 1000)
    const list = registry.list()
    expect(list[0].label).toBe('anonymous')
    registry.clearTimeout(handle)
  })
})
