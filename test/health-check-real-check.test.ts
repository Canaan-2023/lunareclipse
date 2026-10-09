import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HealthCheck } from '../electron/main/monitor/health-check'
import type { ActivationManager } from '../electron/main/api/activation-manager'

// ============================================================
// 健康检查「真实检查代码」测试（重建核心）
// ------------------------------------------------------------
// 此前测试盲区：所有用例都在 mock/临时目录里跑，没有任何一条验证
// 「typecheck 检查项真的用 tsc 检查到项目代码错误、并把信息返回给 AI」。
// 本套测试通过 Windows junction 链接真实 node_modules/typescript 与
// 便携 node 到临时工作区，让健康检查的 typecheck 命令【真实执行】：
//   - 构造含类型错误的迷你项目 → 断言检出 TS 错误、事件送达 AI、可修复信息完整
//   - 修复代码 → 断言检查通过、整体恢复
//   - 同错误冷却 → 断言不重复唤醒 AI（防死循环在真实结果上生效）
// ============================================================

const REAL_APP = join(__dirname, '..')

interface RealCheckHarness {
  hc: HealthCheck
  tmpDirs: string[]
  pushExternalEvent: ReturnType<typeof vi.fn>
}

function makeRealTypecheckHc(opts: { src?: string; srcFile?: string } = {}): RealCheckHarness {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'hc-real-'))
  const configDir = mkdtempSync(join(tmpdir(), 'hc-real-cfg-'))
  mkdirSync(join(tmpRoot, 'node_modules'))
  // junction 链接真实 tsc 与便携 node：typecheck 命令在临时目录里真实执行（等同 App 内运行）
  symlinkSync(join(REAL_APP, 'node_modules', 'typescript'), join(tmpRoot, 'node_modules', 'typescript'), 'junction')
  symlinkSync(join(REAL_APP, '.tools'), join(tmpRoot, '.tools'), 'junction')
  writeFileSync(join(tmpRoot, 'package.json'), JSON.stringify({ name: 'hc-fixture', version: '0.0.0' }), 'utf-8')
  mkdirSync(join(tmpRoot, 'src'))
  writeFileSync(
    join(tmpRoot, 'src', opts.srcFile ?? 'error.ts'),
    opts.src ?? 'export const x: number = "oops"\n',
    'utf-8'
  )
  const cfg = {
    compilerOptions: { noEmit: true, strict: true, target: 'ES2020', module: 'commonjs' },
    include: ['src']
  }
  writeFileSync(join(tmpRoot, 'tsconfig.node.json'), JSON.stringify(cfg), 'utf-8')
  writeFileSync(join(tmpRoot, 'tsconfig.web.json'), JSON.stringify(cfg), 'utf-8')
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      enabled: true,
      interval_minutes: 30,
      checks: { typecheck: true, test: false, lint: false, build: false, files: false },
      cooldown_minutes: 30,
      max_consecutive_failures: 3
    }),
    'utf-8'
  )
  const pushExternalEvent = vi.fn()
  const activationManager = { pushExternalEvent } as unknown as ActivationManager
  const hc = new HealthCheck({ workDir: tmpRoot, configDir, activationManager })
  return { hc, tmpDirs: [tmpRoot, configDir], pushExternalEvent }
}

describe('健康检查真实检查项目代码（typecheck 真实执行 tsc）', () => {
  const allTmp: string[] = []
  afterEach(() => {
    for (const d of allTmp.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('含类型错误的代码 → 检出 TS2322（含文件:行列）并通知 AI 修复', async () => {
    const { hc, tmpDirs, pushExternalEvent } = makeRealTypecheckHc()
    allTmp.push(...tmpDirs)

    const report = await hc.runNow()
    const tc = report.checks.find((c) => c.key === 'typecheck')
    expect(tc?.ok).toBe(false)
    // 输出携带可定位信息：文件名 + 行列 + TS 错误码（AI 据此修复）
    expect(tc?.output).toContain('error.ts')
    expect(tc?.output).toMatch(/TS\d+/)
    expect(tc?.output).toContain('not assignable')

    // 事件送达 AI 会话：内容含告警头、检查项、修复指引与修复说明。
    // 指引刻意不绑定技能名（技能不随包分发，写死名字会指向不存在的 skill）。
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    const msg = pushExternalEvent.mock.calls[0][0] as string
    expect(msg).toContain('【健康检查】')
    expect(msg).toContain('typecheck')
    expect(msg).toContain('先定位根因')
    expect(msg).toContain('修复')
    expect(msg).not.toContain('bug-diagnosis')

    // 面板时间线记录 alert
    const log = hc.getStatusSnapshot().repairLog
    expect(log.some((e) => e.key === 'typecheck' && e.kind === 'alert')).toBe(true)
  })

  it('修复代码后 → typecheck 通过，整体恢复', async () => {
    const { hc, tmpDirs } = makeRealTypecheckHc({ src: 'export const x: number = 42\n' })
    allTmp.push(...tmpDirs)

    const report = await hc.runNow()
    const tc = report.checks.find((c) => c.key === 'typecheck')
    expect(tc?.ok).toBe(true)
    expect(tc?.output).toBe('')
    expect(report.ok).toBe(true)
    expect(hc.getStatusSnapshot().overallOk).toBe(true)
  })

  it('同一错误冷却期内不重复唤醒 AI（防死循环在真实 tsc 结果上生效）', async () => {
    const { hc, tmpDirs, pushExternalEvent } = makeRealTypecheckHc()
    allTmp.push(...tmpDirs)

    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    // 冷却期 30 分钟内同指纹：gate 返回 cooldown，不再 push
    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
  })

  it('错误变化（新指纹）→ 冷却重置，重新唤醒 AI', async () => {
    const { hc, tmpDirs, pushExternalEvent } = makeRealTypecheckHc()
    allTmp.push(...tmpDirs)

    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(1)
    // 改一个不同的错误（指纹变化）→ gate 重置计数，再次 alert
    writeFileSync(join(tmpDirs[0], 'src', 'error.ts'), 'export const x: number = 123\nconst y: string = 1\n', 'utf-8')
    await hc.runNow()
    expect(pushExternalEvent).toHaveBeenCalledTimes(2)
  })
})