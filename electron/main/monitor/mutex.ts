/**
 * 为什么存在：DMN 任务执行与其心跳/冻结检查可能并发读写同一状态，须按 dmnId 隔离两条临界路径防竞态。
 * 作用：基于 async-mutex 维护 heartbeat 与 dmn 两组互斥，提供 tryAcquire/withTimeout 等获取方式。
 */

import { Mutex, tryAcquire, withTimeout, E_ALREADY_LOCKED, E_TIMEOUT } from 'async-mutex'

export class DmnMutex {
  private heartbeatMutexes = new Map<string, Mutex>()
  private dmnMutexes = new Map<string, Mutex>()

  private getHeartbeatMutex(dmnId: string): Mutex {
    let mutex = this.heartbeatMutexes.get(dmnId)
    if (!mutex) {
      mutex = new Mutex()
      this.heartbeatMutexes.set(dmnId, mutex)
    }
    return mutex
  }

  private getDmnMutex(dmnId: string): Mutex {
    let mutex = this.dmnMutexes.get(dmnId)
    if (!mutex) {
      mutex = new Mutex()
      this.dmnMutexes.set(dmnId, mutex)
    }
    return mutex
  }

  async acquireHeartbeatLock(dmnId: string): Promise<boolean> {
    try {
      await tryAcquire(this.getHeartbeatMutex(dmnId)).acquire()
      return true
    } catch (e) {
      if (e === E_ALREADY_LOCKED) return false
      throw e
    }
  }

  releaseHeartbeatLock(dmnId: string): void {
    const mutex = this.heartbeatMutexes.get(dmnId)
    if (mutex) {
      try {
        mutex.release()
      } catch {
        // 锁未被持有（可能已被 completionHandler 或其他路径释放），幂等忽略
      }
    }
  }

  async tryAcquire(dmnId: string, timeoutMs = 0): Promise<boolean> {
    const mutex = this.getDmnMutex(dmnId)
    if (timeoutMs <= 0) {
      try {
        await tryAcquire(mutex).acquire()
        return true
      } catch (e) {
        if (e === E_ALREADY_LOCKED) return false
        throw e
      }
    }
    try {
      await withTimeout(mutex, timeoutMs).acquire()
      return true
    } catch (e) {
      if (e === E_TIMEOUT) return false
      throw e
    }
  }

  release(dmnId: string): void {
    const mutex = this.dmnMutexes.get(dmnId)
    if (mutex) {
      try {
        mutex.release()
      } catch {
        // 锁未被持有（可能已被其他路径释放），幂等忽略
      }
    }
  }

  isHeartbeatLocked(dmnId: string): boolean {
    const mutex = this.heartbeatMutexes.get(dmnId)
    return mutex ? mutex.isLocked() : false
  }

  removeDmn(dmnId: string): void {
    this.heartbeatMutexes.delete(dmnId)
    this.dmnMutexes.delete(dmnId)
  }
}
