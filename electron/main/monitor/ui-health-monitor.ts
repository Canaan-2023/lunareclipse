// ============================================================
// UI 运行状态监控：渲染进程卡死 / 崩溃 / GPU 崩溃 / 主进程事件循环延迟
// ------------------------------------------------------------
// 解决的盲区：窗口"无响应"（白屏/卡死/冻住）时，主进程和 AI 都不知道
// 为什么——crash-logger 只兜原生崩溃和 JS 异常，watchdog 只管 DMN 心跳。
//
// 补四层观测：
// 1. unresponsive / responsive → 渲染进程主线程被阻塞，记录卡死时长
// 2. render-process-gone → 渲染进程崩溃（reason: crashed/oom/killed）
// 3. child-process-gone → GPU/utility 子进程崩溃（白屏常见元凶）
// 4. event-loop 心跳 → 主进程自身被阻塞（如 CPU 被密集任务打满），
// 心跳实际间隔拉长即可测出"主进程也卡了"
//
// 事件统一追加写 {userData}/logs/ui-events.log（JSONL）。
// 严重事件（卡死超阈值 / 崩溃）同时写 pending 标记文件，
// 主进程启动后消费 → pushExternalEvent 注入 AI 对话流
// （复用回滚保护通道），让 AI 知道"上次运行发生了什么"并主动排查。
// ============================================================

import { app, BrowserWindow } from 'electron'
import { join, dirname } from 'path'
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'fs'
import { nowIso } from '../models/memory'
import type { TimerRegistry, TimerHandle } from './timer-registry'

export interface UiHealthEvent {
  type: 'unresponsive-start' | 'unresponsive-end' | 'renderer-gone' | 'child-gone' | 'eventloop-lag'
  /** 由 record() 统一补齐 */
  timestamp?: string
  /** unresponsive-end: 卡死持续毫秒；renderer-gone: 崩溃前卡死毫秒（若有） */
  durationMs?: number
  /** renderer-gone / child-gone: 退出原因 */
  reason?: string
  /** renderer-gone / child-gone: 退出码 */
  exitCode?: number
  /** child-gone: 进程类型（GPU/Utility） */
  processType?: string
  /** eventloop-lag: 期望间隔 / 实际间隔 / 超出量（毫秒） */
  expectedMs?: number
  actualMs?: number
  lagMs?: number
  /** unresponsive-start: 页面 URL */
  url?: string
}

const EVENT_LOG = 'ui-events.log'
const PENDING_FILE = 'pending-ui-events.json'
/** 卡死超过该阈值视为严重事件，需要通知 AI（3 秒对 UI 已明显可感知） */
const SEVERE_FREEZE_MS = 3000
/** 主进程事件循环延迟超过该阈值记录（2 秒说明主进程被阻塞） */
const LAG_THRESHOLD_MS = 2000
/** 心跳间隔：15 秒一次 */
const HEARTBEAT_MS = 15_000

export class UiHealthMonitor {
  private logPath: string
  private pendingPath: string
  private pendingEvents: UiHealthEvent[] = []
  /** 渲染进程开始卡死的时间戳（null = 未卡死） */
  private unresponsiveSince: number | null = null
  private heartbeatHandle: TimerHandle | null = null
  private lastHeartbeatAt = 0
  private shouldStop = false
  private writeBuffer: UiHealthEvent[] = []
  private static readonly WRITE_BUFFER_MAX_SIZE = 200

  constructor(
    userDataDir: string,
    activationDir: string,
    private timerRegistry?: TimerRegistry,
    /**
     * 严重事件实时通知回调（运行中即可推送给 AI，不必等下次主进程启动补报）。
     * 返回 true 表示已实时通知 → 从 pending 移除（避免下次启动重复推）；
     * 返回 false（如激活通道不可用）→ 保留 pending 由启动消费兜底。
     */
    private onSevere?: (text: string) => boolean
  ) {
    const logsDir = join(userDataDir, 'logs')
    mkdirSync(logsDir, { recursive: true })
    this.logPath = join(logsDir, EVENT_LOG)
    // pending 标记放激活目录，与 restart-pending 同链路消费
    this.pendingPath = join(activationDir, PENDING_FILE)
    this.loadPending()
  }

  /**
   * 挂载到窗口：监听渲染进程卡死 / 恢复 / 崩溃。
   * 窗口重建（activate 等）后需对新窗口再次调用。
   */
  attach(win: BrowserWindow): void {
    const wc = win.webContents
    if (!wc) return

    wc.on('unresponsive', () => {
      this.unresponsiveSince = Date.now()
      this.record({
        type: 'unresponsive-start',
        url: wc.getURL()
      })
    })

    wc.on('responsive', () => {
      if (this.unresponsiveSince !== null) {
        const durationMs = Date.now() - this.unresponsiveSince
        this.unresponsiveSince = null
        this.record({
          type: 'unresponsive-end',
          durationMs
        })
      }
    })

    wc.on('render-process-gone', (_event, details) => {
      const evt: UiHealthEvent = {
        type: 'renderer-gone',
        reason: details.reason,
        exitCode: details.exitCode
      }
      // 崩溃前是否处于卡死状态（连续卡死→崩溃，说明是确定性死循环而非偶发）
      if (this.unresponsiveSince !== null) {
        evt.durationMs = Date.now() - this.unresponsiveSince
        this.unresponsiveSince = null
      }
      this.record(evt)
    })
  }

  /** 监听 GPU/utility 子进程崩溃（全局，挂一次即可） */
  watchChildProcessGone(): void {
    app.on('child-process-gone', (_event, details) => {
      // 只关心影响渲染的进程：GPU 崩溃常导致白屏/卡死，utility 崩溃影响功能
      if (details.type === 'GPU' || details.type === 'Utility') {
        this.record({
          type: 'child-gone',
          processType: details.type,
          reason: details.reason,
          exitCode: details.exitCode
        })
      }
    })
  }

  /** 启动主进程事件循环心跳（检测主进程自身被阻塞） */
  start(): void {
    this.shouldStop = false
    this.lastHeartbeatAt = Date.now()
    const tick = (): void => {
      if (this.shouldStop) return
      const now = Date.now()
      const actual = now - this.lastHeartbeatAt
      const lag = actual - HEARTBEAT_MS
      this.lastHeartbeatAt = now
      if (lag > LAG_THRESHOLD_MS) {
        this.record({
          type: 'eventloop-lag',
          expectedMs: HEARTBEAT_MS,
          actualMs: actual,
          lagMs: lag
        })
      }
    }
    if (this.timerRegistry) {
      this.heartbeatHandle = this.timerRegistry.setInterval(tick, HEARTBEAT_MS, 'ui-health.heartbeat')
    } else {
      this.heartbeatHandle = setInterval(tick, HEARTBEAT_MS) as unknown as TimerHandle
    }
  }

  stop(): void {
    this.shouldStop = true
    if (this.heartbeatHandle) {
      if (this.timerRegistry) {
        this.timerRegistry.clearInterval(this.heartbeatHandle)
      } else {
        clearInterval(this.heartbeatHandle as unknown as ReturnType<typeof setInterval>)
      }
      this.heartbeatHandle = null
    }
  }

  /** 是否有待通知的严重事件 */
  hasPending(): boolean {
    return this.pendingEvents.length > 0
  }

  /**
   * 消费待通知的严重事件，返回注入文本（消费后清除）。
   * 主进程启动、前端就绪后调用一次；无事件返回 null。
   */
  consumePendingEvents(): string | null {
    if (this.pendingEvents.length === 0) return null
    const events = [...this.pendingEvents]
    this.pendingEvents = []
    this.savePending()
    const lines = events.map((e) => `- ${formatEvent(e)}`)
    return [
      '【运行监控】检测到上次运行期间 UI 异常事件（窗口卡死/崩溃），原因未知时请排查：',
      ...lines,
      '—— 完整时间线见 {userData}/logs/ui-events.log。若与工具调用/定时任务相关，考虑是 CPU 被密集任务打满导致；若崩溃前无卡死，可能是渲染进程 OOM 或 GPU 问题。'
    ].join('\n')
  }

  /** 记录事件：始终追加到日志文件；严重事件（卡死超阈值/崩溃/主进程延迟）写入 pending */
  private record(evt: UiHealthEvent): void {
    const rec: UiHealthEvent = { ...evt, timestamp: nowIso() }
    this.appendLogWithRetry(rec)
    // 严重性判定：崩溃类必通知；卡死超阈值/主进程延迟超阈值必通知
    const severe =
      evt.type === 'renderer-gone' ||
      evt.type === 'child-gone' ||
      (evt.type === 'unresponsive-end' && (evt.durationMs ?? 0) >= SEVERE_FREEZE_MS) ||
      (evt.type === 'eventloop-lag' && (evt.lagMs ?? 0) >= LAG_THRESHOLD_MS)
    if (severe) {
      this.pendingEvents.push(rec)
      this.savePending()
      // 实时通知：运行中即可推（如渲染进程卡死恢复、渲染崩溃、主进程 lag 恢复后的心跳），
      // 推成功则从 pending 移除，避免下次启动重复推送。
      // 按对象引用精确移除本条：不能用时间戳过滤——nowIso() 精度到秒，
      // 同一秒内若连续发生两条严重事件（如 renderer-gone 紧接 child-gone），
      // 时间戳相同会把未通知的那条也一并删掉，丢失一次待报事件。
      if (this.onSevere) {
        try {
          const notified = this.onSevere(formatEvent(rec))
          if (notified) {
            this.pendingEvents = this.pendingEvents.filter((e) => e !== rec)
            this.savePending()
          }
        } catch (err) {
          console.error('[ui-health] 实时通知失败（保留 pending 由启动消费兜底）:', err)
        }
      }
    }
    console.log(`[ui-health] ${formatEvent(rec)}`)
  }

  private appendLogWithRetry(rec: UiHealthEvent): void {
    if (this.writeBuffer.length > 0) {
      const buffered = this.writeBuffer.splice(0)
      for (const b of buffered) {
        this.tryAppendLog(b)
      }
    }
    this.tryAppendLog(rec)
  }

  private tryAppendLog(rec: UiHealthEvent): void {
    try {
      mkdirSync(dirname(this.logPath), { recursive: true })
      appendFileSync(this.logPath, JSON.stringify(rec) + '\n', 'utf-8')
    } catch (err) {
      console.error('[ui-health] 写事件日志失败:', err)
      if (this.writeBuffer.length < UiHealthMonitor.WRITE_BUFFER_MAX_SIZE) {
        this.writeBuffer.push(rec)
      }
    }
  }

  private savePending(): void {
    try {
      mkdirSync(dirname(this.pendingPath), { recursive: true })
      writeFileSync(this.pendingPath, JSON.stringify(this.pendingEvents, null, 2), 'utf-8')
    } catch (err) {
      console.error('[ui-health] 写 pending 失败:', err)
    }
  }

  private loadPending(): void {
    if (!existsSync(this.pendingPath)) return
    try {
      const raw = readFileSync(this.pendingPath, 'utf-8')
      this.pendingEvents = JSON.parse(raw) as UiHealthEvent[]
    } catch {
      this.pendingEvents = []
    }
  }
}

function formatEvent(e: UiHealthEvent): string {
  switch (e.type) {
    case 'unresponsive-start':
      // 隐私：URL 可能携带本机安装路径（file:///...），只输出是否为额外窗口
      return `[${e.timestamp}] 渲染进程开始无响应（${e.url ? '页面窗口' : '主窗口'}）`
    case 'unresponsive-end':
      return `[${e.timestamp}] 渲染进程恢复，卡死 ${((e.durationMs ?? 0) / 1000).toFixed(1)}s`
    case 'renderer-gone':
      return `[${e.timestamp}] 渲染进程崩溃 reason=${e.reason} exitCode=${e.exitCode}${e.durationMs ? `（崩溃前已卡死 ${(e.durationMs / 1000).toFixed(1)}s）` : ''}`
    case 'child-gone':
      return `[${e.timestamp}] ${e.processType} 子进程退出 reason=${e.reason} exitCode=${e.exitCode}`
    case 'eventloop-lag':
      return `[${e.timestamp}] 主进程事件循环延迟 ${(e.lagMs ?? 0) / 1000}s（期望 ${(e.expectedMs ?? 0) / 1000}s，实际 ${(e.actualMs ?? 0) / 1000}s）`
    default:
      return JSON.stringify(e)
  }
}
