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
// - 同一错误连续失败达上限后彻底静默（只写日志），错误变化才重新提醒
// - 错误恢复后状态重置，下次失败从 1 重新计数
// 4. 打包后自动失效：workDir 指向 asar 归档即禁用（代码自检只属于源码工作区；运行时事件监控不受影响）
// ============================================================

import { exec } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { join } from 'path'
import { TextDecoder } from 'util'
import { logError } from '../services/crash-logger'
import { resolveNodeExe } from '../utils/node-runtime'
import { detectHardware, deriveConcurrency } from '../utils/hardware-profiler'
import type { ActivationManager } from '../api/activation-manager'
import type { TimerRegistry, TimerHandle } from './timer-registry'
import type { ModuleRegistry } from './module-registry'
import type { HealthCheckRepairEntry, HealthCheckStatus } from '@shared/types'
import { AlertGate, hashFingerprint, truncate } from './health-gate'
import { scanWorkspace } from './health-scan'

import { scanCodeReviewIssues, scanUiUxIssues } from './health-semantic-scan'

/**
 * 检查项 key：
 * - files = 文件层检查（关键文件/异常残留，不走命令）
 * - code-review = 代码质量语义评审（静态扫描：调试残留/类型绕过/安全反模式/any 滥用）
 * - uiux = UI/UX 审计（静态扫描：可访问性/硬编码色/字体回退，由 UI/UX 专家视角把关）
 */
export type HealthCheckKey =
  | 'typecheck'
  | 'test'
  | 'lint'
  | 'build'
  | 'files'
  | 'code-review'
  | 'uiux'

/** 运行时事件类型（主进程崩溃监听接入，走同一 AlertGate 防死循环） */
export type RuntimeEventKind = 'uncaughtException' | 'unhandledRejection' | 'render-process-gone'

/**
 * 检查项/运行时事件 → 架构模块映射（模块监控表标红用）。
 * 设计：健康检查发现异常的是"工作区代码/运行主体"，映射到受影响最大的模块：
 * - 代码检查失败 → 工具注册表（工具依赖工作区代码可运行）
 * - 文件层异常 → 工作区服务
 * - 主进程崩溃 → 主进程入口
 * - 渲染进程崩溃 → 渲染界面
 */
const CHECK_TO_MODULE: Record<HealthCheckKey, string> = {
  typecheck: 'tools',
  test: 'tools',
  lint: 'tools',
  build: 'tools',
  files: 'workspace',
  'code-review': 'tools',
  uiux: 'render-ui'
}
const RUNTIME_TO_MODULE: Record<RuntimeEventKind, string> = {
  uncaughtException: 'main',
  unhandledRejection: 'main',
  'render-process-gone': 'render-ui'
}

/** 健康检查配置（持久化到 {dataDir}/.health_check/config.json） */
export interface HealthCheckConfig {
  /** 总开关 */
  enabled: boolean
  /** 检查间隔（分钟） */
  interval_minutes: number
  /** 各检查项开关 */
  checks: Record<HealthCheckKey, boolean>
  /** 同指纹错误冷却期（分钟）：冷却期内不重复提醒 */
  cooldown_minutes: number
  /** 同一错误连续失败达此数后静默（防死循环），错误变化才重置 */
  max_consecutive_failures: number
}

export const DEFAULT_HEALTH_CHECK_CONFIG: HealthCheckConfig = {
  enabled: true,
  interval_minutes: 30,
// typecheck/test/files/code-review/uiux 默认开（快、无副作用）；lint 慢且噪音多；build 与 dev 产物冲突，默认关
  checks: {
    typecheck: true,
    test: true,
    lint: false,
    build: false,
    files: true,
    'code-review': true,
    uiux: true
  },
  cooldown_minutes: 30,
  max_consecutive_failures: 3
}

/** 首次检查延迟（毫秒）：避免和启动流程抢资源。
 * 日志实证：0-test 盲区（vitest worker 全灭）几乎都发生在 App 启动后 2s 首检——
 * 此时渲染进程、LLM 客户端、缓存清理都在抢资源，fork worker 容易起不来。
 * 提高到 20s 错开启动初始化高峰，窗口期由「尚未检查」灰点标注，不再误报红。 */
const HEALTH_CHECK_START_DELAY_MS = 20_000

/**
 * Windows 下把绝对路径的盘符统一为大写。
 * 背景：Electron 的 app.getAppPath()/process.execPath 可能返回小写盘符（d:\...），
 * 而 vite-node 在 worker 侧解析 node_modules 时输出大写盘符（D:/...）。Node ESM
 * 模块缓存以 URL 字符串（含盘符大小写）为 key，同一物理文件会因此被实例化两次，
 * vitest 的 chunk 模块级状态（runner/defaultSuite）随之分裂——collect 在实例 A 设置
 * runner，测试文件 import 'vitest' 在实例 B 执行 describe，B 的 runner 永远 undefined，
 * 表现为此前反复出现的 127 全灭 `TypeError: reading 'config'`。统一 exec 链路的
 * 盘符大小写（node 可执行文件 + cwd）即消除双实例。
 */
function normalizeDriveUpper(p: string): string {
  return /^[a-zA-Z]:[\\/]/.test(p) ? `${p[0].toUpperCase()}${p.slice(1)}` : p
}

/** 检查命令映射（cwd = 工作区 app 目录；files 检查项不走命令，走静态检查）。
 * 不再走 npm run（无全局 npm 机器上 exec 报 'npm' is not recognized），
 * 改为便携 node 直接跑 node_modules 里的工具入口，语义与 package.json scripts 逐一等价。 */
/** 走外部命令的检查项（files/code-review/uiux 均走静态检查，不走命令，见 executeChecks）。 */
function buildCheckCommands(
  workDir: string
): Record<Exclude<HealthCheckKey, 'files' | 'code-review' | 'uiux'>, { cmd: string; timeoutMs: number }> {
  const node = normalizeDriveUpper(resolveNodeExe(workDir))
  const n = (script: string): string => `"${node}" ${script}`
  // 测试并发不写死：按本机硬件（逻辑核/内存）自动推导，换机器自动适配。
  // 默认策略留一半核给系统与前台（App 运行中后台跑测试不挤占 UI），见 hardware-profiler。
  const testWorkers = deriveConcurrency(detectHardware())
  return {
    // = npm run typecheck（typecheck:node && typecheck:web）
    typecheck: {
      cmd: `${n('node_modules\\typescript\\bin\\tsc --noEmit -p tsconfig.node.json --composite false')} && ${n('node_modules\\typescript\\bin\\tsc --noEmit -p tsconfig.web.json --composite false')}`,
      timeoutMs: 180_000
    },
    // = npm run test:unit（排除 e2e 网络测试——依赖真实网络，网络抖动会误报失败）
    // 出包门禁回归单测（package-clean.test.ts）已随出包链迁至仓库根 build/test/
    //（0.51.7，见 VERSIONING.md 2.2），app/test 下不再存在，健康检查只跑 app 侧单元测试；
    // 门禁打包时由 build/ 下 `npm run dist:win` 开头的 test:gate 执行，日常自检不背打包门禁。
    // 并行优化（2026-09-24）：原 --pool=forks --no-file-parallelism 强制单文件串行，
    //  全量 128 文件/1329 用例实测约 102s → 提速瓶颈在串行。改为 forks 并行，
    // worker 数由硬件自动推导（本机 32 核默认策略→16 worker，实测约 15-20s，留一半核给前台）。
    // 排障实录：曾临时改 --pool=threads 对照（threads 同样 127 全灭，证伪子进程链路；
    // 真因是 Windows 盘符大小写导致 Node ESM 双实例，见 normalizeDriveUpper 注释），
    // 已恢复并沿用 forks。
    test: {
      cmd: `${n(`node_modules\\vitest\\vitest.mjs run --exclude "test/e2e-*.test.ts" --pool=forks --maxWorkers=${testWorkers}`)}`,
      timeoutMs: 300_000
    },
    // = npm run lint
    lint: { cmd: n('node_modules\\eslint\\bin\\eslint.js . --ext .ts,.tsx'), timeoutMs: 180_000 },
    // = npm run build
    build: { cmd: n('node_modules\\electron-vite\\bin\\electron-vite.js build'), timeoutMs: 300_000 }
  }
}

/** 单次检查结果 */
export interface HealthCheckResult {
  key: HealthCheckKey
  ok: boolean
  output: string
}

/** 一次完整检查报告 */
export interface HealthReport {
  ok: boolean
  checks: HealthCheckResult[]
  /** 本次检查完成时间戳 */
  checkedAt: number
}




function loadConfig(configDir: string): HealthCheckConfig {
  const configPath = join(configDir, 'config.json')
  if (!existsSync(configPath)) {
    mkdirSync(configDir, { recursive: true })
    writeFileSync(configPath, JSON.stringify(DEFAULT_HEALTH_CHECK_CONFIG, null, 2), 'utf-8')
    return { ...DEFAULT_HEALTH_CHECK_CONFIG }
  }
  try {
    const raw = readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<HealthCheckConfig>
    return {
      enabled: parsed.enabled ?? DEFAULT_HEALTH_CHECK_CONFIG.enabled,
      interval_minutes: parsed.interval_minutes ?? DEFAULT_HEALTH_CHECK_CONFIG.interval_minutes,
checks: {
        typecheck: parsed.checks?.typecheck ?? DEFAULT_HEALTH_CHECK_CONFIG.checks.typecheck,
        test: parsed.checks?.test ?? DEFAULT_HEALTH_CHECK_CONFIG.checks.test,
        lint: parsed.checks?.lint ?? DEFAULT_HEALTH_CHECK_CONFIG.checks.lint,
        build: parsed.checks?.build ?? DEFAULT_HEALTH_CHECK_CONFIG.checks.build,
        files: parsed.checks?.files ?? DEFAULT_HEALTH_CHECK_CONFIG.checks.files,
        'code-review': parsed.checks?.['code-review'] ?? DEFAULT_HEALTH_CHECK_CONFIG.checks['code-review'],
        uiux: parsed.checks?.uiux ?? DEFAULT_HEALTH_CHECK_CONFIG.checks.uiux
      },
      cooldown_minutes: parsed.cooldown_minutes ?? DEFAULT_HEALTH_CHECK_CONFIG.cooldown_minutes,
      max_consecutive_failures:
        parsed.max_consecutive_failures ?? DEFAULT_HEALTH_CHECK_CONFIG.max_consecutive_failures
    }
  } catch {
    return { ...DEFAULT_HEALTH_CHECK_CONFIG }
  }
}

export interface HealthCheckOptions {
  /** 工作区目录（含 package.json，如 app.getAppPath()） */
  workDir: string
  /** 配置目录（如 {dataDir}/.health_check） */
  configDir: string
  /** 数据目录根（history:files 检查在打包态扫这里（图像分发时 workDir=asar 只读，未 package.json/tsconfig）） */
  dataRoot?: string
  /** 注入外部事件唤醒前端 AI（可选：未提供则只写日志） */
  activationManager?: ActivationManager | null
  timerRegistry?: TimerRegistry | null
  /** 模块注册表（可选：检查项失败/恢复时同步标红模块监控表） */
  moduleRegistry?: ModuleRegistry | null
}

export class HealthCheck {
  private config: HealthCheckConfig
  private configDir: string
  private workDir: string
  /** 数据目录根（打包态 files 检查扫描目标 + dumpFullOutput 落盘目标；不传回退 workDir） */
  private dataRoot: string
  /** 是否打包环境（workDir 为 asar 归档/无源码工作区）：
   * 不置 available=false——打包版只跑「文件层 + 运行时事件」检查（源码类自动跳过），
   * 保证分发包里健康检查仍可用；源码类检查在 executeChecks 里逐个跳过，见下。 */
  private packaged = false
  /** 检查命令表（构造时按 workDir 解析便携 node 生成，替代原模块级 npm 调用） */
  private checkCommands: Record<
    Exclude<HealthCheckKey, 'files' | 'code-review' | 'uiux'>,
    { cmd: string; timeoutMs: number }
  >
  private activationManager: ActivationManager | null
  private timerRegistry: TimerRegistry | null
  private moduleRegistry: ModuleRegistry | null
  private gate: AlertGate
  private timerHandle: TimerHandle | null = null
  private startDelayHandle: TimerHandle | null = null
  private runningCheck: Promise<unknown> | null = null
  private available = true
  private lastReport: HealthReport | null = null
  /** 修复记录（发现异常/恢复/静默事件，面板展示用，新在前，最多 50 条） */
  private repairLog: HealthCheckRepairEntry[] = []

  constructor(opts: HealthCheckOptions) {
    this.workDir = opts.workDir
    this.dataRoot = opts.dataRoot ?? opts.workDir
    this.configDir = opts.configDir
    this.checkCommands = buildCheckCommands(opts.workDir)
    this.activationManager = opts.activationManager ?? null
    this.timerRegistry = opts.timerRegistry ?? null
    this.moduleRegistry = opts.moduleRegistry ?? null
    this.config = loadConfig(opts.configDir)
    this.gate = new AlertGate({
      cooldownMs: this.config.cooldown_minutes * 60_000,
      maxConsecutiveFailures: this.config.max_consecutive_failures
    })
    // 打包后不整体禁用：asar 内无源码/tsconfig，npm/命令类检查无法在 asar 虚拟目录执行。
    // 注意：不能只判 package.json——electron-builder 会把 package.json 打进 asar，
    // Electron 的 fs 补丁让 existsSync 对 asar 内路径返回 true，旧守卫在打包版失效，
    // 导致打包版误跑 typecheck/test（cmd ENOENT）并误报 tsconfig 源码缺失。
    // 判 asar 路径而非导入 electron 的 app.isPackaged：本模块有 vitest 单测（纯 Node 环境），
    // 导入 electron 会取到 undefined 导致构造即抛错。
    // 打包态处理：available 保持 true（健康检查仍然工作），仅关闭依赖源码检查的维度：
    // 命令类（typecheck/test/lint/build）与语义扫描（code-review/uiux）在 asar 下必然失败，
    // 留 files（改为扫数据目录）与运行时事件（崩溃监听）这两个与源码无关的维度继续生效。
    const isAsarApp = this.workDir.toLowerCase().endsWith('app.asar')
    if (isAsarApp || !existsSync(join(this.workDir, 'package.json'))) {
      this.packaged = true
      for (const k of ['typecheck', 'test', 'lint', 'build', 'code-review', 'uiux'] as const) {
        this.config.checks[k] = false
      }
      console.info('[health-check] 打包环境（无源码工作区）：源码类自检跳过，文件层与运行时事件监控仍生效')
    }
  }

/** 启动：立即跑一次（延迟 2s 等应用就绪）+ 周期检查 */
  start(): void {
    if (!this.config.enabled) {
      console.info('[health-check] 已禁用（config.enabled=false）')
      return
    }
    if (!this.available) return
    // 幂等：已注册定时器则不再重复注册（重复 start 会让检查频率翻倍）
    if (this.timerHandle || this.startDelayHandle) return
    console.info(`[health-check] 启动：每 ${this.config.interval_minutes} 分钟自检一次`)

    // 首次立即检查（延迟 2 秒，避免和启动流程抢资源）
    if (this.timerRegistry) {
      this.startDelayHandle = this.timerRegistry.setTimeout(
        () => {
          void this.runNow()
        },
        HEALTH_CHECK_START_DELAY_MS,
        'health-check.start-delay'
      )
    } else {
      this.startDelayHandle = setTimeout(() => {
        void this.runNow()
      }, HEALTH_CHECK_START_DELAY_MS) as unknown as TimerHandle
    }

    // 周期检查
    const intervalMs = this.config.interval_minutes * 60_000
    if (this.timerRegistry) {
      this.timerHandle = this.timerRegistry.setInterval(
        () => {
          void this.runNow()
        },
        intervalMs,
        'health-check.interval'
      )
    } else {
      const handle = setInterval(() => {
        void this.runNow()
      }, intervalMs)
      this.timerHandle = handle as unknown as TimerHandle
    }
  }

  /** 停止：清理定时器（随应用退出） */
  stop(): void {
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

  /** 立即执行一轮完整检查（防重入：上一轮未完成则跳过） */
  async runNow(): Promise<HealthReport> {
    if (this.runningCheck) return this.runningCheck as Promise<HealthReport>
    const task = this.executeChecks()
    this.runningCheck = task
    try {
      const report = await task
      this.lastReport = report
      return report
    } finally {
      this.runningCheck = null
    }
  }

  /**
   * 运行时事件上报（主进程崩溃监听接入：uncaughtException / unhandledRejection / render-process-gone）。
   * 与代码检查项共用 AlertGate：同指纹冷却 + 连续失败静默，避免崩溃刷屏唤醒 AI。
   */
  reportRuntimeEvent(kind: RuntimeEventKind, message: string): void {
    const key = `runtime:${kind}`
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
          true
        )
      }
    } else if (decision === 'silence') {
      logError('health-check', `运行时事件 ${kind} 连续失败超上限，静默（错误变化才重新提醒）`)
      this.pushRepairLog(key, 'silence', '连续失败超上限，静默（错误变化才重新提醒）')
    }
    // cooldown：冷却期内不重复提醒，不记录（避免刷屏）
  }

  /** 运行时事件恢复标记（如渲染进程 reload 成功）：清状态 + 记录时间线 */
  markRuntimeRecovered(kind: RuntimeEventKind): void {
    const key = `runtime:${kind}`
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
    const enabledKeys = (Object.keys(this.config.checks) as HealthCheckKey[]).filter(
      (k) => this.config.checks[k]
    )
    const report = this.lastReport
    const lastRunAt = report?.checkedAt ?? null
    const checks = enabledKeys.map((key) => {
      const item = report?.checks.find((r) => r.key === key)
      return {
        key,
        // null = 尚未检查（启动 20s 首检延迟期内、或该项未启用场景），与 ModuleInfo.ok 的 null=未知语义对齐，
        // 避免未检查项被前端 `!ok` 当成“失败”计红
        ok: item?.ok ?? null,
        output: item?.output ?? '',
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
      checks,
      repairLog: this.repairLog
    }
  }

  private async executeChecks(): Promise<HealthReport> {
    const results: HealthCheckResult[] = []
    const keys = Object.keys(this.config.checks) as HealthCheckKey[]
    for (const key of keys) {
      if (!this.config.checks[key]) continue
      let ok: boolean
      let output: string
      if (key === 'files' || key === 'code-review' || key === 'uiux') {
        // 静态检查：不走命令，直接扫工作区（files=文件层；code-review=代码质量语义评审；uiux=UI/UX 审计）
        const r = await this.checkStatic(key)
        ok = r.ok
        output = r.output
      } else {
        const spec = this.checkCommands[key]
        const r = await this.runCommand(spec.cmd, spec.timeoutMs)
        ok = r.ok
        output = r.output
      }
      const fingerprint = ok ? '' : hashFingerprint(output)
      // 失败即落盘完整输出，并把落盘路径带回报告与注入消息（用户/AI 由此可读全文）
      const dumpPath = ok ? null : this.dumpFullOutput(key, output)
      const decision = this.gate.decide(key, ok, fingerprint, Date.now())

      if (!ok && decision === 'alert') {
        this.notify(key, output, dumpPath)
        this.syncModuleStatus(key, false, truncate(output, 200))
      } else if (!ok && decision === 'silence') {
        logError('health-check', `${key} 连续失败超上限，静默（不再提醒，直到错误变化）${dumpPath ? `（完整输出：${dumpPath}）` : ''}`)
        this.pushRepairLog(key, 'silence', '连续失败超上限，静默（错误变化才重新提醒）')
      } else if (ok && decision === 'recovered') {
        console.info(`[health-check] ${key} 已恢复`)
        this.pushRepairLog(key, 'recovered', '检查恢复正常')
        this.syncModuleStatus(key, true, '')
      }

      // 面板/报告 output：中位截断 + 附完整落盘路径（能看到全文在哪）
      results.push({
        key,
        ok,
        output: ok ? '' : `${keepTail(output, 2000)}${dumpPath ? `\n\n完整输出已落盘：\n${dumpPath}` : ''}`
      })
    }
    return { ok: results.every((r) => r.ok), checks: results, checkedAt: Date.now() }
  }

  /**
   * 静态检查（不走命令）：
   * - files = 关键文件存在性 + 异常残留（.orig/.rej）
   * - code-review = 代码质量语义评审（health-semantic-scan）
   * - uiux = UI/UX 审计（health-semantic-scan）
   * 输出 issues 列表（每项一行，可定位：文件:行号）。
   */
  private async checkStatic(
    key: 'files' | 'code-review' | 'uiux'
  ): Promise<{ ok: boolean; output: string }> {
    if (key !== 'files') {
      // 语义扫描：summary 行不算问题，实际有条目才失败
      const r = key === 'code-review' ? scanCodeReviewIssues(this.workDir) : scanUiUxIssues(this.workDir)
      if (r.issues.length === 0) return { ok: true, output: '' }
      return { ok: false, output: [r.summary, ...r.issues].join('\n') }
    }
    const issues: string[] = []
    // 1. 关键文件存在性（打包态无源码工作区：不检查 package.json/tsconfig，
    // 改验数据目录根可写可用——这是打包版 files 检查的实际意义）
    if (this.packaged) {
      if (!existsSync(this.dataRoot)) issues.push(`数据目录根缺失: ${this.dataRoot}`)
    } else {
      for (const f of ['package.json', 'tsconfig.json']) {
        if (!existsSync(join(this.workDir, f))) issues.push(`关键文件缺失: ${f}`)
      }
    }
    // 2. 异常残留（排除大目录，限制扫描量）。
    // 打包态无源码可扫（workDir=asar 只读虚拟目录），改扫数据目录根——数据文件同源受控，
    // 残留同样会破坏运行；EXCLUDE_DIRS 已排除 node_modules 等大目录，扫描量可控
    const scanRoot = this.packaged ? this.dataRoot : this.workDir
    const { residues } = scanWorkspace(scanRoot)
    for (const p of residues.slice(0, 5)) issues.push(`异常残留文件: ${p}`)
    if (residues.length > 5) issues.push(`…另有 ${residues.length - 5} 个残留文件`)
    return issues.length ? { ok: false, output: issues.join('\n') } : { ok: true, output: '' }
  }
  /**
   * 检查失败时把完整输出 + 关键环境变量落盘，便于离线定位 worker 崩溃根因。
   * @returns 落盘文件绝对路径；失败返回 null（调用方把路径带进报错消息，用户/AI 才能拿到全文）。
   */
  private dumpFullOutput(key: HealthCheckKey, output: string): string | null {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      // 落盘位置：打包态 workDir=asar 只读，不可写，改落数据目录（.health-check/logs）；
      // 开发态保持原 data/userdata/logs（与运行时数据根一致）
      const logRoot = this.packaged
        ? join(this.dataRoot, '.health-check', 'logs')
        : join(this.workDir, 'data', 'userdata', 'logs')
      const file = join(logRoot, `health-check-full-${key}-${ts}.log`)
      mkdirSync(dirname(file), { recursive: true })
      const envDump = Object.entries(process.env)
        .filter(([k]) => /NODE|PATH|ELECTRON|VITE|VITEST|npm_|CI|COREPACK/i.test(k))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
      let extra = `nodeExe=${resolveNodeExe(this.workDir)}\n`
      extra += `mainProcessExecPath=${process.execPath}\nmainProcessExecArgv=${JSON.stringify(process.execArgv)}\n`
      try {
        const vp = join(this.workDir, 'node_modules', 'vitest', 'package.json')
        extra += `vitestVersion=${JSON.parse(readFileSync(vp, 'utf-8')).version}\n`
      } catch { /* ignore */ }
      writeFileSync(file, `=== env relevant ===\n${envDump}\n\n=== extra ===\n${extra}\n\n=== output (${output.length} chars) ===\n${output}`, 'utf-8')
      console.warn(`[health-check] ${key} 失败完整输出已落盘: ${file}`)
      return file
    } catch (e) {
      console.warn('[health-check] dumpFullOutput failed', e)
      return null
    }
  }

  private notify(key: HealthCheckKey, output: string, dumpPath: string | null): void {
    const time = new Date().toLocaleString('zh-CN')
    // 注入上限从 800 提高到 4000：头部命令/运行信息 + 尾部 vitest 汇总（中位截断），
    // 让 AI 能直接读到的上下文显著变多；全文始终有完整落盘文件可读。
    const snippet = keepTail(output, 4000)
    const fullRef = dumpPath
      ? `\n\n完整输出已落盘（可读取该文件获取全部报错内容，含被省略的中段）：\n${dumpPath}`
      : ''
    logError('health-check', `${key} 检查失败：\n${snippet}${fullRef}`)
    this.pushRepairLog(key, 'alert', keepTail(output, 200))
    if (!this.activationManager) return
    // 按检查项类型引导 AI 用对应专业能力修复。
    // 为什么不写具体技能名（曾经写死 bug-diagnosis / code-review / ui-ux-pro-max）：
    // 技能只有用户级(skills/)与领域级(skills_domains/)两层，均不随安装包分发，
    // 打包分发版技能池恒为空；写死名字会让 AI 被唤醒来后去 use_skill 一个不存在的技能，
    // 白烧一轮唤醒与 token（ui-ux-pro-max 更是从未存在过）。故只描述「要做什么」——
    // 用户若自装了对应技能，AI 会按描述自然匹配并加载，空池时也照样能直接动手。
    const repairHint =
      key === 'code-review'
        ? '请对上述问题逐条做代码评审并修复（区分真实缺陷与误报：只修确凿问题，疑似项结合上下文判断）'
        : key === 'uiux'
          ? '请以 UI/UX 专家视角评估上述界面问题并修复（以可访问性与设计一致性为准，确属误报的在修复说明中标注排除）'
          : '请先定位根因，再针对性修复'
    this.activationManager.pushExternalEvent(
      `【健康检查】工作区代码自检发现 ${key} 失败（${time}）：\n${snippet}${fullRef}\n——${repairHint}；修复后下次检查通过即自动恢复。若修复涉及架构变更或需要重启应用，先告知用户再执行。`,
      true
    )
  }

  /** 记录修复事件到内存日志（面板展示用，新在前，最多 50 条） */
  private pushRepairLog(key: string, kind: HealthCheckRepairEntry['kind'], detail: string): void {
    this.repairLog.unshift({ time: Date.now(), key, kind, detail })
    if (this.repairLog.length > 50) this.repairLog.length = 50
  }

  /** 检查项失败/恢复 → 同步模块监控表标红/变绿 */
  private syncModuleStatus(key: HealthCheckKey, ok: boolean, detail: string): void {
    if (!this.moduleRegistry) return
    const moduleId = CHECK_TO_MODULE[key]
    if (ok) this.moduleRegistry.markRecovered(moduleId)
    else this.moduleRegistry.reportIssue(moduleId, detail || key)
  }

  /** 运行时事件 → 同步模块监控表标红 */
  private syncRuntimeModuleStatus(kind: RuntimeEventKind, detail: string): void {
    if (!this.moduleRegistry) return
    this.moduleRegistry.reportIssue(RUNTIME_TO_MODULE[kind], detail)
  }

  /** 运行时事件恢复 → 模块监控表变绿 */
  private syncRuntimeModuleRecovered(kind: RuntimeEventKind): void {
    if (!this.moduleRegistry) return
    this.moduleRegistry.markRecovered(RUNTIME_TO_MODULE[kind])
  }

  /** 执行 shell 命令（异步，超时自动杀进程，不阻塞主进程）。
   * 输出策略：stdout + stderr 合并（stdout 在前）。vitest 的 worker 启动失败/垃圾回收
   * 等错误常走 stderr，若「stdout 非空即丢弃 stderr」，0-test 盲区时真实错误会被吞掉，
   * 日志只剩文件列表无法诊断。测试内 console.error（预期日志）也走 stderr，合并后
   * 通过输出内容内部区分，不牺牲诊断信息。
   * 编码策略：子进程输出以 Buffer 接收（encoding: 'buffer'），再按 UTF-8 优先、
   * GBK 回退解码（见 decodeChildOutput）——避免 Windows 中文环境 GBK 字节被
   * exec 默认 utf-8 解码成乱码；并统一剥离 ANSI 转义序列（stripAnsi）。 */
  private runCommand(cmd: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      exec(
        cmd,
        {
          cwd: normalizeDriveUpper(this.workDir),
          timeout: timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          encoding: 'buffer'
        },
        (err, stdout, stderr) => {
          const out = stripAnsi(decodeChildOutput(stdout as Buffer)).trim()
          const errOut = stripAnsi(decodeChildOutput(stderr as Buffer)).trim()
          const output = errOut ? (out ? `${out}\n${errOut}` : errOut) : out
          if (err) {
            // 超时被杀 / 命令失败
            const msg = err.killed ? `命令超时（${timeoutMs / 1000}s）被终止` : err.message
            resolve({ ok: false, output: output || msg })
          } else {
            resolve({ ok: true, output: out })
          }
        }
      )
    })
  }
}

export { AlertGate, hashFingerprint, truncate } from './health-gate'
export type { AlertDecision } from './health-gate'
export { scanWorkspace } from './health-scan'
export { scanCodeReviewIssues, scanUiUxIssues } from './health-semantic-scan'

/**
 * 中位截断：超长输出保留头部（命令/运行信息）+ 尾部（vitest 的 Test Files 汇总、
 * worker 崩溃错误通常在末尾），中间省略。单纯 truncate 只留头部会把真错误截掉。
 */
export function keepTail(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return `${text.slice(0, head)}\n……（中段省略，共 ${text.length} 字符）\n${text.slice(-tail)}`
}

/**
 * 剥离 ANSI 转义序列（颜色码/光标控制等）。
 * 背景：vitest/tsc 等工具在可感知 TTY 或 FORCE_COLOR 环境下会在输出中混入
 * \x1b[31m 这类转义，直接注入 AI / 落盘会变成不可读乱码。统一在解码后剥离。
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '')
}

/**
 * 子进程输出解码：优先 UTF-8（工具链标准输出），非法字节回退 GBK。
 * 背景：Windows 中文环境（代码页 936）下，cmd 子进程/部分工具的错误消息
 * 走 GBK 字节；exec 默认按 utf-8 解码会把它们解成乱码（如 鏄 鏂 等）。
 * 策略：用 fatal 模式的 UTF-8 严格解码，抛错说明存在非法字节序列，
 * 回退 GBK（GB18030 兼容子集，覆盖简体中文 Windows 常见输出）。
 */
export function decodeChildOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      // 理论不可达（gbk 解码器接受任意字节），兜底保编译
      return buf.toString('utf-8')
    }
  }
}
