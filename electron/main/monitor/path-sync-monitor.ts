/**
 * 为什么存在：记忆/缓存的运行期变更由实时文件订阅驱动，订阅之外的存量差异需在启动时补齐，故两者都需纳入。
 * 作用：加载路径同步配置，用 @parcel/watcher 订阅各作用域根目录并把事件交给 Handler，另配置启动补同步与错误上报。
 */

import { subscribe, type AsyncSubscription } from '@parcel/watcher'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { normalizePath, type BaseDataPaths } from '../models/paths'
import { ErrorLog, type ErrorLogEntry } from './error-log'
import type { TimerRegistry } from './timer-registry'
import { OrphanCheck } from './orphan-check'
import { MemorySync } from './memory-sync'
import { NngSync } from './nng-sync'
import { CacheSync } from './cache-sync'
import { IndexSync } from './index-sync'
import { Handler } from './handler'
import { StartupCheck } from './startup-check'
import { nowIso } from '../models/memory'

export interface PathSyncConfig {
  abyssac_root: string
  retry_count: number
  retry_interval_ms: number
  error_log_retry_interval_minutes: number
  error_log_max_retry: number
  startup_check_async: boolean
}

export const DEFAULT_PATH_SYNC_CONFIG: PathSyncConfig = {
  abyssac_root: '',
  retry_count: 3,
  retry_interval_ms: 100,
  error_log_retry_interval_minutes: 5,
  error_log_max_retry: 10,
  startup_check_async: true
}

function loadConfig(configPath: string): Partial<PathSyncConfig> {
  if (!existsSync(configPath)) return {}
  try {
    const raw = readFileSync(configPath, 'utf-8')
    return JSON.parse(raw) as Partial<PathSyncConfig>
  } catch {
    return {}
  }
}

function saveConfig(configPath: string, config: PathSyncConfig): void {
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch {
    // skip
  }
}

export class PathSyncMonitor {
  private paths: BaseDataPaths
  private config: PathSyncConfig
  private configPath: string
  private selfWriteMarker: Set<string> = new Set()
  private errorLog: ErrorLog
  private orphan: OrphanCheck
  private memorySync: MemorySync
  private nngSync: NngSync
  private cacheSync: CacheSync
  private indexSync: IndexSync
  private handler: Handler
  private startupCheck: StartupCheck
  private subscriptions: AsyncSubscription[] = []
  private started = false
  private processingCount = 0
  private startupTime = nowIso()
  private eventStats = { create: 0, modify: 0, delete: 0, move: 0 }
  /** 待处理 watcher 事件（同路径去重合并，防事件风暴） */
  private pendingEvents = new Map<string, { path: string; type: string; priority: number }>()
  /** 是否已有批量处理排队（防止风暴中重复调度微任务） */
  private flushScheduled = false
  /** 单轮事件数超过此阈值判定为风暴：合并为一次全量校准（悄然屏蔽，最终态一致即可） */
  private static readonly STORM_THRESHOLD = 50
  /** selfWriteMarker 最大条目数（防事件丢失导致永久泄漏） */
  private static readonly SELF_WRITE_MARKER_MAX_SIZE = 1000
  /** 风暴全量校准超时（毫秒）：超时后放行 stop()，避免阻塞超过 stop 等待上限 */
  private static readonly STORM_CHECK_TIMEOUT_MS = 4000

  constructor(
    paths: BaseDataPaths,
    config: Partial<PathSyncConfig> = {},
    timerRegistry?: TimerRegistry,
    cacheUidExcluded?: (uid: number) => boolean
  ) {
    this.paths = paths
    this.configPath = join(paths.fileMonitor, 'config.json')
    this.ensureDirs()

    // 文档 5.4：从 .file_monitor/config.json 加载配置，与传入参数合并
    const fileConfig = loadConfig(this.configPath)
    this.config = { ...DEFAULT_PATH_SYNC_CONFIG, ...fileConfig, ...config }
    if (!this.config.abyssac_root) {
      this.config.abyssac_root = paths.root
    }
    // 持久化配置（首次创建或更新）
    saveConfig(this.configPath, this.config)

    this.errorLog = new ErrorLog(paths.fileMonitorErrorLog, {
      retry_interval_ms: this.config.error_log_retry_interval_minutes * 60 * 1000,
      max_retry: this.config.error_log_max_retry
}, timerRegistry)
    this.orphan = new OrphanCheck(paths.fileMonitorCorrupted, this.selfWriteMarker)
    this.memorySync = new MemorySync(
      paths.nngRoot,
      this.orphan,
      this.errorLog,
      this.selfWriteMarker,
      this.config.retry_count,
      this.config.retry_interval_ms
    )
    this.nngSync = new NngSync(
      paths.nngRoot,
      paths.nngRootJson,
      this.orphan,
      this.errorLog,
      this.selfWriteMarker,
      this.config.retry_count,
      this.config.retry_interval_ms
    )
    this.cacheSync = new CacheSync(
      paths.nngRoot,
      paths.cacheIndex,
      paths.cacheIndexJson,
      this.orphan,
      this.errorLog,
      this.selfWriteMarker,
      this.config.retry_count,
      this.config.retry_interval_ms,
      cacheUidExcluded
    )
    this.indexSync = new IndexSync(
      paths.nngRootJson,
      paths.cacheIndexJson,
      this.orphan,
      this.errorLog
    )
    this.nngSync.setCacheSyncHook((nngPath, eventType) => {
      if (eventType === 'created') {
        this.cacheSync.handleNngCreated(nngPath)
      } else {
        this.cacheSync.handleNngModified(nngPath)
      }
    })
    this.handler = new Handler(
      paths.nngRoot,
      paths.cacheIndex,
      paths.cacheInjectionRoot,
      paths.memory,
      this.nngSync,
      this.cacheSync,
      this.memorySync,
      this.indexSync,
      this.selfWriteMarker
    )
    this.startupCheck = new StartupCheck(
      paths.nngRoot,
      paths.cacheIndex,
      // 分层：memory 分散在各 {root}/memory/U{uid}/AI{aiId}/，传 root 递归覆盖全部作用域
      paths.root,
      paths.nngRootJson,
      paths.cacheIndexJson,
      this.errorLog,
      this.nngSync,
      this.cacheSync,
      this.memorySync,
      this.indexSync
    )

    this.errorLog.setRetryHandler(async (entry) => {
      return this.retryEntry(entry)
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.startupTime = nowIso()

    this.errorLog.start()

    // 只订阅 handler 会真正处理的目录（NNG/cache/memory 三类文件的作用域根）：
    // - memory：{root}/memory 递归覆盖所有作用域 U{uid}/AI{aiId}/{normal,meta,high}
    // - NNG：{root}/NNG 内含各作用域 root.json 与 _nng.json（nngRootJson 也在其内）
    // - cache：{root}/cache 内含各作用域 index.json、_cache.json 与 injection 目录
    // 不再订阅 {root} 全树：system-catalog 落档、.file_monitor 配置写入、skills 等无关
    // 事件从源头不产生，风暴判定（batch > STORM_THRESHOLD）只面对真实同步负载。
    await this.subscribePath(this.paths.memory)
    await this.subscribePath(this.paths.nngRoot)
    await this.subscribePath(this.paths.cacheIndex)

    if (this.config.startup_check_async) {
      void this.startupCheck.runFullCheck()
    } else {
      await this.startupCheck.runFullCheck()
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    // 文档 5.5.3：等待当前处理中的任务完成（最多等 5 秒）
    // 先 flush 掉排队中的事件（异步批量改后，pending 可能未处理完）
    if (this.pendingEvents.size > 0) {
      await this.flushPendingEvents()
    }
    const waitStart = Date.now()
    while (this.processingCount > 0 && Date.now() - waitStart < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    this.errorLog.stop()
    for (const sub of this.subscriptions) {
      try {
        await sub.unsubscribe()
      } catch {
        // skip
      }
    }
    this.subscriptions = []

    // 文档 5.5.3：保存监控器状态.json
    this.saveMonitorState()
  }

  private saveMonitorState(): void {
    try {
      const state = {
        启动时间: this.startupTime,
        关闭时间: nowIso(),
        统计: {
          create_events: this.eventStats.create,
          modify_events: this.eventStats.modify,
          delete_events: this.eventStats.delete,
          move_events: this.eventStats.move
        }
      }
      writeFileSync(this.paths.fileMonitorState, JSON.stringify(state, null, 2), 'utf-8')
    } catch {
      // skip
    }
  }

  handleAccessed(path: string): void {
    if (!this.started) return
    try {
      this.handler.handleAccessed(path)
    } catch {
      // skip
    }
  }

  getErrorLog(): ErrorLog {
    return this.errorLog
  }

  getHandler(): Handler {
    return this.handler
  }

  private async subscribePath(path: string): Promise<void> {
    const p = normalizePath(path)
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true })
    }
    try {
      const sub = await subscribe(
        p,
        (err, events) => {
          if (err) {
            this.errorLog.add(`watcher error: ${err.message}`, {
              type: 'custom',
              path: p,
              detail: 'watcher_subscribe'
            })
            return
          }
          this.enqueueEvents(events)
        },
        // 显式指定 Windows 原生后端（ReadDirectoryChangesW），
        // 避免默认先探测 watchman（系统未安装）再回退，消除 "watchman is not recognized" 报错
        { backend: 'windows' }
      )
      this.subscriptions.push(sub)
    } catch (err) {
      this.errorLog.add(`subscribe fail: ${(err as Error).message}`, {
        type: 'custom',
        path: p,
        detail: 'subscribe'
      })
    }
  }

  /**
   * 事件入队（异步批量 + 同路径去重，防事件风暴）：
   * - watcher 回调本身不阻塞事件循环：只入队，由微任务统一处理
   * - 同一路径在风暴中多次触发（NNG↔cache↔memory 互相写回）合并为一次，
   * 避免重复全链路同步 I/O 卡死主进程（曾造成事件循环阻塞 89~114 秒）
   * - 同一批事件按 create > update > delete 优先级合并：create 最强（新建必须全量同步），
   * update 次之（字段修复），delete 最弱（文件已不存在，只走删除清理）
   * - 入队前过滤：只收 handler 会真正处理的事件（NNG/cache/memory/索引，且排除 injection
   * 与 selfWriteMarker 自身写回）。system-catalog 落档、.file_monitor 配置写入等无关事件
   * handler 本来就静默忽略，此前却被计入 batch 触发伪风暴 → 从根源剔除，不入队不计数。
   */
  private enqueueEvents(events: Array<{ path: string; type: string }>): void {
    for (const ev of events) {
      // 类型归一：只收三种同步事件；move 等其他类型原实现不入任何处理分支，直接跳过不入队
      const type = ev.type === 'create' ? 'create' : ev.type === 'update' ? 'update' : ev.type === 'delete' ? 'delete' : null
      if (!type) continue
      // 入队过滤（与 handler 判定同源）：不入队的事件不计入风暴判定、不产生任何处理
      if (!this.handler.isTrackedEvent(ev.path, type)) continue
      const normalized = normalizePath(ev.path)
      const priority = type === 'create' ? 3 : type === 'update' ? 2 : 1
      const existing = this.pendingEvents.get(normalized)
      if (!existing || priority > existing.priority) {
        this.pendingEvents.set(normalized, { path: normalized, type, priority })
      }
    }
    // 已有正在处理/排队的 flush 则不再重复调度（单飞：同时至多一个 flush 在处理，
    // 处理中到达的新事件积压在 pendingEvents，本轮结束后自动续调下一轮）
    if (this.flushScheduled) return
    this.flushScheduled = true
    // 微任务批量处理：当前同步代码块跑完后统一执行，风暴中所有事件合并成一轮
    queueMicrotask(() => {
      void this.flushPendingEvents()
    })
  }

  /**
   * 批量处理待处理事件：
   * - 按文件 mtime 降序（最近变动的先处理——保证最新状态优先落地，
   * 旧事件若与新事件冲突会被后续合并收敛，顺序稳定且结果确定）
   * - 逐条异步处理，每条之间让出事件循环（await setTimeout(0)），
   * 避免大批量事件（如 100+ 记忆文件）同步跑完卡死主进程（曾造成 eventloop 阻塞 15~19s）
   * - 风暴降级：单轮事件数超过 STORM_THRESHOLD 判定为文件风暴
   * （批量脚本/归档迁移等 AI 大动作），逐条处理反而放大乒乓效应
   * （处理→写回→再触发新事件），直接合并为一次全量校准，最终态一致即可
   * - 入队前已过滤 handler 不处理的事件（system-catalog 落档、.file_monitor 配置、injection、
   * selfWriteMarker 自身写回均已剔除），此处的 batch 只承载真实同步负载——
   * 启动期不再被初始化自我写入虚增计数，伪风暴从根源消除。
   */
  private async flushPendingEvents(): Promise<void> {
    try {
      await this.flushPendingEventsOnce()
    } finally {
      // 单飞结束：如果处理期间又有新事件入队（watcher 回调在 await 间隙触发），
      // 自动续调下一轮，保证积压事件不会滞留到下一次事件才处理
      this.flushScheduled = false
      if (this.pendingEvents.size > 0) {
        this.flushScheduled = true
        queueMicrotask(() => {
          void this.flushPendingEvents()
        })
      }
    }
  }

  private async flushPendingEventsOnce(): Promise<void> {
    try {
      if (this.pendingEvents.size === 0) return
      const batch = [...this.pendingEvents.values()]
      this.pendingEvents.clear()
      // 风暴检测：超过阈值合并为全量校准，不再逐条处理
      if (batch.length > PathSyncMonitor.STORM_THRESHOLD) {
        this.processingCount++
        try {
          console.log(`[path-sync] 事件风暴 ${batch.length} 条，合并为全量校准`)
          const stormTimeout = new Promise<void>((resolve) =>
            setTimeout(resolve, PathSyncMonitor.STORM_CHECK_TIMEOUT_MS)
          )
          await Promise.race([this.startupCheck.runFullCheck(), stormTimeout])
        } catch (e) {
          this.errorLog.add(`storm check fail: ${(e as Error).message}`, {
            type: 'custom',
            path: this.paths.nngRoot,
            detail: 'storm_full_check'
          })
        } finally {
          this.processingCount--
        }
        return
      }
      // 排序只做一次磁盘 I/O：先一次性取全部 mtime，再在内存中排序。
      // 之前的实现把 statSync 放进 sort 比较器，O(n log n) 次磁盘 I/O，
      // 路径不存在（delete 事件等）时单次 1-3ms，30 条事件光排序就数百毫秒。
      const withMtime = batch.map((ev) => ({ ev, mtime: this.mtimeOf(ev.path) }))
      withMtime.sort((a, b) => b.mtime - a.mtime)
      for (const { ev } of withMtime) {
        this.processingCount++
        try {
          if (ev.type === 'create') {
            this.eventStats.create++
            this.handler.handleCreated(ev.path)
          } else if (ev.type === 'update') {
            this.eventStats.modify++
            this.handler.handleModified(ev.path)
          } else if (ev.type === 'delete') {
            this.eventStats.delete++
            this.handler.handleDeleted(ev.path)
          }
        } catch (e) {
          this.errorLog.add(`event handle fail: ${(e as Error).message}`, {
            type: 'custom',
            path: ev.path,
            detail: ev.type
          })
        } finally {
          this.processingCount--
        }
        // 每条之间让出事件循环，给 UI/渲染进程呼吸空间。
        // 注意不能用 setTimeout(0)：Windows 上 timer 被系统节流到 ~15.6ms 分辨率，
        // 30 条事件就白白多出 ~450ms（曾实测 [ps-inspect] 每条间隔 15-16ms）。
        // setImmediate 在 Node 里下一轮事件循环回调阶段触发（约 1ms 内），
        // 同样让出主线程，批量事件载入成本趋近与处理本身成正比。
        await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      // 每轮（含风暴分支）都清理一次性标记，防连续风暴/大写入后 marker 泄漏
      // （writeBack 会 add marker，runFullCheck 也能触发，风暴分支此前 return 跳过清理）
      this.cleanupSelfWriteMarker()
    }
  }

  private cleanupSelfWriteMarker(): void {
    if (this.selfWriteMarker.size > PathSyncMonitor.SELF_WRITE_MARKER_MAX_SIZE) {
      this.selfWriteMarker.clear()
    }
  }

  private mtimeOf(path: string): number {
    try {
      return statSync(path).mtimeMs
    } catch {
      return 0
    }
  }

  private async retryEntry(entry: ErrorLogEntry): Promise<boolean> {
    const task = entry.task
    try {
      if (task.type === 'nng_sync') {
        this.nngSync.sync(task.path, 'accessed')
        return true
      }
      if (task.type === 'cache_sync') {
        this.cacheSync.sync(task.path)
        return true
      }
      if (task.type === 'memory_sync') {
        // 重试是补偿不是变动，不触发回填（防重试风暴；回填丢失无害，下次变动会补）
        this.memorySync.sync(task.path, false)
        return true
      }
      if (task.type === 'index_sync') {
        this.indexSync.sync(task.path)
        return true
      }
      if (task.type === 'startup_check') {
        await this.startupCheck.runFullCheck()
        return true
      }
      if (task.type === 'orphan_check') {
        if (task.file_type === 'nng') this.orphan.checkNng(task.path)
        else if (task.file_type === 'cache') this.orphan.checkCache(task.path)
        else if (task.file_type === 'memory') this.orphan.checkMemory(task.path)
        else if (task.file_type === 'index') {
          if (task.path === this.paths.nngRootJson) this.orphan.checkNngRoot(task.path)
          else this.orphan.checkCacheIndex(task.path)
        }
        return true
      }
      if (task.type === 'dmn_crash') {
        return true
      }
      return true
    } catch (err) {
      this.errorLog.add(`retry fail: ${(err as Error).message}`, {
        type: 'custom',
        path: 'path' in task ? task.path : task.dmnId,
        detail: 'retry'
      })
      return false
    }
  }

  private ensureDirs(): void {
    // 只预建全局监视根；三档记忆与 injection 已按作用域分层
    // （{root}/memory/U{uid}/AI{aiId}/{normal,meta,high}、cache/AI{aiId}/U{uid}/injection），
    // 由 scoped 写入方各自创建，这里不再预建顶层目录（2026-09-08 结构统一）
    const dirs = [
      this.paths.memory,
      this.paths.nngRoot,
      this.paths.cacheIndex,
      this.paths.fileMonitor,
      this.paths.fileMonitorCorrupted
    ]
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
    }
  }
}
