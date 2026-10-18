import { describe, it, expect } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import { toolSignalStorage } from '../electron/main/api/llm-types'
import type { AnyTool } from '../electron/main/tools/base-tool'

/**
 * executeTool × 取消信号注入（2026-10-03）
 * 为什么存在：llm.ts 工具循环超时时经 AsyncLocalStorage 注入 AbortSignal，
 *   executeTool 必须把它落到 ToolContext.signal，工具才能据此优雅退出
 *   （修复「外层超时只 reject、底层工具在后台成孤儿」的旧行为）。
 * 覆盖：ALS 注入 / 调用方参数优先 / 已 abort 时短路返回取消结果。
 */
describe('executeTool × 取消信号注入', () => {
  const probe: AnyTool = {
    name: '__signal_probe__',
    description: 'test probe',
    parameters: [],
    execute: (_p, ctx) => ({
      ok: true,
      data: { hasSignal: !!ctx?.signal, aborted: ctx?.signal?.aborted ?? null }
    })
  }

  const makeRegistry = () => {
    const r = createToolRegistry({ config: {} } as never, {} as never)
    r.tools.set(probe.name, probe)
    return r
  }

  it('经 AsyncLocalStorage 注入 signal 到工具 ctx', async () => {
    const ctrl = new AbortController()
    const res = await toolSignalStorage.run(ctrl.signal, () =>
      executeTool(makeRegistry(), probe.name, {})
    )
    expect(res.ok).toBe(true)
    expect((res.data as { hasSignal: boolean }).hasSignal).toBe(true)
    expect((res.data as { aborted: boolean }).aborted).toBe(false)
  })

  it('调用方显式传 signal 优先（无 ALS 亦注入）', async () => {
    const ctrl = new AbortController()
    const res = await executeTool(makeRegistry(), probe.name, {}, ctrl.signal)
    expect((res.data as { hasSignal: boolean }).hasSignal).toBe(true)
  })

  it('已 abort 的 signal → 短路返回取消结果', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await executeTool(makeRegistry(), probe.name, {}, ctrl.signal)
    expect(res.ok).toBe(false)
    expect(res.error ?? '').toContain('取消')
  })
})
