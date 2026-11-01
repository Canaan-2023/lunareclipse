/**
 * 托管任务退出清理回归（2026-10-31 生命周期收口）。
 *
 * 背景：`run_command`/`code_run` 超时后转后台托管（不杀进程）；但退出链此前既不引用
 * 托管注册表也不 abort，窗口关闭后长命令子进程树仍在跑（Windows 孤儿进程）。
 * 修复：`stopAllManagedRuns()` 在退出时 abort 全部 running 任务并清 GC 定时器。
 */
import { describe, it, expect } from 'vitest'
import {
  registerManagedRun,
  stopAllManagedRuns,
  peekManagedRun
} from '../electron/main/services/tool-run-registry'

describe('stopAllManagedRuns · 退出时收尸', () => {
  it('running 任务被 abort、标记 stopped；不再处于可等待状态', () => {
    const controller = new AbortController()
    let resolveExec: (v: unknown) => void = () => {}
    const pending = new Promise<unknown>((resolve) => {
      resolveExec = resolve
    })
    const taskId = registerManagedRun('run_command', { command: 'long' }, Date.now(), controller, pending)

    expect(peekManagedRun(taskId)?.status).toBe('running')
    const stopped = stopAllManagedRuns('退出测试')

    expect(stopped).toBeGreaterThanOrEqual(1)
    expect(controller.signal.aborted).toBe(true)
    const run = peekManagedRun(taskId)
    expect(run?.status).toBe('stopped')
    expect(run?.error).toContain('退出测试')
    // 结束挂起 promise，避免影响其它测试的事件循环
    resolveExec('ok')
  })

  it('已落定任务不会被改判（只处理 running）', () => {
    const controller = new AbortController()
    const settled = Promise.resolve('done')
    const taskId = registerManagedRun('code_run', {}, Date.now(), controller, settled)
    // 让 microtask 落定
    return settled.then(() => {
      const before = peekManagedRun(taskId)?.status
      stopAllManagedRuns()
      const after = peekManagedRun(taskId)
      expect(before).toBe('settled')
      expect(after?.status).toBe('settled')
    })
  })
})
