/**
 * 为什么存在：长时间运行会积累过期临时文件，手工清理不可行，需后台按保留天数定时回收。
 * 作用：注册定时器按 CleanupTarget（路径 + 保留天数）扫描删除过期文件，首次延迟后接入，返回清理结果。
 */

import { existsSync, readdirSync, statSync, rmSync, appendFileSync } from 'fs'
import { join } from 'path'
import type { TimerRegistry, TimerHandle } from '../monitor/timer-registry'

/**
 * 自动清理服务

 * 系统级后台清理：不依赖 AI 被唤醒，主进程自维护。
 * - 启动 60 秒后跑第一次（等应用稳定），之后每 24 小时一次
 * - 只清"累积型垃圾"：崩溃转储 / 运行日志 / npm 调试日志——
 * 这类数据越积越多、应用运行时不读、删了无任何重建负担
 * - **不碰** Chromium 缓存类（Cache/Code Cache/GPUCache）：
 * ① 启动时 cleanStaleGpuCache()（index.ts）已清 GPU 系 + CodeCache；
 * ② 网络缓存 Cache 由 Chromium 自带配额管理，不会无限膨胀；
 * ③ 运行中删缓存收益低（正在用会删失败），且删了下次冷启动要重新下载/编译
 * - 不碰记忆 / RAW / NNG / 会话 / 配置 / 日历 / 日记 等任何业务数据
 * - 删除失败静默忽略（运行中文件占用正常，下轮再清）

 * 清理结果追加写 {userData}/.auto-cleanup.log（供 AI/用户查看），不唤醒 AI。
 */

interface CleanupTarget {
  /** 展示名（日志用） */
  label: string
  /** 目录绝对路径（只清目录内的子条目，目录本身保留） */
  path: string
  /** 保留天数：超过该天数未修改的条目删除；0 = 全部删除 */
  keepDays: number
}

export interface CleanupResult {
  label: string
  path: string
  removed: number
  keepDays: number
  error?: string
}

const DAY_MS = 24 * 60 * 60 * 1000
/** 首次运行延迟（毫秒）——等应用稳定后再清理 */
const FIRST_RUN_DELAY_MS = 60 * 1000

export class AutoCleanupService {
  private intervalHandle: TimerHandle | null = null
  private firstRunHandle: TimerHandle | null = null

  constructor(
    private userDataDir: string,
    private appDir: string,
    private timerRegistry: TimerRegistry,
    private intervalMs = DAY_MS,
    private firstRunDelayMs = FIRST_RUN_DELAY_MS
  ) {}

  /** 清理目标白名单（只动这些目录内的内容，绝不越界）——只留累积型垃圾 */
  private buildTargets(): CleanupTarget[] {
    const u = this.userDataDir
    return [
      { label: '崩溃转储', path: join(u, 'crashes'), keepDays: 7 },
      { label: 'Crashpad', path: join(u, 'Crashpad'), keepDays: 7 },
      { label: '运行日志', path: join(u, 'logs'), keepDays: 3 },
      { label: 'npm 调试日志', path: join(this.appDir, '.npm-cache', '_logs'), keepDays: 3 }
    ]
  }

  /** 启动：首轮延迟执行，之后固定间隔 */
  start(): void {
    if (this.intervalHandle || this.firstRunHandle) return
    this.firstRunHandle = this.timerRegistry.setTimeout(() => {
      this.firstRunHandle = null
      this.run()
      this.intervalHandle = this.timerRegistry.setInterval(() => this.run(), this.intervalMs, 'auto-cleanup')
    }, this.firstRunDelayMs, 'auto-cleanup-first')
  }

  stop(): void {
    if (this.firstRunHandle) {
      this.timerRegistry.clearTimeout(this.firstRunHandle)
      this.firstRunHandle = null
    }
    if (this.intervalHandle) {
      this.timerRegistry.clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
  }

  /** 执行一轮清理，返回每项目标的结果 */
  run(): CleanupResult[] {
    const results = this.buildTargets().map((t) => this.cleanDir(t))
    this.record(results)
    return results
  }

  private cleanDir(t: CleanupTarget): CleanupResult {
    if (!existsSync(t.path)) {
      return { label: t.label, path: t.path, removed: 0, keepDays: t.keepDays }
    }
    let removed = 0
    try {
      const entries = readdirSync(t.path, { withFileTypes: true })
      const deadline = t.keepDays > 0 ? Date.now() - t.keepDays * DAY_MS : Infinity
      for (const e of entries) {
        const full = join(t.path, e.name)
        // 保留天数 > 0：按 mtime 判断是否超期；= 0：全清
        if (t.keepDays > 0) {
          const st = statSync(full)
          if (st.mtimeMs > deadline) continue
        }
        rmSync(full, { recursive: true, force: true })
        removed += 1
      }
    } catch (err) {
      return {
        label: t.label,
        path: t.path,
        removed,
        keepDays: t.keepDays,
        error: (err as Error).message
      }
    }
    return { label: t.label, path: t.path, removed, keepDays: t.keepDays }
  }

  private record(results: CleanupResult[]): void {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), results }) + '\n'
      appendFileSync(join(this.userDataDir, '.auto-cleanup.log'), line, 'utf-8')
      const total = results.reduce((s, r) => s + r.removed, 0)
      const hit = results.filter((r) => r.removed > 0).map((r) => r.label)
      console.log(`[auto-cleanup] 清理完成：删除 ${total} 项${hit.length ? `（${hit.join('、')}）` : '（无）'}`)
    } catch (err) {
      console.error('[auto-cleanup] 记录清理日志失败:', err)
    }
  }
}
