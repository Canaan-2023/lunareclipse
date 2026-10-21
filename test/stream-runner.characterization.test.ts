/**
 * ADR-04 第 0 步（前置硬条件）：`stream-runner.ts` 直测表征测试
 *
 * 为什么存在：ADR-04 要把 1356 行的 `stream-runner.ts` 拆成 rows/status/persistence/review-chain
 * 四模块，但全库**没有任何测试直接 import 它**——现有覆盖全部是经 `createWsProtocol` 的间接集成
 * （`api-server.test.ts` 的 WS 用例）。缺直测则「纯搬移不改行为」无从举证。本文件在拆分前建立
 * 基线，逐条钉住四类行为 + rowId 契约，作为搬迁等价判据（ADR-04 §1 前置硬条件、§6 回归点）。
 *
 * 覆盖（与 ADR 一一对应）：
 * - ① flush 时机与清定时器：token 帧先于 done、done 后无残留 33ms 定时器再推帧
 * - ② 用户中止：推 abort（非 error/done）、清活跃标志、清审查续轮定时器
 * - ③ 静默续接重试：超时错误静默续接一轮、续接消息带上已产出正文、最终 done 且无 error 帧
 * - ④ onError 五条出路：permanent-error（未配置 / 402 余额不足）、user-abort、retry、
 *      ws-closed-recovery、retry-exhausted-recovery
 * - ⑤ rowId 契约（ADR §8 风险 1）：重试不重置计数器，两次尝试行 id 单调递增且不重叠
 *
 * 口径说明：本文件**直连 `createStreamRunner`**（不经 WS/HTTP），依赖面全部以最小 fake 注入；
 * `streamSession` 用真实 `StreamSession`（状态机行为本身也在被表征），其余为记录型 fake。
 */
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'

// 与 api-server.test.ts 同款 mock：openai（本文件不走真实客户端）与 electron（模块图兜底）
vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: async () => ({ choices: [] }) } }
  }
}))
vi.mock('electron', () => ({
  app: { getPath: () => process.cwd(), whenReady: () => Promise.resolve(), on: () => {} }
}))

import { createStreamRunner, type StreamRunnerDeps } from '../electron/main/api/stream-runner'
import { StreamSession } from '../electron/main/api/stream-session'
import type { StreamCallbacks } from '../electron/main/api/llm-types'
import type { LLMClient } from '../electron/main/api/llm'
import type { ConfigStore } from '../electron/main/api/config-store'
import type { SessionStore } from '../electron/main/api/session-store'
import type { ActivationManager } from '../electron/main/api/activation-manager'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { ChatMessage } from '@shared/types'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立（重试分支是 fire-and-forget 的 setTimeout，需要外部等待） */
async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await sleep(20)
  }
}

/** 脚本化假 LLM：按队列逐步驱动回调，记录每次调用入参 */
class FakeLlm {
  readonly calls: Array<{ messages: ChatMessage[]; toolCount: number }> = []
  readonly abortTags: Array<string | undefined> = []
  private readonly script: Array<(cb: StreamCallbacks) => void | Promise<void>> = []

  isReady(): boolean {
    return true
  }

  abort(tag?: string): void {
    this.abortTags.push(tag)
  }

  /** 编排下一次 streamWithTools 的行为 */
  queue(step: (cb: StreamCallbacks) => void | Promise<void>): void {
    this.script.push(step)
  }

  async streamWithTools(
    messages: ChatMessage[],
    tools: unknown[],
    callbacks: StreamCallbacks
  ): Promise<void> {
    this.calls.push({ messages, toolCount: tools.length })
    const step = this.script.shift()
    if (!step) throw new Error('FakeLlm：未编排的 streamWithTools 调用')
    await step(callbacks)
  }
}

interface Harness {
  deps: StreamRunnerDeps
  sent: Array<Record<string, unknown>>
  llm: FakeLlm
  ws: { readyState: number }
  rawWrites: Array<{ isInterrupted: boolean; fullOutput: string }>
  activation: { setStreamActive: ReturnType<typeof vi.fn>; requestInterruptRecovery: ReturnType<typeof vi.fn> }
  run: (over?: { retryCount?: number; sessionId?: string; activation?: boolean }) => Promise<void>
}

function makeHarness(over?: { maxStreamRetries?: number }): Harness {
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (data: string): void => {
      sent.push(JSON.parse(data) as Record<string, unknown>)
    },
    on: () => ws,
    close: () => {}
  }
  const llm = new FakeLlm()
  const rawWrites: Harness['rawWrites'] = []
  const activation = {
    setStreamActive: vi.fn(),
    parseAIOutput: vi.fn(),
    resetInterruptRecovery: vi.fn(),
    requestInterruptRecovery: vi.fn()
  }
  const cfg = {
    llm: { provider: 'openai', apiKey: 'k', model: 'gpt-test', temperature: 0.7, maxTokens: 2048 },
    aiMode: 'coding',
    codeReview: false
  }

  const deps: StreamRunnerDeps = {
    ws: ws as unknown as WebSocket,
    maxRetryDelayMs: 30000,
    maxStreamRetries: over?.maxStreamRetries ?? Number.POSITIVE_INFINITY,
    continuationTimerRef: { current: null },
    configStore: { get: () => cfg } as unknown as ConfigStore,
    streamSession: new StreamSession(),
    serverCtx: {} as ToolContext,
    activationManager: activation as unknown as ActivationManager,
    sessionStore: { get: () => null, saveMessages: vi.fn() } as unknown as SessionStore,
    lastModelBySession: new Map(),
    setLastModel: vi.fn(),
    llmClientRef: { current: llm as unknown as LLMClient },
    toolExecutorsRef: { current: [] },
    rowIdRef: { current: 0 },
    activationContentRef: { current: null },
    lastInjectedEstimateRef: { current: null },
    makeLlmClient: () => llm as unknown as LLMClient,
    makeDistillCallbacks: () => ({}),
    buildInjectedMessages: async (messages: ChatMessage[]) => messages,
    writeRawMemoryForStream: (isInterrupted: boolean, fullOutput: string) => {
      rawWrites.push({ isInterrupted, fullOutput })
    },
    resolveSoftBudget: () => 1_000_000,
    broadcastStreamStatus: vi.fn(),
    resolveStreamSessionContext: async () => ({
      sessionContext: null,
      activeInternalContext: null
    }),
    enqueueInternalSessionJob: vi.fn()
  }

  const { runStream } = createStreamRunner(deps)
  const userMsg: ChatMessage = { id: 'u1', role: 'user', content: '你好', createdAt: 1 }

  return {
    deps,
    sent,
    llm,
    ws,
    rawWrites,
    activation,
    run: (o) =>
      runStream(
        [userMsg],
        o?.activation ?? false,
        'm_test',
        o?.sessionId,
        'gpt-test',
        o?.retryCount ?? 0,
        ''
      )
  }
}

/** 收集帧类型序列 */
const types = (h: Harness): string[] => h.sent.map((f) => String(f.type))
/** 收集行协议帧涉及的全部 rowId */
function rowIds(h: Harness): number[] {
  const ids: number[] = []
  for (const f of h.sent) {
    if (f.type !== 'row_op') continue
    const op = f.rowOp as { op: string; row?: { rowId: number }; rowId?: number }
    if (op.op === 'row.delta') ids.push(op.rowId as number)
    else if (op.row) ids.push(op.row.rowId)
  }
  return ids
}

describe('stream-runner 表征测试（ADR-04 第 0 步：拆分前行为基线）', () => {
  it('① flush 时机：token 帧先于 done，done 之后无残留定时器再推帧', async () => {
    const h = makeHarness()
    h.llm.queue((cb) => {
      cb.onToken('A')
      cb.onToken('B')
      return cb.onDone()
    })
    await h.run()

    const payloads = h.sent
      .filter((f) => f.type === 'token' && typeof f.payload === 'string')
      .map((f) => f.payload as string)
    expect(payloads.join('')).toBe('AB')
    expect(types(h)[types(h).length - 1]).toBe('done')

    // BUFFER_INTERVAL_MS=33：若 done 时未清缓冲定时器，80ms 内会再推一帧
    const before = h.sent.length
    await sleep(80)
    expect(h.sent.length).toBe(before)
  })

  it('② 用户中止：推 abort（非 error/done）并清活跃标志', async () => {
    const h = makeHarness()
    h.llm.queue((cb) => {
      cb.onToken('X')
      cb.onError(new Error('aborted'))
    })
    await h.run()

    expect(types(h)).toContain('abort')
    expect(types(h)).not.toContain('done')
    expect(types(h)).not.toContain('error')
    expect(h.activation.setStreamActive).toHaveBeenLastCalledWith(false)
  })

  it('③ 静默续接重试：超时错误静默续接一轮，续接消息带已产出正文，最终 done 且无 error', async () => {
    const h = makeHarness()
    h.llm.queue((cb) => {
      cb.onToken('A')
      cb.onError(new Error('ttft_timeout'))
    })
    h.llm.queue((cb) => {
      cb.onToken('B')
      return cb.onDone()
    })
    await h.run()
    await waitFor(() => types(h).includes('done'))

    expect(h.llm.calls).toHaveLength(2)
    expect(types(h)).not.toContain('error')
    expect(types(h)).not.toContain('abort')
    // 续接上下文：第二次调用的消息里带上第一轮已产出正文（assistant content='A'）
    expect(h.llm.calls[1].messages.some((m) => m.role === 'assistant' && m.content === 'A')).toBe(true)
  })

  it('④a permanent-error（LLM 未配置）：推 error 原样文案、不重试', async () => {
    const h = makeHarness()
    const msg = 'LLM 未配置：请在设置中填写 API Key'
    h.llm.queue((cb) => cb.onError(new Error(msg)))
    await h.run()

    const err = h.sent.find((f) => f.type === 'error')
    expect(err).toBeDefined()
    expect(err?.payload).toBe(msg)
    expect(h.llm.calls).toHaveLength(1)
    expect(types(h)).not.toContain('done')
  })

  it('④b permanent-error（402 余额不足）：推可行动文案、不重试', async () => {
    const h = makeHarness()
    h.llm.queue((cb) => {
      const err = new Error('boom') as Error & { status?: number }
      err.status = 402
      cb.onError(err)
    })
    await h.run()

    const err = h.sent.find((f) => f.type === 'error')
    expect(String(err?.payload)).toContain('余额不足')
    expect(h.llm.calls).toHaveLength(1)
  })

  it('④c ws-closed-recovery：WS 已断时不推任何收尾帧，写 RAW 并触发中断恢复', async () => {
    const h = makeHarness()
    let framesAtClose = -1
    h.llm.queue((cb) => {
      cb.onToken('partial')
      h.ws.readyState = WebSocket.CLOSED
      framesAtClose = h.sent.length
      cb.onError(new Error('boom'))
    })
    await h.run()

    // 断开后的收尾路径不得再推帧（推 error 会让前端判空闲而触发自主激活、丢原任务上下文）
    expect(h.sent.length).toBe(framesAtClose)
    expect(types(h)).not.toContain('error')
    expect(types(h)).not.toContain('interrupted')
    expect(h.rawWrites).toHaveLength(1)
    expect(h.rawWrites[0].isInterrupted).toBe(true)
    expect(h.activation.requestInterruptRecovery).toHaveBeenCalled()
  })

  it('④d retry-exhausted-recovery：重试耗尽推 interrupted（非 error）并触发恢复', async () => {
    const h = makeHarness({ maxStreamRetries: 1 })
    h.llm.queue((cb) => cb.onError(new Error('boom')))
    await h.run({ retryCount: 1 })

    expect(types(h)).toContain('interrupted')
    expect(types(h)).not.toContain('error')
    expect(h.activation.requestInterruptRecovery).toHaveBeenCalled()
  })

  it('⑤ rowId 契约：重试不重置计数器，两次尝试行 id 单调递增且不重叠', async () => {
    const h = makeHarness()
    h.llm.queue((cb) => {
      cb.onToken('A')
      cb.onError(new Error('ttft_timeout'))
    })
    h.llm.queue((cb) => {
      cb.onToken('B')
      return cb.onDone()
    })
    await h.run()
    await waitFor(() => types(h).includes('done'))

    const ids = rowIds(h)
    expect(ids.length).toBeGreaterThan(0)
    // 不重叠：同一 rowId 不出现两次（重试若重置局部计数器，新行会与旧行撞号）
    expect(new Set(ids).size).toBe(ids.length)
    // 单调递增出现顺序（会话内全局递增契约）
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    // 计数器确实推进过（跨两次尝试共享 deps.rowIdRef）
    expect(h.deps.rowIdRef.current).toBeGreaterThanOrEqual(ids.length)
  })
})
