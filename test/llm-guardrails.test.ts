import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock openai：chat.completions.create 返回可控异步流（复用 llm-failure-halt 范式）
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
 * 工具循环 guardrail 回归测试（2026-08-19，2026-09-12 同步 halt 收尾轮语义）

 * 对照参考实现的 tool_guardrails.py 全量升级 streamWithTools 的防死循环检测：
 *   - same_tool_failure：同工具失败（参数可变也累计），软 warn 注入 + 达阈值 halt
 *   - idempotent_no_progress：读类工具返回结果 hash 相同=无进展，软 warn + 达阈值 halt
 *   - loop_caps：单轮 web_search / 子agent 启动上限（runaway 风暴）
 *   - 既有 exact_failure（同参数失败=3 halt）回归保持

 * 2026-09-12 起 halt 语义：触发熔断后注入收尾指令并放行 1 轮（让模型产出最终回答），
 * 收尾轮仍空转才硬切断。因此失败 N 次的用例总调用数为 N+1。
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

/** 构造"带一次工具调用"的流（name + arguments 由调用方给定） */
function makeToolCallStream(toolName: string, args: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `call_${toolName}`,
                  function: { name: toolName, arguments: JSON.stringify(args) }
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

/** 简单文本流（无工具调用，正常收尾） */
function makeTextStream(text = 'done') {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: text } }] }
    }
  }
}

describe('工具循环 guardrail（2026-08-19）', () => {
  let client: LLMClient

  beforeEach(() => {
    mockCreate.mockReset()
    client = new LLMClient(makeConfig())
  })

  /** 工具执行结果里是否含某软提示（检查所有已发出请求的 user 消息） */
  function hintInjected(substr: string): boolean {
    for (const call of mockCreate.mock.calls) {
      const msgs = (call[0].messages ?? []) as Array<{ role: string; content: string }>
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
      if (lastUser && lastUser.content.includes(substr)) return true
    }
    return false
  }

  it('same_tool_failure：同工具但参数不同连续失败 → warn 注入 + 达阈值 break（不烧 maxRounds）', async () => {
    // 4 个不同 URL（参数不同→exact 指纹各异不算重复），但 tool=web_extract 持续失败
    const alwaysFail = {
      name: 'web_extract',
      description: 'extract',
      parameters: {},
      execute: async () => JSON.stringify({ ok: false, error: '抓取失败: Not Found (404)' })
    }
    for (let i = 0; i < 4; i++) {
      mockCreate.mockImplementationOnce(() =>
        Promise.resolve(makeToolCallStream('web_extract', { url: `https://example.com/dead/${i}` }))
      )
    }
    // 若未熔断会继续，第 5 次给文本收尾（用 maxRounds=8 观察是否提前停）
    mockCreate.mockImplementationOnce(() => Promise.resolve(makeTextStream('收尾')))

    const errs: Error[] = []
    let done = false
    await client.streamWithTools(makeMessages('same-tool'), [alwaysFail], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })

    // 2026-09-12 语义：第 4 轮失败触发 halt → 注入指令放行 1 轮收尾（模型输出最终回答）→ 共 5 次
    // （4 失败 + 1 收尾），不再烧 maxRounds
    expect(mockCreate.mock.calls.length).toBe(5)
    expect(done).toBe(true)
    expect(errs).toHaveLength(0)
    // 软 warn 已注入（sn===2 时）
    expect(hintInjected('已连续 2 次失败')).toBe(true)
  })

  it('idempotent_no_progress：读类工具同参数返回相同结果 → warn 注入 + 达阈值 break', async () => {
    const sameRead = {
      name: 'Read',
      description: 'read file',
      parameters: {},
      execute: async () => JSON.stringify({ ok: true, content: 'SAME_PAGE_CONTENT_甲乙丙丁戊己庚辛' })
    }
    // 连续 6 次相同调用（同 path + 同结果）
    for (let i = 0; i < 6; i++) {
      mockCreate.mockImplementationOnce(() =>
        Promise.resolve(makeToolCallStream('Read', { path: 'D:\\file.txt' }))
      )
    }
    mockCreate.mockImplementationOnce(() => Promise.resolve(makeTextStream('收尾')))

    const errs: Error[] = []
    let done = false
    await client.streamWithTools(makeMessages('idem'), [sameRead], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })

    // 2026-09-12 语义：结果 hash 相同达 6（count>=6）→ halt，注入指令放行 1 轮收尾 → 共 7 次
    // （6 相同调用 + 1 收尾），不再烧 maxRounds=8
    expect(mockCreate.mock.calls.length).toBe(7)
    expect(done).toBe(true)
    expect(errs).toHaveLength(0)
    // 软 warn 已注入（count>=3 时）
    expect(hintInjected('无进展')).toBe(true)
  })

  it('idempotent 只对读类工具生效：写工具成功不算无进展', async () => {
    const writeTool = {
      name: 'Write',
      description: 'write file',
      parameters: {},
      execute: async () => JSON.stringify({ ok: true, path: 'x', bytes: 1 })
    }
    // 同参数 Write 重复多次，结果相同——但 Write 不在 IDEMPOTENT_TOOLS → 不触发无进展
    for (let i = 0; i < 6; i++) {
      mockCreate.mockImplementationOnce(() =>
        Promise.resolve(makeToolCallStream('Write', { path: 'D:\\out.txt', content: 'abc' }))
      )
    }
    mockCreate.mockImplementationOnce(() => Promise.resolve(makeTextStream('收尾')))

    const errs: Error[] = []
    let done = false
    await client.streamWithTools(makeMessages('write'), [writeTool], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })

    // 不触发无进展熔断，正常走完 6 轮 + 收尾 = 7 次（未被 halt 截断）
    expect(mockCreate.mock.calls.length).toBe(7)
    expect(done).toBe(true)
    expect(errs).toHaveLength(0)
    expect(hintInjected('无进展')).toBe(false)
  })

  it('exact_failure 回归：同工具同参数失败 3 次仍熔断（既有行为不被破坏）', async () => {
    const alwaysFail = {
      name: 'web_extract',
      description: 'extract',
      parameters: {},
      execute: async () => JSON.stringify({ ok: false, error: '抓取失败: Not Found (404)' })
    }
    mockCreate.mockImplementation(() =>
      Promise.resolve(makeToolCallStream('web_extract', { url: 'https://same.com/dead' }))
    )
    const errs: Error[] = []
    let done = false
    await client.streamWithTools(makeMessages('exact'), [alwaysFail], {
      onToken: () => {},
      onDone: () => { done = true },
      onError: (e) => errs.push(e)
    })
    // exact_failure=3 → halt，注入指令放行 1 轮收尾（收尾轮仍请求工具→硬切断）→ 共 4 次
    expect(mockCreate).toHaveBeenCalledTimes(4)
    expect(done).toBe(true)
    expect(errs).toHaveLength(0)
  })

  it('工具成功且读类结果不同 → 不触发任何熔断（正常推进）', async () => {
    let i = 0
    const diffRead = {
      name: 'Read',
      description: 'read file',
      parameters: {},
      execute: async () => JSON.stringify({ ok: true, content: `page_v${i++}` })
    }
    for (let k = 0; k < 4; k++) {
      mockCreate.mockImplementationOnce(() =>
        Promise.resolve(makeToolCallStream('Read', { path: `D:\\f${k}.txt` }))
      )
    }
    mockCreate.mockImplementationOnce(() => Promise.resolve(makeTextStream('收尾')))

    const errs: Error[] = []
    await client.streamWithTools(makeMessages('progress'), [diffRead], {
      onToken: () => {},
      onDone: () => {},
      onError: (e) => errs.push(e)
    })
    // 结果/参数都不同 → 4 轮 + 收尾 = 5 次，不熔断
    expect(mockCreate.mock.calls.length).toBe(5)
    expect(errs).toHaveLength(0)
    expect(hintInjected('无进展')).toBe(false)
    expect(hintInjected('自动中止')).toBe(false)
  })
})
