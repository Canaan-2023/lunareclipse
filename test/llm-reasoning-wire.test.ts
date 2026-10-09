/**
 * LLM 请求 wire 装配回归（2026-08-26 DeepSeek reasoning_content 400 修复锁定）
 *
 * 故障：DeepSeek 思考模式要求历史 assistant 消息的 reasoning_content 原样回传，
 * 缺失即下一个请求 400（实测：子 agent 执行完就 400 断链）。
 * 修复：isDeepSeekProvider()（baseURL 判定）+ assistant 历史消息带 reasoning 时
 * 装配 reasoning_content 字段；非 DeepSeek 网关不认识该字段，回传会被拒绝 → 不回传。
 *
 * 锁定点：
 * 1. DeepSeek baseURL：stream 路径请求消息带 reasoning_content
 * 2. 非 DeepSeek baseURL：即便推理有 reasoning，请求消息也不带 reasoning_content
 * 3. 用户消息 / 无 reasoning 的 assistant 消息不装配该字段
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMClient } from '../electron/main/api/llm'
import type { LLMConfig, ChatMessage } from '@shared/types'

// mock openai：捕获每次 create 的请求 body，返回空流/空响应
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

beforeEach(() => {
  mockCreate.mockClear()
})

/** 惰性空流（async iterable；不 yield 也会正常结束） */
function emptyStream() {
  return { async *[Symbol.asyncIterator]() {} }
}

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 2048,
    reasoningEffort: 'off',
    streamingSpeed: 1,
    ...overrides
  }
}

function hist(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: partial.id ?? `m_${Math.random().toString(36).slice(2, 8)}`,
    role: partial.role ?? 'user',
    content: partial.content ?? '',
    createdAt: partial.createdAt ?? Date.now(),
    ...partial
  }
}

describe('LLM reasoning wire 装配（DeepSeek 400 修复）', () => {
  it('DeepSeek baseURL：assistant 历史消息带 reasoning → 请求消息带 reasoning_content', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig())
    await client.stream(
      [
        hist({ role: 'user', content: '继续' }),
        hist({ role: 'assistant', content: '第一轮正文', reasoning: '第一轮思考' })
      ],
      { onToken: () => {}, onDone: () => {} }
    )
    const body = mockCreate.mock.calls[0][0]
    const ass = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(ass.reasoning_content).toBe('第一轮思考')
    const user = body.messages.find((m: { role: string }) => m.role === 'user')
    expect(user.reasoning_content).toBeUndefined()
  })

  it('非 DeepSeek baseURL：assistant 有 reasoning 也不装配 reasoning_content（防网关拒绝）', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig({ baseURL: 'https://api.openai.com/v1' }))
    await client.stream(
      [
        hist({ role: 'user', content: '继续' }),
        hist({ role: 'assistant', content: '第一轮正文', reasoning: '第一轮思考' })
      ],
      { onToken: () => {}, onDone: () => {} }
    )
    const body = mockCreate.mock.calls[0][0]
    const ass = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(ass.reasoning_content).toBeUndefined()
  })

  it('assistant 无 reasoning → 不装配 reasoning_content（零噪音）', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig())
    await client.stream(
      [
        hist({ role: 'user', content: '继续' }),
        hist({ role: 'assistant', content: '无思考正文' })
      ],
      { onToken: () => {}, onDone: () => {} }
    )
    const body = mockCreate.mock.calls[0][0]
    const ass = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(ass.reasoning_content).toBeUndefined()
    expect(ass.content).toBe('无思考正文')
  })

  it('chatWithTools（非流式）同样装配：DeepSeek 下 assistant 历史 reasoning → reasoning_content', async () => {
    mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok', tool_calls: null, reasoning_content: 'r2' }, finish_reason: 'stop' }] })
    const client = new LLMClient(makeConfig())
    await client.chatWithTools(
      [
        hist({ role: 'user', content: '继续' }),
        hist({ role: 'assistant', content: '第一轮正文', reasoning: '第一轮思考' })
      ],
      []
    )
    const body = mockCreate.mock.calls[0][0]
    const ass = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect(ass.reasoning_content).toBe('第一轮思考')
  })
})