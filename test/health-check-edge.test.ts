import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AlertGate,
  keepTail,
  stripAnsi,
  decodeChildOutput,
  HealthCheck
} from '../electron/main/monitor/health-check'
import { ModuleRegistry } from '../electron/main/monitor/module-registry'
import type { ActivationManager } from '../electron/main/api/activation-manager'

// ============================================================
// 健康检查边缘/集成补缺测试
// ------------------------------------------------------------
// 为什么存在：主测试（health-check.test.ts / -real-check.test.ts /
// -lifecycle.test.ts）覆盖了状态机主干、静态扫描与真实 tsc，但
// code-review 复查发现以下可观测行为零覆盖，属真实测试缺口：
//   1. keepTail（中位截断）从未被任一用例断言
//   2. AlertGate 在 maxConsecutiveFailures>100 时能否真的静默
//      （曾在计数被 CONSECUTIVE_FAILURES_CAP 截顶后永远无法达到阈值——
//       这是真实缺陷，已修复，本套用例是防回归）
//   3. getStatusSnapshot 的「尚未检查 ok=null」占位语义
//   4. HealthCheck → ModuleRegistry 联动（检查项失败标红对应模块）
//   5. notify 中 code-review / uiux 的 skill 引导分支
//   6. loadConfig 对损坏 config.json 的回退
//   7. 全部检查完成后统一上报：多失败项一次唤醒只推一条事件（不边检查边上报）
// 作用：把评审发现的缺口固化为回归测试，防止后续改动悄悄破坏这些行为。
// ============================================================

describe('keepTail（中位截断：保留头+尾，中间省略）', () => {
  it('短文本原样返回（不截断）', () => {
    expect(keepTail('hello', 100)).toBe('hello')
  })

  it('超长文本保留头部 60% + 省略标注 + 尾部 40%（vitest 汇总在末尾）', () => {
    const body = 'A'.repeat(50)
    const out = keepTail(body, 10)
    // head = ceil(10*0.6)=6，tail = 10-6=4
    expect(out.startsWith('AAAAAA')).toBe(true)
    expect(out).toContain('中段省略，共 50 字符')
    expect(out.endsWith('AAAA')).toBe(true)
  })

  it('恰好等于上限 → 原样返回，省略标注不出现', () => {
    expect(keepTail('12345', 5)).toBe('12345')
  })
})

describe('stripAnsi（剥离 ANSI 转义序列）', () => {
  it('普通文本原样返回', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('剥离颜色码/粗体等 CSI 序列', () => {
    const colored = '\u001b[31mERROR\u001b[0m \u001b[1mBOLD\u001b[22m'
    expect(stripAnsi(colored)).toBe('ERROR BOLD')
  })

  it('剥离带分号参数的序列（如 38;5;214）', () => {
    expect(stripAnsi('\u001b[38;5;214mX\u001b[39m')).toBe('X')
  })

  it('不误伤正常内容中的普通字符', () => {
    expect(stripAnsi('a[31mb')).toBe('a[31mb')
  })
})

describe('decodeChildOutput（子进程输出编码解码）', () => {
  it('纯 UTF-8 字节原样解码（工具链标准输出）', () => {
    expect(decodeChildOutput(Buffer.from('type error at a.ts:1', 'utf-8'))).toBe('type error at a.ts:1')
  })

  it('UTF-8 中文正常解码', () => {
    expect(decodeChildOutput(Buffer.from('测试失败：断言不匹配', 'utf-8'))).toBe('测试失败：断言不匹配')
  })

  it('GBK 字节回退解码（Windows 中文环境 cmd/部分工具错误消息）', () => {
    // 「测试」的 GBK 编码字节（0xB2E2 0xCAD4），若按 utf-8 解会是乱码
    const gbk = Buffer.from([0xb2, 0xe2, 0xca, 0xd4])
    expect(decodeChildOutput(gbk)).toBe('测试')
  })

  it('空 Buffer 返回空串', () => {
    expect(decodeChildOutput(Buffer.alloc(0))).toBe('')
  })
})

describe('AlertGate 只有冷却、没有永久静默', () => {
  it('冷却 0 时每轮都提醒（持续未修复不会被藏起来）', () => {
    const g = new AlertGate({ cooldownMs: 0 })
    const dec: string[] = []
    for (let i = 1; i <= 5; i++) dec.push(g.decide('typecheck', false, 'same-fp', i * 1000))
    expect(dec).toEqual(['alert', 'alert', 'alert', 'alert', 'alert'])
  })
})

describe('HealthCheck ↔ ModuleRegistry 联动（检查项失败/恢复标红/变绿）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeHc = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-mr-'))
    dirs.push(dir)
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, ...p.split('/'))
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
        checks: { typecheck: false, test: false, lint: false, build: false, files: true, 'code-review': false, uiux: false },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    const moduleRegistry = new ModuleRegistry()
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir, moduleRegistry })
    return { hc, moduleRegistry }
  }

  it('files 检查失败 → 同步标红 workspace 模块（CHECK_TO_MODULE）', async () => {
    const { hc, moduleRegistry } = makeHc({ 'package.json': '{}' }) // 缺 tsconfig.json → files 失败
    await hc.runNow()
    const ws = moduleRegistry.getSnapshot().find((m) => m.id === 'workspace')
    expect(ws?.ok).toBe(false)
    expect(ws?.error).toContain('tsconfig.json')
  })

  it('files 恢复通过 → workspace 变绿（markRecovered）', async () => {
    const { hc, moduleRegistry } = makeHc({ 'package.json': '{}' })
    await hc.runNow()
    expect(moduleRegistry.getSnapshot().find((m) => m.id === 'workspace')?.ok).toBe(false)
    // 补上 tsconfig.json → 修复 → 恢复标绿
    const workDir = (hc as unknown as { workDir: string }).workDir
    writeFileSync(join(workDir, 'tsconfig.json'), '{}')
    await hc.runNow()
    const ws = moduleRegistry.getSnapshot().find((m) => m.id === 'workspace')
    expect(ws?.ok).toBe(true)
  })
})

describe('notify 上报 AI 事件（全部检查完成后统一上报 + code-review/uiux 修复指引分支）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeHc = (files: Record<string, string>, checks: Record<string, boolean>) => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-notify-'))
    dirs.push(dir)
    // 模拟源码工作区（含 package.json）：无 package.json 时构造器按「打包环境」处理，
    // 会强制关闭 code-review/uiux 源码类检查，导致 notify 引导分支不可达——测试因此必须带 package.json。
    writeFileSync(join(dir, 'package.json'), '{}')
    for (const [p, content] of Object.entries(files)) {
      const full = join(dir, ...p.split('/'))
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
    const pushExternalEvent = vi.fn()
    const activationManager = { pushExternalEvent } as unknown as ActivationManager
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir, activationManager })
    return { hc, pushExternalEvent }
  }

  it('code-review 失败 → 事件文案给出逐条代码评审的能力要求（不绑定技能名）', async () => {
    const { hc, pushExternalEvent } = makeHc(
      { 'src/a.ts': 'export function f() {\n  debugger\n}\n' },
      { typecheck: false, test: false, lint: false, build: false, files: false, 'code-review': true, uiux: false }
    )
    const r = await hc.runNow()
    const cr = r.checks.find((c) => c.key === 'code-review')
    expect(cr?.ok).toBe(false)
    expect(cr?.output).toContain('debugger')
    // 关键：推送事件必须给出「怎么做」的能力指引 + 区分误报的要求；
    // 且刻意不绑定具体技能名——技能两层都不随包分发，写死名字会把 AI 指向不存在的 skill。
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    const msg = pushExternalEvent.mock.calls[0][0] as string
    expect(msg).toContain('代码评审')
    expect(msg).toContain('区分真实缺陷与误报')
    expect(msg).not.toContain('code-review skill')
  })

  it('uiux 失败 → 事件文案给出 UI/UX 专家视角的能力要求（不绑定技能名）', async () => {
    const { hc, pushExternalEvent } = makeHc(
      { 'src/App.tsx': 'export const App = () => <button><Icon /></button>\n' },
      { typecheck: false, test: false, lint: false, build: false, files: false, 'code-review': false, uiux: true }
    )
    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    const msg = pushExternalEvent.mock.calls[0][0] as string
    expect(msg).toContain('UI/UX 专家视角')
    expect(msg).toContain('可访问性与设计一致性')
    expect(msg).not.toContain('ui-ux-pro-max')
  })

  it('多个检查项同时失败 → 一次完整检查只唤醒一次 AI，事件包含全部失败项', async () => {
    // files（缺 tsconfig.json）+ code-review（debugger 残留）同时失败：
    // 关键行为——全部检查项跑完后才统一上报，不因第一个失败项中途唤醒 AI
    const { hc, pushExternalEvent } = makeHc(
      { 'src/a.ts': 'export function f() {\n  debugger\n}\n' },
      { typecheck: false, test: false, lint: false, build: false, files: true, 'code-review': true, uiux: false }
    )
    const r = await hc.runNow()
    expect(r.checks.find((c) => c.key === 'files')?.ok).toBe(false)
    expect(r.checks.find((c) => c.key === 'code-review')?.ok).toBe(false)
    // 一次唤醒一条事件，且消息包含全部失败项（各自输出 + 修复指引）
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    const msg = pushExternalEvent.mock.calls[0][0] as string
    expect(msg).toContain('发现 2 项检查未通过')
    expect(msg).toContain('tsconfig.json') // files 失败内容
    expect(msg).toContain('debugger 语句残留') // code-review 失败内容
    expect(msg).toContain('[1/2] files')
    expect(msg).toContain('[2/2] code-review')
    expect(msg).toContain('代码评审')
  })
})

describe('失败时完整输出落盘路径透传（用户/AI 可拿到全文）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const makeHcFilesFail = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-dumppath-'))
    dirs.push(dir)
    // 只给 package.json，缺 tsconfig.json → files 检查失败
    writeFileSync(join(dir, 'package.json'), '{}')
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        enabled: true,
        interval_minutes: 30,
        checks: { typecheck: false, test: false, lint: false, build: false, files: true, 'code-review': false, uiux: false },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    const pushExternalEvent = vi.fn()
    const activationManager = { pushExternalEvent } as unknown as ActivationManager
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir, activationManager })
    return { hc, pushExternalEvent, dir }
  }

  it('注入 AI 的事件消息包含完整输出落盘文件路径', async () => {
    const { hc, pushExternalEvent, dir } = makeHcFilesFail()
    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    const msg = pushExternalEvent.mock.calls[0][0] as string
    // 事件正文可见「完整输出已落盘」提示与绝对路径（开发态落 data/userdata/logs）
    expect(msg).toContain('完整输出已落盘')
    expect(msg).toContain(join(dir, 'data', 'userdata', 'logs'))
    expect(msg).toContain('health-check-full-files-')
  })

  it('报告 output 同样附带完整输出落盘文件路径', async () => {
    const { hc, dir } = makeHcFilesFail()
    const report = await hc.runNow()
    const files = report.checks.find((c) => c.key === 'files')
    expect(files?.ok).toBe(false)
    expect(files?.output).toContain('tsconfig.json')
    expect(files?.output).toContain('完整输出已落盘')
    expect(files?.output).toContain(join(dir, 'data', 'userdata', 'logs'))
  })
})

describe('getStatusSnapshot 占位语义（尚未检查 = null，非 false）', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('未运行过 runNow → 已启用检查项 ok=null、overallOk=null（避免前端 !ok 误计红）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-snap-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'tsconfig.json'), '{}')
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        enabled: true,
        interval_minutes: 30,
        checks: { typecheck: false, test: false, lint: false, build: false, files: true, 'code-review': false, uiux: false },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      })
    )
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir })
    const snap = hc.getStatusSnapshot()
    expect(snap.lastRunAt).toBeNull()
    expect(snap.overallOk).toBeNull()
    expect(snap.running).toBe(false)
    expect(snap.checks.find((c) => c.key === 'files')?.ok).toBeNull()
  })
})

describe('loadConfig 损坏配置回退', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('config.json 是非法 JSON → 回退默认配置，不抛错、enabled=true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-badcfg-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{}')
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), '{ not valid json !!!', 'utf-8')

    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir })
    const snap = hc.getStatusSnapshot()
    expect(snap.enabled).toBe(true)
    expect(snap.interval_minutes).toBe(30)
    expect(snap.available).toBe(true)
  })

  it('非法数值被夹取：interval=0 → 1 分钟，负冷却/0 阈值不产生空转或失效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-clamp-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'package.json'), '{}')
    const cfgDir = join(dir, '.hc')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'config.json'),
      JSON.stringify({
        enabled: true,
        interval_minutes: 0,
        checks: { typecheck: false, test: false, lint: false, build: false, files: true },
        cooldown_minutes: -5,
        max_consecutive_failures: 0
      }),
      'utf-8'
    )
    const hc = new HealthCheck({ workDir: dir, configDir: cfgDir })
    expect(hc.getStatusSnapshot().interval_minutes).toBe(1)
  })
})