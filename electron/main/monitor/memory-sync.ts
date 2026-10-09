/**
 * 为什么存在：AI 实时写入 RAW 记忆后需即时反映到可查询视图，且崩溃/异常会产生孤儿条目，需同步后清理。
 * 作用：处理 memory 作用域变更：同步内存视图与 RAM 映射，含自写标记防回环、失败重试与孤儿清理。
 * 不删掉的理由：记忆写入与 NNG/缓存读取横跨多个进程路径，内存视图不同步会读到陈旧数据；
 * 孤儿清理保证磁盘与索引一致，是记忆检索准确性的守卫。
 */

import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'fs'
import { basename, join } from 'path'
import type { Memory } from '../models/memory'
import { normalizePath } from '../models/paths'
import { OrphanCheck } from './orphan-check'
import { ErrorLog } from './error-log'

export class MemorySync {
  private nngRoot: string
  private orphan: OrphanCheck
  private errorLog: ErrorLog
  private selfWriteMarker: Set<string>
  private retryCount: number
  private retryIntervalMs: number

  constructor(
    nngRoot: string,
    orphan: OrphanCheck,
    errorLog: ErrorLog,
    selfWriteMarker: Set<string>,
    retryCount = 3,
    retryIntervalMs = 100
  ) {
    this.nngRoot = normalizePath(nngRoot)
    this.orphan = orphan
    this.errorLog = errorLog
    this.selfWriteMarker = selfWriteMarker
    this.retryCount = retryCount
    this.retryIntervalMs = retryIntervalMs
  }

  /**
   * @param backfill 是否触发反向回填。仅"记忆文件变动"事件（handler 调用）传 true；
   * 启动扫描/重试传 false——回填只由变动触发，不做全量扫描
   * （设计依据：全量扫描在启动/重试路径上是幂等的重复劳动，成本高且无增量信息）。
   */
  sync(path: string, backfill = true): void {
    const p = normalizePath(path)
    if (!existsSync(p)) return
    let mem: Memory
    let mtime: number
    try {
      const raw = readFileSync(p, 'utf-8')
      mem = JSON.parse(raw) as Memory
      mtime = statSync(p).mtimeMs
    } catch (err) {
      this.errorLog.add(`memory_sync read fail: ${(err as Error).message}`, {
        type: 'memory_sync',
        path: p
      })
      this.orphan.quarantineCorrupted(p)
      return
    }

    let changed = false
    const expectedSelf = p
    if (!mem.自身路径 || mem.自身路径 !== expectedSelf) {
      mem.自身路径 = expectedSelf
      changed = true
    }
    if (!Array.isArray(mem.关联NNG)) {
      mem.关联NNG = []
      changed = true
    }

    // 反向回填：仅变动触发（backfill=true）且 关联NNG 为空/失效时，从 NNG 树反查引用回填。
    // 正常记忆（非空且有效）零扫描；启动扫描传 false 不触发（不做全量回填）。
    const hasInvalidRef = mem.关联NNG.some((r) => !existsSync(r))
    if (backfill && (mem.关联NNG.length === 0 || hasInvalidRef)) {
      const refs = this.collectNngRefs(p)
      if (refs.length > 0 || hasInvalidRef) {
        const merged = [...new Set([...mem.关联NNG.filter((r) => existsSync(r)), ...refs])]
        if (merged.length !== mem.关联NNG.length || !mem.关联NNG.every((r, i) => r === merged[i])) {
          mem.关联NNG = merged
          changed = true
        }
      }
    }

    if (changed) {
      this.writeBack(p, mem, mtime)
    }

    this.orphan.checkMemory(p)
  }

  private writeBack(path: string, mem: Memory, mtimeBefore: number): boolean {
    try {
      const currentMtime = statSync(path).mtimeMs
      if (currentMtime !== mtimeBefore) {
        return false
      }
      this.selfWriteMarker.add(path)
      writeFileSync(path, JSON.stringify(mem, null, 2), 'utf-8')
      return true
    } catch (err) {
      if (this.retryCount > 0) {
        for (let i = 0; i < this.retryCount; i++) {
          this.sleepSync(this.retryIntervalMs)
          try {
            const mtime = statSync(path).mtimeMs
            if (mtime !== mtimeBefore) continue
            this.selfWriteMarker.add(path)
            writeFileSync(path, JSON.stringify(mem, null, 2), 'utf-8')
            return true
          } catch {
            // continue retry
          }
        }
      }
      this.errorLog.add(`memory_sync write fail: ${(err as Error).message}`, {
        type: 'memory_sync',
        path
      })
      return false
    }
  }

  private sleepSync(ms: number): void {
    const buf = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(buf, 0, 0, ms)
  }

  /**
   * 反查 NNG 树：找出所有 关联记忆 中包含 memPath 的 NNG 文件路径。
   * 递归扫描 nngRoot 下所有 _nng.json（跳过 root.json 索引），
   * 只在记忆侧关联NNG 为空/失效时调用，正常路径零开销。
   */
  private collectNngRefs(memPath: string): string[] {
    const results: string[] = []
    const stack: string[] = [this.nngRoot]
    while (stack.length > 0) {
      const dir = stack.pop()
      if (!dir || !existsSync(dir)) continue
      let entries: string[] = []
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(dir, entry).replace(/\\/g, '/')
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (isDir) {
          stack.push(full)
          continue
        }
        if (!entry.endsWith('_nng.json')) continue
        try {
          const raw = readFileSync(full, 'utf-8')
          const nng = JSON.parse(raw) as { 关联记忆?: Array<{ 记忆路径?: string }> }
          const refs = nng.关联记忆 ?? []
          if (refs.some((r) => normalizePath(r.记忆路径 ?? '') === memPath)) {
            results.push(full)
          }
        } catch {
          // 单个 NNG 解析失败不影响反查
        }
      }
    }
    return results
  }
}

export function isMemoryFile(path: string, _memoryRoot?: string): boolean {
  const p = normalizePath(path)
  // 分层：记忆文件在 {root}/memory/U{uid}/AI{aiId}/{normal,meta,high}/ 下（三档直挂工作域，
  // 兼容旧纯数字 /memory/{uid}/{aiId}[/memory]/{tier}/ 结构），
  // 特征判断（memory 域内含 {类型}/ 段，前带 U/AI 前缀或兼容旧纯数字两段）
  if (!/\/memory\/(?:U\d+\/AI\d+|\d+\/\d+)(?:\/memory)?\/(normal|meta|high)\//.test(p)) return false
  if (!p.endsWith('.json')) return false
  if (p.endsWith('计数器.json')) return false
  const name = basename(p)
  if (!/^\d+_/.test(name)) return false
  return true
}
