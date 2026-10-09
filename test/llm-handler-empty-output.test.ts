import { describe, it, expect } from 'vitest'
import { LlmHandler } from '../electron/main/workflow/handlers/llm-handler'
import type { NodeHandlerContext } from '@shared/workflow/types'

/**
 * 验证记录（2026-08-26）：outputVars 决策节点空输出 = 失败（治本：不再 completed 无决策）
 * 修复动机：dispatcher 实例曾"LLM 空输出 → 节点 completed → 决策缺失 → 恢复死循环"。
 * 现在空输出直接抛错 → 节点 failed → 实例 failed → 调度器按失败重跑本批次。
 */
function makeCtx(overrides: { tokenBuf?: string; enableReasoning?: boolean } = {}) {
  const { tokenBuf = '', enableReasoning = false } = overrides
  const instance = { id: 'wf_test_1', mode: 'workflow', context: {}, messages: [] }
  const ctx = {
    node: {
      id: 'dispatcher',
      name: '价值判断 + 生成记忆',
      type: 'llm',
      config: { prompt: 'test', outputVars: ['decision', 'tasks'], stream: false }
    },
    instance,
    config: { prompt: 'test', stream: false },
    llm: {
      streamWithTools: (
        _msgs: unknown,
        _tools: unknown,
        cb: { onToken: (t: string) => void; onReasoning?: (t: string) => void; onDone: () => void }
      ) => {
        if (tokenBuf) cb.onToken(tokenBuf)
        if (enableReasoning) cb.onReasoning?.('思考中')
        cb.onDone()
        return Promise.resolve()
      }
    },
    resolveTemplate: (s: string) => s,
    toolPool: { filter: () => [] },
    emit: () => {}
  }
  return { ctx, instance }
}

describe('LlmHandler outputVars 节点空输出判失败（2026-08-26）', () => {
  it('LLM 空输出 + 配置 outputVars → 抛错（节点失败，走重跑）', async () => {
    const { ctx } = makeCtx({ tokenBuf: '' })
    const handler = new LlmHandler()
    await expect(handler.handle(ctx as unknown as NodeHandlerContext)).rejects.toThrow(/outputVars.*输出为空/)
  })

  it('LLM 有输出 → 正常返回（不受影响）', async () => {
    const { ctx } = makeCtx({ tokenBuf: '<json>{"decision":"skip"}</json>' })
    const handler = new LlmHandler()
    const result = await handler.handle(ctx as unknown as NodeHandlerContext)
    expect(result.output).toContain('"decision":"skip"')
  })

  it('无 outputVars 的空输出节点 → 不抛错（向后兼容：非决策节点空输出不判失败）', async () => {
    const { ctx } = makeCtx({ tokenBuf: '', enableReasoning: true })
    ctx.config = { prompt: 'test', stream: false }
    ctx.node.config = { prompt: 'test' }
    const handler = new LlmHandler()
    const result = await handler.handle(ctx as unknown as NodeHandlerContext)
    expect(result.output).toBe('')
  })
})