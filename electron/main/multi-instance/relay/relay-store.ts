/**
 * 中继存储层（{root}/relay/）。
 * 为什么存在：中继异步传输的文件实体与条目清单必须与其它系统数据完全隔离
 * （不混入 incoming 实时收件、不混入账号/记忆/知识库），并满足"多机并发取件互不干扰"：
 * 条目按 itemId 收敛到独立目录 {root}/relay/files/{itemId}/，一间目录只归一个条目。
 * 作用：entries.json 原子读写 + 状态迁移 + 过期清理；文件实体目录创建/删除。
 * 默认安全：条目文件只写 {root}/relay/ 之下，任何目录穿越在此层整流拒绝。
 */

import { Dirent, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, normalize } from 'path'
import type { RelayEntriesFile, RelayEntry, RelayStatus } from './relay-types'

/** 状态机允许迁移表（防止任意跳转；expired 为终态，downloaded 为终态） */
const ALLOWED_TRANSITIONS: Record<RelayStatus, RelayStatus[]> = {
  uploading: ['uploaded', 'expired'],
  uploaded: ['notified', 'downloaded', 'expired'],
  notified: ['downloaded', 'expired'],
  downloaded: [],
  expired: []
}

export class RelayStore {
  private readonly root: string
  private readonly entriesPath: string
  private readonly filesDir: string

  constructor(root: string) {
    this.root = root
    this.entriesPath = join(root, 'relay', 'entries.json')
    this.filesDir = join(root, 'relay', 'files')
    mkdirSync(this.filesDir, { recursive: true })
  }

  // ===== 条目清单 =====

  loadEntries(): RelayEntry[] {
    try {
      if (!existsSync(this.entriesPath)) return []
      const raw = JSON.parse(readFileSync(this.entriesPath, 'utf-8')) as RelayEntriesFile
      if (!Array.isArray(raw.entries)) return []
      return raw.entries.filter((e) => typeof e.itemId === 'string' && typeof e.senderUid === 'number')
    } catch {
      return []
    }
  }

  private saveEntries(entries: RelayEntry[]): void {
    const tmp = `${this.entriesPath}.tmp`
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), entries } satisfies RelayEntriesFile, null, 2), 'utf-8')
    renameSync(tmp, this.entriesPath)
  }

  /** 按 itemId 取条目（无则 null） */
  get(itemId: string): RelayEntry | null {
    return this.loadEntries().find((e) => e.itemId === itemId) ?? null
  }

  /** 列表（按创建时间倒序） */
  list(): RelayEntry[] {
    return this.loadEntries().sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 新增或覆盖条目（主系统真值写入；发送/接收端副本使用同一套校验） */
  upsert(entry: RelayEntry): void {
    const entries = this.loadEntries()
    const idx = entries.findIndex((e) => e.itemId === entry.itemId)
    if (idx >= 0) entries[idx] = entry
    else entries.push(entry)
    this.saveEntries(entries)
  }

  /**
   * 状态迁移（受 ALLOWED_TRANSITIONS 约束）；非法迁移返回 false 不落盘。
   * 为什么显式约束：中继条目状态驱动收发两端 UI 与主系统清理策略，
   * 任意跳转会破坏"未确认→过期清理"的保留期语义与"下载完成→终态"的去重语义。
   */
  transition(itemId: string, next: RelayStatus, patch?: Partial<RelayEntry>): boolean {
    const entries = this.loadEntries()
    const idx = entries.findIndex((e) => e.itemId === itemId)
    if (idx < 0) return false
    const cur = entries[idx]
    if (cur.status === next) {
      // 同状态幂等（通知重放等）：仅应用字段 patch，不报错
      if (patch) {
        entries[idx] = { ...cur, ...patch }
        this.saveEntries(entries)
      }
      return true
    }
    if (!ALLOWED_TRANSITIONS[cur.status]?.includes(next)) {
      console.warn(`[relay] 非法状态迁移 ${cur.status} → ${next}（itemId=${itemId}）`)
      return false
    }
    entries[idx] = { ...cur, status: next, ...patch }
    this.saveEntries(entries)
    return true
  }

  /** 删除条目（撤回/过期清理后）；可选连带删除文件实体 */
  remove(itemId: string, deleteFiles = true): void {
    const entries = this.loadEntries()
    const next = entries.filter((e) => e.itemId !== itemId)
    if (next.length !== entries.length) this.saveEntries(next)
    if (deleteFiles) this.removeFiles(itemId)
  }

  // ===== 文件实体 =====

  /** 条目文件实体根目录（{root}/relay/files/{itemId}；rectify：目录穿越在此层拒绝） */
  filesRoot(itemId: string): string | null {
    if (!this.isSafeItemId(itemId)) return null
    return join(this.filesDir, itemId)
  }

  /** 目录穿越防线：itemId 只允许单层安全名（禁 ..、/、\、盘符与路径成分） */
  private isSafeItemId(itemId: string): boolean {
    if (!itemId || itemId.length > 128) return false
    if (itemId.includes('/') || itemId.includes('\\') || itemId.includes('\0')) return false
    if (itemId === '.' || itemId === '..') return false
    const norm = normalize(itemId)
    if (norm !== itemId) return false
    return !itemId.startsWith('.') && !itemId.includes(':')
  }

  /** 确保条目文件目录存在 */
  ensureFiles(itemId: string): string | null {
    const root = this.filesRoot(itemId)
    if (!root) return null
    mkdirSync(root, { recursive: true })
    return root
  }

  /** 删除条目文件实体（不存在静默） */
  removeFiles(itemId: string): void {
    const root = this.filesRoot(itemId)
    if (root) rmSync(root, { recursive: true, force: true })
  }

  /**
   * 过期清理：返回本次清理的条目数。
   * 为什么在主系统上做：文件实体只存在于主系统，清理动作只能由持有真值的一方执行。
   */
  sweepExpired(now = Date.now()): number {
    const entries = this.loadEntries()
    let cleaned = 0
    for (const e of entries) {
      if (e.status === 'downloaded' || e.status === 'expired') continue
      if (e.expiresAt > now) continue
      this.removeFiles(e.itemId)
      if (this.transition(e.itemId, 'expired')) cleaned += 1
    }
    return cleaned
  }

  /** 条目文件实体占用总字节（Windows 上 readdir 递归；失败返回 0 不阻塞清理流程） */
  sizeOfFiles(itemId: string): number {
    const root = this.filesRoot(itemId)
    if (!root || !existsSync(root)) return 0
    let total = 0
    const walk = (dir: string): void => {
      let names: Dirent[] = []
      try {
        names = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const d of names) {
        const p = join(dir, d.name)
        if (d.isDirectory()) walk(p)
        else if (d.isFile()) total += statSync(p).size
      }
    }
    walk(root)
    return total
  }
}