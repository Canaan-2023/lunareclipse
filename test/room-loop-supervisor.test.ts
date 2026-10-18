/**
 * ROOM 循环生命周期 owner 回归（P0-3）：`createRoomLoopSupervisor`。
 *
 * 为什么存在：此前「停循环」的唯一实现挂在渲染进程的 React 卸载清理里——窗口关闭 / 渲染崩溃 /
 * 被强杀时 cleanup 不执行，主进程 `setInterval` 继续跑（幽灵循环：配置显示已关、AI 仍在采集执行）。
 * 本文件把「生命周期由主进程单 owner 持有 + 引用计数（多消费者不互相误停）」锁成机械守卫。
 *
 * 覆盖：首次持有才 start / 重复持有只加计数 / 计数归零才 stop / 按 AI 精确停 / 未登录与不可用 fail-closed /
 * release 幂等。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RoomRuntime } from '../electron/main/room/runtime'
import { setRoomRuntime, stopAllRoomRuntimes, type RoomScope } from '../electron/main/room/runtime'
import { createRoomLoopSupervisor } from '../electron/main/room/loop-supervisor'

function makeRuntime(): RoomRuntime & { startCalls: number; stopCalls: number } {
  let running = false
  const rt = {
    startCalls: 0,
    stopCalls: 0,
    start: () => {
      rt.startCalls += 1
      running = true
    },
    stop: () => {
      rt.stopCalls += 1
      running = false
    },
    isRunning: () => running,
    standby: () => undefined,
    wake: () => undefined,
    tick: vi.fn(async () => ({ phase: 'idle' as const, acted: false, executions: [] })),
    getState: () => ({ running, phase: running ? ('idle' as const) : ('stopped' as const), events: [], avatarRev: 0 })
  }
  return rt
}

const UID = 7
const scope = (aiId: number): RoomScope => ({ uid: UID, aiId })

function install(aiId: number, rt: RoomRuntime): void {
  setRoomRuntime(scope(aiId), rt)
}

beforeEach(() => {
  // runtime.ts 的实例表是模块级单例：清空避免用例间串味
  stopAllRoomRuntimes()
})

describe('RoomLoopSupervisor：引用计数与启停', () => {
  it('首次 acquire 才 start；重复 acquire 只加计数（不重复 start）', () => {
    const rt = makeRuntime()
    install(1, rt)
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => rt, getCurrentUid: () => UID })

    expect(sup.acquire(1)).toEqual({ ok: true, running: true })
    expect(rt.startCalls).toBe(1)
    expect(sup.refCount(1)).toBe(1)

    expect(sup.acquire(1)).toEqual({ ok: true, running: true })
    expect(rt.startCalls).toBe(1)
    expect(sup.refCount(1)).toBe(2)
  })

  it('计数未归零不停；归零才 stop', () => {
    const rt = makeRuntime()
    install(1, rt)
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => rt, getCurrentUid: () => UID })

    sup.acquire(1)
    sup.acquire(1)
    expect(sup.release(1)).toEqual({ running: true })
    expect(rt.stopCalls).toBe(0)

    expect(sup.release(1)).toEqual({ running: false })
    expect(rt.stopCalls).toBe(1)
    expect(rt.isRunning()).toBe(false)
    expect(sup.refCount(1)).toBe(0)
    expect(sup.activeCount()).toBe(0)
  })

  it('stopAi 只停目标 AI（不误停别的 AI 的房间）', () => {
    const a = makeRuntime()
    const b = makeRuntime()
    install(1, a)
    install(2, b)
    const sup = createRoomLoopSupervisor({
      ensureRuntime: (aiId) => (aiId === 1 ? a : b),
      getCurrentUid: () => UID
    })
    sup.acquire(1)
    sup.acquire(2)

    sup.stopAi(1)
    expect(a.stopCalls).toBe(1)
    expect(b.stopCalls).toBe(0)
    expect(sup.isRunning(2)).toBe(true)
  })

  it('stopAll 停全部并清空持有（退出 / 主窗口关闭）', () => {
    const a = makeRuntime()
    const b = makeRuntime()
    install(1, a)
    install(2, b)
    const sup = createRoomLoopSupervisor({
      ensureRuntime: (aiId) => (aiId === 1 ? a : b),
      getCurrentUid: () => UID
    })
    sup.acquire(1)
    sup.acquire(2)

    sup.stopAll()
    expect(a.stopCalls).toBe(1)
    expect(b.stopCalls).toBe(1)
    expect(sup.activeCount()).toBe(0)
    expect(sup.isRunning(1)).toBe(false)
  })
})

describe('RoomLoopSupervisor：fail-closed 与幂等', () => {
  it('未登录 → acquire 拒绝且不 start', () => {
    const rt = makeRuntime()
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => rt, getCurrentUid: () => null })
    const r = sup.acquire(1)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('未登录')
    expect(rt.startCalls).toBe(0)
  })

  it('运行时不可用（AI 已下线 / 未装配）→ acquire 拒绝且不 start', () => {
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => null, getCurrentUid: () => UID })
    const r = sup.acquire(1)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('不可用')
  })

  it('release 无持有时幂等（不抛、按实际运行态返回）', () => {
    const rt = makeRuntime()
    install(1, rt)
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => rt, getCurrentUid: () => UID })
    expect(sup.release(1)).toEqual({ running: false })
    expect(rt.stopCalls).toBe(0)
  })

  it('stopAi 之后 release 不会误停（引用已清空，幂等）', () => {
    const rt = makeRuntime()
    install(1, rt)
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => rt, getCurrentUid: () => UID })
    sup.acquire(1)
    sup.stopAi(1)
    expect(rt.stopCalls).toBe(1)
    expect(sup.release(1)).toEqual({ running: false })
    expect(rt.stopCalls).toBe(1)
  })

  it('stopAll 幂等：重复调用不抛、不重复 stop', () => {
    const rt = makeRuntime()
    install(1, rt)
    const sup = createRoomLoopSupervisor({ ensureRuntime: () => rt, getCurrentUid: () => UID })
    sup.acquire(1)
    sup.stopAll()
    sup.stopAll()
    expect(rt.stopCalls).toBe(1)
  })
})
