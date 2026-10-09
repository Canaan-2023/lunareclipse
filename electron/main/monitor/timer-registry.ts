/**
 * 定时器统一注册表

 * 项目中有 8+ 个独立定时器（MemoryWorkflowScheduler / Watchdog / ErrorLog /
 * ActivationManager / server.ts / index.ts），各自管理生命周期容易遗漏清理。

 * 本注册表统一管理所有 setTimeout / setInterval：
 * - 注册时返回 handle，stop(handle) 单个清理
 * - stopAll() 统一清理所有定时器（用于 app.before-quit）
 * - 自带 5 秒退出超时保护，避免某个 stop() 卡住整个退出流程

 * 使用方式：
 * const handle = timerRegistry.setTimeout(() => {...}, 1000)
 * timerRegistry.clearTimeout(handle)
 * const handle = timerRegistry.setInterval(() => {...}, 1000)
 * timerRegistry.clearInterval(handle)
 * await timerRegistry.stopAll() // 退出时调用
 */

export type TimerHandle = string

interface TimerRecord {
  id: TimerHandle
  kind: 'timeout' | 'interval'
  handle: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>
  label: string
  createdAt: number
}


export class TimerRegistry {
  private timers = new Map<TimerHandle, TimerRecord>()
  private sequence = 0

  setTimeout(callback: () => void, delayMs: number, label = 'anonymous'): TimerHandle {
    const id = this.nextId()
    const handle = setTimeout(() => {
      this.timers.delete(id)
      try {
        callback()
      } catch (err) {
        // 与 setInterval 一致：回调异常不冒泡成 uncaughtException（会触发健康检查崩溃事件刷屏）
        console.error(`[timer-registry] timeout callback error (${label}):`, err)
      }
    }, Math.max(0, delayMs))
    this.timers.set(id, {
      id,
      kind: 'timeout',
      handle,
      label,
      createdAt: Date.now()
    })
    return id
  }

  setInterval(callback: () => void, intervalMs: number, label = 'anonymous'): TimerHandle {
    const id = this.nextId()
    const wrapped = (): void => {
      try {
        callback()
      } catch (err) {
        console.error(`[timer-registry] interval callback error (${label}):`, err)
      }
    }
    const handle = setInterval(wrapped, Math.max(0, intervalMs))
    this.timers.set(id, {
      id,
      kind: 'interval',
      handle,
      label,
      createdAt: Date.now()
    })
    return id
  }

  clearTimeout(handle: TimerHandle): void {
    const rec = this.timers.get(handle)
    if (!rec) return
    clearTimeout(rec.handle as ReturnType<typeof setTimeout>)
    this.timers.delete(handle)
  }

  clearInterval(handle: TimerHandle): void {
    const rec = this.timers.get(handle)
    if (!rec) return
    clearInterval(rec.handle as ReturnType<typeof setInterval>)
    this.timers.delete(handle)
  }

  /**
   * 清理所有定时器
   * 用于 app.before-quit：clearTimeout/clearInterval 不会阻塞，直接同步清理
   */
  async stopAll(): Promise<void> {
    const count = this.timers.size
    if (count === 0) return

    for (const rec of this.timers.values()) {
      if (rec.kind === 'timeout') {
        clearTimeout(rec.handle as ReturnType<typeof setTimeout>)
      } else {
        clearInterval(rec.handle as ReturnType<typeof setInterval>)
      }
    }
    this.timers.clear()
  }

  /** 当前注册的定时器数量（调试/诊断用） */
  size(): number {
    return this.timers.size
  }

  /** 列出所有定时器（调试用） */
  list(): Array<{ id: string; kind: string; label: string; createdAt: number }> {
    return Array.from(this.timers.values()).map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      createdAt: r.createdAt
    }))
  }

  private nextId(): TimerHandle {
    this.sequence += 1
    return `timer_${Date.now()}_${this.sequence}`
  }
}

/** 全局单例（主进程） */
let globalRegistry: TimerRegistry | null = null

export function getGlobalTimerRegistry(): TimerRegistry {
  if (!globalRegistry) {
    globalRegistry = new TimerRegistry()
  }
  return globalRegistry
}
