/**
 * Cron 定时任务 IPC：定时任务的列表/新增更新/删除/启停与打开
 * jobs.json 通道，让 AI 与用户都能在 UI 上管理周期任务。
 */
import { ipcMain, shell } from 'electron'
import type { CronScheduler } from '../../cron/scheduler'
import { safeHandle } from './safe-handle'

/**
 * Cron 定时任务 IPC（新版调度器 cron/scheduler.ts）：
 * - cron:list 任务列表
 * - cron:upsert 新增/更新（校验 schedule 表达式：间隔型/cron 5 段/ISO 一次性）
 * - cron:delete 删除
 * - cron:toggle 启用/禁用
 * - cron:openJobs 打开 jobs.json（系统文件管理器）
 */
export function registerCronHandlers(ipc: typeof ipcMain, getCronService: () => CronScheduler | null): void {
  safeHandle(ipc, 'cron:list', () => {
    const svc = getCronService()
    if (!svc) return { ok: false, error: 'Cron 服务未初始化' }
    return { ok: true, jobs: svc.listJobs() }
  }, { ok: false, error: '读取定时任务失败' })

  safeHandle(ipc, 'cron:upsert', (_event, ...args: unknown[]) => {
    const job = args[0] as { id: string; schedule: string; prompt: string; enabled?: boolean }
    const svc = getCronService()
    if (!svc) return { ok: false, error: 'Cron 服务未初始化' }
    return svc.upsertJob({
      id: String(job.id ?? ''),
      schedule: String(job.schedule ?? ''),
      prompt: String(job.prompt ?? ''),
      enabled: job.enabled !== false
    })
  }, { ok: false, error: '保存定时任务失败' })

  safeHandle(ipc, 'cron:delete', (_event, ...args: unknown[]) => {
    const svc = getCronService()
    if (!svc) return { ok: false, error: 'Cron 服务未初始化' }
    svc.deleteJob(String(args[0] ?? ''))
    return { ok: true }
  }, { ok: false, error: '删除定时任务失败' })

  safeHandle(ipc, 'cron:toggle', (_event, ...args: unknown[]) => {
    const svc = getCronService()
    if (!svc) return { ok: false, error: 'Cron 服务未初始化' }
    svc.toggleJob(String(args[0] ?? ''), args[1] === true)
    return { ok: true }
  }, { ok: false, error: '切换定时任务失败' })

  safeHandle(ipc, 'cron:openJobs', () => {
    const svc = getCronService()
    if (!svc) return { ok: false, error: 'Cron 服务未初始化' }
    shell.openPath(svc.getJobsPath())
    return { ok: true }
  }, { ok: false, error: '打开任务文件失败' })
}
