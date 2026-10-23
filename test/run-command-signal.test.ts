import { describe, it, expect } from 'vitest'
import { RunCommandTool } from '../electron/main/tools/run-command'
import type { ToolContext } from '../electron/main/tools/base-tool'

/**
 * run_command × 取消信号（2026-10-03）
 * 为什么存在：外层工具执行器（llm.ts 对话保护墙）超时经 ctx.signal 发取消，run_command 必须真正
 *   终止子进程树，否则命令在后台继续跑成无人回收的孤儿（进程泄漏）。
 * 覆盖：abort 后子进程被终止、结果返回取消（而非等命令自然结束）。
 */
describe('run_command × ctx.signal 取消', () => {
  it('abort 终止正在运行的子进程并返回取消结果（不等命令自然结束）', async () => {
    const tool = new RunCommandTool()
    const ctrl = new AbortController()
    const ctx = { signal: ctrl.signal } as unknown as ToolContext
    // ping 在白名单内（单条命令），-n 30 约 29s；abort 后应远早于此返回
    const p = tool.execute({ command: 'ping -n 30 127.0.0.1', timeoutMs: 60000 }, ctx)
    setTimeout(() => ctrl.abort(), 300)
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('取消')
  }, 15000)
})
