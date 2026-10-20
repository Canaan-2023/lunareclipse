/**
 * @category 工具
 * @summary 业务服务集：块上下文/摘要/定时任务/地理等独立服务
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import type { ActivationManager } from '../api/activation-manager'
import type { TimerRegistry, TimerHandle } from '../monitor/timer-registry'

/**
 * @deprecated 已由 cron/scheduler.ts（CronScheduler）取代——支持间隔型/cron/ISO 三格式。
 * 本文件保留供 test/cron-service.test.ts 回归使用，生产链路（index.ts/IPC/cron_manage 工具）
 * 已全部切到 cron/scheduler.ts。勿在新代码中引用。

 * 标准 Cron 定时任务服务。

 * 配置：abyssac_data/cron/jobs.json
 * { "jobs": [ { "id": "daily9am", "cron": "0 9 * * 1-5", "task": "检查今日待办并汇报", "enabled": true } ] }

 * 机制：
 * - 自研 5 字段 cron 匹配器（分 时 日 月 周，支持通配、步进、区间、列表），不引外部依赖
 * - 每分钟检查一次（TimerRegistry.setInterval，与全局定时器生命周期统一管理）
 * - 匹配 → activationManager.pushExternalEvent('【Cron 定时任务】'+task) → 走现有激活链路唤醒 AI
 * - jobs.json 修改热重载（stat mtime 检查）
 * - 跨重启：jobs.json 持久化，重启重新注册，到点才触发（不补过去的）
 */

/** 单个 cron 任务 */
export interface CronJob {
  id: string
  /** 5 字段 cron 表达式：分 时 日 月 周 */
  cron: string
  /** 任务描述（到点注入给 AI 的内容） */
  task: string
  enabled: boolean
}

/** jobs.json 结构 */
export interface CronJobsFile {
  jobs: CronJob[]
}

/** cron 解析错误 */
export class CronParseError extends Error {}

/** 解析单字段（支持通配、步进、区间、列表），返回 min-max 范围的合法值集合 */
function parseField(field: string, min: number, max: number, fieldName: string): Set<number> {
  const values = new Set<number>()
  const parts = field.split(',')
  for (const part of parts) {
    const p = part.trim()
    if (p === '') throw new CronParseError(`${fieldName} 空字段`)
    if (p === '*') {
      for (let v = min; v <= max; v++) values.add(v)
      continue
    }
    const stepMatch = p.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      const step = parseInt(stepMatch[1], 10)
      if (step <= 0) throw new CronParseError(`${fieldName} 步长必须 > 0`)
      for (let v = min; v <= max; v += step) values.add(v)
      continue
    }
    const rangeStep = p.match(/^(\d+)-(\d+)(?:\/(\d+))?$/)
    if (rangeStep) {
      const lo = parseInt(rangeStep[1], 10)
      const hi = parseInt(rangeStep[2], 10)
      const step = rangeStep[3] ? parseInt(rangeStep[3], 10) : 1
      if (lo < min || hi > max || lo > hi || step <= 0) {
        throw new CronParseError(`${fieldName} 范围非法: ${p}`)
      }
      for (let v = lo; v <= hi; v += step) values.add(v)
      continue
    }
    const single = /^\d+$/.test(p)
    if (!single) throw new CronParseError(`${fieldName} 无法解析: ${p}`)
    const v = parseInt(p, 10)
    if (v < min || v > max) throw new CronParseError(`${fieldName} 越界: ${v}（范围 ${min}-${max}）`)
    values.add(v)
  }
  return values
}

/** 解析 5 字段 cron 表达式为字段集合 */
export function parseCron(expr: string): {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
} {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new CronParseError(`cron 表达式必须 5 字段（分 时 日 月 周），实际 ${fields.length} 字段: "${expr}"`)
  }
  return {
    minutes: parseField(fields[0], 0, 59, '分'),
    hours: parseField(fields[1], 0, 23, '时'),
    days: parseField(fields[2], 1, 31, '日'),
    months: parseField(fields[3], 1, 12, '月'),
    // 周：0=周日，允许 7 作为周日的别名
    weekdays: normalizeWeekdays(parseField(fields[4], 0, 7, '周'))
  }
}

/** 周字段 7 → 0（周日别名） */
function normalizeWeekdays(s: Set<number>): Set<number> {
  if (!s.has(7)) return s
  const copy = new Set(s)
  copy.delete(7)
  copy.add(0)
  return copy
}

/** 判断给定时间是否匹配 cron 表达式（未解析时抛 CronParseError） */
export function matchesCron(expr: string, date: Date): boolean {
  const c = parseCron(expr)
  const weekday = date.getDay()
  // 标准 cron 语义：日与周同时指定时任一匹配即算匹配；
  // 但某个字段为 *（全匹配）时它不参与 OR——否则 `0 9 * * 1-5` 的日字段 * 会让周末也匹配
  // 判断"是否为通配"：集合大小等于全范围即视为通配
  const dayIsWildcard = c.days.size === 31
  const weekdayIsWildcard = c.weekdays.size === 7
  const dayMatch = c.days.has(date.getDate())
  const weekdayMatch = c.weekdays.has(weekday)

  let dayOk: boolean
  if (dayIsWildcard && weekdayIsWildcard) {
    dayOk = true
  } else if (dayIsWildcard) {
    dayOk = weekdayMatch // 日通配 → 只看周
  } else if (weekdayIsWildcard) {
    dayOk = dayMatch // 周通配 → 只看日
  } else {
    dayOk = dayMatch || weekdayMatch // 都指定 → OR
  }

  return (
    c.minutes.has(date.getMinutes()) &&
    c.hours.has(date.getHours()) &&
    dayOk &&
    c.months.has(date.getMonth() + 1)
  )
}

/** Cron 服务 */
export class CronService {
  private jobsPath: string
  private jobs: CronJob[] = []
  private registryHandle?: TimerHandle
  private nativeHandle?: ReturnType<typeof setInterval>
  private lastMtimeMs = 0
  private lastFired: Record<string, string> = {} // jobId → 上次触发的分钟标记（防止同分钟重复触发）
  private activationManager: ActivationManager
  private timerRegistry?: TimerRegistry

  constructor(jobsPath: string, activationManager: ActivationManager, timerRegistry?: TimerRegistry) {
    this.jobsPath = jobsPath
    this.activationManager = activationManager
    this.timerRegistry = timerRegistry
    mkdirSync(join(jobsPath, '..'), { recursive: true })
    this.loadJobs()
    // 记录初始 mtime 作为基线（避免启动瞬间把已存在的 jobs.json 当"修改"重载）
    this.lastMtimeMs = this.getMtime()
  }

  /** 每分钟检查一次 */
  start(): void {
    if (this.registryHandle || this.nativeHandle) return
    const tick = () => this.check()
    if (this.timerRegistry) {
      this.registryHandle = this.timerRegistry.setInterval(tick, 60_000, 'cron.check')
    } else {
      this.nativeHandle = setInterval(tick, 60_000)
    }
    // 启动时立即跑一次（对齐分钟边界）
    this.check()
  }

  stop(): void {
    if (this.registryHandle) {
      this.timerRegistry?.clearInterval(this.registryHandle)
      this.registryHandle = undefined
    }
    if (this.nativeHandle) {
      clearInterval(this.nativeHandle)
      this.nativeHandle = undefined
    }
  }

  /** 当前任务列表（深拷贝防止外部修改） */
  listJobs(): CronJob[] {
    return this.jobs.map((j) => ({ ...j }))
  }

  /** jobs.json 绝对路径（打开文件用） */
  getJobsPath(): string {
    return this.jobsPath
  }

  /** 新增/更新任务（同 id 覆盖），写盘 + 立即生效 */
  upsertJob(job: CronJob): { ok: boolean; error?: string } {
    // 校验 cron 表达式
    try {
      parseCron(job.cron)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
    if (!job.id.trim() || !job.task.trim()) {
      return { ok: false, error: 'id 和 task 不能为空' }
    }
    const idx = this.jobs.findIndex((j) => j.id === job.id)
    if (idx >= 0) {
      this.jobs[idx] = { ...job }
    } else {
      this.jobs.push({ ...job })
    }
    this.persist()
    return { ok: true }
  }

  /** 删除任务 */
  deleteJob(id: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== id)
    delete this.lastFired[id]
    this.persist()
  }

  /** 切换启用状态 */
  toggleJob(id: string, enabled: boolean): void {
    const job = this.jobs.find((j) => j.id === id)
    if (job) {
      job.enabled = enabled
      this.persist()
    }
  }

  private check(): void {
    this.reloadIfChanged()
    const now = new Date()
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`
    for (const job of this.jobs) {
      if (!job.enabled) continue
      if (!matchesCron(job.cron, now)) continue
      // 同分钟去重（防止 check 被多次调用）
      if (this.lastFired[job.id] === minuteKey) continue
      this.lastFired[job.id] = minuteKey
      // 注入激活事件唤醒 AI（与 [TIMER:...] 倒计时同链路）
      this.activationManager.pushExternalEvent(`【Cron 定时任务】${job.task}`, false)
      console.log(`[cron] 触发任务 ${job.id}: ${job.task} @ ${now.toISOString()}`)
    }
  }

  private reloadIfChanged(): void {
    const mtime = this.getMtime()
    if (mtime !== this.lastMtimeMs) {
      this.lastMtimeMs = mtime
      this.loadJobs()
    }
  }

  private getMtime(): number {
    return existsSync(this.jobsPath) ? statSync(this.jobsPath).mtimeMs : 0
  }

  private loadJobs(): void {
    if (!existsSync(this.jobsPath)) {
      this.jobs = []
      return
    }
    const raw = JSON.parse(readFileSync(this.jobsPath, 'utf-8')) as Partial<CronJobsFile>
    this.jobs = Array.isArray(raw.jobs) ? raw.jobs : []
  }

  private persist(): void {
    try {
      writeFileSync(this.jobsPath, JSON.stringify({ jobs: this.jobs }, null, 2), 'utf-8')
      this.lastMtimeMs = this.getMtime()
    } catch (err) {
      console.error('[cron] jobs.json 写入失败:', (err as Error).message)
    }
  }
}
