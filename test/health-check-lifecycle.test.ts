import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HealthCheck } from '../electron/main/monitor/health-check'
import { TimerRegistry } from '../electron/main/monitor/timer-registry'

/** 真实工作区目录作为 workDir（available=true，不触发 asar 守卫）；真实定时器注册表 */
function makeSetup() {
  const workDir = join(__dirname, '..')
  const configDir = mkdtempSync(join(tmpdir(), 'health-check-lc-'))
  const timerRegistry = new TimerRegistry()
  const hc = new HealthCheck({ workDir, configDir, timerRegistry })
  return { workDir, configDir, timerRegistry, hc }
}

describe('HealthCheck start/stop 定时器生命周期', () => {
  let setup: ReturnType<typeof makeSetup>

  beforeEach(() => {
    setup = makeSetup()
  })

  afterEach(() => {
    // 兜底清理，避免泄漏到其他测试
    setup.hc.stop()
    rmSync(setup.configDir, { recursive: true, force: true })
  })

  it('start() → 注册 start-delay 首次检查 + interval 周期检查两个定时器', () => {
    const { timerRegistry, hc } = setup
    expect(timerRegistry.size()).toBe(0)

    hc.start()

    expect(timerRegistry.size()).toBe(2)
    const labels = timerRegistry.list().map((t) => t.label).sort()
    expect(labels).toEqual(['health-check.interval', 'health-check.start-delay'])
  })

  it('start() 幂等：已启动再调 start 不重复注册定时器', () => {
    const { timerRegistry, hc } = setup
    hc.start()
    hc.start()
    expect(timerRegistry.size()).toBe(2)
  })

  it('stop() → 清理 start-delay 与 interval，注册表归零', () => {
    const { timerRegistry, hc } = setup
    hc.start()
    expect(timerRegistry.size()).toBe(2)

    hc.stop()

    expect(timerRegistry.size()).toBe(0)
  })

  it('stop() 后再次 start() → 重新注册（可重启）', () => {
    const { timerRegistry, hc } = setup
    hc.start()
    hc.stop()
    expect(timerRegistry.size()).toBe(0)

    hc.start()

    expect(timerRegistry.size()).toBe(2)
  })

  it('enabled=false 配置 → start() 不注册任何定时器', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'health-check-disabled-'))
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({
        enabled: false,
        interval_minutes: 30,
        checks: { typecheck: true, test: true, lint: false, build: false, files: true },
        cooldown_minutes: 30,
        max_consecutive_failures: 3
      }),
      'utf-8'
    )
    const timerRegistry = new TimerRegistry()
    const hc = new HealthCheck({ workDir: join(__dirname, '..'), configDir, timerRegistry })

    hc.start()

    expect(timerRegistry.size()).toBe(0)
    rmSync(configDir, { recursive: true, force: true })
  })

  it('无 timerRegistry → 用全局 setTimeout/setInterval 也能 start/stop（handle 置空不报错）', () => {
    const hcNoRegistry = new HealthCheck({
      workDir: join(__dirname, '..'),
      configDir: mkdtempSync(join(tmpdir(), 'health-check-global-'))
    })

    expect(() => {
      hcNoRegistry.start()
      hcNoRegistry.stop()
    }).not.toThrow()
    rmSync(join(tmpdir(), 'health-check-global-'), { force: true })
  })
})