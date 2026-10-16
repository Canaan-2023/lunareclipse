/**
 * 为什么存在：AI 对 NNG 记忆的创建/改名/删除必须即时反映到 root.json 索引，并级联同步 cache 派生视图，否则记忆不可检索。
 * 作用：解析 NNG 事件路径与层级，执行索引增删、cache 级联钩子、孤儿清理与失败重试。
 * 不删掉的理由：NngSync 是 watcher → 索引/双向关联/孤儿隔离整条链路的执行体，
 * 删除它会导致 root.json 与 NNG 文件长期失步、下级/上级关联断裂且无自愈，知识图谱检索与图查询全部失效。
 */

import { existsSync, readFileSync, writeFileSync, statSync, renameSync, readdirSync } from 'fs'
import { dirname, basename, join } from 'path'
import type { NNG } from '../models/nng'
import {
  calcNngLevel,
  buildNngFileName,
  findParentNngPath,
  getNngNameFromPath
} from '../models/nng'
import { normalizePath } from '../models/paths'
import { scopeLevel1DirForNng, scopeRootJsonForNng, isNngFile } from './nng-sync-paths'
import { upsertNngRootEntry, removeNngRootEntry, readNngRoot, type NngRootJson } from '../models/index-files'
import { nowIso } from '../models/memory'
import { OrphanCheck } from './orphan-check'
import { ErrorLog } from './error-log'

export class NngSync {
  private nngRoot: string
  private nngRootJson: string
  private orphan: OrphanCheck
  private errorLog: ErrorLog
  private selfWriteMarker: Set<string>
  private retryCount: number
  private retryIntervalMs: number
  private cacheSyncHook: ((nngPath: string, eventType: 'created' | 'modified') => void) | null = null

  constructor(
    nngRoot: string,
    nngRootJson: string,
    orphan: OrphanCheck,
    errorLog: ErrorLog,
    selfWriteMarker: Set<string>,
    retryCount = 3,
    retryIntervalMs = 100
  ) {
    this.nngRoot = normalizePath(nngRoot)
    this.nngRootJson = normalizePath(nngRootJson)
    this.orphan = orphan
    this.errorLog = errorLog
    this.selfWriteMarker = selfWriteMarker
    this.retryCount = retryCount
    this.retryIntervalMs = retryIntervalMs
  }


  setCacheSyncHook(hook: (nngPath: string, eventType: 'created' | 'modified') => void): void {
    this.cacheSyncHook = hook
  }

  sync(path: string, eventType: 'created' | 'modified' | 'accessed' = 'accessed'): void {
    let p = normalizePath(path)
    if (!existsSync(p)) return
    if (!p.endsWith('_nng.json')) return

    const renamed = this.ensureLevelPrefix(p)
    if (renamed) {
      p = renamed
    }

    let nng: NNG | undefined
    let mtime: number | undefined
    let parseError: Error | null = null
    // 读取/解析失败重试：写入方可能在写入中途（watcher 事件在写入完成前触发），
    // 短暂忙等后重读可拿到完整内容，避免把合法写入中的文件误判为损坏而隔离
    // （meta 桥接 NNG 曾被反复隔离/重建，本次重启后仍发生 1 次）
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const raw = readFileSync(p, 'utf-8')
        nng = JSON.parse(raw) as NNG
        mtime = statSync(p).mtimeMs
        parseError = null
        break
      } catch (err) {
        parseError = err as Error
        if (attempt < 2) {
          // 同步短等待（~3ms）后重读。注意：这是 CPU 忙等，会阻塞事件循环，
          // 只作用于"写入进行中导致解析失败"这一异常路径，正常路径首次 read 即成功、不会走到这里。
          // 重试是兜底而非常态：等写入方 flush 完，避免把合法写入中的文件误判为损坏而隔离。
          const end = Date.now() + 3
          while (Date.now() < end) { /* 忙等 */ }
        }
      }
    }
    if (parseError !== null || !nng || !mtime) {
      this.errorLog.add(`nng_sync read fail: ${parseError?.message ?? 'unknown'}`, {
        type: 'nng_sync',
        path: p
      })
      this.orphan.quarantineCorrupted(p)
      return
    }

    let changed = false
    if (!nng.自身路径 || nng.自身路径 !== p) {
      nng.自身路径 = p
      changed = true
    }
    if (!Array.isArray(nng.关联记忆)) {
      nng.关联记忆 = []
      changed = true
    }
    if (!Array.isArray(nng.上级NNG)) {
      nng.上级NNG = []
      changed = true
    }
    if (!Array.isArray(nng.下级NNG)) {
      nng.下级NNG = []
      changed = true
    }
    if (!Array.isArray(nng.归档记录)) {
      nng.归档记录 = []
      changed = true
    }

    this.ensureSiblingFolderParent(p, nng, () => {
      changed = true
    })

    this.ensureSiblingFolderChildren(p, nng, () => {
      changed = true
    })

    this.syncCrossFolderUpper(p, nng, () => {
      changed = true
    })
    this.syncCrossFolderLower(p, nng, () => {
      changed = true
    })

    this.syncToMemory(p, nng)

    if (changed) {
      this.writeBack(p, nng, mtime)
    }

    if (eventType === 'created') {
      this.upsertRootIndex(p, nng)
      this.cacheSyncHook?.(p, 'created')
    } else if (eventType === 'modified') {
      // 描述来源：AI 只在 NNG 文件自身写描述，监控器从 NNG 文件自身读描述填入 root.json
      // 因此 NNG 被修改时也要 upsertRootIndex，让 root.json 的描述跟随一级 NNG 文件更新
      this.upsertRootIndex(p, nng)
      this.cacheSyncHook?.(p, 'modified')
    } else {
      // accessed：兜底同步 root.json 描述（启动扫描/读取触发时确保 root.json 描述与一级 NNG 一致）。
      // 与 created/modified 的差异：只在索引条目缺失或 path/描述与 NNG 文件不一致时才写盘，
      // 不刷新 last_modified——该字段语义是"NNG 文件修改时间"，被访问事件刷新会污染时间线，
      // 也会让 root.json 在每次读取时产生无意义写盘。
      this.syncRootIndexOnAccess(p, nng)
    }

    this.orphan.checkNng(p)
  }

  handleDeleted(path: string): void {
    const p = normalizePath(path)
    if (!p.endsWith('_nng.json')) return
    const isLevel1 = dirname(p).replace(/\\/g, '/') === scopeLevel1DirForNng(p, this.nngRoot)
    if (isLevel1) {
      const name = getNngNameFromPath(p)
      const scopeRootJson = scopeRootJsonForNng(p, this.nngRoot, this.nngRootJson)
      try {
        // 防回环：删除 root.json 条目前打 marker
        this.selfWriteMarker.add(scopeRootJson)
        removeNngRootEntry(scopeRootJson, name)
      } catch (err) {
        this.errorLog.add(`nng_sync delete index fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path: p
        })
      }
    }
  }

  private ensureLevelPrefix(path: string): string | null {
    const dir = dirname(path)
    const fileName = basename(path)
    // 重构：层级相对一级节点目录计算（AI{aiId}/U{uid}/root/ 下的一级 = level 1）
    const level1Dir = scopeLevel1DirForNng(path, this.nngRoot)
    const match = fileName.match(/^(\d+)(.+_nng\.json)$/)
    if (match) {
      const currentLevel = parseInt(match[1], 10)
      const expectedLevel = calcNngLevel(dir, level1Dir)
      if (currentLevel === expectedLevel) {
        return null
      }
      const rest = match[2]
      const newName = `${expectedLevel}${rest}`
      const newPath = join(dir, newName).replace(/\\/g, '/')
      try {
        renameSync(path, newPath)
        return newPath
      } catch (err) {
        this.errorLog.add(`nng_sync rename fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path
        })
        return null
      }
    } else {
      const expectedLevel = calcNngLevel(dir, level1Dir)
      const newName = buildNngFileName(expectedLevel, 'standard', fileName.replace(/_nng\.json$/, ''))
      const newPath = join(dir, newName).replace(/\\/g, '/')
      try {
        renameSync(path, newPath)
        return newPath
      } catch (err) {
        this.errorLog.add(`nng_sync rename fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path
        })
        return null
      }
    }
  }

  private ensureSiblingFolderParent(
    nngPath: string,
    nng: NNG,
    markChanged: () => void
  ): void {
    const level1Dir = scopeLevel1DirForNng(nngPath, this.nngRoot)
    const scopeRootJson = scopeRootJsonForNng(nngPath, this.nngRoot, this.nngRootJson)
    const parentNngPath = findParentNngPath(nngPath, level1Dir)
    if (!parentNngPath) {
      // 一级节点（目录 === 一级节点目录）：父是 root.json（索引文件，非 NNG 节点）。
      // 单向引用 root.json 作为上级，不回链（root.json 无 下级NNG 字段，避免污染索引结构）。
      const dir = dirname(nngPath).replace(/\\/g, '/')
      if (dir === level1Dir && existsSync(scopeRootJson) && !nng.上级NNG.includes(scopeRootJson)) {
        nng.上级NNG.push(scopeRootJson)
        markChanged()
      }
      return
    }
    if (!existsSync(parentNngPath)) return
    if (!nng.上级NNG.includes(parentNngPath)) {
      nng.上级NNG.push(parentNngPath)
      markChanged()
    }
    try {
      const raw = readFileSync(parentNngPath, 'utf-8')
      const parent = JSON.parse(raw) as NNG
      let parentChanged = false
      if (!Array.isArray(parent.下级NNG)) {
        parent.下级NNG = []
        parentChanged = true
      }
      if (!parent.下级NNG.includes(nngPath)) {
        parent.下级NNG.push(nngPath)
        parentChanged = true
      }
      if (parentChanged) {
        this.writeBack(parentNngPath, parent, statSync(parentNngPath).mtimeMs)
      }
    } catch (err) {
      this.errorLog.add(`nng_sync parent sync fail: ${(err as Error).message}`, {
        type: 'nng_sync',
        path: parentNngPath
      })
    }
  }

  private ensureSiblingFolderChildren(
    nngPath: string,
    nng: NNG,
    markChanged: () => void
  ): void {
    const dir = dirname(nngPath)
    const baseName = basename(nngPath).replace(/_nng\.json$/, '')
    const siblingFolder = join(dir, baseName).replace(/\\/g, '/')
    if (!existsSync(siblingFolder)) return
    let entries: string[] = []
    try {
      entries = readdirSync(siblingFolder)
    } catch (err) {
      this.errorLog.add(`nng_sync readdir children fail: ${(err as Error).message}`, {
        type: 'nng_sync',
        path: siblingFolder
      })
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('_nng.json')) continue
      const childPath = join(siblingFolder, entry).replace(/\\/g, '/')
      if (!nng.下级NNG.includes(childPath)) {
        nng.下级NNG.push(childPath)
        markChanged()
      }
      if (!existsSync(childPath)) continue
      try {
        const raw = readFileSync(childPath, 'utf-8')
        const child = JSON.parse(raw) as NNG
        let childChanged = false
        if (!Array.isArray(child.上级NNG)) {
          child.上级NNG = []
          childChanged = true
        }
        if (!child.上级NNG.includes(nngPath)) {
          child.上级NNG.push(nngPath)
          childChanged = true
        }
        if (childChanged) {
          this.writeBack(childPath, child, statSync(childPath).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`nng_sync child sync fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path: childPath
        })
      }
    }
  }

  private syncCrossFolderUpper(nngPath: string, nng: NNG, _markChanged: () => void): void {
    const refs = [...(nng.上级NNG ?? [])]
    const scopeRootJson = scopeRootJsonForNng(nngPath, this.nngRoot, this.nngRootJson)
    const level1Dir = scopeLevel1DirForNng(nngPath, this.nngRoot)
    for (const targetPath of refs) {
      const t = normalizePath(targetPath)
      // root.json 是索引文件（version/nodes[]）而非 NNG 节点，不回链下级（避免污染索引结构）
      if (t === scopeRootJson) continue
      if (t === findParentNngPath(nngPath, level1Dir)) continue
      if (!existsSync(t)) continue
      try {
        const raw = readFileSync(t, 'utf-8')
        const target = JSON.parse(raw) as NNG
        let targetChanged = false
        if (!Array.isArray(target.下级NNG)) {
          target.下级NNG = []
          targetChanged = true
        }
        if (!target.下级NNG.includes(nngPath)) {
          target.下级NNG.push(nngPath)
          targetChanged = true
        }
        if (targetChanged) {
          this.writeBack(t, target, statSync(t).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`nng_sync cross upper fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path: t
        })
      }
    }
  }

  private syncCrossFolderLower(nngPath: string, nng: NNG, _markChanged: () => void): void {
    const refs = [...(nng.下级NNG ?? [])]
    for (const targetPath of refs) {
      const t = normalizePath(targetPath)
      if (!existsSync(t)) continue
      try {
        const raw = readFileSync(t, 'utf-8')
        const target = JSON.parse(raw) as NNG
        let targetChanged = false
        if (!Array.isArray(target.上级NNG)) {
          target.上级NNG = []
          targetChanged = true
        }
        if (!target.上级NNG.includes(nngPath)) {
          target.上级NNG.push(nngPath)
          targetChanged = true
        }
        if (targetChanged) {
          this.writeBack(t, target, statSync(t).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`nng_sync cross lower fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path: t
        })
      }
    }
  }

  private syncToMemory(nngPath: string, nng: NNG): void {
    for (const ref of nng.关联记忆 ?? []) {
      const memPath = normalizePath(ref.记忆路径)
      if (!existsSync(memPath)) continue
      try {
        const raw = readFileSync(memPath, 'utf-8')
        const mem = JSON.parse(raw) as { 关联NNG?: string[] }
        if (!Array.isArray(mem.关联NNG)) {
          mem.关联NNG = []
        }
        if (!mem.关联NNG.includes(nngPath)) {
          mem.关联NNG.push(nngPath)
          this.writeBackRaw(memPath, mem, statSync(memPath).mtimeMs)
        }
      } catch (err) {
        this.errorLog.add(`nng_sync to memory fail: ${(err as Error).message}`, {
          type: 'nng_sync',
          path: memPath
        })
      }
    }
  }

  private upsertRootIndex(nngPath: string, nng: NNG): void {
    // 只有一级 NNG（直接位于一级节点目录下）才进 root.json 索引
    const dir = dirname(nngPath).replace(/\\/g, '/')
    const level1Dir = scopeLevel1DirForNng(nngPath, this.nngRoot)
    const scopeRootJson = scopeRootJsonForNng(nngPath, this.nngRoot, this.nngRootJson)
    if (dir !== level1Dir) return
    // 描述来源链路：AI 只在 NNG 文件自身写描述 → 这里从传入的 nng 对象读描述填入 root.json
    // 任何 AI 都不直接写 root.json 的描述字段，全由监控器从一级 NNG 文件镜像
    try {
      const name = getNngNameFromPath(nngPath)
      // 防回环：写 root.json 前打 marker，避免写回触发 watcher → indexSync → orphan 检查的重复链路
      this.selfWriteMarker.add(scopeRootJson)
      upsertNngRootEntry(scopeRootJson, {
        name,
        path: nngPath,
        描述: nng.描述 ?? '',
        last_modified: nowIso()
      })
    } catch (err) {
      this.errorLog.add(`nng_sync root index upsert fail: ${(err as Error).message}`, {
        type: 'nng_sync',
        path: nngPath
      })
    }
  }

  private syncRootIndexOnAccess(nngPath: string, nng: NNG): void {
    // accessed 兜底：仅当 root.json 条目缺失，或 path/描述与 NNG 文件不一致时才更新；
    // 一致则跳过写盘并保留原 last_modified（它是 NNG 文件修改时间的镜像，与访问无关）。
    const dir = dirname(nngPath).replace(/\\/g, '/')
    const level1Dir = scopeLevel1DirForNng(nngPath, this.nngRoot)
    const scopeRootJson = scopeRootJsonForNng(nngPath, this.nngRoot, this.nngRootJson)
    if (dir !== level1Dir) return
    try {
      const name = getNngNameFromPath(nngPath)
      let data: NngRootJson
      try {
        data = readNngRoot(scopeRootJson)
      } catch {
        // 索引不存在/损坏时按缺失处理，走 upsert 重建
        this.upsertRootIndex(nngPath, nng)
        return
      }
      const existing = data.nodes.find((n) => n.name === name)
      const desc = nng.描述 ?? ''
      if (existing && existing.path === nngPath && (existing.描述 ?? '') === desc) {
        return
      }
      this.upsertRootIndex(nngPath, nng)
    } catch (err) {
      this.errorLog.add(`nng_sync root index access sync fail: ${(err as Error).message}`, {
        type: 'nng_sync',
        path: scopeRootJson
      })
    }
  }

  private writeBack(path: string, nng: NNG, mtimeBefore: number): boolean {
    return this.writeBackRaw(path, nng, mtimeBefore)
  }

  private writeBackRaw(path: string, obj: unknown, mtimeBefore: number): boolean {
    try {
      const currentMtime = statSync(path).mtimeMs
      if (currentMtime !== mtimeBefore) {
        return false
      }
      this.selfWriteMarker.add(path)
      writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8')
      return true
    } catch (err) {
      if (this.retryCount > 0) {
        for (let i = 0; i < this.retryCount; i++) {
          this.sleepSync(this.retryIntervalMs)
          try {
            const mtime = statSync(path).mtimeMs
            if (mtime !== mtimeBefore) continue
            this.selfWriteMarker.add(path)
            writeFileSync(path, JSON.stringify(obj, null, 2), 'utf-8')
            return true
          } catch {
            // continue retry
          }
        }
      }
      this.errorLog.add(`nng_sync write fail: ${(err as Error).message}`, {
        type: 'nng_sync',
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

export { isNngFile }
