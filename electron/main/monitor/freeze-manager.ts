/**
 * 为什么存在：自驱任务执行中可能必须停下来问用户（决策/确认），"等答案"必须实现为可持续问询、可恢复的状态机。
 * 作用：维护冻结记录与等待中的 resolver，通过 onFreeze/onUnfreeze/onAskUser/onInjectContinuation 回调驱动恢复续跑。
 */

import type { FreezeManager } from '../tools/base-tool'
import type { StateStore, FreezeRecord } from './state-store'

export interface FreezeManagerCallbacks {
  onFreeze?: (taskId: string) => void
  onUnfreeze?: (taskId: string, answer: string | null) => void
  onAskUser?: (
    taskId: string,
    question: string,
    context: string | undefined,
    sessionId: string | null
  ) => void
  onInjectContinuation?: (taskId: string, systemMessage: string) => void
}

export class FreezeManagerImpl implements FreezeManager {
  private frozen = new Map<string, FreezeRecord>()
  private resolvers = new Map<string, (answer: string) => void>()
  private callbacks: FreezeManagerCallbacks = {}

  constructor(private stateStore: StateStore) {}

  setCallbacks(callbacks: FreezeManagerCallbacks): void {
    this.callbacks = callbacks
  }

  async freeze(
    taskId: string,
    question: string,
    context: string | undefined,
    sessionId: string | null
  ): Promise<string> {
    const sid = sessionId ?? 'default'
    const record: FreezeRecord = {
      会话ID: sid,
      冻结任务: taskId,
      冻结原因: context,
      冻结问题: question,
      冻结时间戳: new Date().toISOString()
    }
    // 磁盘持久化失败不应阻断冻结机制——内存状态 + resolver 必须设置，
    // 否则任务永远等不到答案，watchdog 也不知道它被冻结
    try {
      void this.stateStore.saveFreeze(record)
    } catch (err) {
      console.error('[freeze] saveFreeze failed (in-memory freeze still active):', err)
    }
    this.frozen.set(taskId, record)
    this.callbacks.onFreeze?.(taskId)
    this.callbacks.onAskUser?.(taskId, question, context, sessionId)

    return new Promise<string>((resolve) => {
      this.resolvers.set(taskId, resolve)
    })
  }

  unfreeze(taskId: string, answer: string | null): void {
    const resolver = this.resolvers.get(taskId)
    if (resolver) {
      resolver(answer ?? '')
      this.resolvers.delete(taskId)
    }
    const record = this.frozen.get(taskId)
    this.frozen.delete(taskId)
    if (record) {
      void this.stateStore.clearFreeze(record.会话ID, taskId)
    }
    if (answer !== null) {
      const continuation = `恢复任务:${taskId} USER_ANSWER:${answer}`
      this.callbacks.onInjectContinuation?.(taskId, continuation)
    }
    this.callbacks.onUnfreeze?.(taskId, answer)
  }

  isFrozen(taskId: string): boolean {
    return this.frozen.has(taskId)
  }

  getFrozenQuestion(taskId: string): string | null {
    return this.frozen.get(taskId)?.冻结问题 ?? null
  }

  getFrozenAt(taskId: string): number | null {
    const record = this.frozen.get(taskId)
    if (!record) return null
    const t = Date.parse(record.冻结时间戳)
    return Number.isNaN(t) ? null : t
  }

  restoreFrozen(taskId: string, record: FreezeRecord): void {
    this.frozen.set(taskId, record)
  }
}