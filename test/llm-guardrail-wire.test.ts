/**
 * LLM 消息来源护栏 wire 装配测试。
 *
 * 为什么存在：护栏接入点位于 streamWithTools 的 conversation 组装（system 不包裹、
 * 其余按来源包裹）+ 工具结果回流（按工具名分类包裹）。本测试用 mock OpenAI 捕获
 * 实际发给 API 的请求 body，锁定三类契约：
 * 1. 用户消息 → user 护栏；普通 AI 历史 → ai 护栏；审查轮 phaseMsg（user+activation+
 *    【代码审查】）→ code-review 护栏；审查轮输出（assistant + review_ id）→ code-review；
 * 2. 协议说明段（system role）置顶注入一次，且 system 自身不包裹；
 * 3. 工具结果回流：web_search → web-search 护栏 / Read → file-read 护栏 / Agent → subagent。
 * 口径与生产代码同源：解析复用 message-guardrail.parseGuardrail（当前会话哈希），
 * 直接断言 body 里每条消息的护栏来源。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMClient } from '../electron/main/api/llm'
import type { LLMConfig, ChatMessage } from '@shared/types'
import { parseGuardrail, wrapGuardrail } from '../electron/main/api/message-guardrail'

const SESSION_ID = 'guardrail-wire-sess'

// mock openai：捕获每次 create 的请求 body
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
    createdAt: Date.now(),
    ...partial
  }
}

/** 无工具 executor（单轮直接结束） */
const NO_TOOLS = []

function sourceOf(bodyMsg: { role: string; content: string }): string | null {
  if (bodyMsg.role === 'system') return null
  const parsed = parseGuardrail(bodyMsg.content, SESSION_ID)
  if (!parsed.wrapped) return null
  return parsed.valid ? parsed.source : `INVALID:${parsed.reason}`
}

describe('LLM 消息来源护栏 wire 装配', () => {
  it('apiKey 未配置时提前返回（不发起请求、不加护栏）', async () => {
    const client = new LLMClient(makeConfig({ apiKey: '' }))
    let err: Error | null = null
    await client.streamWithTools(
      [hist({ role: 'user', content: '你好' })],
      NO_TOOLS,
      { onDone: () => {}, onError: (e) => { err = e } },
      { guardrailSessionId: SESSION_ID }
    )
    expect(mockCreate).not.toHaveBeenCalled()
    expect(err).not.toBeNull()
  })

  it('用户消息 → user 护栏；普通 AI 历史 → ai 护栏；system 不包裹；协议段置顶', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      [
        hist({ role: 'system', content: '系统规则原样' }),
        hist({ role: 'user', content: '用户提问' }),
        hist({ role: 'assistant', id: 'prev_1', content: '上轮回答' })
      ],
      NO_TOOLS,
      { onDone: () => {}, onError: () => {} },
      { guardrailSessionId: SESSION_ID }
    )
    const body = mockCreate.mock.calls[0][0]
    const msgs = body.messages as Array<{ role: string; content: string }>

    // 协议说明段置顶为 system（含护栏协议说明）
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('消息来源护栏协议')
    // 系统规则 system 消息原样不包裹
    const sysRule = msgs.find((m) => m.content === '系统规则原样')
    expect(sysRule).toBeTruthy()
    // 用户消息 → user
    const userMsg = msgs.find((m) => m.content.includes('用户提问'))
    expect(sourceOf(userMsg!)).toBe('user')
    // AI 历史 → ai
    const aiMsg = msgs.find((m) => m.content.includes('上轮回答'))
    expect(sourceOf(aiMsg!)).toBe('ai')
  })

  it('审查轮 phaseMsg（activation+【代码审查】）→ code-review；审查轮输出 → code-review', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      [
        hist({ role: 'user', activation: true, content: '【代码审查】请审查 src/a.ts' }),
        hist({ role: 'assistant', id: 'review_5_1', content: '审查意见' })
      ],
      NO_TOOLS,
      { onDone: () => {}, onError: () => {} },
      { guardrailSessionId: SESSION_ID }
    )
    const body = mockCreate.mock.calls[0][0]
    const msgs = body.messages as Array<{ role: string; content: string }>
    const command = msgs.find((m) => m.content.includes('请审查 src/a.ts'))
    expect(sourceOf(command!)).toBe('code-review')
    const output = msgs.find((m) => m.content.includes('审查意见'))
    expect(sourceOf(output!)).toBe('code-review')
  })

  it('工具结果回流按工具名分类：web_search → web-search / Read → file-read / Agent → subagent', async () => {
    // 第一轮：模型请求调用三个工具（流式 chunk）；第二轮：模型收尾（空流结束）
    mockCreate
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_web', function: { name: 'web_search', arguments: '{"q":"x"}' } },
                    { index: 1, id: 'call_read', function: { name: 'Read', arguments: '{"path":"a.ts"}' } },
                    { index: 2, id: 'call_agent', function: { name: 'Agent', arguments: '{"task":"t"}' } }
                  ]
                }
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce(emptyStream())

    // 工具 executor：直接返回固定结果
    const executors = [
      { name: 'web_search', description: '', parameters: {}, execute: async () => '搜索到 1 个结果' },
      { name: 'Read', description: '', parameters: {}, execute: async () => '文件内容 abc' },
      { name: 'Agent', description: '', parameters: {}, execute: async () => '子代理汇报' }
    ] as never

    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      [hist({ role: 'user', content: '执行工具' })],
      executors,
      { onDone: () => {}, onError: () => {} },
      { guardrailSessionId: SESSION_ID }
    )

    // 第二轮 body：assistant 工具调用声明 + 三条 tool 结果（带护栏分类）
    const body2 = mockCreate.mock.calls[1]?.[0]
    expect(body2).toBeTruthy()
    const toolMsgs = (body2.messages as Array<{ role: string; content: string; tool_call_id?: string }>).filter(
      (m) => m.role === 'tool'
    )
    expect(toolMsgs).toHaveLength(3)
    const srcByName = new Map<string, string | null>()
    for (const tm of toolMsgs) {
      const src = sourceOf(tm)
      const name =
        tm.tool_call_id === 'call_web' ? 'web_search' : tm.tool_call_id === 'call_read' ? 'Read' : 'Agent'
      srcByName.set(name, src)
    }
    expect(srcByName.get('web_search')).toBe('web-search')
    expect(srcByName.get('Read')).toBe('file-read')
    expect(srcByName.get('Agent')).toBe('subagent')
  })

  it('蒸馏替换后的工具结果仍保持来源护栏（蒸馏不破坏包裹）', async () => {
    // 第一轮：模型请求调用 Read 工具；第二轮：模型收尾（空流结束）
    mockCreate
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_read_d', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }
                  ]
                }
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce(emptyStream())

    const executors = [
      { name: 'Read', description: '', parameters: {}, execute: async () => '长文件内容'.repeat(200) }
    ] as never

    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      [hist({ role: 'user', content: '读文件' })],
      executors,
      {
        onDone: () => {},
        onError: () => {},
        // 模拟上层蒸馏回调：蒸馏成功返回摘要（server.ts makeDistillCallbacks 同等形态），
        // 蒸馏在下一轮请求构建前用摘要替换 conversation 中 tool 消息原文
        distillToolResult: (toolName: string) => `【蒸馏摘要】${toolName}: 文件要点`
      } as never,
      { guardrailSessionId: SESSION_ID }
    )

    // 第二轮 body：蒸馏替换后的 tool 消息必须仍带 file-read 护栏
    const body2 = mockCreate.mock.calls[1]?.[0]
    expect(body2).toBeTruthy()
    const toolMsgs = (body2.messages as Array<{ role: string; content: string; tool_call_id?: string }>).filter(
      (m) => m.role === 'tool'
    )
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].content).toContain('【蒸馏摘要】Read:')
    expect(toolMsgs[0].content).not.toContain('长文件内容')
    expect(sourceOf(toolMsgs[0])).toBe('file-read')
  })

  it('蒸馏意图按对话对组装：intent 取自该工具调用前最近 N 对 user+assistant，并经配置透传', async () => {
    // 第一轮：模型请求调用 Read 工具；第二轮：模型收尾（空流结束）
    mockCreate
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_read_i', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }
                  ]
                }
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce(emptyStream())

    const executors = [
      { name: 'Read', description: '', parameters: {}, execute: async () => '长文件内容'.repeat(200) }
    ] as never

    // 两对历史问答（Q1/A1 较旧，Q2/A2 最近）后跟当前提问「读文件」；
    // 工具调用发生于当前提问的回复期，intentTurnPairs=2 时应携带：当前提问 + 最近 1 对完整问答
    const conversation = [
      hist({ role: 'user', content: 'Q1' }),
      hist({ role: 'assistant', content: 'A1' }),
      hist({ role: 'user', content: 'Q2' }),
      hist({ role: 'assistant', content: 'A2' }),
      hist({ role: 'user', content: '读文件' })
    ]

    // 意图与摘要都收集：按 conversation 顺序（越新越靠后）
    const receivedIntents: string[] = []
    const receivedSummaries: string[] = []
    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      conversation,
      executors,
      {
        onDone: () => {},
        onError: () => {},
        distillIntentTurnPairs: 2, // 模拟 makeDistillCallbacks 从 distillCfg.intentTurnPairs 透传
        distillToolResult: (toolName: string, _toolCallId: string, _result: string, intent?: string) => {
          receivedIntents.push(intent ?? '')
          receivedSummaries.push(`【蒸馏摘要】${toolName}`)
          return `【蒸馏摘要】${toolName}: 文件要点`
        }
      } as never,
      { guardrailSessionId: SESSION_ID }
    )

    // 只蒸馏了一次（Read 的结果），意图携带当前提问 + 最近 1 对问答
    expect(receivedIntents).toHaveLength(1)
    const intent = receivedIntents[0]
    expect(intent).toContain('读文件') // 引发本次工具调用的当前提问
    expect(intent).toContain('Q2') // 最近 1 对问答的 user 侧
    expect(intent).toContain('A2') // 最近 1 对问答的 assistant 侧
    expect(intent).not.toContain('Q1') // pairs=2 时更旧的历史不进入意图
    expect(intent).not.toContain('A1')
    expect(receivedSummaries).toHaveLength(1)
  })

  it('LLM 声明 _result_mode=full 时工具结果原文保留（跳过蒸馏），缺省走蒸馏', async () => {
    // 第一轮：模型同时调用 Read 两次——一次声明 full（原文保留）、一次不声明（缺省蒸馏）
    mockCreate
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_full',
                      function: { name: 'Read', arguments: '{"path":"a.ts","_result_mode":"full"}' }
                    },
                    {
                      index: 1,
                      id: 'call_distill',
                      function: { name: 'Read', arguments: '{"path":"b.ts"}' }
                    }
                  ]
                }
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce(emptyStream())

    const executors = [
      { name: 'Read', description: '', parameters: {}, execute: async () => '长文件内容'.repeat(200) }
    ] as never

    const distilledIds: string[] = []
    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      [hist({ role: 'user', content: '读两个文件，一个要完整一个要摘要' })],
      executors,
      {
        onDone: () => {},
        onError: () => {},
        distillToolResult: (toolName: string, toolCallId: string) => {
          distilledIds.push(toolCallId)
          return `【蒸馏摘要】${toolName}: 文件要点`
        }
      } as never,
      { guardrailSessionId: SESSION_ID }
    )

    // 只蒸馏了未声明 _result_mode 的那个调用；声明 full 的原文保留
    expect(distilledIds).toEqual(['call_distill'])
    const body2 = mockCreate.mock.calls[1]?.[0]
    expect(body2).toBeTruthy()
    const toolMsgs = (body2.messages as Array<{ role: string; content: string; tool_call_id?: string }>).filter(
      (m) => m.role === 'tool'
    )
    expect(toolMsgs).toHaveLength(2)
    const byId = new Map(toolMsgs.map((m) => [m.tool_call_id, m]))
    expect(byId.get('call_full')?.content).toContain('长文件内容') // full：原文完整保留
    expect(byId.get('call_full')?.content).not.toContain('【蒸馏摘要】')
    expect(byId.get('call_distill')?.content).toContain('【蒸馏摘要】') // 缺省：正常蒸馏
    expect(byId.get('call_distill')?.content).not.toContain('长文件内容')
    // 护栏不被破坏：两条 tool 消息仍带 file-read 来源包裹
    expect(sourceOf(toolMsgs[0])).toBe('file-read')
    expect(sourceOf(toolMsgs[1])).toBe('file-read')
  })

  it('蒸馏失败（重试一次仍失败）时保留工具结果原文，护栏不破坏', async () => {
    mockCreate
      .mockResolvedValueOnce({
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_read_e', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }
                  ]
                }
              }
            ]
          }
        }
      })
      .mockResolvedValueOnce(emptyStream())

    const executors = [
      { name: 'Read', description: '', parameters: {}, execute: async () => '长文件内容'.repeat(200) }
    ] as never

    const client = new LLMClient(makeConfig())
    let distillCalls = 0
    await client.streamWithTools(
      [hist({ role: 'user', content: '读文件' })],
      executors,
      {
        onDone: () => {},
        onError: () => {},
        // 蒸馏两次都失败（第一次 + 重试一次）→ 保留原文
        distillToolResult: async () => {
          distillCalls++
          return undefined
        }
      } as never,
      { guardrailSessionId: SESSION_ID }
    )

    expect(distillCalls).toBe(2)
    const body2 = mockCreate.mock.calls[1]?.[0]
    expect(body2).toBeTruthy()
    const toolMsgs = (body2.messages as Array<{ role: string; content: string; tool_call_id?: string }>).filter(
      (m) => m.role === 'tool'
    )
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].content).toContain('长文件内容')
    expect(sourceOf(toolMsgs[0])).toBe('file-read')
  })

  it('未传 guardrailSessionId 时不包裹（旧行为保持）', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig())
    await client.streamWithTools(
      [hist({ role: 'user', content: '你好' })],
      NO_TOOLS,
      { onDone: () => {}, onError: () => {} }
    )
    const body = mockCreate.mock.calls[0][0]
    const msgs = body.messages as Array<{ role: string; content: string }>
    expect(msgs.some((m) => m.content.includes('消息来源护栏协议'))).toBe(false)
    const userMsg = msgs.find((m) => m.content === '你好')
    expect(userMsg?.content).toBe('你好')
  })

  it('已包裹消息跳过兜底分类（streamWithTools 与 chatWithTools 同规，不二次包裹）', async () => {
    mockCreate.mockResolvedValueOnce(emptyStream())
    const client = new LLMClient(makeConfig())
    // 调用方已按细分类包裹（web-search 来源）的 assistant 历史，streamWithTools
    // 不应再按 role 兜底重包成 ai——已包裹判定优先，保留调用方声明的来源
    const preWrapped = wrapGuardrail('搜索到 1 个结果', 'web-search', SESSION_ID)
    await client.streamWithTools(
      [hist({ role: 'assistant', id: 'assist_1', content: preWrapped })],
      NO_TOOLS,
      { onDone: () => {}, onError: () => {} },
      { guardrailSessionId: SESSION_ID }
    )
    const body = mockCreate.mock.calls[0][0]
    const msgs = body.messages as Array<{ role: string; content: string }>
    const aiMsg = msgs.find((m) => m.content?.includes('搜索到 1 个结果'))
    expect(aiMsg).toBeTruthy()
    // 来源仍是调用方声明的 web-search，未被 role 兜底改写成 ai
    expect(sourceOf(aiMsg!)).toBe('web-search')
  })
})

describe('chatWithTools 消息来源护栏 wire 装配', () => {
  it('协议段置顶 + role 兜底包裹：user → user / assistant → ai / tool → tool-return', async () => {
    // 非流式响应：choices[0].message 直接作为最终内容
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'chat 回复', tool_calls: undefined }, finish_reason: 'stop' }]
    })
    const client = new LLMClient(makeConfig())
    await client.chatWithTools(
      [
        { role: 'user', content: 'chat 用户' },
        { role: 'assistant', content: 'chat AI' },
        { role: 'tool', content: 'tool 返回', tool_call_id: 'c1' }
      ],
      [],
      undefined,
      { guardrailSessionId: SESSION_ID }
    )
    const body = mockCreate.mock.calls[0][0]
    const msgs = body.messages as Array<{ role: string; content: string }>

    // 协议说明段置顶为 system（非流式同样注入）
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('消息来源护栏协议')
    // role 兜底分类：user/assistant/tool 分别包成 user/ai/tool-return
    expect(sourceOf(msgs.find((m) => m.content.includes('chat 用户'))!)).toBe('user')
    expect(sourceOf(msgs.find((m) => m.content.includes('chat AI'))!)).toBe('ai')
    expect(sourceOf(msgs.find((m) => m.content.includes('tool 返回'))!)).toBe('tool-return')
  })

  it('已包裹的消息跳过兜底分类（parseGuardrail 检测 wrapped → 不二次包裹）', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'done', tool_calls: undefined }, finish_reason: 'stop' }]
    })
    const client = new LLMClient(makeConfig())
    // 调用方已按工具名细分包裹（web-search 来源），chatWithTools 不应再按 role 兜底重包
    const preWrapped = wrapGuardrail('搜索到 1 个结果', 'web-search', SESSION_ID)
    await client.chatWithTools(
      [{ role: 'tool', content: preWrapped, tool_call_id: 'c_ws' }],
      [],
      undefined,
      { guardrailSessionId: SESSION_ID }
    )
    const body = mockCreate.mock.calls[0][0]
    const msgs = body.messages as Array<{ role: string; content: string }>
    const toolMsg = msgs.find((m) => m.tool_call_id === 'c_ws')
    expect(toolMsg).toBeTruthy()
    // 来源仍是调用方声明的 web-search，未被 role 兜底改写成 tool-return
    expect(sourceOf(toolMsg!)).toBe('web-search')
    // 内容未被二次包裹：原文保留可读
    expect(toolMsg!.content).toContain('搜索到 1 个结果')
  })

  it('未传 guardrailSessionId 时 chatWithTools 不包裹', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }]
    })
    const client = new LLMClient(makeConfig())
    await client.chatWithTools([{ role: 'user', content: '你好' }], [], undefined)
    const msgs = mockCreate.mock.calls[0][0].messages as Array<{ role: string; content: string }>
    expect(msgs.some((m) => m.content.includes('消息来源护栏协议'))).toBe(false)
    expect(msgs.find((m) => m.content === '你好')?.content).toBe('你好')
  })
})