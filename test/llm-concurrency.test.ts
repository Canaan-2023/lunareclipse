import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock openai 模块：chat.completions.create 返回可控的异步流
const mockCreate = vi.fn()
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate
        }
      }
    }
  }
})

import { LLMClient } from '../electron/main/api/llm'
import type { LLMConfig, ChatMessage } from '@shared/types'

/**
 * LLMClient 并发化回归测试（2026-08-16）

 * 背景：原实现 currentController 单字段，并行子 agent 同时调 streamWithTools 互相覆盖
 * controller → 2 个以上子任务必失败。改造后每请求独立 controller（含 abortReason，存
 * controllers map），abort 控制互不干扰。

 * 本测试用 mock openai 验证：
 * 1. 两个并发 streamWithTools 各自正常完成（互不覆盖）
 * 2. abort() 中止全部活跃请求（每个请求的 onError 收到 aborted）
 * 3. 串行调用流正常（一个完成后下一个开始）
 */

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    temperature: 0.7,
    maxTokens: 2048,
    reasoningEffort: 'off',
    streamingSpeed: 1,
    ...overrides
  }
}

function makeMessages(seed: string): ChatMessage[] {
  return [{ id: `m_${seed}`, role: 'user', content: `hello ${seed}`, createdAt: Date.now() }]
}

/** 构造一个可控的 mock 流：每个 chunk 延迟一点，便于并发交错 */
function makeAsyncIterable(chunks: string[], delayMs = 5) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, delayMs))
        yield { choices: [{ delta: { content: c } }] }
      }
    }
  }
}

describe('LLMClient 并发化（2026-08-16 回归）', () => {
  let client: LLMClient

  beforeEach(() => {
    mockCreate.mockReset()
    client = new LLMClient(makeConfig())
    // 让 isReady() 为 true（rebuildClient 在构造时执行，apiKey 已给）
  })

  it('两个并发 stream 各自正常完成（互不覆盖 controller）', async () => {
    // 第一个请求：慢流（3 chunks × 20ms），第二个请求：快流（1 chunk）
    mockCreate
      .mockImplementationOnce(() => Promise.resolve(makeAsyncIterable(['a', 'b', 'c'], 20)))
      .mockImplementationOnce(() => Promise.resolve(makeAsyncIterable(['x'], 1)))

    const out1: string[] = []
    const out2: string[] = []
    const err1: Error[] = []
    const err2: Error[] = []
    let done1 = false
    let done2 = false

    const p1 = client.streamWithTools(makeMessages('1'), [], {
      onToken: (t) => out1.push(t),
      onDone: () => { done1 = true },
      onError: (e) => err1.push(e)
    })
    // 让第一个请求先发出（mock 第一次调用已 resolve）
    await new Promise((r) => setTimeout(r, 5))
    const p2 = client.streamWithTools(makeMessages('2'), [], {
      onToken: (t) => out2.push(t),
      onDone: () => { done2 = true },
      onError: (e) => err2.push(e)
    })

    await Promise.all([p1, p2])

    expect(err1).toHaveLength(0)
    expect(err2).toHaveLength(0)
    expect(done1).toBe(true)
    expect(done2).toBe(true)
    expect(out1.join('')).toBe('abc')
    expect(out2.join('')).toBe('x')
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })

  it('abort() 中止全部活跃请求，每个请求 onError 收到 aborted', async () => {
    // 两个请求都是慢流（永不结束的流，靠 abort 打断）
    mockCreate.mockImplementation(() => Promise.resolve(makeAsyncIterable(['a', 'a', 'a', 'a', 'a'], 500)))

    const errs: Error[] = []
    const doneFlags: boolean[] = []
    const p1 = client.streamWithTools(makeMessages('1'), [], {
      onToken: () => {},
      onDone: () => { doneFlags.push(true) },
      onError: (e) => errs.push(e)
    })
    const p2 = client.streamWithTools(makeMessages('2'), [], {
      onToken: () => {},
      onDone: () => { doneFlags.push(true) },
      onError: (e) => errs.push(e)
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(client.isStreaming()).toBe(true)
    client.abort()

    await Promise.all([p1, p2])
    expect(errs.length).toBe(2)
    // abort() 设置 abortReason='user'（原语义沿袭），两个请求都应收到 user 中止
    expect(errs.every((e) => e.message === 'user')).toBe(true)
    expect(doneFlags).toHaveLength(0)
    expect(client.isStreaming()).toBe(false)
  })

  it('单请求完成后 isStreaming 恢复 false（map 正确清理）', async () => {
    mockCreate.mockImplementationOnce(() => Promise.resolve(makeAsyncIterable(['ok'], 1)))
    const errs: Error[] = []
    await client.streamWithTools(makeMessages('1'), [], {
      onToken: () => {},
      onDone: () => {},
      onError: (e) => errs.push(e)
    })
    expect(errs).toHaveLength(0)
    expect(client.isStreaming()).toBe(false)
  })
})
