/**
 * ROOM 运行时按 (uid, aiId) 分实例（ADR-25 L3 / 支柱 2）契约测试。
 *
 * 为什么存在：此前 ROOM 运行时是**全局单例**且会话 id 固定 `room-autonomous`，所有 AI 的自主
 * 行为都计入 AI1（L3）。用户要求「每个 AI 都要有自己的自主模式」。本文件钉住：
 * - 会话 id **含 AI**（`room-autonomous-U{uid}-AI{aiId}`）；
 * - 同一 AI 复用同一实例、不同 AI 各自独立实例；
 * - 停某个 AI 的房间不影响别的 AI；未装配工厂时 `ensureRoomRuntime` 返回 null（调用方报错，
 *   不静默借用别的 AI）。
 *
 * 说明：真实工厂在 `bootstrap/room-runtime.ts`（依赖 electron 装配），此处用等价假工厂覆盖
 * 持有者语义（键、复用、停止粒度）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  roomSessionId,
  roomScopeKey,
  setRoomRuntime,
  getRoomRuntime,
  ensureRoomRuntime,
  setRoomRuntimeFactory,
  stopRoomRuntimeForAi,
  stopAllRoomRuntimes,
  type RoomRuntime,
  type RoomScope
} from '../electron/main/room/runtime'

/** 最小运行时假体：只记录 start/stop 状态，够断言停止粒度 */
function fakeRuntime(): RoomRuntime & { running: boolean } {
  const rt = {
    running: false,
    start: () => {
      rt.running = true
    },
    stop: () => {
      rt.running = false
    },
    isRunning: () => rt.running,
    standby: () => undefined,
    wake: () => undefined,
    tick: async () => ({ phase: 'idle' as const, acted: false, executions: [] }),
    getState: () => ({ running: rt.running, phase: rt.running ? ('idle' as const) : ('stopped' as const), events: [], avatarRev: 0 })
  }
  return rt
}

/** 等价假工厂：与 bootstrap 同形（建实例 → setRoomRuntime → 返回；同 scope 复用） */
function installFactory(uid: number): void {
  setRoomRuntimeFactory((aiId: number) => {
    const scope: RoomScope = { uid, aiId }
    const existing = getRoomRuntime(scope)
    if (existing) return existing
    const rt = fakeRuntime()
    setRoomRuntime(scope, rt)
    return rt
  })
}

beforeEach(() => {
  stopAllRoomRuntimes()
  setRoomRuntimeFactory(null)
})

afterEach(() => {
  stopAllRoomRuntimes()
  setRoomRuntimeFactory(null)
})

describe('ROOM 每 AI 独立实例（L3）', () => {
  it('会话 id 含 AI（各 AI 不同）', () => {
    expect(roomSessionId({ uid: 1, aiId: 1 })).toBe('room-autonomous-U1-AI1')
    expect(roomSessionId({ uid: 1, aiId: 2 })).toBe('room-autonomous-U1-AI2')
    expect(roomSessionId({ uid: 7, aiId: 2 })).not.toBe(roomSessionId({ uid: 1, aiId: 2 }))
  })

  it('作用域键区分 (uid, aiId)', () => {
    expect(roomScopeKey({ uid: 1, aiId: 2 })).not.toBe(roomScopeKey({ uid: 1, aiId: 1 }))
    expect(roomScopeKey({ uid: 2, aiId: 2 })).not.toBe(roomScopeKey({ uid: 1, aiId: 2 }))
  })

  it('未装配工厂 → ensureRoomRuntime 返回 null（不静默借用别的 AI）', () => {
    expect(ensureRoomRuntime(1)).toBeNull()
  })

  it('同一 AI 复用同一实例；不同 AI 各自独立实例', () => {
    installFactory(1)
    const a1 = ensureRoomRuntime(1)
    const a2 = ensureRoomRuntime(2)
    expect(a1).not.toBeNull()
    expect(a2).not.toBeNull()
    expect(a1).not.toBe(a2)
    expect(ensureRoomRuntime(1)).toBe(a1)
    expect(ensureRoomRuntime(2)).toBe(a2)
  })

  it('停某个 AI 的房间不影响别的 AI', () => {
    installFactory(1)
    const a1 = ensureRoomRuntime(1) as ReturnType<typeof fakeRuntime>
    const a2 = ensureRoomRuntime(2) as ReturnType<typeof fakeRuntime>
    a1.start()
    a2.start()
    stopRoomRuntimeForAi(2)
    expect((a2 as unknown as { running: boolean }).running).toBe(false)
    expect((a1 as unknown as { running: boolean }).running).toBe(true)
    // AI2 的实例已移除 → 下次 ensure 重建（新对象）
    expect(ensureRoomRuntime(2)).not.toBe(a2)
  })

  it('stopAllRoomRuntimes 停全部并清空（关窗即停）', () => {
    installFactory(1)
    const a1 = ensureRoomRuntime(1) as ReturnType<typeof fakeRuntime>
    const a2 = ensureRoomRuntime(2) as ReturnType<typeof fakeRuntime>
    a1.start()
    a2.start()
    stopAllRoomRuntimes()
    expect((a1 as unknown as { running: boolean }).running).toBe(false)
    expect((a2 as unknown as { running: boolean }).running).toBe(false)
    expect(getRoomRuntime({ uid: 1, aiId: 1 })).toBeNull()
  })
})
