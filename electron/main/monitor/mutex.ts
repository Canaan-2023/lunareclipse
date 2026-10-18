/**
 * 为什么存在：自治任务执行与其冻结检查可能并发读写同一状态，须按 taskId 隔离两条临界路径防竞态。
 * 作用：基于 async-mutex 维护两类互斥（心跳锁与任务锁），提供 tryAcquire/withTimeout 等获取方式。
 * 注：heartbeat 互斥仅服务已退役的旧心跳调度体系，待清理（见 _pending_delete 计划），
 * 现仅任务锁（mutexes）有真实调用方。
 */

import { Mutex, tryAcquire, withTimeout, E_ALREADY_LOCKED, E_TIMEOUT } from 'async-mutex'

export class TaskMutex {
  private heartbeatMutexes = new Map<string, Mutex>()
  private mutexes = new Map<string, Mutex>()

  private getHeartbeatMutex(taskId: string): Mutex {
    let mutex = this.heartbeatMutexes.get(taskId)
    if (!mutex) {
      mutex = new Mutex()
      this.heartbeatMutexes.set(taskId, mutex)
    }
    return mutex
  }

  private getMutex(taskId: string): Mutex {
    let mutex = this.mutexes.get(taskId)
    if (!mutex) {
      mutex = new Mutex()
      this.mutexes.set(taskId, mutex)
    }
    return mutex
  }

  async acquireHeartbeatLock(taskId: string): Promise<boolean> {
    try {
      await tryAcquire(this.getHeartbeatMutex(taskId)).acquire()
      return true
    } catch (e) {
      if (e === E_ALREADY_LOCKED) return false
      throw e
    }
  }

  releaseHeartbeatLock(taskId: string): void {
    const mutex = this.heartbeatMutexes.get(taskId)
    if (mutex) {
      try {
        mutex.release()
      } catch {
        // 锁未被持有（可能已被 completionHandler 或其他路径释放），幂等忽略
      }
    }
  }

  async tryAcquire(taskId: string, timeoutMs = 0): Promise<boolean> {
    const mutex = this.getMutex(taskId)
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

  release(taskId: string): void {
    const mutex = this.mutexes.get(taskId)
    if (mutex) {
      try {
        mutex.release()
      } catch {
        // 锁未被持有（可能已被其他路径释放），幂等忽略
      }
    }
  }

  isHeartbeatLocked(taskId: string): boolean {
    const mutex = this.heartbeatMutexes.get(taskId)
    return mutex ? mutex.isLocked() : false
  }

  remove(taskId: string): void {
    this.heartbeatMutexes.delete(taskId)
    this.mutexes.delete(taskId)
  }
}