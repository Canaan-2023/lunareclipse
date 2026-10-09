/**
 * 为什么存在：崩溃或异常写入会让索引指向不存在的文件或留下无主文件，影响 AI 行为一致性，需一致性核对。
 * 作用：核对 NNG/cache/memory 索引与实际文件：移除孤儿引用、删除无主文件，损坏文件移入 corrupted 目录（可配置）而非直接删除。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import type { NNG, NngMemoryRef } from '../models/nng'
import type { Cache, CacheMemoryEntry } from '../models/cache'
import type { Memory } from '../models/memory'
import {
  readNngRoot,
  writeNngRoot,
  readCacheIndex,
  writeCacheIndex
} from '../models/index-files'
import { normalizePath } from '../models/paths'

export interface OrphanCheckResult {
  changed: boolean
  removed: string[]
}

export class OrphanCheck {
  /**
   * 修复（事件风暴根断）：orphan 检查写回修复文件时如果不打 selfWriteMarker，
   * 写回会触发新的 watcher 事件 → 再次进入 sync → orphan 再次判定缺失 → 再次写回，
   * 形成确定性死循环（记忆流水线批量建记忆时引用短暂不一致即点燃，曾造成事件循环阻塞 89~114 秒）。
   * 现在所有写回前先 add marker，让 handler 消费掉自身写回产生的事件，从根上断循环。
   */
  private selfWriteMarker: Set<string>

  constructor(private corruptedDir: string = '', selfWriteMarker?: Set<string>) {
    this.selfWriteMarker = selfWriteMarker ?? new Set()
  }

  setCorruptedDir(dir: string): void {
    this.corruptedDir = dir
  }

  checkNng(path: string): OrphanCheckResult {
    if (!existsSync(path)) {
      return { changed: false, removed: [] }
    }
    let nng: NNG
    try {
      nng = JSON.parse(readFileSync(path, 'utf-8')) as NNG
    } catch {
      return { changed: false, removed: [] }
    }
    const removed: string[] = []
    let changed = false

    const newRefs: NngMemoryRef[] = []
    for (const ref of nng.关联记忆 ?? []) {
      const target = normalizePath(ref.记忆路径)
      if (existsSync(target)) {
        newRefs.push(ref)
      } else {
        removed.push(ref.记忆路径)
        changed = true
      }
    }
    if (changed) {
      nng.关联记忆 = newRefs
    }

    const newUpper: string[] = []
    for (const p of nng.上级NNG ?? []) {
      const t = normalizePath(p)
      if (existsSync(t)) {
        newUpper.push(p)
      } else {
        removed.push(p)
        changed = true
      }
    }
    if (newUpper.length !== (nng.上级NNG ?? []).length) {
      nng.上级NNG = newUpper
    }

    const newLower: string[] = []
    for (const p of nng.下级NNG ?? []) {
      const t = normalizePath(p)
      if (existsSync(t)) {
        newLower.push(p)
      } else {
        removed.push(p)
        changed = true
      }
    }
    if (newLower.length !== (nng.下级NNG ?? []).length) {
      nng.下级NNG = newLower
    }

    if (changed) {
      this.selfWriteMarker.add(path)
      writeFileSync(path, JSON.stringify(nng, null, 2), 'utf-8')
    }
    return { changed, removed }
  }

  checkCache(path: string): OrphanCheckResult {
    if (!existsSync(path)) {
      return { changed: false, removed: [] }
    }
    let cache: Cache
    try {
      cache = JSON.parse(readFileSync(path, 'utf-8')) as Cache
    } catch {
      return { changed: false, removed: [] }
    }
    const removed: string[] = []
    let changed = false

    const newUpper: string[] = []
    for (const p of cache.上级缓存 ?? []) {
      const t = normalizePath(p)
      if (existsSync(t)) {
        newUpper.push(p)
      } else {
        removed.push(p)
        changed = true
      }
    }
    if (newUpper.length !== (cache.上级缓存 ?? []).length) {
      cache.上级缓存 = newUpper
    }

    const newLower: string[] = []
    for (const p of cache.下级缓存 ?? []) {
      const t = normalizePath(p)
      if (existsSync(t)) {
        newLower.push(p)
      } else {
        removed.push(p)
        changed = true
      }
    }
    if (newLower.length !== (cache.下级缓存 ?? []).length) {
      cache.下级缓存 = newLower
    }

    const newRefs: CacheMemoryEntry[] = []
    for (const entry of cache.关联记忆 ?? []) {
      // 孤立审查检查 记忆路径 是否还存在；不存在则移除
      const target = normalizePath(entry.记忆路径 ?? '')
      if (target && existsSync(target)) {
        newRefs.push(entry)
      } else {
        removed.push(entry.记忆路径 ?? '')
        changed = true
      }
    }
    if (newRefs.length !== (cache.关联记忆 ?? []).length) {
      cache.关联记忆 = newRefs
    }

    if (changed) {
      this.selfWriteMarker.add(path)
      writeFileSync(path, JSON.stringify(cache, null, 2), 'utf-8')
    }
    return { changed, removed }
  }

  checkMemory(path: string): OrphanCheckResult {
    if (!existsSync(path)) {
      return { changed: false, removed: [] }
    }
    let mem: Memory
    try {
      mem = JSON.parse(readFileSync(path, 'utf-8')) as Memory
    } catch {
      return { changed: false, removed: [] }
    }
    const removed: string[] = []
    let changed = false

    const newAssoc: string[] = []
    for (const p of mem.关联NNG ?? []) {
      const t = normalizePath(p)
      if (existsSync(t)) {
        newAssoc.push(p)
      } else {
        removed.push(p)
        changed = true
      }
    }
    if (newAssoc.length !== (mem.关联NNG ?? []).length) {
      mem.关联NNG = newAssoc
    }

    if (changed) {
      this.selfWriteMarker.add(path)
      writeFileSync(path, JSON.stringify(mem, null, 2), 'utf-8')
    }
    return { changed, removed }
  }

  checkNngRoot(rootJsonPath: string): OrphanCheckResult {
    if (!existsSync(rootJsonPath)) {
      return { changed: false, removed: [] }
    }
    const data = readNngRoot(rootJsonPath)
    const removed: string[] = []
    const newNodes = data.nodes.filter((n) => {
      const t = normalizePath(n.path)
      if (existsSync(t)) {
        return true
      }
      removed.push(n.path)
      return false
    })
    if (newNodes.length !== data.nodes.length) {
      data.nodes = newNodes
      this.selfWriteMarker.add(rootJsonPath)
      writeNngRoot(rootJsonPath, data)
      return { changed: true, removed }
    }
    return { changed: false, removed }
  }

  checkCacheIndex(indexJsonPath: string): OrphanCheckResult {
    if (!existsSync(indexJsonPath)) {
      return { changed: false, removed: [] }
    }
    const data = readCacheIndex(indexJsonPath)
    const removed: string[] = []
    const newList = data.cache_list.filter((c) => {
      const t = normalizePath(c.path)
      if (existsSync(t)) {
        return true
      }
      removed.push(c.path)
      return false
    })
    if (newList.length !== data.cache_list.length) {
      data.cache_list = newList
      this.selfWriteMarker.add(indexJsonPath)
      writeCacheIndex(indexJsonPath, data)
      return { changed: true, removed }
    }
    return { changed: false, removed }
  }

  quarantineCorrupted(path: string, corruptedDir?: string): void {
    const dir = corruptedDir ?? this.corruptedDir
    if (!dir) return
    if (!existsSync(path)) return
    const safeName = path.replace(/[\\/:*?"<>|]/g, '_')
    const dest = `${dir}/${safeName}.${Date.now()}`
    // 修复：不再"备份后写空原文件"——写空会触发 watcher update 事件，
    // 事件处理再次读空文件→再次隔离→再次写空，形成死循环（曾产出 2913 个 corrupted 备份）。
    // 改为【移动】文件到隔离区：移动是原子操作，原路径消失只产生一次 delete 事件，
    // 由 handler 走正常删除清理，循环从根上断掉。
    this.ensureDir(dest)
    try {
      renameSync(path, dest)
      return
    } catch {
      // 移动失败（跨卷/占用等罕见情况）兜底：复制到隔离区 + 删除原文件（删除也不产生 update 事件）
      try {
        const raw = readFileSync(path, 'utf-8')
        writeFileSync(dest, raw, 'utf-8')
        unlinkSync(path)
      } catch {
        // skip
      }
    }
  }

  ensureDir(path: string): void {
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
  }
}
