/**
 * 托管移交不被流计时器误杀（端到端回归，2026-10-31）
 *
 * 用户可见症状：`run_command` 跑到 30s 外墙阈值，本应"转后台 + 返回 taskId +
 * 提示 AI 用 tool_watch 检查"（设计如此），但同一时刻 TTFT/idle 流计时器把整条流 abort，
 * AI 永远收不到这段托管提示 → 用户看到超时/重试，命令却还在后台继续跑。
 *
 * 本测试用假时钟跑完整 `LLMClient.streamWithTools` 链路：
 * 1. 第一轮模型先回 `tool_calls`（无思考/正文首包，典型的非思考模式工具轮）；
 * 2. `run_command` executor 挂起 45s（超过 30s 外墙）；
 * 3. 断言 30s 后：托管提示进入下一轮请求上下文、无 onError、工具只执行一次。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

const mockCreate = vi.fn()
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = { completions: { create: mockCreate } }
    }
  }
})

import { LLMClient } from '../electron/main/api/llm'
import type { LLMConfig, ChatMessage } from '@shared/types'
import type { StreamCallbacks } from '../electron/main/api/llm-types'

function makeConfig(): LLMConfig {
  return {
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    model: 'test-model',
    temperature: 0.3,
    maxTokens: 2048,
    reasoningEffort: 'off',
    streamingSpeed: 1
  }
}

function makeMessages(): ChatMessage[] {
  return [
    {
      id: 'm_managed_1',
      role: 'user',
      content: '跑一个 45 秒的命令',
      createdAt: Date.now()
    }
  ]
}

/** 首轮：只有 tool_calls（run_command），没有正文/思考 */
function toolCallStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_managed_1',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({ command: 'ping -n 45 127.0.0.1' })
                  }
                }
              ]
            }
          }
        ]
      }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    }
  }
}

/** 第二轮：文本收尾 */
function textStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '命令已转入后台，我用 tool_watch 跟进。' } }] }
    }
  }
}

function cbs(overrides: Partial<StreamCallbacks> = {}): StreamCallbacks {
  return { onToken: () => {}, onDone: () => {}, onError: () => {}, ...overrides }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('run_command 30s 托管移交不被流计时器 abort', () => {
  it('托管提示进入下一轮上下文、无 onError、工具只执行一次', async () => {
    vi.useFakeTimers()
    let execCount = 0
    const hangingRunCommand = {
      name: 'run_command',
      description: 'run',
      parameters: {},
      execute: async (): Promise<string> => {
        execCount++
        // 挂起 45s：超过 30s 外墙 → 应转入托管而非被 abort
        await new Promise((resolve) => setTimeout(resolve, 45_000))
        return JSON.stringify({ ok: true, stdout: 'done' })
      }
    }
    mockCreate.mockClear()
    mockCreate.mockResolvedValueOnce(toolCallStream())
    mockCreate.mockResolvedValueOnce(textStream())

    const client = new LLMClient(makeConfig())
    const errors: Error[] = []
    let doneCount = 0
    const p = client.streamWithTools(makeMessages(), [hangingRunCommand], cbs({
      onDone: () => {
        doneCount++
      },
      onError: (e) => {
        errors.push(e)
      }
    }))

    // 让首轮流消费 + 工具进入 30s 外墙；再推进 1s 让托管移交后的下一轮跑完
    await vi.advanceTimersByTimeAsync(31_000)
    await p

    expect(errors).toEqual([])
    expect(doneCount).toBe(1)
    expect(execCount).toBe(1)
    expect(mockCreate).toHaveBeenCalledTimes(2)

    // 第二次请求必须带上托管诊断（taskId + tool_watch 指引）——这正是被 abort 时会丢掉的东西
    const secondBody = mockCreate.mock.calls[1][0] as {
      messages: Array<{ role: string; content: string }>
    }
    const toolMsg = secondBody.messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeTruthy()
    expect(toolMsg!.content).toContain('"managed":true')
    expect(toolMsg!.content).toContain('tool_watch')
  })
})
