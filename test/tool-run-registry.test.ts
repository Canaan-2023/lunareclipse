/**
 * 工具运行托管注册表（services/tool-run-registry.ts）单元测试。
 *
 * 为什么存在：T3 软超时托管协议是「超时不打断、AI 检查、可继续等待或主动停止」的
 * 状态中枢，测试覆盖它的三条核心语义——
 * 1. register → running，落定后 settled 且带结果（watch 能取回）；
 * 2. waitForManagedRun 等待窗口内落定返回终局、超时返回 wait_timeout（AI 可续查）；
 * 3. stopManagedRun 中止 running 任务为 stopped，且对已落定任务不重复中止。
 * 注：无并发上限用例——硬性约定「永不硬截断」，超时一律转托管，不因并发占满
 * 等任何条件退回 abort 强杀（用户明令禁止「为了兜底改变实际使用逻辑」）。
 */
import { describe, it, expect } from 'vitest'
import {
  registerManagedRun,
  peekManagedRun,
  waitForManagedRun,
  stopManagedRun
} from '../electron/main/services/tool-run-registry'

function deferred(): { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void } {
  let resolve!: (v: string) => void
  let reject!: (e: Error) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('tool-run-registry 软超时托管协议', () => {
  it('注册后 running，落定后 settled 并保留结果（watch 可读）', async () => {
    const d = deferred()
    const taskId = registerManagedRun('run_command', { command: 'ping' }, Date.now(), new AbortController(), d.promise)
    expect(taskId).toContain('run_command')
    expect(peekManagedRun(taskId)?.status).toBe('running')

    d.resolve('done!')
    await sleep(10)
    const run = peekManagedRun(taskId)
    expect(run?.status).toBe('settled')
    expect(run?.result).toBe('done!')
  })

  it('promise reject 时记为 settled 并保存错误（而非卡死 running）', async () => {
    const d = deferred()
    const taskId = registerManagedRun('code_run', {}, Date.now(), new AbortController(), d.promise)
    d.reject(new Error('boom'))
    await sleep(10)
    const run = peekManagedRun(taskId)
    expect(run?.status).toBe('settled')
    expect(run?.error).toContain('boom')
  })

  it('waitForManagedRun：等待窗口内落定 → 返回终局', async () => {
    const d = deferred()
    const taskId = registerManagedRun('run_command', {}, Date.now(), new AbortController(), d.promise)
    const waitPromise = waitForManagedRun(taskId, 500)
    await sleep(30)
    d.resolve('early-done')
    expect(await waitPromise).not.toBe('not_found')
    const outcome = (await waitPromise) as { status: string; result?: string }
    expect(outcome.status).toBe('settled')
    expect(outcome.result).toBe('early-done')
  })

  it('waitForManagedRun：等待窗口到期仍 running → wait_timeout（AI 可续查）', async () => {
    const d = deferred()
    const taskId = registerManagedRun('run_command', {}, Date.now(), new AbortController(), d.promise)
    const outcome = await waitForManagedRun(taskId, 80)
    expect(outcome).toBe('wait_timeout')
    expect(peekManagedRun(taskId)?.status).toBe('running')
    // 续查语义：再等窗口内完成
    const wait2 = waitForManagedRun(taskId, 500)
    await sleep(20)
    d.resolve('second-watch-done')
    const out2 = (await wait2) as { status: string; result?: string }
    expect(out2.status).toBe('settled')
    expect(out2.result).toBe('second-watch-done')
  })

  it('waitForManagedRun：不存在任务 → not_found', async () => {
    expect(await waitForManagedRun('run_command-404', 50)).toBe('not_found')
  })

  it('stopManagedRun：running 任务中止为 stopped 并触发 abort（工具感知后收尸）', async () => {
    const d = deferred()
    const controller = new AbortController()
    const taskId = registerManagedRun('run_command', {}, Date.now(), controller, d.promise)
    const stopped = stopManagedRun(taskId)
    expect(stopped?.status).toBe('stopped')
    expect(controller.signal.aborted).toBe(true)
    expect(peekManagedRun(taskId)?.status).toBe('stopped')
  })

  it('stopManagedRun：已落定任务返回现有终局、不重复中止', async () => {
    const d = deferred()
    const controller = new AbortController()
    const taskId = registerManagedRun('run_command', {}, Date.now(), controller, d.promise)
    d.resolve('already-done')
    await sleep(10)
    const stopped = stopManagedRun(taskId)
    expect(stopped?.status).toBe('settled')
    expect(controller.signal.aborted).toBe(false)
  })

  it('stopManagedRun：不存在任务返回 undefined', () => {
    expect(stopManagedRun('nonexist')).toBeUndefined()
  })
})