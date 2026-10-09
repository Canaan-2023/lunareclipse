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

describe('AlertGate 防死循环状态机', () => {
  const gate = () =>
    new AlertGate({ cooldownMs: 1000, maxConsecutiveFailures: 3 })

  it('首次失败 → alert（提醒）', () => {
    const g = gate()
    expect(g.decide('typecheck', false, 'fp1', 0)).toBe('alert')
  })

  it('同指纹且冷却期内 → cooldown（不重复提醒）', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp1', 0)
    // 500ms 后同指纹：仍在冷却期（1000ms）
    expect(g.decide('typecheck', false, 'fp1', 500)).toBe('cooldown')
  })

  it('同指纹冷却期后 → alert（计数递增）', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp1', 0)
    // 1500ms 后同指纹：冷却期已过
    expect(g.decide('typecheck', false, 'fp1', 1500)).toBe('alert')
  })

  it('同指纹连续失败超上限 → silence（防死循环核心）', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp1', 0) // alert (1)
    expect(g.decide('typecheck', false, 'fp1', 1000)).toBe('alert') // (2)
    expect(g.decide('typecheck', false, 'fp1', 2000)).toBe('alert') // (3)
    expect(g.decide('typecheck', false, 'fp1', 3000)).toBe('silence') // (4) 超上限
    expect(g.decide('typecheck', false, 'fp1', 4000)).toBe('silence') // 持续静默
  })

  it('指纹变化（错误内容变了）→ 重置计数并 alert', () => {
    const g = gate()
    g.decide('typecheck', false, 'fp_old', 0)
    g.decide('typecheck', false, 'fp_old', 1000)
    g.decide('typecheck', false, 'fp_old', 2000) // 连续 3 次
    expect(g.decide('typecheck', false, 'fp_new', 3000)).toBe('alert') // 错误变了，重置
  })

  it('恢复（ok）→ recovered 并清除状态；再失败从 1 重新开始', () => {
    const g = gate()
    g.decide('test', false, 'fp1', 0)
    expect(g.decide('test', true, '', 500)).toBe('recovered')
    expect(g.failingKeys()).toHaveLength(0)
    // 恢复后再失败：重新计数（还能再提醒，不是 silence）
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
    // lint 首次失败不受 typecheck 状态影响
    expect(g.decide('lint', false, 'fp2', 0)).toBe('alert')
    // typecheck 恢复不影响 lint 的冷却状态
    g.decide('typecheck', true, '', 500)
    expect(g.decide('lint', false, 'fp2', 500)).toBe('cooldown')
  })
})

describe('hashFingerprint', () => {
  it('同文本 → 同指纹', () => {
    expect(hashFingerprint('error: foo bar')).toBe(hashFingerprint('error: foo bar'))
  })

  it('不同文本 → 不同指纹（大概率）', () => {
    expect(hashFingerprint('error: foo')).not.toBe(hashFingerprint('error: bar'))
  })

  it('长文本只取前 2000 字符参与 hash（性能保护）', () => {
    const long1 = 'a'.repeat(3000)
    const long2 = 'a'.repeat(2000) + 'b'.repeat(1000)
    expect(hashFingerprint(long1)).toBe(hashFingerprint(long2))
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

describe('打包环境守卫（asar workDir → 源码类自检跳过，文件层与运行时监控仍生效）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('workDir 指向 app.asar → available=true + packaged=true，且源码类检查项被强制关闭', () => {
    // 模拟打包环境：app.getAppPath() 返回 asar 归档路径（含 package.json 也无效）
    const dir = mkdtempSync(join(tmpdir(), 'hc-asar-'))
    dirs.push(dir)
    const asarPath = join(dir, 'resources', 'app.asar')
    const hc = new HealthCheck({ workDir: asarPath, configDir: join(dir, '.hc') })
    const snap = hc.getStatusSnapshot()
    // 打包版健康检查仍可用（available 保持 true），只是源码类维度关闭
    expect(snap.available).toBe(true)
    expect(snap.packaged).toBe(true)
    // 源码类检查项（命令类 + 语义扫描）被强制关闭，只剩 files 与配置开关保留
    const enabledKeys = snap.checks.map((c) => c.key)
    expect(enabledKeys).toContain('files')
    expect(enabledKeys).not.toContain('typecheck')
    expect(enabledKeys).not.toContain('test')
    expect(enabledKeys).not.toContain('lint')
    expect(enabledKeys).not.toContain('build')
    expect(enabledKeys).not.toContain('code-review')
    expect(enabledKeys).not.toContain('uiux')
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

  it('打包态 dataRoot 缺失 → files 检查检出（打包版数据目录监察依然工作）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-asar-'))
    dirs.push(dir)
    const asarPath = join(dir, 'resources', 'app.asar')
    const missingDataRoot = join(dir, 'no-such-userdata')
    const hc = new HealthCheck({ workDir: asarPath, configDir: join(dir, '.hc'), dataRoot: missingDataRoot })
    const r = await hc.runNow()
    // 打包态只跑 files：其余检查项被关闭
    const files = r.checks.find((c) => c.key === 'files')
    expect(files?.ok).toBe(false)
    expect(files?.output).toContain('数据目录根缺失')
    // 其它检查项不执行（不存在于报告中）
    expect(r.checks.filter((c) => c.key !== 'files')).toHaveLength(0)
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

  it('干净源码 → 输出只有汇总行，无问题条目', () => {
    const dir = makeDir({ 'src/a.ts': 'export const a = 1\n' })
    const r = scanCodeReviewIssues(dir)
    expect(r.summary).toContain('发现 code-review 问题 0 处')
    expect(r.issues).toHaveLength(0)
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
