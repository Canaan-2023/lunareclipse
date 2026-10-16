/**
 * 定时任务 + 日历系统 preload 域（L9 调度器 + entries.json）。
 * 为什么存在：任务调度与日历文件读写由主进程持久化持有并定时触发，渲染进程只负责管理与
 * 展示，必须经 IPC 操作。
 * 作用：暴露 cron:list/upsert/delete/toggle/openJobs 与 calendar:list 等系列方法，并导出
 * CalendarEntry 类型供 preload 类型声明命名引用（见下）。
 */
import { ipcRenderer } from 'electron'

/** 日历条目（与主进程 ipc/handlers/calendar.ts 的 CalendarEntry 保持一致）
 * 为什么导出：preload/index.ts 的 `LunareclipseAPI = typeof api` 生成声明文件时
 * 需要能命名引用该类型，否则 tsc 报 TS4023（exported variable uses name ... but cannot be named）。
 */
export interface CalendarEntry {
  id: string
  type: 'memo' | 'plan' | 'reminder' | 'backup'
  title: string
  content?: string
  date?: string
  remindAt?: string
  done?: boolean
  createdAt: string
}

export const api = {
  // ===== 定时任务（L9 新版调度器 cron/scheduler.ts，schedule 三格式） =====
  /** 任务列表 */
  cronList: () =>
    ipcRenderer.invoke('cron:list') as Promise<{ ok: boolean; jobs?: Array<{ id: string; schedule: string; prompt: string; enabled: boolean }>; error?: string }>,
  /** 新增/更新任务（校验 schedule：间隔型/cron 5 段/ISO） */
  cronUpsert: (job: { id: string; schedule: string; prompt: string; enabled?: boolean }) =>
    ipcRenderer.invoke('cron:upsert', job) as Promise<{ ok: boolean; error?: string }>,
  /** 删除任务 */
  cronDelete: (id: string) =>
    ipcRenderer.invoke('cron:delete', id) as Promise<{ ok: boolean; error?: string }>,
  /** 启用/禁用任务 */
  cronToggle: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('cron:toggle', id, enabled) as Promise<{ ok: boolean; error?: string }>,
  /** 打开 jobs.json（系统文件管理器） */
  cronOpenJobs: () =>
    ipcRenderer.invoke('cron:openJobs') as Promise<{ ok: boolean; error?: string }>,

  // ===== 日历系统（{aiDir}/calendar/entries.json，uid/aiId 隔离） =====
  /** 读取日历条目列表 */
  calendarList: () =>
    ipcRenderer.invoke('calendar:list') as Promise<{ ok: boolean; entries?: CalendarEntry[]; meta?: Record<string, unknown> | null; error?: string }>,
  /** 新增日历条目（type: memo/plan/reminder/backup，reminder 需 remindAt） */
  calendarAdd: (entry: { type: string; title: string; content?: string; date?: string; remindAt?: string; done?: boolean }) =>
    ipcRenderer.invoke('calendar:add', entry) as Promise<{ ok: boolean; entry?: CalendarEntry; error?: string }>,
  /** 更新条目（按 id 打补丁：title/content/type/date/remindAt/done） */
  calendarUpdate: (id: string, patch: Partial<Omit<CalendarEntry, 'id' | 'createdAt'>>) =>
    ipcRenderer.invoke('calendar:update', id, patch) as Promise<{ ok: boolean; entry?: CalendarEntry; error?: string }>,
  /** 删除条目 */
  calendarDelete: (id: string) =>
    ipcRenderer.invoke('calendar:delete', id) as Promise<{ ok: boolean; error?: string }>,
  /** 读取某天日记（{aiDir}/raw_memory/YYYY/MM/DD/diary.md，无则 content=null） */
  diaryGet: (date: string) =>
    ipcRenderer.invoke('diary:get', date) as Promise<{ ok: boolean; content?: string | null; error?: string }>,
}