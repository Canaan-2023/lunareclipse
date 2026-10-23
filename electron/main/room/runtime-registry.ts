/**
 * @category ROOM
 * @summary ROOM 运行时持有者：按 (uid, aiId) 分实例的注册表 + 工厂（从 `runtime.ts` 拆出）
 *
 * 为什么拆：`runtime.ts` 已接近 800 行硬红线（CODE-RULES §3.1），而 0.53.1 还要给运行时
 * 加感知器接线。持有者（注册表 / 工厂 / 停止）与「一个房间怎么跑」是两个职责，
 * 拆出后 `runtime.ts` 只留编排，本文件只管「实例放在哪、怎么取、怎么停」。
 *
 * 语义（ADR-25 支柱 2 / L3）：每个 AI 一个房间，会话 id 含 AI；
 * 实例按需创建（`ensureRoomRuntime`）、关窗即停（`stopAllRoomRuntimes`）。
 *
 * 不删理由：删掉即运行时回到全局单例——所有 AI 的自主行为会混进同一个会话。
 */
import type { RoomRuntime } from './runtime-types'
import { clearWakeArbiters, unregisterWakeArbiter } from './wake'

/** ROOM 运行时作用域：一个 (uid, aiId) 一个房间实例 */
export interface RoomScope {
  uid: number
  aiId: number
}

/** 自主会话 id（**含 AI**）：`room-autonomous-U{uid}-AI{aiId}` */
export function roomSessionId(scope: RoomScope): string {
  return `room-autonomous-U${scope.uid}-AI${scope.aiId}`
}

export function roomScopeKey(scope: RoomScope): string {
  return `${scope.uid}_${scope.aiId}`
}

const runtimes = new Map<string, RoomRuntime>()

/** 运行时工厂（组合根注入）：按 aiId 造实例；未登录 / 该 AI 不可运行 / 未装配 → null */
export type RoomRuntimeFactory = (aiId: number) => RoomRuntime | null

let runtimeFactory: RoomRuntimeFactory | null = null

export function setRoomRuntimeFactory(factory: RoomRuntimeFactory | null): void {
  runtimeFactory = factory
}

/** 取（必要时创建）某 AI 的运行时；不可用 → null（调用方按 null 报错，不静默用别的 AI） */
export function ensureRoomRuntime(aiId: number): RoomRuntime | null {
  return runtimeFactory?.(aiId) ?? null
}

export function setRoomRuntime(scope: RoomScope, rt: RoomRuntime | null): void {
  if (rt) runtimes.set(roomScopeKey(scope), rt)
  else runtimes.delete(roomScopeKey(scope))
}

export function getRoomRuntime(scope: RoomScope): RoomRuntime | null {
  return runtimes.get(roomScopeKey(scope)) ?? null
}

/**
 * **无副作用**读取某 AI 的运行时（P2-8）：只查已存在的实例，**不创建**。
 * 为什么需要：`room:runtime-state` 被原位视图在**挂载时**读取一次（此后靠推送），此前用
 * `ensureRoomRuntime` 会**持续创建**实例（未启动的房间也被造出来，且带会话/链路副作用）。
 * 只读路径必须用本函数。
 */
export function peekRoomRuntime(aiId: number): RoomRuntime | null {
  for (const [k, rt] of runtimes) {
    if (k.endsWith(`_${aiId}`)) return rt
  }
  return null
}

/** 已存在实例的 aiId 列表（`room:status` 用）。 */
export function listRoomRuntimeAiIds(): number[] {
  const ids = new Set<number>()
  for (const k of runtimes.keys()) {
    const seg = k.slice(k.lastIndexOf('_') + 1)
    const n = Number(seg)
    if (Number.isInteger(n)) ids.add(n)
  }
  return [...ids]
}

/** 停某个 AI 的运行时（键 = `{uid}_{aiId}`，aiId 为数字段，后缀匹配即精确命中） */
export function stopRoomRuntimeForAi(aiId: number): void {
  for (const [k, rt] of runtimes) {
    if (k.endsWith(`_${aiId}`)) {
      rt.stop()
      runtimes.delete(k)
    }
  }
  // 仲裁器也要注销：否则它仍持有旧 runtime 的闭包，后续广播会叫醒一个已销毁的房间
  unregisterWakeArbiter(aiId)
}

/** 停全部运行时并清空（主窗口关闭 / 退出时调用，不留常驻定时器） */
export function stopAllRoomRuntimes(): void {
  for (const rt of runtimes.values()) rt.stop()
  runtimes.clear()
  clearWakeArbiters()
}
