/**
 * 健康检查命令执行器回归（0.53.10）。
 *
 * 重点不是「命令能跑」，而是：
 * - 超时被识别为 timeout（不与普通失败混为一谈）；
 * - 超时后整棵进程树被终止（Windows 实测 taskkill /T /F；POSIX 跳过该断言）；
 * - 输出/退出码/耗时在结果里保留；
 * - 结算只发生一次（超时与自然退出竞态不会重复 resolve）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { runHealthCommand } from '../electron/main/monitor/health-command'

const dirs: string[] = []
afterEach(() => {
  // 超时用例的子进程可能刚被 taskkill，目录句柄释放有延迟 → 重试删除
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hc-cmd-'))
  dirs.push(dir)
  return dir
}

const NODE = `"${process.execPath}"`

describe('runHealthCommand', () => {
  it('退出码 0 → pass，保留 stdout', async () => {
    const dir = makeDir()
    const r = await runHealthCommand({
      cmd: `${NODE} -e "process.stdout.write('hello')"`,
      cwd: dir,
      timeoutMs: 10_000
    })
    expect(r.outcome).toBe('pass')
    expect(r.timedOut).toBe(false)
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain('hello')
  })

  it('非零退出 → fail，保留 stderr 与退出码（不冒充超时）', async () => {
    const dir = makeDir()
    const r = await runHealthCommand({
      cmd: `${NODE} -e "process.stderr.write('boom'); process.exit(3)"`,
      cwd: dir,
      timeoutMs: 10_000
    })
    expect(r.outcome).toBe('fail')
    expect(r.timedOut).toBe(false)
    expect(r.exitCode).toBe(3)
    expect(r.output).toContain('boom')
  })

  it('超时 → timeout，保留已产出的部分输出并给出明确原因', async () => {
    const dir = makeDir()
    const r = await runHealthCommand({
      cmd: `${NODE} -e "process.stdout.write('started'); setTimeout(()=>{}, 60000)"`,
      cwd: dir,
      timeoutMs: 300
    })
    expect(r.outcome).toBe('timeout')
    expect(r.timedOut).toBe(true)
    expect(r.output).toContain('started')
    expect(r.output).toContain('命令超时')
    expect(r.durationMs).toBeLessThan(8_000) // 不能等满 5s 宽限才结算
  })

  it('超时终止整棵进程树（Windows 实测孙进程被清理）', async () => {
    const dir = makeDir()
    const script = join(dir, 'hang.js')
    writeFileSync(
      script,
      [
        "const { spawn } = require('child_process')",
        "const g = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })",
        "process.stdout.write('grandchild=' + g.pid + '\\n')",
        'setTimeout(()=>{}, 60000)'
      ].join('\n'),
      'utf-8'
    )
    const r = await runHealthCommand({
      cmd: `${NODE} "${script}"`,
      cwd: dir,
      timeoutMs: 400
    })
    expect(r.outcome).toBe('timeout')
    const pid = Number(r.output.match(/grandchild=(\d+)/)?.[1] ?? 0)
    if (process.platform === 'win32' && pid > 0) {
      // taskkill 异步完成：给 500ms 收尾
      await new Promise((res) => setTimeout(res, 500))
      const check = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf-8' })
      expect(check.stdout).not.toContain(String(pid))
    }
  })
})
