/**
 * @category 工具
 * @summary 定时任务调度器：cron 表达式解析与任务触发
 * @note 为什么存在：AI（经 cron_manage 工具）或用户需要"到点自动做事"（复盘/日报/监控），
 * 本模块把调度诉求转化为进程内定时触发，不依赖外部计划任务程序。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join, dirname } from 'path'
import type { TimerRegistry, TimerHandle } from '../monitor/timer-registry'
import type { ActivationManager } from '../api/activation-manager'

/**
 * Cron 定时任务调度器

 * 配置驱动、到点触发、热重载。
 * 月蚀的触发语义：到点把任务内容作为【外部事件】推给 ActivationManager——
 * AI 空闲时立即响应，忙时事件入队等下一轮注入（复用现有激活机制，不加新链路）。

 * 配置：{paths.cron}/jobs.json（DataPaths.cron 预留目录）
 * ```json
 * {
 * "jobs": [
 * { "id": "review-thinking", "schedule": "every 6h", "prompt": "复盘 thinking-log 思考日志，提炼决策质量经验", "enabled": true },
 * { "id": "daily-review", "schedule": "0 9 * * *", "prompt": "每天 9 点复盘昨日开发记录，提炼今日待办", "enabled": true },
   * { "id": "one-shot", "schedule": "2025-01-01T09:00:00+08:00", "prompt": "一次性任务", "enabled": true }
 * ]
 * }
 * ```

 * schedule 支持三种格式：
 * - 间隔型："30m" / "2h" / "every 6h" / "every 30m"
 * - cron 型："分 时 日 月 周"（5 段，空格分隔，* 通配）
 * - 一次性：ISO 8601 时间戳（触发后自动禁用）
 */
export interface CronJob {
  id: string
  /** 调度表达式：间隔型（30m/2h/every 6h）| cron 型（5 段）| ISO 一次性 */
  schedule: string
  /** 触发时注入给 AI 的任务内容 */
  prompt: string
  /** 是否启用 */
  enabled?: boolean
  /** 上次触发时间（ISO 字符串，持久化；用于启动补跑判断） */
  lastRunAt?: string
}

export interface CronConfig {
  jobs: CronJob[]
}

/** 解析"30m"/"2h"/"every 6h" → 毫秒；无法解析返回 null */
function parseInterval(schedule: string): number | null {
  const m = schedule.trim().match(/^(?:every\s+)?(\d+)\s*(s|m|h|d)$/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const unit = m[2].toLowerCase()
  const mult: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return n * mult[unit]
}

/** 解析 cron 5 段表达式 → 当前时间是否命中 */
function matchCron(schedule: string, date: Date): boolean {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [min, hour, dom, month, dow] = parts
  const match = (field: string, value: number): boolean => field === '*' || field.split(',').some((f) => {
    if (f.includes('-')) {
      const [a, b] = f.split('-').map((x) => parseInt(x, 10))
      return value >= a && value <= b
    }
    if (f.includes('/')) {
      const [base, step] = f.split('/')
      if (base === '*') return value % parseInt(step, 10) === 0
      return value >= parseInt(base, 10) && (value - parseInt(base, 10)) % parseInt(step, 10) === 0
    }
    return value === parseInt(f, 10)
  })
  return match(min, date.getMinutes()) &&
    match(hour, date.getHours()) &&
    match(dom, date.getDate()) &&
    match(month, date.getMonth() + 1) &&
    match(dow, date.getDay())
}

const TICK_MS = 30 * 1000 // 30 秒 tick（覆盖分钟级 cron 和间隔型）

export class CronScheduler {
  private configPath: string
  private jobs: CronJob[] = []
  /** 间隔型任务上次触发时间（重启后按当前时间重新计时） */
  private lastFired: Map<string, number> = new Map()
  /** cron 型任务上次命中的分钟（避免同一分钟内重复触发） */
  private lastCronHit: Map<string, string> = new Map()
  private tickHandle: TimerHandle | null = null
  private watcher: FSWatcher | null = null
  private unwatch: (() => void) | null = null

  constructor(
    cronDir: string,
    private activationManager: ActivationManager,
    private timerRegistry: TimerRegistry
  ) {
    this.configPath = join(cronDir, 'jobs.json')
    this.load()
  }

/**
   * 读取配置（文件不存在时创建空配置）。

   * 为什么存在：调度器的运行状态全部由 jobs.json 驱动，进程启动与文件热重载
   * 都经过此方法；文件缺失需要播种初始配置，文件损坏则必须降级而不是崩溃。
   * 作用：确保 this.jobs 永远是合法数组——JSON 解析失败时保留空任务列表并告警，
   * 避免单个损坏的配置文件导致整个主进程启动失败（评审 m3：此前 raw JSON.parse
   * 无保护，坏文件直接抛异常中断构造器）。
   */
  private load(): void {
    try {
      if (!existsSync(this.configPath)) {
        mkdirSync(dirname(this.configPath), { recursive: true })
        writeFileSync(this.configPath, JSON.stringify({ jobs: [] }, null, 2), 'utf-8')
      }
      const raw = readFileSync(this.configPath, 'utf-8')
      const cfg = JSON.parse(raw) as CronConfig
      this.jobs = Array.isArray(cfg.jobs) ? cfg.jobs.filter((j) => j && j.id && j.schedule) : []
    } catch (err) {
      // 损坏配置降级：清空任务列表并告警（热重载时也会走到这里，多次告警可接受）
      this.jobs = []
      console.error(`[cron] jobs.json 解析失败，已跳过全部定时任务: ${(err as Error).message}`)
    }
  }

  /** 启动 tick + 配置文件热重载监听 */
  start(): void {
    if (this.tickHandle) return
    this.tickHandle = this.timerRegistry.setInterval(() => this.tick(), TICK_MS, 'cron-scheduler')
    this.watcher = watch(this.configPath, () => {
      this.load()
    })
    this.unwatch = () => {
      this.watcher?.close()
    }
    // 启动补跑：应用停机期间错过的任务，开机后补触发一次
    this.catchUpMissed()
  }

  /**
   * 启动补跑：检查每个任务是否在停机期间错过，错过则补触发一次。
   * - cron 型（5 段）：上次运行日期 < 今天 → 补触发（补当天错过的）
   * - 间隔型（30m/2h/every 6h）：上次运行距现在超过 2 个周期 → 补触发一次（不追全部，避免堆积）
   * - ISO 一次性：不补（触发后自动禁用，无意义）
   */
  private catchUpMissed(): void {
    const now = new Date()
    const nowMs = Date.now()
    for (const job of this.jobs) {
      if (job.enabled === false) continue
      try {
        // 间隔型
        const interval = parseInterval(job.schedule)
        if (interval !== null) {
          if (!job.lastRunAt) {
            // 从未跑过：记录基线，不补（避免开机即触发一堆任务）
            job.lastRunAt = now.toISOString()
            this.persist()
            continue
          }
          const lastMs = Date.parse(job.lastRunAt)
          if (!Number.isNaN(lastMs) && nowMs - lastMs >= interval * 2) {
            console.log(`[cron] 启动补跑 job ${job.id}（停机错过，上次 ${job.lastRunAt}）`)
            this.fire(job)
          }
          continue
        }
        // ISO 一次性：不补
        const isoMs = Date.parse(job.schedule)
        if (!Number.isNaN(isoMs) && job.schedule.includes('T')) continue
        // cron 型：上次运行日期 < 今天 → 补
        if (job.lastRunAt) {
          const last = new Date(job.lastRunAt)
          const lastDay = `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}`
          const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
          if (lastDay < today) {
            console.log(`[cron] 启动补跑 job ${job.id}（停机错过，上次 ${job.lastRunAt}）`)
            this.fire(job)
          }
        }
        // 无 lastRunAt 的 cron 型：首次启动，不补（避免开机即触发）
      } catch (err) {
        console.error(`[cron] 启动补跑检查 job ${job.id} 失败:`, err)
      }
    }
  }

  /** 停止（closeApiServer 调用） */
  stop(): void {
    if (this.tickHandle) {
      this.timerRegistry.clearInterval(this.tickHandle)
      this.tickHandle = null
    }
    this.unwatch?.()
    this.unwatch = null
  }

  /** 每 30 秒 tick：检查所有启用的 job（覆盖分钟级 cron、间隔型、ISO 一次性） */
  private tick(): void {
    const now = new Date()
    const nowMs = Date.now()
    for (const job of this.jobs) {
      if (job.enabled === false) continue
      try {
        this.fireIfDue(job, now, nowMs)
      } catch (err) {
        console.error(`[cron] job ${job.id} 检查失败:`, err)
      }
    }
  }

  private fireIfDue(job: CronJob, now: Date, nowMs: number): void {
    // 1. 间隔型
    const interval = parseInterval(job.schedule)
    if (interval !== null) {
      const last = this.lastFired.get(job.id)
      if (last === undefined) {
        // 首次：记录时间，不立即触发（避免启动即跑一遍）
        this.lastFired.set(job.id, nowMs)
        return
      }
      if (nowMs - last >= interval) {
        this.lastFired.set(job.id, nowMs)
        this.fire(job)
      }
      return
    }

    // 2. ISO 一次性（含日期解析成功且非纯时间）
    const isoMs = Date.parse(job.schedule)
    if (!Number.isNaN(isoMs) && job.schedule.includes('T')) {
      if (nowMs >= isoMs) {
        this.fire(job)
        // 一次性任务触发后自动禁用（下次启动不再触发）
        this.jobs = this.jobs.map((j) => (j.id === job.id ? { ...j, enabled: false } : j))
        writeFileSync(this.configPath, JSON.stringify({ jobs: this.jobs }, null, 2), 'utf-8')
      }
      return
    }

    // 3. cron 型（5 段）
    if (matchCron(job.schedule, now)) {
      const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}:${now.getMinutes()}`
      if (this.lastCronHit.get(job.id) !== minuteKey) {
        this.lastCronHit.set(job.id, minuteKey)
        this.fire(job)
      }
    }
  }

  /** 触发：推外部事件给 ActivationManager（AI 空闲即响应，忙则入队下轮注入） */
  private fire(job: CronJob): void {
    console.log(`[cron] 触发 job ${job.id}（${job.schedule}）`)
    // 记录触发时间并持久化（供启动补跑判断）
    job.lastRunAt = new Date().toISOString()
    this.persist()
    this.activationManager.pushExternalEvent(`【定时任务 ${job.id}】${job.prompt}`)
  }

  /** 列出当前 job（调试/UI 用） */
  listJobs(): CronJob[] {
    return [...this.jobs]
  }

  /** jobs.json 绝对路径（打开文件用） */
  getJobsPath(): string {
    return this.configPath
  }

  // ===== 管理 API（cron_manage 工具 / IPC 用）=====

  /** 校验 schedule 表达式合法（间隔型/cron 5 段/ISO 一次性 三选一） */
  private isValidSchedule(schedule: string): boolean {
    const s = schedule.trim()
    if (parseInterval(s) !== null) return true
    if (!Number.isNaN(Date.parse(s)) && s.includes('T')) return true
    // cron 5 段：结构校验（不匹配当前时间——"0 9 * * *" 现在非 9 点也合法）
    const parts = s.split(/\s+/)
    if (parts.length !== 5) return false
    const fieldOk = (field: string, min: number, max: number): boolean =>
      field === '*' ||
      field.split(',').every((f) => {
        if (f.includes('-')) {
          const [a, b] = f.split('-').map(Number)
          return !Number.isNaN(a) && !Number.isNaN(b) && a >= min && b <= max && a <= b
        }
        if (f.includes('/')) {
          const [base, step] = f.split('/')
          if (base !== '*' && (Number.isNaN(Number(base)) || Number(base) < min || Number(base) > max)) return false
          const st = Number(step)
          return !Number.isNaN(st) && st > 0
        }
        const v = Number(f)
        return !Number.isNaN(v) && v >= min && v <= max
      })
    return (
      fieldOk(parts[0], 0, 59) &&
      fieldOk(parts[1], 0, 23) &&
      fieldOk(parts[2], 1, 31) &&
      fieldOk(parts[3], 1, 12) &&
      fieldOk(parts[4], 0, 7)
    )
  }

  /** 新增/更新任务（同 id 覆盖），写盘 + 立即生效 */
  upsertJob(job: CronJob): { ok: boolean; error?: string } {
    if (!job.id.trim()) return { ok: false, error: 'id 不能为空' }
    if (!job.schedule.trim()) return { ok: false, error: 'schedule 不能为空' }
    if (!job.prompt.trim()) return { ok: false, error: 'prompt（任务内容）不能为空' }
    if (!this.isValidSchedule(job.schedule)) {
      return {
        ok: false,
        error: `schedule 非法: "${job.schedule}"（支持间隔型 30m/2h/every 6h、cron 5 段"0 9 * * 1-5"、ISO 时间戳）`
      }
    }
    const idx = this.jobs.findIndex((j) => j.id === job.id)
    if (idx >= 0) {
      // 保留原 lastRunAt（调用方通常不传该字段，直接展开会清掉补跑基线）
      this.jobs[idx] = { ...job, enabled: job.enabled !== false, lastRunAt: job.lastRunAt ?? this.jobs[idx].lastRunAt }
    } else {
      this.jobs.push({ ...job, enabled: job.enabled !== false })
    }
    this.lastFired.delete(job.id)
    this.lastCronHit.delete(job.id)
    this.persist()
    return { ok: true }
  }

  /** 删除任务 */
  deleteJob(id: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== id)
    this.lastFired.delete(id)
    this.lastCronHit.delete(id)
    this.persist()
  }

  /** 启用/停用 */
  toggleJob(id: string, enabled: boolean): void {
    const job = this.jobs.find((j) => j.id === id)
    if (job) {
      job.enabled = enabled
      this.persist()
    }
  }

  /** 写盘（watcher 会自动 reload，无需手动重载） */
  private persist(): void {
    writeFileSync(this.configPath, JSON.stringify({ jobs: this.jobs }, null, 2), 'utf-8')
  }
}
