/**
 * 日历 IPC：前端「日历面板」的备忘/计划/提醒/备份条目读写；
 * 数据按 用户×AI 隔离存于 memory/U{uid}/AI{aiId}/calendar/entries.json。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { dirname } from 'path'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import type { BaseDataPaths } from '../../models/paths'
import type { UserStore } from '../../models/user-store'
import { resolveScopePaths } from '../../models/paths'
import { safeHandle, errorFallback } from './safe-handle'
import { DEFAULT_AI_ID } from '@shared/types'

/** 日历条目类型：备忘 / 计划 / 提醒 / 备份 */
export type CalendarEntryType = 'memo' | 'plan' | 'reminder' | 'backup'

export interface CalendarEntry {
  id: string
  type: CalendarEntryType
  title: string
  content?: string
  /** 关联日期 YYYY-MM-DD（计划/备忘挂的日期） */
  date?: string
  /** 提醒时间（ISO），type=reminder 时生效 */
  remindAt?: string
  done?: boolean
  createdAt: string
}

const ENTRIES_FILE = 'entries.json'
const MAX_CALENDAR_TITLE_LENGTH = 200

/** 解析日历条目库文件路径：memory/U{uid}/AI{aiId}/calendar/entries.json（uid/aiId 隔离） */
export function resolveCalendarFile(dataPaths: BaseDataPaths, uid: number, aiId = DEFAULT_AI_ID): string {
  const scoped = resolveScopePaths(dataPaths, { uid, aiId })
  return join(scoped.calendar ?? join(dataPaths.root, 'memory', `U${uid}`, `AI${aiId}`, 'calendar'), ENTRIES_FILE)
}

interface CalendarFile {
  meta?: Record<string, unknown>
  entries: CalendarEntry[]
}

function readCalendar(file: string): CalendarFile {
  if (!existsSync(file)) return { entries: [] }
  try {
    const raw = readFileSync(file, 'utf-8')
    const data = JSON.parse(raw) as CalendarFile
    if (!Array.isArray(data.entries)) return { entries: [] }
    return data
  } catch {
    return { entries: [] }
  }
}

function writeCalendar(file: string, data: CalendarFile): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

/** 当前登录用户 UID（无登录态返回 null） */
function currentUid(getUserStore: () => UserStore | null): number | null {
  return getUserStore()?.getCurrentUser()?.UID ?? null
}

/** 文件级简单锁：防止 add/update/delete 并发执行时读-改-写竞态导致数据丢失 */
const fileLocks = new Map<string, Promise<void>>()
function withFileLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve()
  const result = prev.then(() => fn())
  // 链式排队：将当前操作接在 prev 后面，存入 Map 供后续操作排队
  const chained = prev.then(() => result.then(() => undefined, () => undefined))
  fileLocks.set(file, chained)
  // 链完成后清理 Map（若仍是当前 chain 才删，防止误删后续排入的新 chain）
  chained.finally(() => {
    if (fileLocks.get(file) === chained) {
      fileLocks.delete(file)
    }
  })
  return result
}

/**
* 日历系统 IPC：前端「日历面板」读写 memory/U{uid}/AI{aiId}/calendar/entries.json。
 * 与 AI 侧日历工作流共用同一数据源（我记备忘走 entries.json，UI 直接看同一份）。
 */
export function registerCalendarHandlers(
  ipc: typeof ipcMainType,
  getDataPaths: () => BaseDataPaths | null,
  getUserStore: () => UserStore | null
): void {
  safeHandle(
    ipc,
    'calendar:list',
    () => {
      const paths = getDataPaths()
      const uid = currentUid(getUserStore)
      if (!paths || uid === null) return { ok: false, error: '数据路径或登录态未就绪' }
      const file = resolveCalendarFile(paths, uid)
      const data = readCalendar(file)
      return { ok: true, entries: data.entries, meta: data.meta ?? null }
    },
    errorFallback('读取日历失败')
  )

  safeHandle(
    ipc,
    'calendar:add',
    async (_event, input: unknown) => {
      const paths = getDataPaths()
      const uid = currentUid(getUserStore)
      if (!paths || uid === null) return { ok: false, error: '数据路径或登录态未就绪' }
      const entry = (input ?? {}) as Partial<CalendarEntry>
      if (!entry.title || typeof entry.title !== 'string') {
        return { ok: false, error: 'title 必填' }
      }
      const type = (entry.type ?? 'memo') as CalendarEntryType
      if (!['memo', 'plan', 'reminder', 'backup'].includes(type)) {
        return { ok: false, error: 'type 必须是 memo/plan/reminder/backup' }
      }
      const now = new Date().toISOString()
      const item: CalendarEntry = {
        id: entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        title: entry.title.slice(0, MAX_CALENDAR_TITLE_LENGTH),
        content: entry.content ?? '',
        date: entry.date ?? undefined,
        remindAt: entry.remindAt ?? undefined,
        done: entry.done ?? false,
        createdAt: entry.createdAt ?? now
      }
      const file = resolveCalendarFile(paths, uid)
      return withFileLock(file, () => {
        const data = readCalendar(file)
        data.entries.push(item)
        writeCalendar(file, data)
        return { ok: true, entry: item }
      })
    },
    errorFallback('添加日历条目失败')
  )

  safeHandle(
    ipc,
    'calendar:update',
    async (_event, id: unknown, patch: unknown) => {
      const paths = getDataPaths()
      const uid = currentUid(getUserStore)
      if (!paths || uid === null) return { ok: false, error: '数据路径或登录态未就绪' }
      if (typeof id !== 'string') return { ok: false, error: 'id 必填' }
      const file = resolveCalendarFile(paths, uid)
      return withFileLock(file, () => {
        const data = readCalendar(file)
        const idx = data.entries.findIndex((e) => e.id === id)
        if (idx === -1) return { ok: false, error: '条目不存在' }
        const p = (patch ?? {}) as Record<string, unknown>
        const updated: CalendarEntry = { ...data.entries[idx] }
        if (typeof p.title === 'string') updated.title = p.title.slice(0, MAX_CALENDAR_TITLE_LENGTH)
        if (typeof p.content === 'string') updated.content = p.content
        if (typeof p.type === 'string' && ['memo', 'plan', 'reminder', 'backup'].includes(p.type)) {
          updated.type = p.type as CalendarEntryType
        }
        if (typeof p.date === 'string') updated.date = p.date
        if (typeof p.remindAt === 'string') updated.remindAt = p.remindAt
        if (typeof p.done === 'boolean') updated.done = p.done
        data.entries[idx] = updated
        writeCalendar(file, data)
        return { ok: true, entry: updated }
      })
    },
    errorFallback('更新日历条目失败')
  )

  safeHandle(
    ipc,
    'calendar:delete',
    async (_event, id: unknown) => {
      const paths = getDataPaths()
      const uid = currentUid(getUserStore)
      if (!paths || uid === null) return { ok: false, error: '数据路径或登录态未就绪' }
      if (typeof id !== 'string') return { ok: false, error: 'id 必填' }
      const file = resolveCalendarFile(paths, uid)
      return withFileLock(file, () => {
        const data = readCalendar(file)
        const before = data.entries.length
        data.entries = data.entries.filter((e) => e.id !== id)
        if (data.entries.length === before) return { ok: false, error: '条目不存在' }
        writeCalendar(file, data)
        return { ok: true }
      })
    },
    errorFallback('删除日历条目失败')
  )
}
