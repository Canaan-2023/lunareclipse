/**
 * 为什么存在：后台同步失败若只记内存，重启即丢失且无从重试；落盘后可按策略补做并标记永久失败，不重复打扰用户。
 * 作用：持久化同步/崩溃/自定义任务的错误条目（含重试计数与永久失败标记），提供回读、清理与定时重试。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { nowIso } from '../models/memory'
import type { TimerRegistry, TimerHandle } from './timer-registry'

export interface ErrorLogEntry {
  id: string
  timestamp: string
  error: string
  task: ErrorLogTask
  retry_count: number
  permanent_failure: boolean
  last_retry_at: string | null
}

export type ErrorLogTask =
  | { type: 'nng_sync'; path: string }
  | { type: 'cache_sync'; path: string }
  | { type: 'memory_sync'; path: string }
  | { type: 'index_sync'; path: string }
  | { type: 'orphan_check'; path: string; file_type: 'nng' | 'cache' | 'memory' | 'index' }
  | { type: 'startup_check'; path: string }
  | { type: 'dmn_crash'; dmnId: string }
  | { type: 'custom'; path: string; detail: string }

export interface ErrorLogConfig {
  retry_interval_ms: number
  max_retry: number
}

export const DEFAULT_ERROR_LOG_CONFIG: ErrorLogConfig = {
  retry_interval_ms: 5 * 60 * 1000,
  max_retry: 10
}

export class ErrorLog {
  private logPath: string
  private config: ErrorLogConfig
  private entries: ErrorLogEntry[] = []
  private loaded = false
  private retryHandle: TimerHandle | null = null
  private retryHandler: ((entry: ErrorLogEntry) => Promise<boolean>) | null = null
  private timerRegistry?: TimerRegistry

  constructor(logPath: string, config: ErrorLogConfig = DEFAULT_ERROR_LOG_CONFIG, timerRegistry?: TimerRegistry) {
    this.logPath = logPath
    this.config = config
    this.timerRegistry = timerRegistry
  }

  setRetryHandler(handler: (entry: ErrorLogEntry) => Promise<boolean>): void {
    this.retryHandler = handler
  }

  start(): void {
    this.load()
    if (this.retryHandle) {
      this.timerRegistry?.clearInterval(this.retryHandle)
    }
    const cb = () => {
      void this.retryPending()
    }
    this.retryHandle = this.timerRegistry
      ? this.timerRegistry.setInterval(cb, this.config.retry_interval_ms, 'error-log.retry')
      : setInterval(cb, this.config.retry_interval_ms) as unknown as TimerHandle
  }

  stop(): void {
    if (this.retryHandle) {
      if (this.timerRegistry) {
        this.timerRegistry.clearInterval(this.retryHandle)
      } else {
        clearInterval(this.retryHandle as unknown as ReturnType<typeof setInterval>)
      }
      this.retryHandle = null
    }
  }

  add(error: string, task: ErrorLogTask): ErrorLogEntry {
    this.ensureLoaded()
    const entry: ErrorLogEntry = {
      id: randomUUID(),
      timestamp: nowIso(),
      error,
      task,
      retry_count: 0,
      permanent_failure: false,
      last_retry_at: null
    }
    this.entries.push(entry)
    this.appendToFile(entry)
    return entry
  }

  remove(id: string): void {
    this.ensureLoaded()
    this.entries = this.entries.filter((e) => e.id !== id)
    this.rewriteFile()
  }

  list(): ErrorLogEntry[] {
    this.ensureLoaded()
    return [...this.entries]
  }

  async retryPending(): Promise<void> {
    this.ensureLoaded()
    if (!this.retryHandler) return
    const pending = this.entries.filter((e) => !e.permanent_failure)
    try {
      for (const entry of pending) {
        const ok = await this.retryHandler(entry)
        entry.last_retry_at = nowIso()
        if (ok) {
          this.entries = this.entries.filter((e) => e.id !== entry.id)
        } else {
          entry.retry_count += 1
          if (entry.retry_count >= this.config.max_retry) {
            entry.permanent_failure = true
          }
        }
      }
    } finally {
      this.rewriteFile()
    }
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.load()
    }
  }

  private load(): void {
    this.loaded = true
    if (!existsSync(this.logPath)) {
      this.entries = []
      return
    }
    try {
      const raw = readFileSync(this.logPath, 'utf-8')
      const lines = raw.split('\n').filter((l) => l.trim().length > 0)
      this.entries = []
      for (const line of lines) {
        try {
          this.entries.push(JSON.parse(line) as ErrorLogEntry)
        } catch {
          // 跳过损坏行，保留可解析的记录
        }
      }
    } catch {
      this.entries = []
    }
  }

  private appendToFile(entry: ErrorLogEntry): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(entry) + '\n', 'utf-8')
    } catch {
      // skip
    }
  }

  private rewriteFile(): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      const text = this.entries.map((e) => JSON.stringify(e)).join('\n')
      const out = this.entries.length > 0 ? text + '\n' : ''
      writeFileSync(this.logPath, out, 'utf-8')
    } catch {
      // skip
    }
  }
}
