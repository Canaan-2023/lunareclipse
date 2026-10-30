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
  const injectedCalls: Array<{ sessionContext: unknown; purpose?: string; ctxSessionId?: string }> = []
  const saves: ChatMessage[][] = []
  const raws: string[] = []
  const serverCtx: { sessionId?: string } = {}
  // 与真实 StreamSession.enqueue 同语义：串行队列（0.53.10 起 headless 整轮入队）
  let chain: Promise<unknown> = Promise.resolve()
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
      saveMessages: (_id: string, messages: ChatMessage[]) => {
        saves.push(messages)
      }
    },
    buildInjectedMessages: async (
      _m: ChatMessage[],
      _sid?: string,
      sessionContext?: unknown,
      purpose?: string
    ): Promise<ChatMessage[]> => {
      injectedCalls.push({ sessionContext, purpose, ctxSessionId: serverCtx.sessionId })
      return []
    },
    lastInjectedEstimateRef: { current: null },
    streamSession: {
      enqueue: (fn: () => Promise<unknown>) => {
        const run = chain.then(fn)
        chain = run.catch(() => {})
        return run
      },
      setForwarder: () => {},
      isOpen: () => false,
      push: () => {}
    },
    llmClientRef: { current: llm },
    makeLlmClient: () => llm,
    toolExecutorsRef: { current: [] },
    makeDistillCallbacks: () => ({}),
    rowIdRef: { current: 0 },
    writeRawMemoryForStream: () => {
      raws.push('x')
    },
    serverCtx,
    ...over
  } as unknown as HeadlessChatDeps
  return { runner: createHeadlessChatRunner(deps), injectedCalls, serverCtx, saves, raws }
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

  it('并发 headless 轮次整轮串行：每个轮次组装时读到的 serverCtx.sessionId 是自己的', async () => {
    // 0.53.10 前：组装在 streamSession 队列外，A/B 并发会互相覆盖 serverCtx.sessionId。
    // 现在整轮（设 sessionId → 组装 → 流 → 持久化）在同一个串行队列内。
    const { runner, injectedCalls } = makeHarness()
    await Promise.all([runner('A', 'sess-A'), runner('B', 'sess-B')])
    expect(injectedCalls).toHaveLength(2)
    // 队列 FIFO：A 先入队，故先看到 sess-A
    expect(injectedCalls.map((c) => c.ctxSessionId)).toEqual(['sess-A', 'sess-B'])
  })
})

/**
 * 房间规划轮的落盘口径（0.53.18 起不写会话历史；2026-10-31 起**照常写 RAW**）。
 *
 * 为什么不写会话历史（0.53.18，保留）：规划是自主模式自己的 TODO（给 AI 自己看），
 * 此前规划跑在 `room-autonomous` 会话里，落盘只弄脏那棵「房间会话」；继承承载会话后若照旧落盘，
 * 每轮规划提示词会以用户消息、JSON 计划会以 AI 回复的形式混进用户正常聊天。
 *
 * 为什么写 RAW（2026-10-31 用户裁决，覆盖 0.53.18 的 RAW 部分）：自主模式下有 aiId 主AI的
 * 轮次与外部对话同规格计入记忆系统——主AI的上下文（含前置规划指令、采集输入）与响应都应被
 * 记忆工作流看见；只有「进不进用户聊天记录」这一层仍豁免。
 */
describe('房间规划轮：写 RAW、不进会话历史', () => {
  it('purpose=room → 不 saveMessages，但**写 RAW**（2026-10-31 裁决）', async () => {
    const { runner, saves, raws } = makeHarness()
    await runner('你是自主房间（ROOM）里的执行主体。…', 'sess-1', 1, 'room')
    expect(saves).toHaveLength(0)
    expect(raws).toHaveLength(1)
  })

  it('普通轮次照常落盘（对照：会话历史与 RAW 都写）', async () => {
    const { runner, saves, raws } = makeHarness()
    await runner('你好', 'sess-1')
    expect(saves).toHaveLength(1)
    expect(raws).toHaveLength(1)
  })

  it('每轮只发起一次 LLM 调用（回归：runHeadlessTurn 曾被重复调用两次，双倍 token）', async () => {
    let calls = 0
    const countingLlm = {
      isReady: () => true,
      streamWithTools: async (_m: unknown, _e: unknown, cb?: { onToken?: (t: string) => void }): Promise<string> => {
        calls += 1
        cb?.onToken?.('ok')
        return 'ok'
      }
    }
    // 局部桩不满足 LLMClient 完整类型——与 harness 同口径在覆盖点断言（见 L71 的整对象 cast）
    const { runner } = makeHarness({
      llmClientRef: { current: countingLlm } as unknown as HeadlessChatDeps['llmClientRef']
    })
    await runner('规划提示词', 'sess-1', 1, 'room')
    expect(calls).toBe(1)
  })
})
