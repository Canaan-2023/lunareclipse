/**
 * 为什么存在：cache 是给 AI 的带容量上限的派生视图（截断/折叠），NNG 记忆每变一次就需同步派生并更新索引，否则视图过期。
 * 作用：对 created/modified/deleted 事件执行 NNG↔cache 路径换算、内容截断、索引维护、孤儿清理与错误重试。
 * 不删掉的理由：缓存与 NNG 保持镜像同构是 ABYSS 检索线的关键前提（查缓存=查 NNG 的精简版），
 * 无同步器则缓存漂移、AI 读到过期/孤儿条目；本文件是缓存与索引一致性的维护者。
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'fs'
import { dirname, basename, join } from 'path'
import type { NNG } from '../models/nng'
import type { Cache } from '../models/cache'
import {
  buildCacheSiblingFolder,
  shouldTruncate,
  truncateContent,
  readMemory,
  buildCacheMemoryEntry
} from '../models/cache'
import { normalizePath } from '../models/paths'
import { upsertCacheIndexEntry, removeCacheIndexEntry } from '../models/index-files'
import { nowIso } from '../models/memory'
import { OrphanCheck } from './orphan-check'
import { ErrorLog } from './error-log'
import {
  scopeCacheRootFor,
  scopeCacheLevel1DirFor,
  scopeCacheIndexJsonFor,
  nngToCachePath,
  cacheToNngPath,
  uidOfScopePath
} from './cache-sync-paths'

export { isCacheFile, uidOfScopePath, buildCachePathFromNng } from './cache-sync-paths'

export class CacheSync {
  private nngRoot: string
  private cacheIndexRoot: string
  private cacheIndexJson: string
  private orphan: OrphanCheck
  private errorLog: ErrorLog
  private selfWriteMarker: Set<string>
  private retryCount: number
  private retryIntervalMs: number
  private readonly isUidExcluded?: (uid: number) => boolean

  constructor(
    nngRoot: string,
    cacheIndexRoot: string,
    cacheIndexJson: string,
    orphan: OrphanCheck,
    errorLog: ErrorLog,
    selfWriteMarker: Set<string>,
    retryCount = 3,
    retryIntervalMs = 100,
    isUidExcluded?: (uid: number) => boolean
  ) {
    this.nngRoot = normalizePath(nngRoot)
    this.cacheIndexRoot = normalizePath(cacheIndexRoot)
    this.cacheIndexJson = normalizePath(cacheIndexJson)
    this.orphan = orphan
    this.errorLog = errorLog
    this.selfWriteMarker = selfWriteMarker
    this.retryCount = retryCount
    this.retryIntervalMs = retryIntervalMs
    this.isUidExcluded = isUidExcluded
  }

  /** 主系统分账号排除：该 uid 的 cache 由分系统派生后同步过来，本机不生成/不校验/不重写（信任镜像）。非主系统（分系统/单机）不传谓词，全部处理。 */
  private isExcludedUid(path: string): boolean {
    if (!this.isUidExcluded) return false
    const uid = uidOfScopePath(path)
    return uid !== null && this.isUidExcluded(uid)
  }

  handleNngCreated(nngPath: string): void {
    if (this.isExcludedUid(nngPath)) return
    const p = normalizePath(nngPath)
    if (!p.endsWith('_nng.json')) return
    if (!existsSync(p)) return
    const cachePath = nngToCachePath(p, this.nngRoot, this.cacheIndexRoot)
    if (!cachePath) return
    this.ensureCacheFileAndSibling(cachePath)
    this.rewriteFromNng(p, cachePath, true)
    this.upsertCacheIndex(cachePath)
    this.orphan.checkCache(cachePath)
  }

  handleNngModified(nngPath: string): void {
    if (this.isExcludedUid(nngPath)) return
    const p = normalizePath(nngPath)
    if (!p.endsWith('_nng.json')) return
    if (!existsSync(p)) return
    const cachePath = nngToCachePath(p, this.nngRoot, this.cacheIndexRoot)
    if (!cachePath) return
    if (!existsSync(cachePath)) {
      this.handleNngCreated(p)
      return
    }
    this.rewriteFromNng(p, cachePath, false)
    this.upsertCacheIndex(cachePath)
    this.orphan.checkCache(cachePath)
  }

  sync(path: string): void {
    if (this.isExcludedUid(path)) return
    const p = normalizePath(path)
    if (!p.endsWith('_cache.json')) return
    if (!existsSync(p)) {
      // 防御：cache 文件缺失（误删/幽灵目录清理后）→ 从 NNG 镜像重建（缓存是 NNG 的镜像）
      // 否则缺失的镜像永远无法自愈，index.json 索引也会随之丢失
      const nngPath = cacheToNngPath(p, this.nngRoot, this.cacheIndexRoot)
      if (nngPath && existsSync(nngPath)) {
        this.rewriteFromNng(nngPath, p, true)
        const dir = dirname(p).replace(/\\\\/g, '/')
        if (dir === scopeCacheLevel1DirFor(p, this.cacheIndexRoot)) {
          this.upsertCacheIndex(p)
        }
        this.orphan.checkCache(p)
      }
      return
    }
    // 防御：路径是目录（历史 bug 产生的幽灵目录）→ 空目录直接删除后跳过，避免 EISDIR 刷屏
    try {
      const st = statSync(p)
      if (st.isDirectory()) {
        const entries = readdirSync(p)
        if (entries.length === 0) {
          this.selfWriteMarker.add(p)
          rmdirSync(p)
        }
        return
      }
    } catch {
      // stat 失败则继续走正常逻辑
    }
    let cache: Cache
    let mtime: number
    try {
      const raw = readFileSync(p, 'utf-8')
      cache = JSON.parse(raw) as Cache
      mtime = statSync(p).mtimeMs
    } catch (err) {
      // 文档 4.4.8/4.5.2：任何缓存问题直接镜像同步——JSON 解析失败时隔离损坏文件 + 从 NNG 重写
      this.errorLog.add(`cache_sync read fail (mirror from nng): ${(err as Error).message}`, {
        type: 'cache_sync',
        path: p
      })
      this.orphan.quarantineCorrupted(p)
      this.rewriteFromNngByCachePath(p)
      return
    }

    // 孤儿缓存清理：缓存是 NNG 的镜像，若对应 NNG 不存在
    // （NNG 被整目录删除/移动、或创建失败时 watcher 未捕获 delete 事件），
    // 缓存即成无源孤儿，应清理删除（删文件+空目录+index 条目）而非保留。
    // 只对"合法可解析"的 cache 判定：损坏文件走上方隔离路径，保留现场。
    const mirrorNng = cacheToNngPath(p, this.nngRoot, this.cacheIndexRoot)
    if (mirrorNng && !existsSync(mirrorNng)) {
      this.errorLog.add(`cache_sync orphan cache (no matching nng): ${p}`, {
        type: 'cache_sync',
        path: p
      })
      this.handleDeleted(p)
      return
    }

    // 文档 4.4.8/4.5.2：任何缓存问题直接镜像同步——字段缺失/类型错误时从 NNG 重写（不再补默认值）
    const needsRewrite =
      !cache.自身路径 ||
      cache.自身路径 !== p ||
      !Array.isArray(cache.关联记忆) ||
      !Array.isArray(cache.上级缓存) ||
      !Array.isArray(cache.下级缓存) ||
      !Array.isArray(cache.归档记录)

    if (needsRewrite) {
      this.errorLog.add(`cache_sync field invalid (mirror from nng): ${p}`, {
        type: 'cache_sync',
        path: p
      })
      this.rewriteFromNngByCachePath(p)
      return
    }

    let changed = false
    this.ensureSiblingFolderParent(p, cache, () => {
      changed = true
    })
    this.ensureSiblingFolderChildren(p, cache, () => {
      changed = true
    })
    this.syncCrossFolderUpper(p, cache)
    this.syncCrossFolderLower(p, cache)

    if (changed) {
      this.writeBack(p, cache, mtime)
    }

    // 一级缓存：兜底同步 cache/index.json 的描述（确保 index 描述与 cache 文件一致，
    // 覆盖启动扫描/崩溃恢复等场景；handleNngCreated/Modified 已是主路径）
    const dir = dirname(p).replace(/\\/g, '/')
    if (dir === scopeCacheLevel1DirFor(p, this.cacheIndexRoot)) {
      this.upsertCacheIndex(p)
    }

    // 文档 4.4.8/4.5.2：孤立审查发现引用缺失也属于"缓存问题"，直接镜像同步
    const orphanResult = this.orphan.checkCache(p)
    if (orphanResult.changed) {
      this.errorLog.add(`cache_sync orphan check changed (mirror from nng): ${p}`, {
        type: 'cache_sync',
        path: p
      })
      this.rewriteFromNngByCachePath(p)
    }
  }

  handleDeleted(path: string): void {
    const p = normalizePath(path)
    if (!p.endsWith('_cache.json')) return

    // 文档 4.4.8/4.5.2：镜像同步——NNG 删除/移动时，cache 必须跟随删除（不留孤儿）
    // 删除 cache 文件本身
    if (existsSync(p)) {
      try {
        this.selfWriteMarker.add(p)
        unlinkSync(p)
      } catch (err) {
        this.errorLog.add(`cache_sync delete file fail: ${(err as Error).message}`, {
          type: 'cache_sync',
          path: p
        })
      }
    }

    // 删除同名文件夹（仅在为空时删除，避免误删下级 cache）
    const dir = dirname(p).replace(/\\/g, '/')
    const baseName = basename(p).replace(/_cache\.json$/, '')
    const siblingFolder = join(dir, baseName).replace(/\\/g, '/')
    if (existsSync(siblingFolder)) {
      try {
        const entries = readdirSync(siblingFolder)
        if (entries.length === 0) {
          rmdirSync(siblingFolder)
        }
      } catch {
        // 非空或无权限，跳过（StartupCheck 会兜底清理）
      }
    }

    // 删除 cache/index.json 索引条目（仅一级缓存）
    const scopeCacheIndexJson = scopeCacheIndexJsonFor(p, this.cacheIndexRoot, this.cacheIndexJson)
    const isLevel1 = dir === scopeCacheLevel1DirFor(p, this.cacheIndexRoot)
    if (isLevel1) {
      const name = baseName
      try {
        // 防回环：删 index.json 条目前打 marker
        this.selfWriteMarker.add(scopeCacheIndexJson)
        removeCacheIndexEntry(scopeCacheIndexJson, name)
      } catch (err) {
        this.errorLog.add(`cache_sync delete index fail: ${(err as Error).message}`, {
          type: 'cache_sync',
          path: p
        })
      }
    }
  }

  triggerRewriteForMemory(memoryPath: string): void {
    if (this.isExcludedUid(memoryPath)) return
    const mp = normalizePath(memoryPath)
    if (!existsSync(mp)) return
    // 文档 4.4.7：记忆修改触发缓存重写
    // 从记忆文件的关联NNG字段获取关联的 NNG 路径，重写对应缓存（镜像同步）
    let mem: { 关联NNG?: string[] }
    try {
      mem = JSON.parse(readFileSync(mp, 'utf-8')) as { 关联NNG?: string[] }
    } catch {
      return
    }
    const nngPaths = mem.关联NNG ?? []
    for (const nngPath of nngPaths) {
      const np = normalizePath(nngPath)
      if (!existsSync(np)) continue
      const cachePath = nngToCachePath(np, this.nngRoot, this.cacheIndexRoot)
      if (cachePath && existsSync(cachePath)) {
        this.rewriteFromNng(np, cachePath, false)
      }
    }
  }

  /**
   * 文档 4.4.8/4.5.2：从缓存路径反推 NNG 路径，触发镜像重建
   * 用于 cache 文件自身损坏/字段缺失/孤立审查 changed 等任何"缓存问题"场景
   */
  private rewriteFromNngByCachePath(cachePath: string): void {
    const nngPath = cacheToNngPath(cachePath, this.nngRoot, this.cacheIndexRoot)
    if (!nngPath || !existsSync(nngPath)) {
      // 对应 NNG 不存在，无法镜像重建，仅隔离已无效（quarantineCorrupted 已在调用方处理）
      return
    }
    const isCreate = !existsSync(cachePath)
    this.rewriteFromNng(nngPath, cachePath, isCreate)
    // 重建后兜底同步索引
    const dir = dirname(cachePath).replace(/\\/g, '/')
    if (dir === scopeCacheLevel1DirFor(cachePath, this.cacheIndexRoot)) {
      this.upsertCacheIndex(cachePath)
    }
    // 重建后再次孤立审查，确保新文件引用也都有效
    this.orphan.checkCache(cachePath)
  }

  /**
   * 缓存路径反推 NNG 路径实现已抽至 cache-sync-paths.ts（cacheToNngPath 纯函数）
   */

  private rewriteFromNng(nngPath: string, cachePath: string, isCreate: boolean): void {
    let nng: NNG
    try {
      nng = JSON.parse(readFileSync(nngPath, 'utf-8')) as NNG
    } catch (err) {
      this.errorLog.add(`cache_sync read nng fail: ${(err as Error).message}`, {
        type: 'cache_sync',
        path: nngPath
      })
      return
    }

    // 文档 4.4.7：保留现有 上级缓存/下级缓存 字段值（这两个字段不照搬 NNG，是缓存自己的，由 4.4.5 上下级识别独立维护）
    let existingUpper: string[] = []
    let existingLower: string[] = []
    if (!isCreate && existsSync(cachePath)) {
      try {
        const oldCache = JSON.parse(readFileSync(cachePath, 'utf-8')) as Cache
        existingUpper = Array.isArray(oldCache.上级缓存) ? oldCache.上级缓存 : []
        existingLower = Array.isArray(oldCache.下级缓存) ? oldCache.下级缓存 : []
      } catch {
        // skip（缓存损坏时 existingUpper/Lower 为空，由 4.4.5 上下级识别重新补齐）
      }
    }

    const cache: Cache = {
      自身路径: cachePath,
      描述: nng.描述 ?? '',
      关联记忆: [],
      上级缓存: existingUpper,
      下级缓存: existingLower,
      归档记录: Array.isArray(nng.归档记录) ? nng.归档记录 : []
    }

    // 文档 4.4.7：关联记忆 = 把 NNG.关联记忆 里每个 记忆路径 替换为精简内容快照
    // AI 只在 NNG 填路径，同步器把路径展开为 CacheMemoryEntry（只含 用户原话/AI回复/关联文件/备注，描述不带）
    // 描述 字段不进 cache（AI 需要时去 NNG 查）
    for (const ref of nng.关联记忆 ?? []) {
      const memPath = normalizePath(ref.记忆路径)
      const mem = readMemory(memPath)
      if (mem) {
        cache.关联记忆.push(buildCacheMemoryEntry(mem))
      }
    }

    this.applyCharLimit(cache)
    this.ensureSiblingFolderParent(cachePath, cache, () => {})
    this.ensureSiblingFolderChildren(cachePath, cache, () => {})
    this.syncCrossFolderUpper(cachePath, cache)
    this.syncCrossFolderLower(cachePath, cache)

    if (existsSync(cachePath)) {
      this.writeBack(cachePath, cache, statSync(cachePath).mtimeMs)
    } else {
      try {
        mkdirSync(dirname(cachePath), { recursive: true })
        this.selfWriteMarker.add(cachePath)
        writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
      } catch (err) {
        this.errorLog.add(`cache_sync create write fail: ${(err as Error).message}`, {
          type: 'cache_sync',
          path: cachePath
        })
      }
    }
  }

  /**
   * 为什么存在：cache 是带容量上限（CACHE_CHAR_LIMIT）的 AI 派生视图，
   * 超限会让单文件过大拖慢 AI 读取与索引加载，因此重写镜像时必须压缩内容。
   * 作用：对镜像写回前的 cache.关联记忆 逐字段截断超长文本（truncateContent），
   * 保证总字符量回落到限制之内；是否超限由 shouldTruncate 判定，本函数只执行截断。
   */
  private applyCharLimit(cache: Cache): void {
    if (!shouldTruncate(cache)) return
    for (const entry of cache.关联记忆) {
      if (typeof entry.用户原话 === 'string') {
        entry.用户原话 = truncateContent(entry.用户原话)
      } else if (Array.isArray(entry.用户原话)) {
        entry.用户原话 = entry.用户原话.map((s) => truncateContent(String(s)))
      }
      if (typeof entry.AI回复 === 'string') {
        entry.AI回复 = truncateContent(entry.AI回复)
      }
      if (typeof entry.精炼内容 === 'string') {
        entry.精炼内容 = truncateContent(entry.精炼内容)
      }
    }
  }

  /**
   * NNG 路径 → cache 路径实现已抽至 cache-sync-paths.ts（nngToCachePath 纯函数）
   */

  private ensureCacheFileAndSibling(cachePath: string): void {
    try {
      mkdirSync(dirname(cachePath), { recursive: true })
      // 防御：目标文件路径若被历史 bug 产生的同名目录占用，先清理（只删空目录，避免误删下级缓存）
      if (existsSync(cachePath)) {
        try {
          const st = statSync(cachePath)
          if (st.isDirectory()) {
            const entries = readdirSync(cachePath)
            if (entries.length === 0) {
              rmdirSync(cachePath)
            }
          }
        } catch {
          // stat/readdir 失败则跳过，不阻塞后续
        }
      }
      const siblingFolder = buildCacheSiblingFolder(scopeCacheRootFor(cachePath, this.cacheIndexRoot), cachePath)
      const correctedSibling = siblingFolder.replace(/\\/g, '/')
      if (!existsSync(correctedSibling)) {
        mkdirSync(correctedSibling, { recursive: true })
      }
    } catch (err) {
      this.errorLog.add(`cache_sync mkdir fail: ${(err as Error).message}`, {
        type: 'cache_sync',
        path: cachePath
      })
    }
  }

  private ensureSiblingFolderParent(
    cachePath: string,
    cache: Cache,
    markChanged: () => void
  ): void {
    const dir = dirname(cachePath).replace(/\\/g, '/')
    if (dir === scopeCacheLevel1DirFor(cachePath, this.cacheIndexRoot)) return
    const parentDir = dirname(dir)
    const folderName = basename(dir)
    const parentCachePath = `${parentDir}/${folderName}_cache.json`
    if (!existsSync(parentCachePath)) return
    if (!cache.上级缓存.includes(parentCachePath)) {
      cache.上级缓存.push(parentCachePath)
      markChanged()
    }
    try {
      const raw = readFileSync(parentCachePath, 'utf-8')
      const parent = JSON.parse(raw) as Cache
      let parentChanged = false
      if (!Array.isArray(parent.下级缓存)) {
        parent.下级缓存 = []
        parentChanged = true
      }
      if (!parent.下级缓存.includes(cachePath)) {
        parent.下级缓存.push(cachePath)
        parentChanged = true
      }
      if (parentChanged) {
        this.writeBack(parentCachePath, parent, statSync(parentCachePath).mtimeMs)
      }
    } catch (err) {
      this.errorLog.add(`cache_sync parent sync fail: ${(err as Error).message}`, {
        type: 'cache_sync',
        path: parentCachePath
      })
    }
  }

  private ensureSiblingFolderChildren(
    cachePath: string,
    cache: Cache,
    markChanged: () => void
  ): void {
    const dir = dirname(cachePath)
    const baseName = basename(cachePath).replace(/_cache\.json$/, '')
    const siblingFolder = join(dir, baseName).replace(/\\/g, '/')
    if (!existsSync(siblingFolder)) return
    let entries: string[] = []
    try {
      entries = readdirSync(siblingFolder)
    } catch (err) {
      this.errorLog.add(`cache_sync readdir children fail: ${(err as Error).message}`, {
        type: 'cache_sync',
        path: siblingFolder
      })
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('_cache.json')) continue
      const childPath = join(siblingFolder, entry).replace(/\\/g, '/')
      if (!cache.下级缓存.includes(childPath)) {
        cache.下级缓存.push(childPath)
        markChanged()
      }
      if (!existsSync(childPath)) continue
      try {
        const raw = readFileSync(childPath, 'utf-8')
        const child = JSON.parse(raw) as Cache
        let childChanged = false
        if (!Array.isArray(child.上级缓存)) {
          child.上级缓存 = []
          childChanged = true
        }
        if (!child.上级缓存.includes(cachePath)) {
          child.上级缓存.push(cachePath)
          childChanged = true
        }
        if (childChanged) {
          this.writeBack(childPath, child, statSync(childPath).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`cache_sync child sync fail: ${(err as Error).message}`, {
          type: 'cache_sync',
          path: childPath
        })
      }
    }
  }

  private syncCrossFolderUpper(cachePath: string, cache: Cache): void {
    const refs = [...(cache.上级缓存 ?? [])]
    const siblingParent = this.findSiblingParent(cachePath)
    for (const targetPath of refs) {
      const t = normalizePath(targetPath)
      if (t === siblingParent) continue
      if (!existsSync(t)) continue
      try {
        const raw = readFileSync(t, 'utf-8')
        const target = JSON.parse(raw) as Cache
        let targetChanged = false
        if (!Array.isArray(target.下级缓存)) {
          target.下级缓存 = []
          targetChanged = true
        }
        if (!target.下级缓存.includes(cachePath)) {
          target.下级缓存.push(cachePath)
          targetChanged = true
        }
        if (targetChanged) {
          this.writeBack(t, target, statSync(t).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`cache_sync cross upper fail: ${(err as Error).message}`, {
          type: 'cache_sync',
          path: t
        })
      }
    }
  }

  private syncCrossFolderLower(cachePath: string, cache: Cache): void {
    const refs = [...(cache.下级缓存 ?? [])]
    for (const targetPath of refs) {
      const t = normalizePath(targetPath)
      if (!existsSync(t)) continue
      try {
        const raw = readFileSync(t, 'utf-8')
        const target = JSON.parse(raw) as Cache
        let targetChanged = false
        if (!Array.isArray(target.上级缓存)) {
          target.上级缓存 = []
          targetChanged = true
        }
        if (!target.上级缓存.includes(cachePath)) {
          target.上级缓存.push(cachePath)
          targetChanged = true
        }
        if (targetChanged) {
          this.writeBack(t, target, statSync(t).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`cache_sync cross lower fail: ${(err as Error).message}`, {
          type: 'cache_sync',
          path: t
        })
      }
    }
  }

  private findSiblingParent(cachePath: string): string | null {
    const dir = dirname(cachePath).replace(/\\/g, '/')
    if (dir === scopeCacheLevel1DirFor(cachePath, this.cacheIndexRoot)) return null
    const parentDir = dirname(dir)
    const folderName = basename(dir)
    return `${parentDir}/${folderName}_cache.json`
  }

  private upsertCacheIndex(cachePath: string): void {
    // 只有一级缓存（直接位于一级缓存目录下）才进 cache/index.json 索引
    const dir = dirname(cachePath).replace(/\\/g, '/')
    const scopeCacheLevel1Dir = scopeCacheLevel1DirFor(cachePath, this.cacheIndexRoot)
    const scopeCacheIndexJson = scopeCacheIndexJsonFor(cachePath, this.cacheIndexRoot, this.cacheIndexJson)
    if (dir !== scopeCacheLevel1Dir) return
    try {
      const name = basename(cachePath).replace(/_cache\.json$/, '')
      // 描述来源链路：AI 只在 NNG 文件自身写描述 → rewriteFromNng 把 NNG 描述镜像到 cache 文件
      // → 这里从 cache 文件自身读描述填入 index.json（cache 是 NNG 的镜像，描述已在其中）
      // 任何 AI 都不直接写 cache/index.json 的描述字段，全由监控器从一级 cache 文件镜像
      let desc = ''
      try {
        const cache = JSON.parse(readFileSync(cachePath, 'utf-8')) as Cache
        desc = cache.描述 ?? ''
      } catch {
        // cache 文件读失败时描述留空，不阻塞索引更新
      }
      // 防回环：写 index.json 前打 marker，避免写回触发 watcher → indexSync → orphan 检查的重复链路
      this.selfWriteMarker.add(scopeCacheIndexJson)
      upsertCacheIndexEntry(scopeCacheIndexJson, {
        name,
        path: cachePath,
        描述: desc,
        last_modified: nowIso()
      })
    } catch (err) {
      this.errorLog.add(`cache_sync index upsert fail: ${(err as Error).message}`, {
        type: 'cache_sync',
        path: cachePath
      })
    }
  }

  private writeBack(path: string, cache: Cache, mtimeBefore: number): boolean {
    try {
      const currentMtime = statSync(path).mtimeMs
      if (currentMtime !== mtimeBefore) {
        return false
      }
      this.selfWriteMarker.add(path)
      writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8')
      return true
    } catch (err) {
      if (this.retryCount > 0) {
        for (let i = 0; i < this.retryCount; i++) {
          this.sleepSync(this.retryIntervalMs)
          try {
            const mtime = statSync(path).mtimeMs
            if (mtime !== mtimeBefore) continue
            this.selfWriteMarker.add(path)
            writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8')
            return true
          } catch {
            // continue retry
          }
        }
      }
      this.errorLog.add(`cache_sync write fail: ${(err as Error).message}`, {
        type: 'cache_sync',
        path
      })
      return false
    }
  }

  private sleepSync(ms: number): void {
    const buf = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(buf, 0, 0, ms)
  }
}
