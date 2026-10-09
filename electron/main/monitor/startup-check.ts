/**
 * 为什么存在：文件监视器只跟踪运行期事件，程序退出期间产生的变更需在每次启动时补齐账目。
 * 作用：启动时遍历 NNG/Cache/Memory/Index 各同步根目录，逐个文件调用对应同步器补同步并记录错误。
 */

import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { normalizePath } from '../models/paths'
import { ErrorLog, type ErrorLogEntry } from './error-log'
import { NngSync, isNngFile } from './nng-sync'
import { CacheSync, isCacheFile } from './cache-sync'
import { MemorySync, isMemoryFile } from './memory-sync'
import { IndexSync } from './index-sync'

export class StartupCheck {
  private nngRoot: string
  private cacheIndexRoot: string
  private memoryRoot: string
  private nngRootJson: string
  private cacheIndexJson: string
  private errorLog: ErrorLog
  private nngSync: NngSync
  private cacheSync: CacheSync
  private memorySync: MemorySync
  private indexSync: IndexSync

  constructor(
    nngRoot: string,
    cacheIndexRoot: string,
    memoryRoot: string,
    nngRootJson: string,
    cacheIndexJson: string,
    errorLog: ErrorLog,
    nngSync: NngSync,
    cacheSync: CacheSync,
    memorySync: MemorySync,
    indexSync: IndexSync
  ) {
    this.nngRoot = normalizePath(nngRoot)
    this.cacheIndexRoot = normalizePath(cacheIndexRoot)
    this.memoryRoot = normalizePath(memoryRoot)
    this.nngRootJson = normalizePath(nngRootJson)
    this.cacheIndexJson = normalizePath(cacheIndexJson)
    this.errorLog = errorLog
    this.nngSync = nngSync
    this.cacheSync = cacheSync
    this.memorySync = memorySync
    this.indexSync = indexSync
  }

  async runFullCheck(): Promise<void> {
    const tasks: ErrorLogEntry[] = []
    this.collectNngFiles(this.nngRoot, tasks)
    this.collectCacheFiles(this.cacheIndexRoot, tasks)
    this.collectMemoryFiles(this.memoryRoot, tasks)
    if (existsSync(this.nngRootJson)) {
      tasks.push(this.errorLog.add('startup_check nng root.json', { type: 'startup_check', path: this.nngRootJson }))
    }
    if (existsSync(this.cacheIndexJson)) {
      tasks.push(this.errorLog.add('startup_check cache index.json', { type: 'startup_check', path: this.cacheIndexJson }))
    }
for (const entry of tasks) {
      await this.processEntry(entry)
      // 启动扫描是连续同步文件 I/O（读/解析/写回），若 100+ 文件会长时间占住主线程，
      // 期间 UI/渲染进程无响应。每条之间让出事件循环（setImmediate 不受 Windows
      // timer ~15.6ms 节流影响，代价约 1ms，收益是主线程不阻塞）。
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  private collectNngFiles(dir: string, tasks: ErrorLogEntry[]): void {
    if (!existsSync(dir)) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = normalizePath(join(dir, entry))
      const st = this.safeStat(full)
      if (!st) continue
      if (st.isDirectory()) {
        this.collectNngFiles(full, tasks)
      } else if (isNngFile(full, this.nngRoot)) {
        tasks.push(
          this.errorLog.add('startup_check nng', { type: 'startup_check', path: full })
        )
      }
    }
  }

  private collectCacheFiles(dir: string, tasks: ErrorLogEntry[]): void {
    if (!existsSync(dir)) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = normalizePath(join(dir, entry))
      const st = this.safeStat(full)
      if (!st) continue
      if (st.isDirectory()) {
        this.collectCacheFiles(full, tasks)
      } else if (isCacheFile(full, this.cacheIndexRoot)) {
        tasks.push(
          this.errorLog.add('startup_check cache', { type: 'startup_check', path: full })
        )
      }
    }
  }

  private collectMemoryFiles(dir: string, tasks: ErrorLogEntry[]): void {
    if (!existsSync(dir)) return
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = normalizePath(join(dir, entry))
      const st = this.safeStat(full)
      if (!st) continue
      if (st.isDirectory()) {
        this.collectMemoryFiles(full, tasks)
      } else if (isMemoryFile(full, this.memoryRoot)) {
        tasks.push(
          this.errorLog.add('startup_check memory', { type: 'startup_check', path: full })
        )
      }
    }
  }

  private safeStat(p: string): { isDirectory(): boolean; isFile(): boolean } | null {
    try {
      return statSync(p)
    } catch {
      return null
    }
  }

  private async processEntry(entry: ErrorLogEntry): Promise<void> {
    if (entry.task.type !== 'startup_check') return
    const p = normalizePath(entry.task.path)
    if (this.indexSync.isIndexFile(p)) {
      this.indexSync.sync(p)
      this.errorLog.remove(entry.id)
      return
    }
    if (isNngFile(p, this.nngRoot)) {
      this.nngSync.sync(p, 'accessed')
      // 关键：NNG→cache 镜像是 created/modified 事件才触发，启动扫描（accessed）不会触发。
      // 必须在这里主动调 handleNngModified——它内部对缺失的 cache 会转 handleNngCreated 重建，
      // 这样一级缓存文件缺失/幽灵目录清理后，启动时能自动补齐镜像 + 索引（缓存是 NNG 的镜像）。
      this.cacheSync.handleNngModified(p)
      this.errorLog.remove(entry.id)
      return
    }
    if (isCacheFile(p, this.cacheIndexRoot)) {
      this.cacheSync.sync(p)
      this.errorLog.remove(entry.id)
      return
    }
    if (isMemoryFile(p, this.memoryRoot)) {
      // backfill=false：启动扫描只做基础校准（自身路径/字段存在性），
      // 不触发反向回填——回填只由"记忆文件变动"事件触发
      // （设计依据：全量扫描在启动路径上是重复劳动，反向回填仅对增量变动才有信息量）
      this.memorySync.sync(p, false)
      this.errorLog.remove(entry.id)
      return
    }
    this.errorLog.remove(entry.id)
  }
}
