import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock openai：chat.completions.create 返回可控异步流（复用 llm-concurrency 范式）
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
 * 工具失败死循环熔断回归测试（2026-08-18）

 * 背景：任务模式下 web_search/web_extract 抓技术文档反复失败（404/超时/无关结果），
 *   AI 陷入"换 URL 再抓→失败→再换"的空转，每轮近似相同文本（用户感知"连续输出相同字符"），
 *   且无机制打断直到 maxRounds 烧完。修复：streamWithTools 跨轮统计"同工具+同参数"失败次数，
 *   达阈值(3)注入自动打断指令并 break（走自然收尾 fold+onDone），保留已生成文本。

 * 本测试验证：
 * 1. 同一 URL 重复失败 3 次 → 熔断：仅多给 1 轮收尾（2026-09-12 起注入打断指令后放行一轮，
 *    让模型产出最终回答而不是空输出；收尾轮仍空转则硬切断）→ mockCreate 恰 4 次
 *    （未烧到 maxRounds=8）、onDone 正常调用、无 onError、且打断指令已注入。
 * 2. 不同 URL 的失败不算重复（指纹含参数），不熔断、不注入打断。
 */

function makeConfig(): LLMConfig {
  return {
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    model: 'gpt-test',
    temperature: 0.7,
    maxTokens: 2048,
    reasoningEffort: 'off',
    streamingSpeed: 1
  }
}

function makeMessages(seed: string): ChatMessage[] {
  return [{ id: `m_${seed}`, role: 'user', content: `do task ${seed}`, createdAt: Date.now() }]
}

/** 构造"发出一次 web_extract 调用"的流 */
function makeToolCallStream(url: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_x',
                  function: { name: 'web_extract', arguments: JSON.stringify({ url }) }
                }
              ]
            }
          }
        ]
      }
      yield { choices: [{ delta: {} }] }
    }
  }
}

/** 构造简单文本流（无工具调用，正常收尾） */
function makeTextStream(text = 'done') {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: text } }] }
    }
  }
}

/** 总是返回失败的工具 executor */
const failingWebExtract = {
  name: 'web_extract',
  description: 'extract',
  parameters: {},
  execute: async () => JSON.stringify({ ok: false, error: '抓取失败: Not Found (404)' })
}

describe('工具失败死循环熔断（2026-08-18）', () => {
  let client: LLMClient

  beforeEach(() => {
    mockCreate.mockReset()
    client = new LLMClient(makeConfig())
  })

  it('同一 URL 失败 3 次触发熔断：只多给 1 轮收尾（4 次而非 maxRounds=8）、正常 onDone、无 onError', async () => {
    // 前 3 次 mockCreate 都返回"调用同一死 URL"的流；若无可控熔断会继续烧到 maxRounds(8)
    mockCreate.mockImplementation(() => Promise.resolve(makeToolCallStream('https://example.com/dead-page')))

    const errs: Error[] = []
    let done = false

    await client.streamWithTools(makeMessages('cls'), [failingWebExtract], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })

    // 2026-09-12 语义：第 3 轮失败触发 halt → 注入打断指令并放行 1 轮收尾（让模型产出最终回答）；
    // 收尾轮仍是死循环 → 硬切断。故共 4 次（3 失败 + 1 收尾），没有烧到 maxRounds=8（核心：不再空转）
    expect(mockCreate).toHaveBeenCalledTimes(4)
    expect(done).toBe(true)
    expect(errs).toHaveLength(0)
    // 收尾轮有界：不会继续发第 5 轮
    expect(mockCreate.mock.calls.length).toBe(4)
  })

  it('不同 URL 失败在 exact 层面不算重复（指纹含参数），且在 same_tool 熔断阈值前不误杀，正常走完', async () => {
    // 2026-08-19 升级说明：原用例 4 个不同 URL 失败期待 5 次(不熔断)；现在新增 same_tool_failure
    // （同工具失败参数可变也累计，阈值=4），4 次同工具连续失败会被熔断接管。为保留"不同参数
    // 不触发 exact 熔断、阈值内不误杀"的原意，降到 3 个不同 URL（same_tool=3 < 4 不到熔断）。
    const urls = ['https://a.com/1', 'https://b.com/2', 'https://c.com/3']
    urls.forEach((u) => mockCreate.mockImplementationOnce(() => Promise.resolve(makeToolCallStream(u))))
    // 第 4 次给普通文本流收尾（否则继续跑，mock 耗尽）
    mockCreate.mockImplementationOnce(() => Promise.resolve(makeTextStream('收尾')))

    const errs: Error[] = []
    let done = false
    await client.streamWithTools(makeMessages('diff'), [failingWebExtract], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })

    // 3 轮失败 + 1 轮收尾 = 4 次调用，正常完成且无 same_tool/exact 熔断注入
    expect(mockCreate).toHaveBeenCalledTimes(4)
    expect(done).toBe(true)
    expect(errs).toHaveLength(0)

    // 断言未注入打断指令：所有已发出的调用里 user 消息都不含"自动中止"
    let haltFound = false
    for (const call of mockCreate.mock.calls) {
      const msgs = (call[0].messages ?? []) as Array<{ role: string; content: string }>
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      if (lastUser && lastUser.content.includes('自动中止')) haltFound = true
    }
    expect(haltFound).toBe(false)
  })

  it('工具成功不触发熔断（正常流程不受影响）', async () => {
    const successTool = {
      name: 'web_extract',
      description: 'extract',
      parameters: {},
      execute: async () => JSON.stringify({ ok: true, data: { text: 'content here', title: 'ok' } })
    }
    // 成功一轮后，第二次请求是普通文本流（收尾）
    mockCreate
      .mockImplementationOnce(() => Promise.resolve(makeToolCallStream('https://good.com/a')))
      .mockImplementationOnce(() => Promise.resolve(makeTextStream('完成')))

    const errs: Error[] = []
    let done = false
    await client.streamWithTools(makeMessages('ok'), [successTool], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })

    expect(errs).toHaveLength(0)
    expect(done).toBe(true)
    // 成功调用不会累积失败 → 不会注入打断，mockCreate 按正常流程调 2 次
    expect(mockCreate).toHaveBeenCalledTimes(2)
  })
})
