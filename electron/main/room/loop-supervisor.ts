/**
 * @category ROOM
 * @summary 自主循环生命周期的**主进程唯一 owner**：按 (uid, aiId) 引用计数持有/释放，停由主进程发起
 *
 * 为什么存在（P0-3，2026-10-18 工程保障团队实测确认）：此前「停循环」的唯一实现挂在**渲染进程**的
 * React 卸载清理里（`RoomApp` 的 effect cleanup）。窗口被关闭/渲染进程崩溃/被任务管理器强杀时，
 * cleanup 根本不会执行——而主进程的 `setInterval` 照跑，形成**幽灵循环**：配置显示已关，
 * AI 仍每 60s 采集→规划→执行。生命周期必须由**持有定时器的那一侧**（主进程）拥有。
 *
 * 引用计数为什么必要：`stopRoomRuntimeForAi(aiId)` 是「按 AI 全局停」，同一 AI 有两个消费者时
 * （例如原位视图 + 待机唤醒器，或两个会话页都开了 ROOM），一个消费者退订会误杀另一个还在用的循环。
 * 计数让「谁要跑」可叠加，只有最后一个消费者退订才真正停。
 *
 * 不删理由：删掉即「幽灵循环」复发，且「无残留定时器」这条上线门禁失去唯一 owner。
 */
import { getRoomRuntime, roomScopeKey, stopAllRoomRuntimes, type RoomRuntime, type RoomScope } from './runtime'

export interface RoomLoopSupervisorDeps {
  /** 取（必要时创建）某 AI 的运行时；未登录 / 该 AI 已下线 / 未装配 → null */
  ensureRuntime: (aiId: number) => RoomRuntime | null
  /** 当前登录用户 uid（未登录 → null：自主循环的作用域按 uid 分，未登录不该跑） */
  getCurrentUid: () => number | null
}

export interface RoomLoopSupervisor {
  /** 消费者声明「我要这个 AI 的循环在跑」：首次持有即启动；返回 false 表示不可用（未登录 / 该 AI 不可运行） */
  acquire: (aiId: number) => { ok: boolean; running: boolean; error?: string }
  /** 消费者退订：计数归零才真正停 */
  release: (aiId: number) => { running: boolean }
  /** 强制停某 AI 的全部作用域（显式停止 / 关窗 / 承载会话关闭） */
  stopAi: (aiId: number) => void
  /** 强制停全部并清空运行时实例（主窗口关闭 / 退出） */
  stopAll: () => void
  /** 运行态查询（无副作用，不创建实例） */
  isRunning: (aiId: number) => boolean
  /** 某 AI 的当前引用数（诊断 / 门禁断言用） */
  refCount: (aiId: number) => number
  /** 当前被持有的作用域数（诊断 / 门禁断言用） */
  activeCount: () => number
}

export function createRoomLoopSupervisor(deps: RoomLoopSupervisorDeps): RoomLoopSupervisor {
  /** scopeKey → { scope, refs }：只记录被消费者持有的作用域 */
  const held = new Map<string, { scope: RoomScope; refs: number }>()

  const scopeOf = (aiId: number): RoomScope | null => {
    const uid = deps.getCurrentUid()
    return uid == null ? null : { uid, aiId }
  }

  const acquire = (aiId: number): { ok: boolean; running: boolean; error?: string } => {
    const scope = scopeOf(aiId)
    if (!scope) {
      return { ok: false, running: false, error: '未登录：自主循环的作用域按用户分，未登录不启动' }
    }
    const rt = deps.ensureRuntime(aiId)
    if (!rt) {
      return {
        ok: false,
        running: false,
        error: `自主运行时不可用（AI${aiId}）：未登录 / 该 AI 已下线 / 未装配`
      }
    }
    const key = roomScopeKey(scope)
    const cur = held.get(key)
    if (cur) {
      // 已有消费者：只加计数，不重复 start（runtime.start 本身幂等，这里再省一层）
      cur.refs += 1
      return { ok: true, running: rt.isRunning() }
    }
    held.set(key, { scope, refs: 1 })
    rt.start()
    return { ok: true, running: true }
  }

  const release = (aiId: number): { running: boolean } => {
    const scope = scopeOf(aiId)
    if (!scope) return { running: false }
    const key = roomScopeKey(scope)
    const cur = held.get(key)
    if (!cur) return { running: getRoomRuntime(scope)?.isRunning() ?? false }
    cur.refs -= 1
    if (cur.refs > 0) return { running: true }
    held.delete(key)
    getRoomRuntime(scope)?.stop()
    return { running: false }
  }

  const stopAi = (aiId: number): void => {
    for (const [key, entry] of [...held]) {
      if (entry.scope.aiId === aiId) {
        held.delete(key)
        getRoomRuntime(entry.scope)?.stop()
      }
    }
  }

  const stopAll = (): void => {
    held.clear()
    // held 里的实例都由 `ensureRuntime` 创建并登记进实例表（bootstrap 的工厂就是这么做的），
    // 故一次 stopAllRoomRuntimes 即覆盖全部；额外兜底清掉「被创建但未被持有」的实例。
    stopAllRoomRuntimes()
  }

  return {
    acquire,
    release,
    stopAi,
    stopAll,
    isRunning: (aiId) => {
      const scope = scopeOf(aiId)
      return scope ? (getRoomRuntime(scope)?.isRunning() ?? false) : false
    },
    refCount: (aiId) => {
      const scope = scopeOf(aiId)
      return scope ? (held.get(roomScopeKey(scope))?.refs ?? 0) : 0
    },
    activeCount: () => held.size
  }
}

// ===== 主进程单例（组合根装配期安装；room-window 的 IPC 与窗口事件读它）=====
let supervisor: RoomLoopSupervisor | null = null

export function setRoomLoopSupervisor(next: RoomLoopSupervisor | null): void {
  supervisor = next
}

export function getRoomLoopSupervisor(): RoomLoopSupervisor | null {
  return supervisor
}
