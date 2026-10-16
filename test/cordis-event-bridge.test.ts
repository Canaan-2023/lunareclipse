import { describe, it, expect } from 'vitest'
import { createRootContext } from '../electron/main/kernel/cordis-runtime'
import { attachCordisEventBridge, HOOK_TO_CORDIS } from '../electron/main/kernel/event-bridge'
import { HookManager } from '../electron/main/hooks/hook-manager'
import type { HookContext } from '../electron/main/hooks/types'

/**
 * 月蚀 ↔ Cordis 事件桥验证（阶段 3c，2026-08-25）
 *
 * - 映射表覆盖全部 6 个 hook 事件
 * - 观察桥：hookManager.run() 时 Cordis 监听器收到同载荷事件
 * - 原 hook 主链不受影响（返回结果不变）
 * - detach 恢复原始 run
 */

describe('事件桥：映射表', () => {
  it('覆盖全部 7 个 hook 事件', () => {
    const expected: Array<keyof typeof HOOK_TO_CORDIS> = [
      'PreLLMCall',
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
      'Notification'
    ]
    for (const ev of expected) {
      expect(HOOK_TO_CORDIS[ev]).toBeTruthy()
    }
    expect(Object.keys(HOOK_TO_CORDIS).length).toBe(7)
  })

  it('映射目标均为已声明的事件键', () => {
    const known = new Set([
      'llm/pre-call',
      'tools/pre-execute',
      'tools/post-execute',
      'user/message',
      'agent/turn-stopping',
      'agent/stop',
      'system/notify'
    ])
    for (const target of Object.values(HOOK_TO_CORDIS)) {
      expect(known.has(target as string)).toBe(true)
    }
  })
})

describe('事件桥：观察桥行为', () => {
  it('run 时 Cordis 监听器收到同载荷事件（PreLLMCall → llm/pre-call）', async () => {
    const ctx = createRootContext()
    const hookManager = new HookManager()
    // 空 hooks 时 run 直接 continue（不经过 executor）
    hookManager.loadHooks([])
    let received: HookContext | null = null
    ctx.on('llm/pre-call', (hookCtx) => {
      received = hookCtx
    })
    const detach = attachCordisEventBridge(ctx, hookManager)
    const payload: HookContext = {
      event: 'PreLLMCall',
      userPrompt: '你好',
      sessionId: 's-1'
    } as HookContext
    const result = await hookManager.run('PreLLMCall', payload)
    expect(received).toBe(payload)
    expect(result.action).toBe('continue') // 主链结果不变
    detach()
  })

  it('Cordis 监听器异常不阻断主链', async () => {
    const ctx = createRootContext()
    const hookManager = new HookManager()
    hookManager.loadHooks([])
    ctx.on('user/message', () => {
      throw new Error('观察者炸了')
    })
    attachCordisEventBridge(ctx, hookManager)
    const result = await hookManager.run('UserPromptSubmit', { event: 'UserPromptSubmit' } as HookContext)
    expect(result.action).toBe('continue') // 异常被吞，主链继续
  })

  it('detach 恢复原始 run（桥解除后不再 emit）', async () => {
    const ctx = createRootContext()
    const hookManager = new HookManager()
    hookManager.loadHooks([])
    let seen = 0
    ctx.on('agent/stop', () => seen++)
    const detach = attachCordisEventBridge(ctx, hookManager)
    await hookManager.run('SubagentStop', { event: 'SubagentStop' } as HookContext)
    expect(seen).toBe(1)
    detach()
    await hookManager.run('SubagentStop', { event: 'SubagentStop' } as HookContext)
    expect(seen).toBe(1) // 桥解除后不再触发
  })
})