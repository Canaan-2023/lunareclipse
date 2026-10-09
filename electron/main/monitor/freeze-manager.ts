/**
 * 为什么存在：自驱任务执行中可能必须停下来问用户（决策/确认），"等答案"必须实现为可持续问询、可恢复的状态机。
 * 作用：维护冻结记录与等待中的 resolver，通过 onFreeze/onUnfreeze/onAskUser/onInjectContinuation 回调驱动恢复续跑。
 */

import type { FreezeManager } from '../tools/base-tool'
import type { StateStore, FreezeRecord } from './state-store'

export interface FreezeManagerCallbacks {
  onFreeze?: (dmnId: string) => void
  onUnfreeze?: (dmnId: string, answer: string | null) => void
  onAskUser?: (
    dmnId: string,
    question: string,
    context: string | undefined,
    sessionId: string | null
  ) => void
  onInjectContinuation?: (dmnId: string, systemMessage: string) => void
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
    dmnId: string,
    question: string,
    context: string | undefined,
    sessionId: string | null
  ): Promise<string> {
    const sid = sessionId ?? 'default'
    const record: FreezeRecord = {
      会话ID: sid,
      冻结DMN: dmnId,
      冻结原因: context,
      冻结问题: question,
      冻结时间戳: new Date().toISOString()
    }
    // 磁盘持久化失败不应阻断冻结机制——内存状态 + resolver 必须设置，
    // 否则 DMN 永远等不到答案，watchdog 也不知道它被冻结
    try {
      void this.stateStore.saveFreeze(record)
    } catch (err) {
      console.error('[freeze] saveFreeze failed (in-memory freeze still active):', err)
    }
    this.frozen.set(dmnId, record)
    this.callbacks.onFreeze?.(dmnId)
    this.callbacks.onAskUser?.(dmnId, question, context, sessionId)

    return new Promise<string>((resolve) => {
      this.resolvers.set(dmnId, resolve)
    })
  }

  unfreeze(dmnId: string, answer: string | null): void {
    const resolver = this.resolvers.get(dmnId)
    if (resolver) {
      resolver(answer ?? '')
      this.resolvers.delete(dmnId)
    }
    const record = this.frozen.get(dmnId)
    this.frozen.delete(dmnId)
    if (record) {
      void this.stateStore.clearFreeze(record.会话ID, dmnId)
    }
    if (answer !== null) {
      const continuation = `恢复DMN:${dmnId} USER_ANSWER:${answer}`
      this.callbacks.onInjectContinuation?.(dmnId, continuation)
    }
    this.callbacks.onUnfreeze?.(dmnId, answer)
  }

  isFrozen(dmnId: string): boolean {
    return this.frozen.has(dmnId)
  }

  getFrozenQuestion(dmnId: string): string | null {
    return this.frozen.get(dmnId)?.冻结问题 ?? null
  }

  getFrozenAt(dmnId: string): number | null {
    const record = this.frozen.get(dmnId)
    if (!record) return null
    const t = Date.parse(record.冻结时间戳)
    return Number.isNaN(t) ? null : t
  }

  restoreFrozen(dmnId: string, record: FreezeRecord): void {
    this.frozen.set(dmnId, record)
  }
}
