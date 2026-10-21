import { describe, it, expect, afterEach } from 'vitest'
import {
  AlertGate,
  hashFingerprint,
  truncate,
  HealthCheck,
  scanWorkspace,
  scanCodeReviewIssues,
  scanUiUxIssues
} from '../electron/main/monitor/health-check'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

describe('AlertGate 冷却去重状态机', () => {
  const gate = () => new AlertGate({ cooldownMs: 1000 })

  it('首次失败 → alert（提醒）', () => {
    const g = gate()
    expect(g.decide('typecheck', false, 'fp1', 0)).toBe('alert')
  })

  it('同指纹且冷却期内 → cooldown（不重复提醒）', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp1', 0)
    expect(g.decide('typecheck', false, 'fp1', 500)).toBe('cooldown')
  })

  it('同指纹冷却期后 → alert（持续未修复就再提醒，不做永久静默）', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp1', 0)
    expect(g.decide('typecheck', false, 'fp1', 1500)).toBe('alert')
    expect(g.decide('typecheck', false, 'fp1', 3000)).toBe('alert')
  })

  it('指纹变化（可能是新问题）→ 立即 alert，不等冷却', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp_old', 0)
    expect(g.decide('typecheck', false, 'fp_new', 100)).toBe('alert')
  })

  it('恢复（ok）→ recovered 并清除状态；再失败重新 alert', () => {
    const g = gate()
    g.decide('test', false, 'fp1', 0)
    expect(g.decide('test', true, '', 500)).toBe('recovered')
    expect(g.failingKeys()).toHaveLength(0)
    expect(g.decide('test', false, 'fp1', 1000)).toBe('alert')
  })

  it('一直健康 → ok（无状态变化）', () => {
    const g = gate()
    expect(g.decide('lint', true, '', 0)).toBe('ok')
    expect(g.decide('lint', true, '', 1000)).toBe('ok')
  })

  it('不同检查项互不影响', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp1', 0)
    expect(g.decide('lint', false, 'fp2', 0)).toBe('alert')
    g.decide('typecheck', true, '', 500)
    expect(g.decide('lint', false, 'fp2', 500)).toBe('cooldown')
  })

  it('reset() 人工解除冷却（不清除报告）', () => {
    const g = new AlertGate({ cooldownMs: 60_000 })
    g.decide('files', false, 'fp', 0)
    expect(g.decide('files', false, 'fp', 1000)).toBe('cooldown')
    g.reset()
    expect(g.getState('files')).toBeNull()
    expect(g.decide('files', false, 'fp', 2000)).toBe('alert')
  })
})

describe('hashFingerprint', () => {
  it('同文本 → 同指纹', () => {
    expect(hashFingerprint('error: foo bar')).toBe(hashFingerprint('error: foo bar'))
  })

  it('不同文本 → 不同指纹（大概率）', () => {
    expect(hashFingerprint('error: foo')).not.toBe(hashFingerprint('error: bar'))
  })

  it('长文本不只取前 2000 字符：尾部差异也会改变指纹', () => {
    // 旧实现只 hash 前 2000 字符 → 同一检查项的尾部错误（vitest 汇总/worker 崩溃）
    // 会被前缀吞掉，不同根因被错误合并。现在头尾都参与指纹。
    const long1 = 'a'.repeat(3000)
    const long2 = 'a'.repeat(3000) + '尾部真实错误'
    expect(hashFingerprint(long1)).not.toBe(hashFingerprint(long2))
  })

  it('前缀相同、尾部不同（不同根因）→ 不同指纹', () => {
    const base = 'error: identical prefix '.repeat(100)
    expect(hashFingerprint(`${base}TS2322 at a.ts`)).not.toBe(hashFingerprint(`${base}TS2345 at b.ts`))
  })

  it('时间戳/耗时/临时目录/PID 归一化 → 同错误指纹稳定', () => {
    const e1 =
      'time 2026-10-21T01:02:03.456Z pid=1234 duration 31ms temp C:\\Users\\x\\AppData\\Local\\Temp\\vitest-abc\\a.test.ts: TS2322'
    const e2 =
      'time 2026-10-22T11:22:33.999Z pid=9876 duration 99ms temp C:\\Users\\x\\AppData\\Local\\Temp\\vitest-xyz\\a.test.ts: TS2322'
    expect(hashFingerprint(e1)).toBe(hashFingerprint(e2))
  })

  it('归一化不抹掉诊断差异：文件/行号/错误码变化 → 指纹变化', () => {
    const a = 'src/a.ts:10 TS2322 Type X is not assignable'
    const b = 'src/a.ts:11 TS2322 Type X is not assignable'
    const c = 'src/b.ts:10 TS2322 Type X is not assignable'
    expect(hashFingerprint(a)).not.toBe(hashFingerprint(b))
    expect(hashFingerprint(a)).not.toBe(hashFingerprint(c))
  })

  it('归一化后相同、原文长度不同 → 同一指纹（长度不能并入 hash）', () => {
    // 反例：Duration 9.4s 与 10.1s 归一化后相同，但原文长度差 1
    const a = 'Tests 3 failed | Duration 9.4s pid=123'
    const b = 'Tests 3 failed | Duration 10.1s pid=123'
    expect(hashFingerprint(a)).toBe(hashFingerprint(b))
  })

  it('独立时钟（vitest Start at HH:MM:SS）也归一化', () => {
    const a = 'Start at  10:14:07\nTests 1 failed'
    const b = 'Start at  11:20:09\nTests 1 failed'
    expect(hashFingerprint(a)).toBe(hashFingerprint(b))
  })

  it('npm debug 日志路径带时间戳 → 归一化后指纹稳定（防冷却失效）', () => {
    // npm 自身错误输出每次带新时间戳路径，不剥离会导致同错误指纹永远不同
    const e1 = 'npm error Missing script: "test"\nlog: d:\\app\\.npm-cache\\_logs\\2026-08-06T05_09_22_042Z-debug-0.log'
    const e2 = 'npm error Missing script: "test"\nlog: d:\\app\\.npm-cache\\_logs\\2026-08-07T12_00_00_000Z-debug-5.log'
    expect(hashFingerprint(e1)).toBe(hashFingerprint(e2))
  })
})

describe('truncate', () => {
  it('短文本原样返回', () => {
    expect(truncate('hello', 100)).toBe('hello')
  })

  it('超长文本截断并标注', () => {
    const out = truncate('x'.repeat(50), 10)
    expect(out.startsWith('xxxxxxxxxx')).toBe(true)
    expect(out).toContain('已截断')
  })
})

describe('HealthCheck 运行时事件接入（崩溃监听 → AlertGate + 面板时间线）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  // 真实 HealthCheck 实例：临时目录构造（无 package.json → available=false，但 runtime 事件不依赖 available）；
  // 不传 activationManager → 不会真注入外部事件，测试安全
  const makeHc = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-runtime-'))
    dirs.push(dir)
    return new HealthCheck({ workDir: dir, configDir: join(dir, '.hc') })
  }

  it('首次崩溃 → alert 记录进修复日志（面板可见）', () => {
    const hc = makeHc()
    hc.reportRuntimeEvent('render-process-gone', 'reason=oom exitCode=3')
    const log = hc.getStatusSnapshot().repairLog
    expect(log[0]).toMatchObject({ key: 'runtime:render-process-gone', kind: 'alert' })
  })

  it('同指纹冷却期内重复上报 → 不新增记录（防刷屏）', () => {
    const hc = makeHc()
    hc.reportRuntimeEvent('render-process-gone', 'reason=oom exitCode=3')
    hc.reportRuntimeEvent('render-process-gone', 'reason=oom exitCode=3')
    const log = hc.getStatusSnapshot().repairLog
    expect(
      log.filter((e) => e.key === 'runtime:render-process-gone' && e.kind === 'alert')
    ).toHaveLength(1)
  })

  it('markRuntimeRecovered → recovered 记录；恢复后再崩溃重新提醒', () => {
    const hc = makeHc()
    hc.reportRuntimeEvent('render-process-gone', 'reason=oom exitCode=3')
    hc.markRuntimeRecovered('render-process-gone')
    let log = hc.getStatusSnapshot().repairLog
    expect(log[0]).toMatchObject({ key: 'runtime:render-process-gone', kind: 'recovered' })
    // 恢复后再崩溃：重新 alert（不再静默）
    hc.reportRuntimeEvent('render-process-gone', 'reason=oom exitCode=3')
    log = hc.getStatusSnapshot().repairLog
    expect(log[0]).toMatchObject({ key: 'runtime:render-process-gone', kind: 'alert' })
  })

  it('不同类型运行时事件互相独立', () => {
    const hc = makeHc()
    hc.reportRuntimeEvent('uncaughtException', 'TypeError: x is undefined')
    hc.reportRuntimeEvent('unhandledRejection', 'TypeError: x is undefined')
    const keys = hc.getStatusSnapshot().repairLog.map((e) => e.key)
    expect(keys).toContain('runtime:uncaughtException')
    expect(keys).toContain('runtime:unhandledRejection')
  })
})

describe('检查策略统一（打包不关闭检查项，缺材料显式 unavailable）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('workDir 指向 app.asar → packaged=true，但检查项仍按配置全部保留', () => {
    // 旧行为：构造期把 typecheck/test/lint/build/code-review/uiux 强制关掉。
    // 新行为：策略由 config.checks 决定；打包只影响展示与落盘位置。
    const dir = mkdtempSync(join(tmpdir(), 'hc-asar-'))
    dirs.push(dir)
    const asarPath = join(dir, 'resources', 'app.asar')
    const hc = new HealthCheck({ workDir: asarPath, configDir: join(dir, '.hc') })
    const snap = hc.getStatusSnapshot()
    expect(snap.available).toBe(true)
    expect(snap.packaged).toBe(true)
    const enabledKeys = snap.checks.map((c) => c.key)
    // 默认配置：typecheck/test/files/code-review/uiux 开；lint/build 关
    expect(enabledKeys).toEqual(
      expect.arrayContaining(['typecheck', 'test', 'files', 'code-review', 'uiux'])
    )
    expect(enabledKeys).not.toContain('lint')
    expect(enabledKeys).not.toContain('build')
  })

  it('打包态 start() 可启动（健康检查工作），未到首检延迟不产生报告', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-asar-'))
    dirs.push(dir)
    const asarPath = join(dir, 'resources', 'app.asar')
    const hc = new HealthCheck({ workDir: asarPath, configDir: join(dir, '.hc') })
    hc.start()
    // 首检延迟 20s：start 后立即查询还没有报告（但定时器已挂）
    expect(hc.getStatusSnapshot().lastRunAt).toBeNull()
    hc.stop()
  })

  it('打包态真实执行：源码类检查返回 unavailable + 原因，文件层照常执行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-asar-'))
    dirs.push(dir)
    const asarPath = join(dir, 'resources', 'app.asar')
    const missingDataRoot = join(dir, 'no-such-userdata')
    const hc = new HealthCheck({ workDir: asarPath, configDir: join(dir, '.hc'), dataRoot: missingDataRoot })
    const r = await hc.runNow()

    // 文件层是真信号：数据目录根缺失 → fail
    const files = r.checks.find((c) => c.key === 'files')
    expect(files?.outcome).toBe('fail')
    expect(files?.output).toContain('数据目录根缺失')

    // 源码类检查没有被静默跳过，也没有被伪装成通过：逐项 unavailable + 原因
    for (const key of ['typecheck', 'test', 'code-review', 'uiux'] as const) {
      const item = r.checks.find((c) => c.key === key)
      expect(item, `${key} 应出现在报告里`).toBeTruthy()
      expect(item?.outcome).toBe('unavailable')
      expect(item?.ok).toBe(false)
      expect(item?.reason).toContain('无法执行')
    }
    // 整体不得显示为健康，且 incomplete 标记为真
    expect(r.ok).toBe(false)
    expect(hc.getStatusSnapshot().incomplete).toBe(true)
  })

  it('package.json 缺失不会再把检查项关掉（只影响 files 检查本身）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-nopkg-'))
    dirs.push(dir)
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
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
          files: true,
          'code-review': true,
          uiux: true
        },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir })
    expect(hc.getStatusSnapshot().packaged).toBe(false)
    expect(hc.getStatusSnapshot().checks).toHaveLength(7)

    const r = await hc.runNow()
    // files 因缺 package.json/tsconfig 失败（真实信号），不是被关闭
    expect(r.checks.find((c) => c.key === 'files')?.outcome).toBe('fail')
    // 命令类因缺工具链/配置 → unavailable，而不是被构造期静默关闭
    expect(r.checks.find((c) => c.key === 'typecheck')?.outcome).toBe('unavailable')
    expect(r.checks.find((c) => c.key === 'test')?.outcome).toBe('unavailable')
    expect(r.checks.find((c) => c.key === 'lint')?.outcome).toBe('unavailable')
    expect(r.checks.find((c) => c.key === 'build')?.outcome).toBe('unavailable')
    // 语义扫描：没有源码根 → unavailable（不是 0 问题通过）
    expect(r.checks.find((c) => c.key === 'code-review')?.outcome).toBe('unavailable')
    expect(r.checks.find((c) => c.key === 'uiux')?.outcome).toBe('unavailable')
  })

  it('打包态数据目录存在 → files 通过（部署目录适配，不改变检查语义）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-asar-'))
    dirs.push(dir)
    const asarPath = join(dir, 'resources', 'app.asar')
    const hc = new HealthCheck({ workDir: asarPath, configDir: join(dir, '.hc'), dataRoot: dir })
    const r = await hc.runNow()
    expect(r.checks.find((c) => c.key === 'files')?.outcome).toBe('pass')
  })

  it('真实工作区目录（dev）→ available=true 且 packaged=false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-dev-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{}')
    const hc = new HealthCheck({ workDir: dir, configDir: join(dir, '.hc') })
    const snap = hc.getStatusSnapshot()
    expect(snap.available).toBe(true)
    expect(snap.packaged).toBe(false)
  })
})

describe('scanWorkspace 文件层扫描', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-scan-'))
    dirs.push(dir)
    return dir
  }

  it('检出 .orig/.rej 异常残留', () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'x.ts.orig'), 'old content')
    writeFileSync(join(dir, 'y.ts.rej'), 'rejected patch')
    writeFileSync(join(dir, 'z.ts'), 'normal')
    const { residues } = scanWorkspace(dir)
    expect(residues).toHaveLength(2)
  })

  it('排除 node_modules 等大目录', () => {
    const dir = makeDir()
    // node_modules 里的异常残留不应被扫到
    mkdirSync(join(dir, 'node_modules', 'some-pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'some-pkg', 'index.js.orig'), 'old')
    writeFileSync(join(dir, 'ok.ts'), 'clean')
    const { residues } = scanWorkspace(dir)
    expect(residues).toHaveLength(0)
  })

  it('干净目录 → 无异常', () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    const r = scanWorkspace(dir)
    expect(r.residues).toHaveLength(0)
  })
})

describe('HealthCheck 文件层检查项（checkFiles）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeHc = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-files-'))
    dirs.push(dir)
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, p)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    // 只开 files 检查项：避免 runNow() 在临时目录真实跑 npm typecheck/test（慢且噪音）
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        enabled: true,
        interval_minutes: 30,
        checks: { typecheck: false, test: false, lint: false, build: false, files: true },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    return new HealthCheck({ workDir: dir, configDir: cfgDir })
  }

  it('关键文件缺失 → 检出', async () => {
    const hc = makeHc({ 'package.json': '{}' }) // 缺 tsconfig.json
    const r = await hc.runNow()
    const files = r.checks.find((c) => c.key === 'files')
    expect(files?.ok).toBe(false)
    expect(files?.output).toContain('tsconfig.json')
  })

  it('异常残留 .orig/.rej → 检出并注入修复日志', async () => {
    const hc = makeHc({
      'package.json': '{}',
      'tsconfig.json': '{}',
      'src/a.ts.orig': 'old content'
    })
    const r = await hc.runNow()
    const files = r.checks.find((c) => c.key === 'files')
    expect(files?.ok).toBe(false)
    expect(files?.output).toContain('异常残留文件')
    // 修复日志有记录（面板时间线可见）
    const alerts = hc.getStatusSnapshot().repairLog.filter((e) => e.key === 'files')
    expect(alerts.length).toBeGreaterThan(0)
  })

  it('干净工作区 → files 检查项通过', async () => {
    const hc = makeHc({ 'package.json': '{}', 'tsconfig.json': '{}', 'src/a.ts': 'export const a = 1\n' })
    const r = await hc.runNow()
    const files = r.checks.find((c) => c.key === 'files')
    expect(files?.ok).toBe(true)
  })
})

describe('语义扫描 code-review 维度（scanCodeReviewIssues）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-semantic-'))
    dirs.push(dir)
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, p)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    return dir
  }

  it('达到 maxFiles 上限 → complete=false（不能把「只扫了一部分」当全扫完）', () => {
    const dir = makeDir({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export const b = 1\n'
    })
    const r = scanCodeReviewIssues(dir, { maxFiles: 1 })
    expect(r.files).toBe(1)
    expect(r.complete).toBe(false)
    expect(r.summary).toContain('扫描未完成')
  })

  it('干净源码 → 输出只有汇总行，无问题条目', () => {
    const dir = makeDir({ 'src/a.ts': 'export const a = 1\n' })
    const r = scanCodeReviewIssues(dir)
    expect(r.summary).toContain('发现 code-review 问题 0 处')
    expect(r.issues).toHaveLength(0)
  })

  it('assets / release 不扫（第三方压缩 JS 与打包产物不是本仓源码）', () => {
    const dir = makeDir({
      'src/a.ts': 'export const a = 1\n',
      'assets/room-seed/live2d/live2dcubismcore.min.js': 'try{a()}catch(e){}',
      'release/win-unpacked/resources/room-seed/live2d/live2dcubismcore.min.js': 'try{a()}catch(e){}'
    })
    const r = scanCodeReviewIssues(dir)
    expect(r.issues).toHaveLength(0)
    expect(r.summary).toContain('发现 code-review 问题 0 处')
  })

  it('检出 debugger / TODO / @ts-ignore 等确定性问题，格式为 文件:行号', () => {
    const dir = makeDir({
      'src/a.ts': 'export function f() {\n  debugger\n}\n',
      'src/b.tsx': '// TODO: 接入真实接口\nconst x: number = 1\n'
    })
    const r = scanCodeReviewIssues(dir)
    const joined = r.issues.join('\n')
    expect(joined).toContain('debugger 语句残留')
    expect(joined).toContain('TODO/FIXME/HACK 待办残留')
    expect(joined).toMatch(/src\/a\.ts:\d+ debugger/)
    expect(joined).toMatch(/src\/b\.tsx:\d+ TODO/)
  })

  it('仅注释行首的 @ts-ignore / @ts-nocheck 算压制；正文提及不算（误报回归）', () => {
    const dir = makeDir({
      // 真压制：指令独占注释行首
      'src/real.ts': '// @ts-ignore\nexport const a = 1\n',
      'src/real2.ts': '/* @ts-nocheck */\nexport const b = 1\n',
      // 只是解释性正文：该词出现在句子里，不构成指令（曾因全文匹配被误报）
      'src/prose.ts': '/**\n * 说明：vendor 目录整体 @ts-nocheck，类型面不稳定。\n */\nexport const c = 1\n'
    })
    const r = scanCodeReviewIssues(dir)
    const joined = r.issues.join('\n')
    expect(joined).toMatch(/src\/real\.ts:1 @ts-ignore/)
    expect(joined).toMatch(/src\/real2\.ts:1 @ts-ignore/)
    expect(joined).not.toContain('src/prose.ts')
    expect(r.issues).toHaveLength(2)
  })

  it('不计入排除目录（node_modules 里的 debugger 不报）', () => {
    const dir = makeDir({
      'src/a.ts': 'export const a = 1\n',
      'node_modules/pkg/index.js': 'function f() {\n  debugger\n}\n'
    })
    const r = scanCodeReviewIssues(dir)
    expect(r.issues).toHaveLength(0)
    expect(r.summary).toContain('0 处')
  })

  it('any 滥用按文件聚合报 Top 文件', () => {
    const dir = makeDir({
      'src/a.ts': 'export const f = (x: any): any => x as any\n',
      'src/b.ts': 'export const g = (x: any): any => x\n'
    })
    const r = scanCodeReviewIssues(dir)
    const joined = r.issues.join('\n')
    expect(joined).toContain('any 滥用')
    // a.ts 有 3 处（: any + : any + as any），b.ts 有 2 处 → a.ts 排前
    const aIdx = joined.indexOf('src/a.ts')
    const bIdx = joined.indexOf('src/b.ts')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('疑似项标注（疑似）前缀（secret / dangerouslySetInnerHTML）', () => {
    const dir = makeDir({
      'src/a.tsx': 'const el = <div dangerouslySetInnerHTML={{ __html: html }} />\n'
    })
    const r = scanCodeReviewIssues(dir)
    const joined = r.issues.join('\n')
    expect(joined).toContain('（疑似）')
    expect(joined).toContain('dangerouslySetInnerHTML')
  })

  it('字符串/模板/正则字面量内的模式字样不误报（掩码）', () => {
    const dir = makeDir({
      // catch(e){} 出现在字符串字面量内
      'src/a.ts': "const SECURITY_PREAMBLE = 'try{}catch(e){}globalThis.eval=undefined;'\n",
      // .innerHTML = 出现在模板字符串常量（如快照 HTML/JS 注入脚本）内
      'src/b.ts': "const WELCOME_HTML = `...el.innerHTML = '<div>...</div>'...`\n",
      // eval( 出现在「检测规则定义」的正则字面量内
      'src/c.ts': "const DANGEROUS_PATTERNS = [{ re: /\\beval\\s*\\(/i }]\n",
      // new Function 出现在文档注释中（应含注释本身，但不应命中 eval 动态执行）
      'src/d.ts': '// 注意：new Function( 仅用于说明\n'
    })
    const r = scanCodeReviewIssues(dir)
    const joined = r.issues.join('\n')
    expect(joined).not.toContain('空 catch')
    expect(joined).not.toContain('innerHTML')
    expect(joined).not.toContain('eval/动态代码执行')
  })

  it('health-scan: ignore 豁免注释：命中行/上一行带标记则跳过，总结计数不含该条', () => {
    const dir = makeDir({
      // 真实代码形态命中，但带豁免注释（人工/AI 评审确认安全）
      'src/a.ts': "const cfg = { api_key: '0123456789abcdefghij' }; // health-scan: ignore-secret 本地 mock，非真实凭据\n",
      'src/b.ts': "try { x() } catch (e) {\n  // health-scan: ignore-empty-catch 有意吞错（异步恢复路径）\n}\n",
      // kind 不匹配的豁免不影响其他规则
      'src/c.ts': "try { y() } catch (e) {}\n"
    })
    const r = scanCodeReviewIssues(dir)
    const joined = r.issues.join('\n')
    // a/b 豁免生效；c 的 real 空 catch 仍命中
    expect(joined).not.toContain('src/a.ts')
    expect(joined).not.toContain('src/b.ts')
    expect(joined).toMatch(/src\/c\.ts:\d+ 空 catch/)
    expect(r.summary).toContain('问题 1 处')
  })

  it('掩码不掩盖真实代码缺陷（真实空 catch / 真实 new Function 仍命中）', () => {
    const dir = makeDir({
      'src/a.ts': 'function f() {\n  try { work() } catch {}\n}\n'
    })
    const r = scanCodeReviewIssues(dir)
    expect(r.issues.join('\n')).toMatch(/src\/a\.ts:\d+ 空 catch/)
  })

  it('跨行空 catch 命中（块内仅换行/空白，无注释无代码）', () => {
    const dir = makeDir({
      'src/a.ts': 'function f() {\n  try { work() } catch (e) {\n  }\n}\n'
    })
    const r = scanCodeReviewIssues(dir)
    expect(r.issues.join('\n')).toMatch(/src\/a\.ts:2 空 catch/)
  })

  it('带说明注释的跨行空 catch 不命中（有意吞错，非缺陷）', () => {
    const dir = makeDir({
      'src/a.ts': 'function f() {\n  try { work() } catch (e) {\n    // 剪贴板不可用时静默忽略\n  }\n}\n'
    })
    const r = scanCodeReviewIssues(dir)
    expect(r.issues.join('\n')).not.toContain('空 catch')
  })
})

describe('语义扫描 UI/UX 维度（scanUiUxIssues）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeDir = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-uiux-'))
    dirs.push(dir)
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, p)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    return dir
  }

  it('干净 UI 代码 → 无问题条目', () => {
    const dir = makeDir({
      'src/App.tsx': 'export const App = () => <button title="确定">确定</button>\n'
    })
    const r = scanUiUxIssues(dir)
    expect(r.issues).toHaveLength(0)
    expect(r.summary).toContain('0 处')
  })

  it('检出纯图标按钮无无障碍名', () => {
    const dir = makeDir({
      'src/App.tsx': 'export const App = () => <button><Icon /></button>\n'
    })
    const joined = scanUiUxIssues(dir).issues.join('\n')
    expect(joined).toContain('纯图标按钮缺少 title/aria-label')
  })

  it('带 title/aria-label 的图标按钮不误报', () => {
    const dir = makeDir({
      'src/App.tsx': 'export const App = () => <button aria-label="关闭"><Icon /></button>\n'
    })
    const r = scanUiUxIssues(dir)
    expect(r.issues).toHaveLength(0)
  })

  it('检出 img 缺 alt 与 Tailwind 硬编码颜色', () => {
    const dir = makeDir({
      'src/App.tsx': 'export const App = () => <img src="/logo.png" />\n'
    })
    const joined = scanUiUxIssues(dir).issues.join('\n')
    expect(joined).toContain('<img> 缺少 alt 无障碍文本')
  })

  it('检出内联 fontFamily 无回退', () => {
    const dir = makeDir({
      'src/App.tsx': "export const s = { fontFamily: 'PingFang SC' }\n"
    })
    const joined = scanUiUxIssues(dir).issues.join('\n')
    expect(joined).toContain('内联 fontFamily 无回退字体')
  })

  it('排除 node_modules', () => {
    const dir = makeDir({
      'src/App.tsx': 'export const App = () => <span>ok</span>\n',
      'node_modules/pkg/index.js': 'const el = <img src="x.png" />\n'
    })
    const r = scanUiUxIssues(dir)
    expect(r.issues).toHaveLength(0)
  })
})

describe('HealthCheck 语义检查项接入（code-review / uiux 走静态扫描闭环）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeHc = (files: Record<string, string>, checks: Record<string, boolean>) => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-sem-'))
    dirs.push(dir)
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, p)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        enabled: true,
        interval_minutes: 30,
        checks,
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir })
    // 只跑静态检查项，避免临时目录真实跑 npm
    return { hc, dir }
  }

  it('code-review 发现调试残留 → 检查失败并进修复日志，输出可定位', async () => {
    const { hc } = makeHc(
      {
        'package.json': '{}',
        'tsconfig.json': '{}',
        'src/a.ts': 'export function f() {\n  debugger\n}\n'
      },
      { typecheck: false, test: false, lint: false, build: false, files: false, 'code-review': true, uiux: false }
    )
    const r = await hc.runNow()
    const cr = r.checks.find((c) => c.key === 'code-review')
    expect(cr?.ok).toBe(false)
    expect(cr?.output).toContain('debugger 语句残留')
    const alerts = hc.getStatusSnapshot().repairLog.filter((e) => e.key === 'code-review' && e.kind === 'alert')
    expect(alerts.length).toBeGreaterThan(0)
  })

  it('uiux 发现图标按钮缺无障碍名 → 检查失败并进修复日志', async () => {
    const { hc } = makeHc(
      {
        'package.json': '{}',
        'tsconfig.json': '{}',
        'src/App.tsx': 'export const App = () => <button><Icon /></button>\n'
      },
      { typecheck: false, test: false, lint: false, build: false, files: false, 'code-review': false, uiux: true }
    )
    const r = await hc.runNow()
    const ux = r.checks.find((c) => c.key === 'uiux')
    expect(ux?.ok).toBe(false)
    expect(ux?.output).toContain('纯图标按钮缺少 title/aria-label')
  })

  it('干净源码 → code-review / uiux 检查通过', async () => {
    const { hc } = makeHc(
      {
        'package.json': '{}',
        'tsconfig.json': '{}',
        'src/App.tsx': 'export const App = () => <button title="确定">确定</button>\n'
      },
      { typecheck: false, test: false, lint: false, build: false, files: false, 'code-review': true, uiux: true }
    )
    const r = await hc.runNow()
    expect(r.checks.find((c) => c.key === 'code-review')?.ok).toBe(true)
    expect(r.checks.find((c) => c.key === 'uiux')?.ok).toBe(true)
  })
})
