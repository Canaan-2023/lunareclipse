/**
 * 为什么存在：DMN 自驱任务无声崩溃、卡死或冻结时用户无从得知，需要常驻巡检兜底并触发恢复动作。
 * 作用：跟踪每 DMN 状态机（running/frozen/crashed/stopped），超时/异常时回调 onCrash/onRestart/onContinueHint 等。
 */

import type { DmnRunner } from './dmn-runner'
import type { DmnMutex } from './mutex'
import type { FreezeManager } from '../tools/base-tool'
import type { MonitorConfig } from './monitor-config'
import type { ErrorLog } from './error-log'
import type { TimerRegistry, TimerHandle } from './timer-registry'

export interface WatchdogCallbacks {
  onCrash?: (dmnId: string, reason: string) => void
  onContinueHint?: (dmnId: string) => void
  onStopped?: (dmnId: string, reason: string) => void
  /** 文档 16.11.2：retryCount < max_retry 时触发，由 supervisor 重启该 DMN 的起始流程 */
  onRestart?: (dmnId: string) => void
}

interface DmnWatchState {
  startedAt: number
  retryCount: number
  status: 'idle' | 'running' | 'frozen' | 'crashed' | 'stopped'
}

// 心跳路径已随旧 DMN 调度体系退役（memory-workflow 不经过心跳锁路径），
// 故不再维护心跳 DMN 清单（原 HEARTBEAT_DMNS 恒为空数组、对应 if 分支恒不可达 = 死代码，已删除）。
// ALL_DMNS 保留当前唯一受监控对象 memory-workflow——看门狗只巡检它，避免放大巡检面误伤其他流程。
const ALL_DMNS = ['memory-workflow']
const CONTINUE_HINT = '请继续执行当前任务，直到完成任务后再停止。'

export class Watchdog {
  private states = new Map<string, DmnWatchState>()
  private checkHandle: TimerHandle | null = null
  private shouldStop = false

  constructor(
    private runner: DmnRunner,
    private mutex: DmnMutex,
    private freezeManager: FreezeManager,
    private config: MonitorConfig,
    private errorLog: ErrorLog,
    private callbacks: WatchdogCallbacks = {},
    private timerRegistry?: TimerRegistry
  ) {
    for (const id of ALL_DMNS) {
      this.states.set(id, {
        startedAt: 0,
        retryCount: 0,
        status: 'idle'
      })
    }
  }

  updateConfig(config: MonitorConfig): void {
    this.config = config
  }

  start(): void {
    this.shouldStop = false
    const intervalMs = this.config.watchdog.continue_check_seconds * 1000
    if (this.timerRegistry) {
      this.checkHandle = this.timerRegistry.setInterval(() => {
        void this.tick()
      }, intervalMs, 'watchdog.tick')
    } else {
      // 兼容路径：未注入 registry 时直接用全局 setInterval（不推荐）
      const handle = setInterval(() => {
        void this.tick()
      }, intervalMs)
      // 用 registry 的 id 格式便于统一清理（此处用类型断言绕过，因为 setInterval 返回的是 NodeJS.Timeout）
      this.checkHandle = handle as unknown as TimerHandle
    }
  }

  stop(): void {
    this.shouldStop = true
    if (this.checkHandle) {
      if (this.timerRegistry) {
        this.timerRegistry.clearInterval(this.checkHandle)
      } else {
        clearInterval(this.checkHandle as unknown as ReturnType<typeof setInterval>)
      }
      this.checkHandle = null
    }
  }

  markRunning(dmnId: string): void {
    const state = this.states.get(dmnId)
    if (state) {
      state.status = 'running'
      state.startedAt = Date.now()
    }
  }

  markIdle(dmnId: string): void {
    const state = this.states.get(dmnId)
    if (state) {
      state.status = 'idle'
      state.startedAt = 0
      // 文档 13.5：DMN 成功完成后重置连续失败计数，避免历史失败累积误触发 max_retry
      state.retryCount = 0
    }
  }

  markFrozen(dmnId: string): void {
    const state = this.states.get(dmnId)
    if (state) {
      state.status = 'frozen'
    }
  }

  getStatus(dmnId: string): DmnWatchState['status'] {
    return this.states.get(dmnId)?.status ?? 'idle'
  }

  getRetryCount(dmnId: string): number {
    return this.states.get(dmnId)?.retryCount ?? 0
  }

  private async tick(): Promise<void> {
    if (this.shouldStop) return
    const now = Date.now()
    const timeoutMs = this.config.watchdog.timeout_minutes * 60 * 1000
    const continueMs = this.config.watchdog.continue_check_seconds * 1000

    for (const dmnId of ALL_DMNS) {
      const state = this.states.get(dmnId)
      if (!state) continue
      if (state.status === 'stopped' || state.status === 'idle') continue

      if (state.status === 'frozen') {
        const freezeTimeoutMs = this.config.freeze.timeout_minutes * 60 * 1000
        const frozenAt = this.freezeManager.getFrozenAt(dmnId)
        if (frozenAt && now - frozenAt > freezeTimeoutMs) {
          this.freezeManager.unfreeze(dmnId, null)
        }
        continue
      }

      if (state.status !== 'running') continue

      if (!this.runner.isRunning(dmnId)) {
        continue
      }

      const lastActivity = this.runner.getLastActivityAt(dmnId)
      if (lastActivity && now - lastActivity > timeoutMs) {
        await this.forceRestart(dmnId, 'timeout: 无活动超时')
        continue
      }

      if (lastActivity && now - lastActivity > continueMs) {
        this.sendContinueHint(dmnId)
      }
    }
  }

  private sendContinueHint(dmnId: string): void {
    const injected = this.runner.injectSystemMessage(dmnId, CONTINUE_HINT)
    if (injected) {
      this.callbacks.onContinueHint?.(dmnId)
    }
  }

  async forceRestart(dmnId: string, reason: string): Promise<void> {
    const state = this.states.get(dmnId)
    if (!state) return

    state.status = 'crashed'
    this.runner.kill(dmnId)

    // 释放互斥锁（可能抛错，但不能阻断后续状态更新和重启逻辑）。
    // 为什么直接走 release：旧心跳锁路径（isHeartbeatLocked/releaseHeartbeatLock）仅服务已退役的
    // 心跳调度体系，心跳 DMN 清单恒为空导致该分支永不可达；统一调 release 覆盖全部现存 DMN，
    // 保留 try/catch 的原因——release 抛错只应告警，绝不能阻断下方 retry/onRestart 状态机推进。
    try {
      this.mutex.release(dmnId)
    } catch (err) {
      console.error('[watchdog] mutex.release failed:', err)
    }

    // retryCount 先递增，确保 errorLog.add 抛错时重启逻辑仍能正确判断重试次数
    state.retryCount += 1

    // 记录错误日志（可能抛错，但不能阻断重启逻辑）
    try {
      this.errorLog.add(reason, { type: 'dmn_crash', dmnId })
    } catch (err) {
      console.error('[watchdog] errorLog.add failed:', err)
    }

    this.callbacks.onCrash?.(dmnId, reason)

    if (state.retryCount >= this.config.watchdog.max_retry) {
      state.status = 'stopped'
      state.retryCount = 0
      this.callbacks.onStopped?.(dmnId, `超过最大重试次数: ${reason}`)
      return
    }

    // 文档 16.11.2：retryCount < max_retry 时重新启动该 DMN，从其起始流程重新执行
    state.status = 'idle'
    state.startedAt = 0
    this.callbacks.onRestart?.(dmnId)
  }
}
