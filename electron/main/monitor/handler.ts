/**
 * 为什么存在：单个文件事件可能同时涉及 NNG/Cache/Memory/Index 多个同步域，且同步器自身写回须与外部变更区分（防回环）。
 * 作用：聚合四个同步器统一分发 created/modified/deleted 事件，并维护 selfWriteMarker 跳过自身产生的写事件。
 */

import { existsSync } from 'fs'
import { normalizePath } from '../models/paths'
import { isNngFile, NngSync } from './nng-sync'
import { isCacheFile, CacheSync } from './cache-sync'
import { isMemoryFile, MemorySync } from './memory-sync'
import { IndexSync } from './index-sync'

export class Handler {
  private nngRoot: string
  private cacheIndexRoot: string
  private cacheInjectionRoot: string
  private memoryRoot: string
  private nngSync: NngSync
  private cacheSync: CacheSync
  private memorySync: MemorySync
  private indexSync: IndexSync
  private selfWriteMarker: Set<string>

  constructor(
    nngRoot: string,
    cacheIndexRoot: string,
    cacheInjectionRoot: string,
    memoryRoot: string,
    nngSync: NngSync,
    cacheSync: CacheSync,
    memorySync: MemorySync,
    indexSync: IndexSync,
    selfWriteMarker: Set<string>
  ) {
    this.nngRoot = normalizePath(nngRoot)
    this.cacheIndexRoot = normalizePath(cacheIndexRoot)
    this.cacheInjectionRoot = normalizePath(cacheInjectionRoot)
    this.memoryRoot = normalizePath(memoryRoot)
    this.nngSync = nngSync
    this.cacheSync = cacheSync
    this.memorySync = memorySync
    this.indexSync = indexSync
    this.selfWriteMarker = selfWriteMarker
  }

  /** 判断路径是否在缓存注入目录内（注入文件由系统自身写入，监视器跳过） */
  private isInInjection(p: string): boolean {
    return p.startsWith(this.cacheInjectionRoot + '/')
  }

/**
   * 入队前判定：该事件是否会被本 handler 真正处理（供监视器入队过滤使用）。

   * 语义与 handleCreated / handleModified / handleDeleted 的判定完全同源：
   * - injection 目录事件：系统自身写入，handler 一律跳过 → 不入队
   * - selfWriteMarker 命中：自身写回，handler 只消费标记不处理内容 → 不入队（标记在此消费）
   * - 类型范围：仅 NNG / cache / memory / 索引文件会被 handler 处理，
   * system-catalog 落档、.file_monitor 配置写入等无关事件 handler 静默 return → 不入队
   * - delete 特例：handler 只处理后缀 _nng.json / _cache.json（memory delete 无动作）

   * 目的：风暴判定（batch > STORM_THRESHOLD）只面对 handler 真正会处理的事件，
   * 启动期 system-catalog 落档、主动校准写回等"初始化自我写入"不再虚增计数，
   * 从根源消除启动伪风暴日志与多余的全量校准，而非用宽限期掩盖。
   */
  isTrackedEvent(path: string, type: 'create' | 'update' | 'delete'): boolean {
    const p = normalizePath(path)
    if (this.isInInjection(p)) return false
    if (this.selfWriteMarker.has(p)) {
      this.selfWriteMarker.delete(p)
      return false
    }
    if (this.indexSync.isIndexFile(p)) {
      // handler 对 index 的 create 直接 return（无动作），update/delete 会走 indexSync
      return type !== 'create'
    }
    if (type === 'delete') {
      return p.endsWith('_nng.json') || p.endsWith('_cache.json')
    }
    return (
      isNngFile(p, this.nngRoot) ||
      isCacheFile(p, this.cacheIndexRoot) ||
      isMemoryFile(p, this.memoryRoot)
    )
  }

  handleCreated(path: string): void {
    const p = normalizePath(path)
    if (this.isInInjection(p)) return
    if (this.selfWriteMarker.has(p)) {
      this.selfWriteMarker.delete(p)
      return
    }
    if (this.indexSync.isIndexFile(p)) return
    if (isNngFile(p, this.nngRoot)) {
      this.nngSync.sync(p, 'created')
      return
    }
    if (isCacheFile(p, this.cacheIndexRoot)) {
      this.cacheSync.sync(p)
      return
    }
    if (isMemoryFile(p, this.memoryRoot)) {
      this.memorySync.sync(p)
      return
    }
  }

  handleModified(path: string): void {
    const p = normalizePath(path)
    if (this.isInInjection(p)) return
    if (this.selfWriteMarker.has(p)) {
      this.selfWriteMarker.delete(p)
      return
    }
    if (this.indexSync.isIndexFile(p)) {
      this.indexSync.handleModified(p)
      return
    }
    if (isNngFile(p, this.nngRoot)) {
      try {
        if (existsSync(p)) {
          this.nngSync.sync(p, 'modified')
        } else {
          this.nngSync.handleDeleted(p)
          this.cacheSync.handleDeleted(this.nngPathToCachePath(p))
        }
      } catch {
        if (!existsSync(p)) {
          this.nngSync.handleDeleted(p)
          this.cacheSync.handleDeleted(this.nngPathToCachePath(p))
        }
      }
      return
    }
    if (isCacheFile(p, this.cacheIndexRoot)) {
      try {
        if (existsSync(p)) {
          this.cacheSync.sync(p)
        } else {
          this.cacheSync.handleDeleted(p)
        }
      } catch {
        if (!existsSync(p)) {
          this.cacheSync.handleDeleted(p)
        }
      }
      return
    }
    if (isMemoryFile(p, this.memoryRoot)) {
      try {
        if (existsSync(p)) {
          this.memorySync.sync(p)
          this.cacheSync.triggerRewriteForMemory(p)
        }
      } catch {
        // TOCTOU: 文件在检查后被删除，忽略
      }
      return
    }
  }

  handleDeleted(path: string): void {
    const p = normalizePath(path)
    if (this.isInInjection(p)) return
    if (this.selfWriteMarker.has(p)) {
      this.selfWriteMarker.delete(p)
      return
    }
    if (this.indexSync.isIndexFile(p)) {
      this.indexSync.handleDeleted(p)
      return
    }
    if (p.endsWith('_nng.json')) {
      this.nngSync.handleDeleted(p)
      const cachePath = this.nngPathToCachePath(p)
      this.cacheSync.handleDeleted(cachePath)
      return
    }
    if (p.endsWith('_cache.json')) {
      this.cacheSync.handleDeleted(p)
      return
    }
  }

  handleAccessed(path: string): void {
    const p = normalizePath(path)
    if (this.isInInjection(p)) return
    if (this.selfWriteMarker.has(p)) {
      this.selfWriteMarker.delete(p)
      return
    }
    if (this.indexSync.isIndexFile(p)) {
      if (existsSync(p)) {
        this.indexSync.sync(p)
      }
      return
    }
    if (isNngFile(p, this.nngRoot)) {
      if (existsSync(p)) {
        this.nngSync.sync(p, 'accessed')
      }
      return
    }
    if (isCacheFile(p, this.cacheIndexRoot)) {
      if (existsSync(p)) {
        this.cacheSync.sync(p)
      }
      return
    }
    if (isMemoryFile(p, this.memoryRoot)) {
      if (existsSync(p)) {
        this.memorySync.sync(p)
      }
      return
    }
  }

/**
   * NNG 删除时映射对应 cache 路径（重构：一级目录基准映射）。
   * NNG/AI{aiId}/U{uid}/root/{rel}/{name}_nng.json → cache/AI{aiId}/U{uid}/index/{rel}/{name}_cache.json
   */
  private nngPathToCachePath(nngPath: string): string {
    const np = normalizePath(nngPath)
    const m = np.match(/^(.+\/NNG\/AI\d+\/U\d+)(?:\/|$)/)
    if (!m) return np
    const scopeNng = m[1]
    const level1 = `${scopeNng}/root`
    if (!np.startsWith(level1 + '/')) return np
    const rel = np.slice(level1.length + 1)
    const fileName = rel.split('/').pop() ?? ''
    const cacheFileName = `${fileName.replace(/_nng\.json$/, '')}_cache.json`
    const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    const scopeCache = scopeNng.replace(/\/NNG(\/AI\d+\/U\d+)$/, '/cache$1')
    return relDir.length === 0
      ? `${scopeCache}/index/${cacheFileName}`
      : `${scopeCache}/index/${relDir}/${cacheFileName}`
  }
}
