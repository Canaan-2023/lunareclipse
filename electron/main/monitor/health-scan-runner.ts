/**
 * 语义扫描的 worker 调度（0.53.10）。
 *
 * 为什么需要硬超时：扫描是同步实现，JS 定时器无法中断正在执行的同步代码。
 * 唯一可靠的抢占方式是把它放进 worker_threads，由主线程 `terminate()`。
 *
 * 预算推导（不写裸 15s）：
 * - 单文件预算 10ms：1MB 上限 + 3 次掩码/规则遍历；本仓实测 804 文件 code-review 1.17s
 *   （≈1.45ms/文件）、uiux 0.36s（≈0.45ms/文件），10ms 是 7 倍慢盘余量。
 * - 扫描上限 2000 文件（MAX_SCAN_FILES，见 health-semantic-scan.ts）。
 * - worker 启动预算 5s：冷启动加载 bundle + 文件系统缓存未命中。
 * - 硬超时 = 5s + 2000 × 10ms = 25s；正常本仓约 1~3s，25s 只在极端慢盘/杀软扫描时命中。
 * 该值同时作为 worker 内部的协作式截止时间；主线程再留 2s 终止宽限。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import {
  MAX_SCAN_FILES,
  scanCodeReviewIssues,
  scanUiUxIssues,
  type SemanticScanResult
} from './health-semantic-scan'

/** 单文件最坏耗时预算（见文件头推导） */
const SCAN_FILE_BUDGET_MS = 10
/** worker 冷启动预算（bundle 加载 + 首次文件系统访问） */
const SCAN_WORKER_STARTUP_MS = 5_000
/** 主线程硬超时（= 协作式截止 + 终止宽限） */
const SCAN_HARD_TIMEOUT_MS = SCAN_WORKER_STARTUP_MS + MAX_SCAN_FILES * SCAN_FILE_BUDGET_MS
/** 硬超时后给 worker.terminate() 的收尾宽限 */
const WORKER_TERMINATE_GRACE_MS = 2_000
/** worker 产物文件名（electron.vite.config.ts 的 main 第二个入口） */
const WORKER_FILE = 'health-scan-worker.js'

export type SemanticScanKind = 'code-review' | 'uiux'

export interface SemanticScanRunResult extends SemanticScanResult {
  /** 是否真的在 worker 中执行（false = 未找到 worker 产物，回退同步扫描） */
  worker: boolean
  /** 是否因硬超时被终止 */
  timedOut: boolean
  /** 是否因 worker 内部错误/异常退出而失败 */
  failed: boolean
  /** 本轮使用的硬超时（毫秒），用于告警文案 */
  budgetMs: number
  elapsedMs: number
}

export interface RunSemanticScanOptions {
  kind: SemanticScanKind
  root: string
  /** 覆盖硬超时（测试/嵌入用）；缺省按文件上限推导 */
  timeoutMs?: number
  /** 覆盖 worker 产物路径（测试用） */
  workerPath?: string
}

function fallbackScan(kind: SemanticScanKind, root: string, deadlineMs: number): SemanticScanResult {
  return kind === 'code-review'
    ? scanCodeReviewIssues(root, { deadlineMs })
    : scanUiUxIssues(root, { deadlineMs })
}

/**
 * 在 worker 中执行一轮语义扫描；worker 产物不存在时回退同步扫描（仅测试/未构建场景）。
 * 永不 reject：所有失败都以 `failed/timedOut` 表达。
 */
export function runSemanticScan(opts: RunSemanticScanOptions): Promise<SemanticScanRunResult> {
  const startedAt = Date.now()
  const timeoutMs = opts.timeoutMs ?? SCAN_HARD_TIMEOUT_MS
  const workerPath = opts.workerPath ?? join(__dirname, WORKER_FILE)

  // 未构建且处于测试环境 → 同步回退（vitest 直接加载 TS 源码，没有 out/main 产物）。
  // 非测试环境缺 worker = 构建/打包缺陷，必须显式失败，不能静默回退到阻塞主线程的同步扫描。
  if (!existsSync(workerPath)) {
    const inTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
    if (inTest) {
      const r = fallbackScan(opts.kind, opts.root, timeoutMs)
      return Promise.resolve({
        ...r,
        worker: false,
        timedOut: false,
        failed: false,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - startedAt
      })
    }
    return Promise.resolve({
      summary: `扫描 worker 产物缺失：${workerPath}（构建/打包缺陷，拒绝回退到阻塞主线程的同步扫描）`,
      issues: [],
      files: 0,
      complete: false,
      worker: false,
      timedOut: false,
      failed: true,
      budgetMs: timeoutMs,
      elapsedMs: Date.now() - startedAt
    })
  }

  return new Promise((resolve) => {
    let settled = false
    let worker: Worker
    try {
      worker = new Worker(workerPath, {
        workerData: { kind: opts.kind, root: opts.root, deadlineMs: timeoutMs }
      })
    } catch {
      // Worker 构造失败（产物损坏/权限）：回退同步扫描并标记 failed，由调用方告警。
      const r = fallbackScan(opts.kind, opts.root, timeoutMs)
      resolve({
        ...r,
        worker: false,
        timedOut: false,
        failed: true,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - startedAt
      })
      return
    }

    const finish = (result: SemanticScanRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        summary: `扫描超过 ${Math.round(timeoutMs / 1000)}s 硬超时，worker 已终止（结果不完整）`,
        issues: [],
        files: 0,
        complete: false,
        worker: true,
        timedOut: true,
        failed: false,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - startedAt
      })
    }, timeoutMs + WORKER_TERMINATE_GRACE_MS)

    worker.once('message', (msg: SemanticScanResult) => {
      finish({
        ...msg,
        worker: true,
        timedOut: false,
        failed: false,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - startedAt
      })
    })
    worker.once('error', (err: Error) => {
      finish({
        summary: `扫描 worker 内部错误：${err.message}`,
        issues: [],
        files: 0,
        complete: false,
        worker: true,
        timedOut: false,
        failed: true,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - startedAt
      })
    })
    worker.once('exit', (code) => {
      if (settled) return
      finish({
        summary: `扫描 worker 异常退出（code=${code}）`,
        issues: [],
        files: 0,
        complete: false,
        worker: true,
        timedOut: false,
        failed: true,
        budgetMs: timeoutMs,
        elapsedMs: Date.now() - startedAt
      })
    })
  })
}
