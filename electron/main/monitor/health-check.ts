// ============================================================
// 健康检查模块：定时自检工作区代码能否正常运行
// ------------------------------------------------------------
// 背景（设计动机）：
// AI 需要能自检「工作区代码是否正常运行、有报错能否直接处理」——C 方案：
// Electron 主进程常驻模块。
// 前置约束：只有程序开启时启动（天然满足：主进程活着才跑），
// 且绝不能陷入死循环（AI 反复被叫醒处理同一个修不了的问题）。
//
// 防死循环设计（核心）：
// 1. 只在应用运行时启动：start()/stop() 随主进程生命周期，退出自动清理定时器
// 2. 事件队列天然节流：pushExternalEvent 入队后，仅前端 AI 空闲时触发
// （activation-manager 的 setActivationCallback 里已有 isFrontendIdle 判断）
// 3. AlertGate 状态机：错误指纹去重 + 冷却期 + 连续失败上限
// - 同指纹（错误没变）在冷却期内不重复提醒
// - 连续失败达上限后静默（只写日志/面板仍标红），错误稳定变化才重新提醒
// - 错误恢复后状态重置，下次失败从 1 重新计数
//
// 0.53.10 政策统一（重要，勿回退）：
// - **开发态与发行态使用同一套检查策略**：config.checks 决定跑不跑，不再由
//   `app.isPackaged` / `app.asar` / package.json 是否存在在构造期强制关闭检查项。
// - 工作区缺少执行材料（如分发包只有 out/、没有 tsconfig/vitest 源码）时，
//   每项检查返回 `unavailable` + 具体缺什么，面板/日志可见；**绝不伪装成通过**。
// - 单项检查抛错只影响该项（outcome=error），不中断整轮；其余检查照常执行。
// - 命令超时单独标识（timedOut），并按进程树终止，避免孤儿进程。
// ============================================================

import { app as electronApp } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ChildProcess } from 'child_process'
import { logError } from '../services/crash-logger'
import { buildCheckCommands, normalizeDriveUpper } from './health-commands'
import type { ActivationManager } from '../api/activation-manager'
import type { TimerRegistry, TimerHandle } from './timer-registry'
import type { ModuleRegistry } from './module-registry'
import type { HealthCheckOutcome, HealthCheckRepairEntry, HealthCheckStatus } from '@shared/types'
import { AlertGate, hashFingerprint, truncate } from './health-gate'
import { scanWorkspace } from './health-scan'
import { getCheckDefinition, type CheckContext, type RawCheckResult } from './health-check-registry'
import { killProcessTree, runHealthCommand, type HealthCommandResult } from './health-command'
import { keepTail } from './health-output'
import { dumpHealthOutput } from './health-dump'

import { runSemanticScan } from './health-scan-runner'
import { RUNTIME_TO_MODULE, loadConfig, type HealthCheckConfig, type RuntimeEventKind } from './health-config'

/** 首次检查延迟（毫秒）：避免和启动流程抢资源。
 * 日志实证：0-test 盲区（vitest worker 全灭）几乎都发生在 App 启动后 2s 首检——
 * 此时渲染进程、LLM 客户端、缓存清理都在抢资源，fork worker 容易起不来。
 * 提高到 20s 错开启动初始化高峰，窗口期由「尚未检查」灰点标注，不再误报红。 */
const HEALTH_CHECK_START_DELAY_MS = 20_000

/**
 * 静态语义扫描预算由 health-scan-runner.ts 按「文件上限 × 单文件最坏耗时 + worker 冷启动」
 * 推导（默认 25s，见该文件头注释）；此处不再保留裸 15s 常量。
 * `HealthCheckOptions.staticScanBudgetMs` 仅用于测试/嵌入覆盖。
 */

/**
 * 检查项 → 模块监控表的异常来源标识。
 * 同一模块（如 tools）可能被多个检查项同时标红；按来源分开记账，
 * 单项恢复不会把仍在失败的另一项刷绿（见 module-registry）。
 */
function moduleSourceOf(key: string): string {
  return `check:${key}`
}

/** 单次检查结果 */
export interface HealthCheckResult {
  key: string
  /** 仅 pass 为 true（unavailable/error 都不是通过） */
  ok: boolean
  outcome: HealthCheckOutcome
  output: string
  /** 无法执行的具体原因（outcome=unavailable 时非空） */
  reason?: string
  /** 命令超时被终止（与普通失败区分） */
  timedOut?: boolean
  /** 命令退出码 / 信号（命令类检查） */
  exitCode?: number | null
  signal?: string | null
}

/** 一次完整检查报告 */
export interface HealthReport {
  ok: boolean
  checks: HealthCheckResult[]
  /** 本次检查完成时间戳 */
  checkedAt: number
  /** 本轮因 stop()/重启而被取消（结果不完整，不应写入 lastReport） */
  cancelled?: boolean
}







import type { HealthCheckOptions } from './health-options'
export type { HealthCheckOptions } from './health-options'

export class HealthCheck {
  private config: HealthCheckConfig
  private configDir: string
  private workDir: string
  /** 数据目录根（files 检查扫描目标 + dumpFullOutput 落盘目标；不传回退 workDir） */
  private dataRoot: string
  /**
   * 是否运行在打包产物中。**仅用于展示与落盘位置选择，绝不用于关闭检查项**。
   * 判定来源：Electron 的 app.isPackaged（权威）或 workDir 以 app.asar 结尾（旧布局兼容）。
   */
  private packaged = false
  /** 检查命令表（构造时按 workDir 解析便携 node 生成，替代原模块级 npm 调用） */
  private checkCommands: Record<string, { cmd: string; timeoutMs: number }>
  private activationManager: ActivationManager | null
  private timerRegistry: TimerRegistry | null
  private moduleRegistry: ModuleRegistry | null
  private gate: AlertGate
  private timerHandle: TimerHandle | null = null
  private startDelayHandle: TimerHandle | null = null
  private runningCheck: Promise<HealthReport> | null = null
  private available = true
  private lastReport: HealthReport | null = null
  /** 修复记录（发现异常/恢复/静默/无法执行事件，面板展示用，新在前，最多 50 条） */
  private repairLog: HealthCheckRepairEntry[] = []
  /**
   * 轮次令牌：stop()/重启时自增。在飞轮次每完成一个 await 都核对令牌，
   * 不一致即停止后续检查并丢弃结果——避免旧轮次迟到覆盖新状态或发送告警。
   */
  private runToken = 0
  /** 正在运行的子进程（stop()/退出链据此终止整棵进程树） */
  private activeChildren = new Set<ChildProcess>()
  /** 已记录过「无法执行」的检查项（只记首次，避免每轮刷日志） */
  private unavailableKeys = new Set<string>()
  /** 运行时事件最近发生时间（用于「稳定窗口内无复发 → 恢复」判定） */
  private runtimeEventAt = new Map<RuntimeEventKind, number>()
  /** 运行时事件稳定恢复窗口（见 HealthCheckOptions.runtimeEventStableMs） */
  private runtimeEventStableMs: number
  /** 已停止标志：stop() 后迟到的 runNow 不再启动新命令（退出链清理不能被绕过） */
  private stopped = false
  /** 静态扫描预算（仅测试/嵌入覆盖；缺省由 health-scan-runner 推导） */
  private staticScanBudgetMs: number | undefined

  constructor(opts: HealthCheckOptions) {
    this.workDir = opts.workDir
    this.dataRoot = opts.dataRoot ?? opts.workDir
    this.configDir = opts.configDir
    this.staticScanBudgetMs = opts.staticScanBudgetMs
    this.checkCommands = buildCheckCommands(opts.workDir)
    this.activationManager = opts.activationManager ?? null
    this.timerRegistry = opts.timerRegistry ?? null
    this.moduleRegistry = opts.moduleRegistry ?? null
    this.config = loadConfig(opts.configDir)
    // 稳定窗口推导：默认检查间隔 30min → 60min；最低 30min。
    // 依据：崩溃若会复发，通常在同一使用时段内；一个完整检查周期无复发 + 本轮通过，
    // 才算恢复证据（避免「崩溃一次永远红到重启」）。
    this.runtimeEventStableMs =
      opts.runtimeEventStableMs ??
      Math.max(30 * 60_000, this.config.interval_minutes * 2 * 60_000)
    this.gate = new AlertGate({
      cooldownMs: this.config.cooldown_minutes * 60_000
    })
    // 打包判定只影响展示与落盘位置，不再改写 config.checks。
    // 历史教训（勿重犯）：0.52.9 用 app.isPackaged 在构造期把源码类检查全部关掉，
    // 结果开发态/发行态两套策略，且「缺少依赖」被伪装成「正常跳过」。
    // 纯 Node 单测下 electron 的 app 为 undefined：可选链 + try 兜底，保持非打包语义。
    let isPackagedEnv = false
    try {
      isPackagedEnv = electronApp?.isPackaged === true
    } catch {
      isPackagedEnv = false
    }
    this.packaged =
      opts.packaged ?? (isPackagedEnv || this.workDir.toLowerCase().endsWith('app.asar'))
  }

  /** 启动：延迟 20s 首检（避开启动高峰）+ 周期检查 */
  start(): void {
    if (!this.config.enabled) {
      console.info('[health-check] 已禁用（config.enabled=false）')
      return
    }
    if (!this.available) return
    // 幂等：已注册定时器则不再重复注册（重复 start 会让检查频率翻倍）
    if (this.timerHandle || this.startDelayHandle) return
    this.stopped = false
    console.info(`[health-check] 启动：每 ${this.config.interval_minutes} 分钟自检一次`)

    // 首次检查（延迟 20 秒，错开启动初始化高峰）
    if (this.timerRegistry) {
      this.startDelayHandle = this.timerRegistry.setTimeout(
        () => {
          this.runSafely()
        },
        HEALTH_CHECK_START_DELAY_MS,
        'health-check.start-delay'
      )
    } else {
      this.startDelayHandle = setTimeout(() => {
        this.runSafely()
      }, HEALTH_CHECK_START_DELAY_MS) as unknown as TimerHandle
    }

    // 周期检查
    const intervalMs = this.config.interval_minutes * 60_000
    if (this.timerRegistry) {
      this.timerHandle = this.timerRegistry.setInterval(
        () => {
          this.runSafely()
        },
        intervalMs,
        'health-check.interval'
      )
    } else {
      const handle = setInterval(() => {
        this.runSafely()
      }, intervalMs)
      this.timerHandle = handle as unknown as TimerHandle
    }
  }

  /** 定时器回调入口：必须吞掉 rejection 并留痕——否则会被 prelude 当成主进程未处理异常。 */
  private runSafely(): void {
    void this.runNow().catch((err) => {
      logError('health-check', `检查轮次异常：${err instanceof Error ? err.stack || err.message : String(err)}`)
    })
  }

  /** 停止：清理定时器 + 终止在飞检查的子进程树（随应用退出） */
  stop(): void {
    // 令牌自增：在飞轮次完成后会因令牌不一致而丢弃结果，不会向已关闭的应用推告警。
    this.runToken += 1
    this.stopped = true
    // 允许 stop() 后立刻 start()：旧轮次仍在收尾，但令牌已失效；runNow 的 finally
    // 只在 `runningCheck === task` 时清空，不会误清新轮次的句柄。
    this.runningCheck = null
    this.killActiveChildren()
    if (this.startDelayHandle) {
      if (this.timerRegistry) {
        this.timerRegistry.clearTimeout(this.startDelayHandle)
      } else {
        clearTimeout(this.startDelayHandle as unknown as ReturnType<typeof setTimeout>)
      }
      this.startDelayHandle = null
    }
    if (this.timerHandle) {
      if (this.timerRegistry) {
        this.timerRegistry.clearInterval(this.timerHandle)
      } else {
        clearInterval(this.timerHandle as unknown as ReturnType<typeof setInterval>)
      }
      this.timerHandle = null
    }
  }

  /** 终止仍在运行的检查命令（同步 taskkill，退出链里必须可靠收尾） */
  private killActiveChildren(): void {
    for (const child of this.activeChildren) {
      killProcessTree(child, true)
    }
    this.activeChildren.clear()
  }

  /**
   * 立即执行一轮完整检查（防重入：上一轮未完成则复用同一 Promise）。
   * stop() 后旧轮次的结果不会写入 lastReport，也不会推送告警。
   */
  async runNow(): Promise<HealthReport> {
    if (this.stopped) return this.cancelledReport([])
    if (this.runningCheck) return this.runningCheck
    const token = this.runToken
    const task = this.executeChecks(token)
    this.runningCheck = task
    try {
      const report = await task
      if (!report.cancelled && token === this.runToken) {
        this.lastReport = report
      }
      return report
    } finally {
      if (this.runningCheck === task) this.runningCheck = null
    }
  }

  /** 人工重置告警抑制状态（静默/冷却/连续失败计数）。最近报告保留，面板仍显示真实结果。 */
  resetAlertState(): void {
    this.gate.reset()
    this.unavailableKeys.clear()
    console.info('[health-check] 告警抑制状态已人工重置')
  }

  /**
   * 运行时事件上报（主进程崩溃监听接入：uncaughtException / unhandledRejection / render-process-gone）。
   * 与代码检查项共用 AlertGate：同指纹冷却，避免崩溃刷屏唤醒 AI；不做连续失败静默。
   */
  reportRuntimeEvent(kind: RuntimeEventKind, message: string): void {
    const key = `runtime:${kind}`
    this.runtimeEventAt.set(kind, Date.now())
    const fingerprint = hashFingerprint(message)
    const decision = this.gate.decide(key, false, fingerprint, Date.now())
    const time = new Date().toLocaleString('zh-CN')
    if (decision === 'alert') {
      const snippet = truncate(message, 800)
      logError('health-check', `运行时事件 ${kind}：\n${snippet}`)
      this.pushRepairLog(key, 'alert', truncate(message, 200))
      this.syncRuntimeModuleStatus(kind, truncate(message, 200))
      if (this.activationManager) {
        this.activationManager.pushExternalEvent(
          `【健康检查】运行时事件 ${kind}（${time}）：\n${snippet}\n——这是主进程/渲染进程崩溃事件（可能影响功能）。请先定位根因再针对性修复；若需重启应用或改架构，先告知用户再执行。`,
          true,
          `runtime:${kind}:${fingerprint}`
        )
      }
    }
    // cooldown：冷却期内不重复提醒，不记录（避免刷屏）
  }

  /** 运行时事件恢复标记（如渲染进程 reload 成功）：清状态 + 记录时间线 */
  markRuntimeRecovered(kind: RuntimeEventKind): void {
    const key = `runtime:${kind}`
    this.runtimeEventAt.delete(kind)
    if (this.gate.decide(key, true, '', Date.now()) === 'recovered') {
      console.info(`[health-check] ${key} 已恢复`)
      this.pushRepairLog(key, 'recovered', '运行时事件已恢复')
      this.syncRuntimeModuleRecovered(kind)
    }
  }

  /** 最近一次检查报告（无则 null） */
  getLastReport(): HealthReport | null {
    return this.lastReport
  }

  /**
   * 前端监控面板用状态快照（viz:getAll 附带返回）。
   * 内存态实时读取：available/enabled/interval 来自构造与配置，checks 来自最近报告；
   * 从未检查过时 checks 用配置的 key 填「尚未检查」占位。
   */
  getStatusSnapshot(): HealthCheckStatus {
    const enabledKeys = Object.keys(this.config.checks).filter((k) => this.config.checks[k])
    const report = this.lastReport
    const lastRunAt = report?.checkedAt ?? null
    const checks = enabledKeys.map((key) => {
      const item = report?.checks.find((r) => r.key === key)
      const def = getCheckDefinition(key)
      return {
        key,
        label: def?.label ?? key,
        // null = 尚未检查（启动 20s 首检延迟期内、或该项未启用场景），与 ModuleInfo.ok 的 null=未知语义对齐，
        // 避免未检查项被前端 `!ok` 当成“失败”计红
        ok: item?.ok ?? null,
        outcome: item?.outcome ?? null,
        output: item?.output ?? '',
        reason: item?.reason ?? '',
        checkedAt: item ? lastRunAt : null
      }
    })
    return {
      available: this.available,
      packaged: this.packaged,
      enabled: this.config.enabled,
      interval_minutes: this.config.interval_minutes,
      lastRunAt,
      running: this.runningCheck !== null,
      overallOk: report === null ? null : report.ok,
      // 有「无法执行」时不得显示为健康；面板据此展示「部分检查无法执行」而非「全部通过」
      incomplete: checks.some((c) => c.outcome === 'unavailable'),
      checks,
      repairLog: this.repairLog
    }
  }

  /**
   * 一轮完整检查。
   * 错误隔离：每项检查单独 try/catch——一项抛错只记为该 check 的 outcome=error，
   * 不阻断后续检查；整轮结束仍汇总全部项。
   * 取消：stop()/重启会让令牌失效，循环在每个 await 后核对并提前返回 cancelled。
   */
  private async executeChecks(token: number): Promise<HealthReport> {
    const results: HealthCheckResult[] = []
    const keys = Object.keys(this.config.checks)
    const ctx: CheckContext = {
      workDir: this.workDir,
      dataRoot: this.dataRoot,
      packaged: this.packaged,
      commands: this.checkCommands,
      runCommand: async (spec) => {
        const r = await this.runCommand(spec, token)
        // null = 令牌失效（stop/重启）：让本轮在下一个检查点被丢弃；
        // 定义层不感知令牌，统一转成可结算的 error 结果。
        return r ?? { outcome: 'error', output: '检查已取消（stop/重启）' }
      },
      runSemantic: (kind) => this.checkStatic(kind, token),
      scanFiles: () => this.checkStatic('files', token)
    }
    // 待统一上报的失败项（AlertGate 判定为 alert）：全部检查项跑完后一次性推给 AI，
    // 避免「typecheck 失败→唤醒→code-review 还没跑又唤醒一次」的边检查边上报。
    const alerts: Array<{
      key: string
      outcome: HealthCheckOutcome
      output: string
      dumpPath: string | null
      timedOut: boolean
      fingerprint: string
      reason?: string
    }> = []

    for (const key of keys) {
      if (!this.config.checks[key]) continue
      if (token !== this.runToken) return this.cancelledReport(results)

      // ① 注册表查定义。未知 key 不走「静默跳过」——配置里写了就必须有结果。
      const def = getCheckDefinition(key)
      if (!def) {
        const output = `未知检查项「${key}」：config.checks 引用了未注册的 key。请在 health-check-registry.ts 注册该检查，或从配置中移除。`
        logError('health-check', output)
        results.push({ key, ok: false, outcome: 'error', output, reason: output })
        continue
      }

      // ② 执行材料是否具备（缺材料 = unavailable，明确「无法执行」，不伪装成通过）
      const unavailableReason = def.availability(this.workDir)
      if (unavailableReason) {
        results.push({
          key,
          ok: false,
          outcome: 'unavailable',
          output: '',
          reason: unavailableReason
        })
        this.noteUnavailable(key, unavailableReason)
        // 无法验证 ≠ 仍然失败：清掉本检查项在模块表上的旧红点，
        // 否则「先失败、后缺依赖」会让模块永久停在陈旧错误上。
        this.syncModuleStatus(def.moduleId, key, true, '')
        continue
      }
      if (this.unavailableKeys.delete(key)) {
        console.info(`[health-check] ${key} 已恢复可执行`)
      }

      // ③ 单项执行（异常只影响本项）
      let raw: RawCheckResult | null
      try {
        raw = await def.run(ctx)
      } catch (err) {
        const detail = err instanceof Error ? err.stack || err.message : String(err)
        raw = { outcome: 'error', output: `检查器内部错误：${detail}`, reason: '检查器自身异常（不是业务检查失败）' }
        logError('health-check', `${key} 检查器内部错误：\n${detail}`)
      }
      if (raw === null || token !== this.runToken) return this.cancelledReport(results)

      const result: HealthCheckResult = {
        key,
        ok: raw.outcome === 'pass',
        outcome: raw.outcome,
        output: raw.output,
        ...(raw.reason ? { reason: raw.reason } : {}),
        ...(raw.timedOut ? { timedOut: true } : {}),
        ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
        ...(raw.signal !== undefined ? { signal: raw.signal } : {})
      }

      if (raw.outcome === 'unavailable') {
        results.push(result)
        this.noteUnavailable(key, raw.reason ?? '未知原因')
        this.syncModuleStatus(def.moduleId, key, true, '')
        continue
      }

      // ④ 冷却去重：同指纹在冷却期内不重复唤醒；不做连续失败静默。
      const passed = raw.outcome === 'pass'
      const fingerprint = passed ? '' : hashFingerprint(raw.output)
      const decision = this.gate.decide(key, passed, fingerprint, Date.now())
      // 只在真正要唤醒 AI 时落盘完整输出；冷却期间不重复写大日志。
      const dumpPath =
        !passed && decision === 'alert'
          ? await dumpHealthOutput({
              key,
              output: raw.output,
              packaged: this.packaged,
              workDir: this.workDir,
              dataRoot: this.dataRoot
            })
          : null

      // 模块监控表：失败/内部错误 → 标红；通过 → 只清除本检查项这一来源
      this.syncModuleStatus(def.moduleId, key, passed, passed ? '' : truncate(raw.output, 200))

      if (!passed && decision === 'alert') {
        alerts.push({
          key,
          outcome: raw.outcome,
          output: raw.output,
          dumpPath,
          timedOut: raw.timedOut === true,
          fingerprint,
          ...(raw.reason ? { reason: raw.reason } : {})
        })
      } else if (passed && decision === 'recovered') {
        console.info(`[health-check] ${key} 已恢复`)
        this.pushRepairLog(key, 'recovered', '检查恢复正常')
      }

      // 面板/报告 output：中位截断 + 附完整落盘路径（能看到全文在哪）
      results.push({
        ...result,
        output: passed
          ? ''
          : `${keepTail(raw.output, 2000)}${dumpPath ? `\n\n完整输出已落盘：\n${dumpPath}` : ''}`
      })
    }

    if (token !== this.runToken) return this.cancelledReport(results)
    // 全部检查项跑完后统一上报一次：一次唤醒携带所有失败项（各自修复指引 + 完整输出落盘路径）。
    if (alerts.length > 0) {
      this.notifyAlerts(alerts)
    }
    const report: HealthReport = {
      ok: results.every((r) => r.outcome === 'pass'),
      checks: results,
      checkedAt: Date.now()
    }
    // 运行时事件的恢复证据：本轮检查通过 + 稳定窗口内没有再次崩溃。
    // 不是「崩溃一次就永远红到重启」，也不是「刚崩完就当没事」。
    if (report.ok) this.recoverStableRuntimeEvents(report.checkedAt)
    return report
  }

  /** 稳定窗口内无新运行时事件且本轮健康 → 标记对应事件恢复（清模块来源红点） */
  private recoverStableRuntimeEvents(now: number): void {
    for (const [kind, at] of this.runtimeEventAt) {
      if (now - at < this.runtimeEventStableMs) continue
      this.markRuntimeRecovered(kind)
    }
  }

  /** 已停止/重启：返回取消报告（不写 lastReport、不推告警） */
  private cancelledReport(results: HealthCheckResult[]): HealthReport {
    return { ok: false, checks: results, checkedAt: Date.now(), cancelled: true }
  }

  /** 「无法执行」只记首次，避免每轮刷日志；状态本身每轮都出现在报告/面板里 */
  private noteUnavailable(key: string, reason: string): void {
    if (this.unavailableKeys.has(key)) return
    this.unavailableKeys.add(key)
    console.warn(`[health-check] ${key} 无法执行：${reason}`)
    this.pushRepairLog(key, 'unavailable', truncate(reason, 300))
  }

  /**
   * 静态检查（不走命令）：
   * - files = 关键文件存在性 + 异常残留（.orig/.rej）
   * - code-review = 代码质量语义评审（health-semantic-scan）
   * - uiux = UI/UX 审计（health-semantic-scan）
   * 输出 issues 列表（每项一行，可定位：文件:行号）。
   */
  private async checkStatic(
    key: 'files' | 'code-review' | 'uiux',
    token: number
  ): Promise<RawCheckResult> {
    if (key !== 'files') {
      // 语义扫描放到 worker：主线程不被同步 readdir/readFile 冻结；
      // worker 可被硬超时 terminate()，这是同步代码唯一可靠的抢占方式。
      // 0 文件 = 没有可审计对象（分发包只有 out/）→ unavailable，不能返回「0 问题」冒充通过。
      const r = await runSemanticScan({
        kind: key,
        root: this.workDir,
        ...(this.staticScanBudgetMs !== undefined ? { timeoutMs: this.staticScanBudgetMs } : {})
      })
      // 顺序有意：先判「扫描器失败/超时」，再判「没扫完」，最后判「0 文件」。
      // 预算耗尽时 collectFiles 可能返回 files=[] 且 complete=false——若先判 0 文件，
      // 会把「扫描不完整」误报成「分发包没有可审计对象」。
      if (r.failed) {
        return { outcome: 'error', output: r.summary, reason: '扫描器内部错误/worker 异常' }
      }
      if (r.timedOut) {
        return {
          outcome: 'timeout',
          output: r.summary,
          reason: `静态扫描超过 ${Math.round(r.budgetMs / 1000)}s 硬超时，worker 已终止，结果不完整`
        }
      }
      if (!r.complete) {
        return {
          outcome: 'timeout',
          output: `${r.summary}\n扫描未完成（达到 ${Math.round(r.budgetMs / 1000)}s 预算或 ${r.files} 文件上限），结果不完整（不得视为通过）。\n${r.issues.join('\n')}`,
          reason: '静态扫描未完成，结果不完整'
        }
      }
      if (r.files === 0) {
        return {
          outcome: 'unavailable',
          output: '',
          reason: `无法执行：在 ${this.workDir} 下未扫描到任何源码文件（分发包只含 out/，没有可审计对象）`
        }
      }
      if (r.issues.length === 0) return { outcome: 'pass', output: '' }
      return { outcome: 'fail', output: [r.summary, ...r.issues].join('\n') }
    }

    if (token !== this.runToken) return { outcome: 'error', output: '检查已取消' }
    const issues: string[] = []
    // 1. 关键文件存在性。
    // 发行态检查部署目录（数据根可写可用），开发态检查源码工作区（package.json/tsconfig）。
    // 这是**执行环境适配**，不是检查策略分流：files 检查两端都启用、语义都是「关键材料缺失即失败」。
    if (this.packaged) {
      if (!existsSync(this.dataRoot)) issues.push(`数据目录根缺失: ${this.dataRoot}`)
    } else {
      for (const f of ['package.json', 'tsconfig.json']) {
        if (!existsSync(join(this.workDir, f))) issues.push(`关键文件缺失: ${f}`)
      }
    }
    // 2. 异常残留（排除大目录，限制扫描量）。
    // 发行态 workDir 可能是只读 asar，改扫数据目录根——数据文件同源受控，残留同样会破坏运行。
    const scanRoot = this.packaged ? this.dataRoot : this.workDir
    const { residues } = scanWorkspace(scanRoot)
    for (const p of residues.slice(0, 5)) issues.push(`异常残留文件: ${p}`)
    if (residues.length > 5) issues.push(`…另有 ${residues.length - 5} 个残留文件`)
    return issues.length ? { outcome: 'fail', output: issues.join('\n') } : { outcome: 'pass', output: '' }
  }
  /**
   * 全部检查完成后统一上报 AI（替代原「每个检查项失败立即上报」）。
   * 一次唤醒携带所有失败项：各自的中位截断输出、完整输出落盘路径、按检查项类型的修复指引。
   * 仍受 AlertGate 约束：alerts 里只有本轮 gate 判定为 alert 的检查项；
   * 冷却期/silence 的项不在此列（对应状态已在 executeChecks 循环内写入修复日志）。
   */
  private notifyAlerts(
    alerts: Array<{
      key: string
      outcome: HealthCheckOutcome
      output: string
      dumpPath: string | null
      timedOut: boolean
      fingerprint: string
      reason?: string
    }>
  ): void {
    const time = new Date().toLocaleString('zh-CN')
    const total = alerts.length
    const parts = alerts.map((a, i) => {
      // 注入上限从 800 提高到 4000：头部命令/运行信息 + 尾部 vitest 汇总（中位截断），
      // 让 AI 能直接读到的上下文显著变多；全文始终有完整落盘文件可读。
      const snippet = keepTail(a.output, 4000)
      const fullRef = a.dumpPath
        ? `\n\n完整输出已落盘（可读取该文件获取全部报错内容，含被省略的中段）：\n${a.dumpPath}`
        : ''
      const label =
        a.outcome === 'timeout'
          ? a.timedOut
            ? '命令超时（已请求终止进程树）'
            : '检查超时（静态扫描预算耗尽，结果不完整）'
          : a.outcome === 'error'
            ? '检查器内部错误'
            : '失败'
      return `[${i + 1}/${total}] ${a.key} ${label}：\n${snippet}${fullRef}\n——${getCheckDefinition(a.key)?.repairHint ?? '请先定位根因，再针对性修复'}`
    })
    const combined = parts.join('\n\n')
    logError('health-check', `本轮共 ${total} 项检查未通过：\n${combined}`)
    for (const a of alerts) {
      this.pushRepairLog(a.key, 'alert', keepTail(a.output, 200))
    }
    if (!this.activationManager) return
    // 按检查项类型引导 AI 用对应专业能力修复。
    // 为什么不写具体技能名（曾经写死 bug-diagnosis / code-review / ui-ux-pro-max）：
    // 技能只有用户级(skills/)与领域级(skills_domains/)两层，均不随安装包分发，
    // 打包分发版技能池恒为空；写死名字会让 AI 被唤醒来后去 use_skill 一个不存在的技能，
    // 白烧一轮唤醒与 token（ui-ux-pro-max 更是从未存在过）。故只描述「要做什么」——
    // 用户若自装了对应技能，AI 会按描述自然匹配并加载，空池时也照样能直接动手。
    //
    // 去重键：同一批失败（同检查项 + 同归一化指纹）在队列里只保留一条。
    // 防的是「AI 一直没消费（无前台会话/窗口不可用）→ 每轮冷却后再入队」的无界堆积。
    const dedupeKey = `health-check:${alerts
      .map((a) => `${a.key}:${a.fingerprint}`)
      .sort()
      .join('|')}`
    this.activationManager.pushExternalEvent(
      `【健康检查】工作区代码自检完成，发现 ${total} 项检查未通过（${time}）：\n${combined}\n——请逐项定位根因并针对性修复；修复后下次检查通过即自动恢复。若当前处于会话模式（aiMode=chat），请先告知用户并请其切换到编码/任务模式，再动手修复。若修复涉及架构变更或需要重启应用，先告知用户再执行。`,
      true,
      dedupeKey
    )
  }

  /** 记录修复事件到内存日志（面板展示用，新在前，最多 50 条） */
  private pushRepairLog(key: string, kind: HealthCheckRepairEntry['kind'], detail: string): void {
    this.repairLog.unshift({ time: Date.now(), key, kind, detail })
    if (this.repairLog.length > 50) this.repairLog.length = 50
  }

  /** 检查项失败/恢复 → 同步模块监控表标红/变绿（按检查项来源分开记账） */
  private syncModuleStatus(moduleId: string, key: string, ok: boolean, detail: string): void {
    if (!this.moduleRegistry) return
    const source = moduleSourceOf(key)
    if (ok) this.moduleRegistry.markRecovered(moduleId, source)
    else this.moduleRegistry.reportIssue(moduleId, detail || key, source)
  }

  /** 运行时事件 → 同步模块监控表标红（每个事件类型各占一个来源） */
  private syncRuntimeModuleStatus(kind: RuntimeEventKind, detail: string): void {
    if (!this.moduleRegistry) return
    this.moduleRegistry.reportIssue(RUNTIME_TO_MODULE[kind], detail, `runtime:${kind}`)
  }

  /** 运行时事件恢复 → 只清除该事件类型的来源，不影响其它来源 */
  private syncRuntimeModuleRecovered(kind: RuntimeEventKind): void {
    if (!this.moduleRegistry) return
    this.moduleRegistry.markRecovered(RUNTIME_TO_MODULE[kind], `runtime:${kind}`)
  }

  /**
   * 执行检查命令。
   * - 超时由 health-command 统一处理：单独 outcome=timeout + 进程树终止（taskkill /T /F），
   *   不再把超时混成普通失败；
   * - 子进程登记进 activeChildren，stop()/退出链可同步终止；
   * - 令牌失效（stop/重启）返回 null，调用方丢弃本轮。
   * 输出策略：stdout + stderr 合并（stdout 在前）——vitest 的 worker 启动失败等错误常走
   * stderr，若「stdout 非空即丢弃 stderr」，0-test 盲区时真实错误会被吞掉。
   */
  private async runCommand(
    spec: { cmd: string; timeoutMs: number },
    token: number
  ): Promise<{
    outcome: HealthCheckOutcome
    output: string
    timedOut?: boolean
    exitCode?: number | null
    signal?: string | null
  } | null> {
    const r: HealthCommandResult = await runHealthCommand({
      cmd: spec.cmd,
      cwd: normalizeDriveUpper(this.workDir),
      timeoutMs: spec.timeoutMs,
      onSpawn: (child) => this.activeChildren.add(child),
      onSettle: (child) => this.activeChildren.delete(child)
    })
    if (token !== this.runToken) return null
    return {
      outcome: r.outcome,
      output: r.output,
      ...(r.timedOut ? { timedOut: true } : {}),
      exitCode: r.exitCode,
      signal: r.signal
    }
  }
}

export { AlertGate, hashFingerprint, normalizeFingerprintText, sampleFingerprintText, truncate } from './health-gate'
export type { AlertDecision, AlertGateState } from './health-gate'
export {
  DEFAULT_HEALTH_CHECK_CONFIG,
  loadConfig,
  type HealthCheckConfig,
  type HealthCheckKey,
  type RuntimeEventKind
} from './health-config'
export { buildCheckCommands, normalizeDriveUpper, type CheckCommandSpec, type CommandCheckKey } from './health-commands'
export { scanWorkspace } from './health-scan'
export { scanCodeReviewIssues, scanUiUxIssues } from './health-semantic-scan'
export { decodeChildOutput, keepTail, stripAnsi } from './health-output'
export {
  BUILTIN_CHECK_DEFINITIONS,
  createDefaultChecks,
  getCheckDefinition,
  type CheckContext,
  type HealthCheckDefinition,
  type RawCheckResult
} from './health-check-registry'
export { runHealthCommand, killProcessTree } from './health-command'
export type { HealthCommandResult, HealthCommandOutcome } from './health-command'
