/**
 * 健康检查可靠性回归（0.53.10）。
 *
 * 锁定五件事：
 * 1. 单项检查抛异常不会中断整轮，其余检查照常执行，失败项记 outcome=error；
 * 2. runNow 防重入：并发调用只跑一轮；
 * 3. stop() 后旧轮次的迟到结果被丢弃（不写 lastReport、不推告警）；
 * 4. 静默不等于删除错误：报告/面板仍为失败 + silenced 标记，恢复后清除；
 * 5. 无法执行（unavailable）在快照中可见，且整体不显示为健康。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { HealthCheck, type HealthCheckKey, type HealthCheckResult } from '../electron/main/monitor/health-check'
import { ModuleRegistry } from '../electron/main/monitor/module-registry'
import { ActivationManager } from '../electron/main/api/activation-manager'

type StaticRunner = (
  key: 'files' | 'code-review' | 'uiux',
  token: number
) => Promise<{ outcome: 'pass' | 'fail' | 'error' | 'unavailable'; output: string; reason?: string }>

const dirs: string[] = []
afterEach(() => {
  // 子进程/临时目录句柄释放有延迟 → 重试删除
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

function makeHc(opts: {
  files?: Record<string, string>
  checks: Partial<Record<HealthCheckKey, boolean>>
  cooldownMinutes?: number
  activationManager?: ActivationManager | null
  moduleRegistry?: ModuleRegistry
  runtimeEventStableMs?: number
}) {
  const dir = mkdtempSync(join(tmpdir(), 'hc-reliability-'))
  dirs.push(dir)
  for (const [p, content] of Object.entries(opts.files ?? {})) {
    const full = join(dir, p)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  const cfgDir = join(dir, '.hc')
  mkdirSync(cfgDir, { recursive: true })
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      enabled: true,
      interval_minutes: 30,
      checks: {
        typecheck: false,
        test: false,
        lint: false,
        build: false,
        files: false,
        'code-review': false,
        uiux: false,
        ...opts.checks
      },
      cooldown_minutes: opts.cooldownMinutes ?? 30
    })
  )
  const hc = new HealthCheck({
    workDir: dir,
    configDir: cfgDir,
    ...(opts.activationManager ? { activationManager: opts.activationManager } : {}),
    ...(opts.moduleRegistry ? { moduleRegistry: opts.moduleRegistry } : {}),
    ...(opts.runtimeEventStableMs !== undefined ? { runtimeEventStableMs: opts.runtimeEventStableMs } : {})
  })
  const patchable = hc as unknown as { checkStatic: StaticRunner; runToken: number }
  return { hc, dir, patchable }
}

describe('单项检查异常隔离', () => {
  it('code-review 抛错 → outcome=error，files/uiux 仍执行并给出真实结果', async () => {
    const { hc, patchable } = makeHc({
      files: { 'package.json': '{}', 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1\n' },
      checks: { files: true, 'code-review': true, uiux: true }
    })
    const original = patchable.checkStatic.bind(hc)
    patchable.checkStatic = async (key, token) => {
      if (key === 'code-review') throw new Error('scanner boom')
      return original(key, token)
    }

    const report = await hc.runNow()
    const byKey = new Map<string, HealthCheckResult>(report.checks.map((c) => [c.key, c]))
    expect(byKey.get('code-review')?.outcome).toBe('error')
    expect(byKey.get('code-review')?.ok).toBe(false)
    expect(byKey.get('code-review')?.output).toContain('检查器内部错误')
    expect(byKey.get('files')?.outcome).toBe('pass')
    expect(byKey.get('uiux')?.outcome).toBe('pass')
    expect(report.ok).toBe(false)
  })
})

describe('并发、停止与迟到结果', () => {
  it('并发 runNow 只执行一轮（不重复检查/不重复告警）', async () => {
    const pushExternalEvent = vi.fn()
    const activationManager = { pushExternalEvent } as unknown as ActivationManager
    const { hc, patchable } = makeHc({
      files: { 'package.json': '{}' }, // 缺 tsconfig → files 失败
      checks: { files: true },
      activationManager
    })
    const original = patchable.checkStatic.bind(hc)
    let calls = 0
    patchable.checkStatic = async (key, token) => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return original(key, token)
    }

    await Promise.all([hc.runNow(), hc.runNow()])
    expect(calls).toBe(1)
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
  })

  it('stop() 后旧轮次迟到结果被丢弃：不写 lastReport、不推告警', async () => {
    const pushExternalEvent = vi.fn()
    const activationManager = { pushExternalEvent } as unknown as ActivationManager
    const { hc, patchable } = makeHc({
      files: { 'package.json': '{}' }, // 失败项
      checks: { files: true },
      activationManager
    })
    const original = patchable.checkStatic.bind(hc)
    patchable.checkStatic = async (key, token) => {
      await new Promise((r) => setTimeout(r, 80))
      return original(key, token)
    }

    const pending = hc.runNow()
    hc.stop() // 令牌失效
    const report = await pending

    expect(report.cancelled).toBe(true)
    expect(hc.getLastReport()).toBeNull()
    expect(pushExternalEvent).not.toHaveBeenCalled()
  })
})

describe('持续失败可见与恢复', () => {
  it('冷却 0 时每轮都提醒：持续未修复的错误不会被静默藏起来', async () => {
    const pushExternalEvent = vi.fn()
    const { hc } = makeHc({
      files: { 'package.json': '{}' }, // 缺 tsconfig
      checks: { files: true },
      cooldownMinutes: 0,
      activationManager: { pushExternalEvent } as unknown as ActivationManager
    })

    await hc.runNow()
    await hc.runNow()
    await hc.runNow()

    const snap = hc.getStatusSnapshot()
    const files = snap.checks.find((c) => c.key === 'files')
    expect(files?.outcome).toBe('fail')
    expect(files?.ok).toBe(false)
    expect(snap.overallOk).toBe(false)
    expect(pushExternalEvent).toHaveBeenCalledTimes(3)
  })

  it('同指纹在冷却期内只提醒一次；冷却过后再次提醒', async () => {
    const pushExternalEvent = vi.fn()
    const { hc } = makeHc({
      files: { 'package.json': '{}' },
      checks: { files: true },
      cooldownMinutes: 30,
      activationManager: { pushExternalEvent } as unknown as ActivationManager
    })
    await hc.runNow()
    await hc.runNow() // 冷却期内
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    // 直接清掉冷却状态模拟「冷却期已过」
    hc.resetAlertState()
    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(2)
  })

  it('修复后恢复：错误状态清除，面板转绿', async () => {
    const { hc, dir } = makeHc({
      files: { 'package.json': '{}' },
      checks: { files: true },
      cooldownMinutes: 0
    })
    await hc.runNow()
    expect(hc.getStatusSnapshot().checks.find((c) => c.key === 'files')?.outcome).toBe('fail')

    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    const report = await hc.runNow()
    expect(report.checks.find((c) => c.key === 'files')?.outcome).toBe('pass')
    expect(hc.getStatusSnapshot().checks.find((c) => c.key === 'files')?.outcome).toBe('pass')
  })

  it('config 引用未注册检查项 → outcome=error（不静默跳过）', async () => {
    const { hc } = makeHc({
      files: { 'package.json': '{}', 'tsconfig.json': '{}' },
      checks: { files: false, 'future-check': true }
    })
    const report = await hc.runNow()
    const item = report.checks.find((c) => c.key === 'future-check')
    expect(item?.outcome).toBe('error')
    expect(item?.output).toContain('未知检查项')
    expect(hc.getStatusSnapshot().checks.find((c) => c.key === 'future-check')?.label).toBe('future-check')
  })

  it('内置检查项的 label 由注册表下发（渲染端不再维护硬编码标签表）', async () => {
    const { hc } = makeHc({
      files: { 'package.json': '{}', 'tsconfig.json': '{}' },
      checks: { files: true }
    })
    expect(hc.getStatusSnapshot().checks.find((c) => c.key === 'files')?.label).toBe('文件层')
  })

  it('无法执行在快照中可见（incomplete=true、overallOk=false、reason 非空）', async () => {
    const { hc } = makeHc({
      files: { 'package.json': '{}' },
      checks: { typecheck: true }
    })
    // 工作区没有 tsconfig/tsc → unavailable（不是构造期关闭，也不是通过）
    const report = await hc.runNow()
    expect(report.checks.find((c) => c.key === 'typecheck')?.outcome).toBe('unavailable')
    const snap = hc.getStatusSnapshot()
    const tc = snap.checks.find((c) => c.key === 'typecheck')
    expect(tc?.outcome).toBe('unavailable')
    expect(tc?.reason).toContain('无法执行')
    expect(snap.incomplete).toBe(true)
    expect(snap.overallOk).toBe(false)
  })
  it('uncaughtException 在稳定窗口无复发 + 健康轮通过后恢复（不永远红到重启）', async () => {
    const reg = new ModuleRegistry()
    const { hc } = makeHc({
      files: { 'package.json': '{}', 'tsconfig.json': '{}' },
      checks: { files: true },
      moduleRegistry: reg,
      runtimeEventStableMs: 20
    })
    hc.reportRuntimeEvent('uncaughtException', 'boom')
    expect(reg.getSnapshot().find((m) => m.id === 'main')?.ok).toBe(false)

    // 稳定窗口内：仍保持红（不把「刚崩完」当恢复）
    await hc.runNow()
    expect(reg.getSnapshot().find((m) => m.id === 'main')?.ok).toBe(false)

    await new Promise((r) => setTimeout(r, 30))
    const report = await hc.runNow()
    expect(report.ok).toBe(true)
    expect(reg.getSnapshot().find((m) => m.id === 'main')?.ok).toBe(true)
    expect(hc.getStatusSnapshot().repairLog.some((e) => e.key === 'runtime:uncaughtException' && e.kind === 'recovered')).toBe(true)
  })
})

describe('真实发行产物（release/win-unpacked/resources/app）', () => {
  // 机器特异性前置：只有跑过 dist:win 的机器才有该目录。缺失时显式跳过（R-T4），
  // 存在时验证的是**真实打包布局**，不是在纯 Node 里伪造 app.isPackaged。
  const PACKAGED_APP = join(__dirname, '..', 'release', 'win-unpacked', 'resources', 'app')

  it.skipIf(!existsSync(PACKAGED_APP))(
    '发行产物缺少源码/tsconfig/vitest → 源码类检查逐项 unavailable + 原因（不冒充通过）',
    async () => {
      const cfgDir = mkdtempSync(join(tmpdir(), 'hc-packaged-cfg-'))
      const dataRoot = mkdtempSync(join(tmpdir(), 'hc-packaged-data-'))
      dirs.push(cfgDir, dataRoot)
      writeFileSync(
        join(cfgDir, 'config.json'),
        JSON.stringify({
          enabled: true,
          interval_minutes: 30,
          checks: {
            typecheck: true,
            test: true,
            lint: true,
            build: true,
            // files 关闭：本用例只验证「真实产物里源码类检查 unavailable」；
            // 在纯 Node 下 app.isPackaged=false，files 会按开发态检查 tsconfig，
            // 从而把失败日志写进发行目录（污染产物）。文件层行为由上面的用例覆盖。
            files: false,
            'code-review': true,
            uiux: true
          },
          cooldown_minutes: 30,
          max_consecutive_failures: 3
        })
      )
      const hc = new HealthCheck({ workDir: PACKAGED_APP, configDir: cfgDir, dataRoot })
      const report = await hc.runNow()
      const byKey = new Map(report.checks.map((c) => [c.key, c]))

      // 真实产物事实：有 out/ 与 package.json，没有源码/tsconfig/vitest
      expect(existsSync(join(PACKAGED_APP, 'out'))).toBe(true)
      expect(existsSync(join(PACKAGED_APP, 'tsconfig.json'))).toBe(false)
      expect(existsSync(join(PACKAGED_APP, 'node_modules', 'vitest'))).toBe(false)

      for (const key of ['typecheck', 'test', 'lint', 'build', 'code-review', 'uiux'] as const) {
        const item = byKey.get(key)
        expect(item, `${key} 应在报告中`).toBeTruthy()
        expect(item?.outcome, `${key} 应为 unavailable`).toBe('unavailable')
        expect(item?.reason).toContain('无法执行')
      }
      // 整体不健康，且 incomplete 可见
      expect(report.ok).toBe(false)
      expect(hc.getStatusSnapshot().incomplete).toBe(true)
    }
  )
})

describe('静态扫描预算、模块状态与告警联动', () => {
  it('静态扫描预算耗尽 → outcome=timeout（结果不完整，不伪装成通过）', async () => {
    const { hc } = makeHc({
      files: { 'package.json': '{}', 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1\n' },
      checks: { 'code-review': true }
    })
    // 0ms 预算：collectFiles 立刻判定不完整
    const hc2 = new HealthCheck({
      workDir: (hc as unknown as { workDir: string }).workDir,
      configDir: (hc as unknown as { configDir: string }).configDir,
      staticScanBudgetMs: 0
    })
    const report = await hc2.runNow()
    const cr = report.checks.find((c) => c.key === 'code-review')
    expect(cr?.outcome).toBe('timeout')
    expect(cr?.output).toContain('扫描未完成')
    expect(report.ok).toBe(false)
  })

  it('检查从 fail 变为 unavailable 时清除模块旧红点（不展示陈旧错误）', async () => {
    const { dir } = makeHc({
      files: {
        'package.json': '{}',
        'tsconfig.json': '{}',
        'src/a.ts': 'export function f() {\n  debugger\n}\n'
      },
      checks: { 'code-review': true }
    })
    const reg = new ModuleRegistry()
    const hc2 = new HealthCheck({
      workDir: dir,
      configDir: join(dir, '.hc'),
      moduleRegistry: reg
    })
    await hc2.runNow()
    expect(reg.getSnapshot().find((m) => m.id === 'tools')?.ok).toBe(false)

    // 移除源码根 → code-review 变 unavailable
    rmSync(join(dir, 'src'), { recursive: true, force: true })
    const report = await hc2.runNow()
    expect(report.checks.find((c) => c.key === 'code-review')?.outcome).toBe('unavailable')
    expect(reg.getSnapshot().find((m) => m.id === 'tools')?.ok).toBe(true)
  })

  it('真实 ActivationManager：同错误冷却期只入队一条，新错误再入队', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-dedupe-'))
    dirs.push(dir)
    const am = new ActivationManager(join(dir, '.activation'))
    try {
      const { hc } = makeHc({
        files: { 'package.json': '{}' }, // 缺 tsconfig
        checks: { files: true },
        activationManager: am
      })
      await hc.runNow()
      expect(am.pendingEventCount()).toBe(1)
      await hc.runNow() // 冷却期，同指纹
      expect(am.pendingEventCount()).toBe(1)
      // 新错误：补一个残留文件 → 指纹变化 → 新事件
      writeFileSync(join((hc as unknown as { workDir: string }).workDir, 'x.ts.orig'), 'old')
      await hc.runNow()
      expect(am.pendingEventCount()).toBe(2)
    } finally {
      am.stop()
    }
  })

  it('resetAlertState() 人工解除冷却（不清除最近报告）', async () => {
    const pushExternalEvent = vi.fn()
    const { hc } = makeHc({
      files: { 'package.json': '{}' },
      checks: { files: true },
      cooldownMinutes: 60,
      activationManager: { pushExternalEvent } as unknown as ActivationManager
    })
    await hc.runNow()
    await hc.runNow() // 冷却期内，不推
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)

    hc.resetAlertState()
    const snap = hc.getStatusSnapshot()
    // 最近报告仍在（面板仍显示真实失败）
    expect(snap.checks.find((c) => c.key === 'files')?.outcome).toBe('fail')

    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(2)
  })
})

describe('停止时终止在飞命令（退出链）', () => {
  it('stop() 同步终止检查命令的整棵进程树，迟到结果被丢弃', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-stopcmd-'))
    dirs.push(dir)
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'typescript', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'tsconfig.node.json'), '{}')
    writeFileSync(join(dir, 'tsconfig.web.json'), '{}')
    writeFileSync(join(dir, 'node_modules', 'typescript', 'bin', 'tsc'), '// dummy')
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        enabled: true,
        interval_minutes: 30,
        checks: { typecheck: true, test: false, lint: false, build: false, files: false, 'code-review': false, uiux: false },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    const pidFile = join(dir, 'grandchild.pid')
    const script = join(dir, 'hang.js')
    writeFileSync(
      script,
      [
        "const { spawn } = require('child_process')",
        "const fs = require('fs')",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })",
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid))`,
        'setTimeout(()=>{}, 60000)'
      ].join('\n')
    )

    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir })
    const patchable = hc as unknown as {
      checkCommands: Record<string, { cmd: string; timeoutMs: number }>
      activeChildren: Set<unknown>
    }
    patchable.checkCommands.typecheck = {
      cmd: `"${process.execPath}" "${script}"`,
      timeoutMs: 60_000
    }

    const pending = hc.runNow()
    // 等子进程启动
    const deadline = Date.now() + 3_000
    while (patchable.activeChildren.size === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(patchable.activeChildren.size).toBeGreaterThan(0)

    hc.stop()
    const report = await pending
    expect(report.cancelled).toBe(true)
    expect(hc.getLastReport()).toBeNull()

    if (process.platform === 'win32' && existsSync(pidFile)) {
      await new Promise((r) => setTimeout(r, 500))
      const pid = readFileSync(pidFile, 'utf-8').trim()
      const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf-8' })
      expect(check.stdout).not.toContain(pid)
    }
  })
})

describe('打包态覆盖（测试注入，验证 app.isPackaged 分支语义）', () => {
  it('packaged=true 时 files 检查部署目录，而不是源码 tsconfig', async () => {
    const { hc, dir } = makeHc({ files: { 'package.json': '{}' }, checks: { files: true } })
    const hc2 = new HealthCheck({
      workDir: dir,
      configDir: join(dir, '.hc'),
      dataRoot: dir, // 数据根存在
      packaged: true
    })
    const report = await hc2.runNow()
    expect(hc2.getStatusSnapshot().packaged).toBe(true)
    // 若仍按开发态检查，会因缺 tsconfig.json 失败；走部署目录语义则通过
    expect(report.checks.find((c) => c.key === 'files')?.outcome).toBe('pass')
    expect(hc).toBeTruthy()
  })
})
