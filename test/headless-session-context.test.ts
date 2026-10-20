/**
 * 无头链路的**内部会话锚点**接入（v11 双层会话 / 逆生树）。
 *
 * 为什么测：此前无头链路把 `sessionContext` **硬编码为 null** → 走线性管线（裸历史），
 * 而 WS 主路径走「路由 → `buildSessionContext` 锚点」。结果是同一套 AI 在房间里比在普通会话里
 * 明显简陋（无路由/代际/摘要/继承）。本用例锁定三件事：
 * 1. 注入了 `resolveSessionContext` → 其返回值作为**第 3 参**传给 `buildInjectedMessages`；
 * 2. 未注入 → 仍传 `null`（**行为与引入前逐字一致**，不误伤未升级的调用方）；
 * 3. 解析抛错 → **回退 null 且不抛**（无头轮次不能卡在路由上）。
 */
import { describe, it, expect } from 'vitest'
import { createHeadlessChatRunner, type HeadlessChatDeps } from '../electron/main/api/run-headless-chat'
import type { ChatMessage, SessionContext } from '@shared/types'

const ANCHOR = { internalId: 'int-1', anchorMessages: [] } as unknown as SessionContext

function makeHarness(over: Partial<HeadlessChatDeps> = {}) {
  const injectedCalls: Array<{ sessionContext: unknown; purpose?: string }> = []
  const llm = {
    isReady: () => true,
    // runner 返回的是 onToken 累积出的 fullOutput（不是 streamWithTools 的返回值），故桩要真的推一个 token
    streamWithTools: async (_m: unknown, _e: unknown, cb?: { onToken?: (t: string) => void }): Promise<string> => {
      cb?.onToken?.('ok')
      return 'ok'
    }
  }
  const deps = {
    configStore: { get: () => ({ llm: {} }) },
    sessionStore: {
      get: () => ({ id: 'sess-1', messages: [] }),
      getOrCreate: () => ({ id: 'sess-1', messages: [] }),
      saveMessages: () => {}
    },
    buildInjectedMessages: async (
      _m: ChatMessage[],
      _sid?: string,
      sessionContext?: unknown,
      purpose?: string
    ): Promise<ChatMessage[]> => {
      injectedCalls.push({ sessionContext, purpose })
      return []
    },
    lastInjectedEstimateRef: { current: null },
    streamSession: {
      enqueue: async (fn: () => unknown) => await fn(),
      setForwarder: () => {},
      isOpen: () => false,
      push: () => {}
    },
    llmClientRef: { current: llm },
    makeLlmClient: () => llm,
    toolExecutorsRef: { current: [] },
    makeDistillCallbacks: () => ({}),
    rowIdRef: { current: 0 },
    writeRawMemoryForStream: () => {},
    serverCtx: {},
    ...over
  } as unknown as HeadlessChatDeps
  return { runner: createHeadlessChatRunner(deps), injectedCalls }
}

describe('无头链路的内部会话锚点（逆生树）', () => {
  it('注入了 resolveSessionContext → 锚点作为第 3 参传入（且 purpose 一并透传）', async () => {
    const { runner, injectedCalls } = makeHarness({
      resolveSessionContext: async () => ANCHOR
    })
    await runner('你好', 'sess-1', 1, 'room')
    expect(injectedCalls).toHaveLength(1)
    expect(injectedCalls[0].sessionContext).toBe(ANCHOR)
    expect(injectedCalls[0].purpose).toBe('room')
  })

  it('未注入 → 仍传 null（未升级的调用方行为逐字不变）', async () => {
    const { runner, injectedCalls } = makeHarness()
    await runner('你好', 'sess-1')
    expect(injectedCalls[0].sessionContext).toBeNull()
  })

  it('解析抛错 → **上浮不吞**（用户裁决：报错比兜底好，静默降级才是「不干净」）', async () => {
    const { runner, injectedCalls } = makeHarness({
      resolveSessionContext: async () => {
        throw new Error('router boom')
      }
    })
    await expect(runner('你好', 'sess-1')).rejects.toThrow('router boom')
    // 抛错时**不得**继续用「线性管线」把这一轮跑完
    expect(injectedCalls).toHaveLength(0)
  })

  it('解析返回 null（未启用/路由失败）→ 线性管线，不崩', async () => {
    const { runner, injectedCalls } = makeHarness({ resolveSessionContext: async () => null })
    await runner('你好', 'sess-1')
    expect(injectedCalls[0].sessionContext).toBeNull()
  })
})
