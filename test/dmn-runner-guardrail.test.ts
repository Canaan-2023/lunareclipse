/**
 * DmnRunner 消息来源护栏 + 工具结果蒸馏契约测试。
 *
 * 为什么存在：DMN（监控自动回复引擎）与主会话/工作流一视同仁——进入 LLM 上下文的每条消息
 * 都必须带护栏来源声明，大体积工具结果必须先蒸馏再进上下文。本测试用 mock LLM + 迷你工具
 * 锁定 DmnRunner 内部契约：
 * 1. run() 调用 chatWithTools 时透传 guardrailSessionId（显式传入优先，缺省 DMN_GUARDRAIL_KEY）；
 * 2. 工具结果按工具名细分类包裹：web_search → web-search / Read → file-read / 普通工具 → tool-return；
 * 3. distillToolResult 注入时蒸馏成功替换原文、失败重试一次仍失败保留原文；
 * 4. 护栏解析口径与生产代码同源（parseGuardrail），确保包裹可被下游正确识别。
 */
import { describe, it, expect } from 'vitest'
import { DmnRunner, type LLM, type DmnRunOptions } from '../electron/main/monitor/dmn-runner'
import type { AnyTool, ToolContext } from '../electron/main/tools/base-tool'
import { parseGuardrail, DMN_GUARDRAIL_KEY, SUBAGENT_GUARDRAIL_KEY } from '../electron/main/api/message-guardrail'
import type { ApiMessage, ChatWithToolsResult, ToolCallResult } from '../electron/main/api/llm-types'

function tool(name: string, execute?: AnyTool['execute']): AnyTool {
  return {
    name,
    description: `mock tool ${name}`,
    parameters: [],
    execute: execute ?? (async () => ({ ok: true, data: `result-of-${name}` }))
  } as unknown as AnyTool
}

function toolCall(id: string, name: string, args = '{}'): ToolCallResult {
  return { id, type: 'function', function: { name, arguments: args } }
}

/** 可编程 mock LLM：按脚本逐轮返回，且记录每轮收到的 options */
function mockLlm(script: ChatWithToolsResult[]) {
  const received: Array<{ messages: ApiMessage[]; options?: { guardrailSessionId?: string } }> = []
  let idx = 0
  const llm: LLM = {
    chatWithTools: async (_messages, _tools, _model, options) => {
      received.push({ messages: _messages, options })
      return script[idx++] ?? { content: 'final', toolCalls: [], finishReason: 'stop' }
    }
  }
  return { llm, received }
}

function baseCtx(): ToolContext {
  // 极简上下文：能力闸/hooks 均缺省（executeTool 内部宽松跳过）
  return {} as ToolContext
}

describe('DmnRunner 护栏 + 蒸馏', () => {
  const runnerArgs = (partial?: Partial<DmnRunOptions>): DmnRunOptions => ({
    dmnId: 'dmn_test',
    messages: [{ role: 'user', content: '查一下 memory' }],
    tools: [tool('web_search'), tool('Read'), tool('calc')],
    ctx: baseCtx(),
    ...partial
  })

  it('缺省护栏键 = DMN_GUARDRAIL_KEY，chatWithTools 收到透传', async () => {
    const { llm, received } = mockLlm([{ content: 'done', toolCalls: [], finishReason: 'stop' }])
    const runner = new DmnRunner(llm)
    const result = await runner.run(runnerArgs())
    expect(result.lastContent).toBe('done')
    expect(received).toHaveLength(1)
    expect(received[0].options?.guardrailSessionId).toBe(DMN_GUARDRAIL_KEY)
  })

  it('显式 guardrailSessionId 优先（子 agent 上下文用 SUBAGENT_GUARDRAIL_KEY）', async () => {
    const { llm, received } = mockLlm([{ content: 'sub done', toolCalls: [], finishReason: 'stop' }])
    const runner = new DmnRunner(llm)
    await runner.run(runnerArgs({ guardrailSessionId: SUBAGENT_GUARDRAIL_KEY }))
    expect(received[0].options?.guardrailSessionId).toBe(SUBAGENT_GUARDRAIL_KEY)
  })

  it('工具结果按工具名细分类包裹（web-search / file-read / tool-return），可被解析', async () => {
    const { llm, received } = mockLlm([
      {
        content: '',
        toolCalls: [
          toolCall('call_web', 'web_search', '{"q":"x"}'),
          toolCall('call_read', 'Read', '{"path":"a.ts"}'),
          toolCall('call_calc', 'calc', '{"a":1}')
        ],
        finishReason: 'tool_calls'
      },
      { content: '最终答复', toolCalls: [], finishReason: 'stop' }
    ])
    const runner = new DmnRunner(llm)
    await runner.run(runnerArgs())

    // 第二轮：tool 消息已按工具名细分类包裹
    const second = received[1].messages
    const toolMsgs = second.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(3)

    const byId = new Map(toolMsgs.map((m) => [m.tool_call_id, m]))
    const src = (m?: ApiMessage) => {
      const parsed = parseGuardrail(m?.content ?? '', DMN_GUARDRAIL_KEY)
      return parsed.wrapped && parsed.valid ? parsed.source : null
    }
    expect(src(byId.get('call_web'))).toBe('web-search')
    expect(src(byId.get('call_read'))).toBe('file-read')
    expect(src(byId.get('call_calc'))).toBe('tool-return')
  })

  it('distillToolResult 注入时：蒸馏成功 → 摘要替换原文且保持护栏', async () => {
    const { llm, received } = mockLlm([
      {
        content: '',
        toolCalls: [toolCall('call_d', 'Read', '{"path":"big.ts"}')],
        finishReason: 'tool_calls'
      },
      { content: 'final', toolCalls: [], finishReason: 'stop' }
    ])
    const runner = new DmnRunner(llm)
    const intentSeen: string[] = []
    await runner.run(
      runnerArgs({
        distillToolResult: async (_toolName: string, _id: string, _result: string, intent?: string) => {
          intentSeen.push(intent ?? '')
          return `【摘要】${_toolName}: 要点`
        }
      })
    )
    const toolMsg = received[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('【摘要】Read: 要点')
    expect(toolMsg?.content).not.toContain('result-of-Read')
    const parsed = parseGuardrail(toolMsg?.content ?? '', DMN_GUARDRAIL_KEY)
    expect(parsed.wrapped).toBe(true)
    expect(parsed.valid).toBe(true)
    expect(parsed.source).toBe('file-read')
    // intent 不得传空串：携带该工具调用前的最近对话意图（user 提问原文），供蒸馏 LLM 判断相关性
    expect(intentSeen[0]).toContain('user: 查一下 memory')
  })

  it('distillToolResult 连续失败（重试一次仍失败）→ 保留原文，护栏不被破坏', async () => {
    const { llm, received } = mockLlm([
      {
        content: '',
        toolCalls: [toolCall('call_e', 'web_search', '{"q":"y"}')],
        finishReason: 'tool_calls'
      },
      { content: 'final', toolCalls: [], finishReason: 'stop' }
    ])
    const runner = new DmnRunner(llm)
    let distillCalls = 0
    await runner.run(
      runnerArgs({
        distillToolResult: async () => {
          distillCalls++
          return undefined
        }
      })
    )
    expect(distillCalls).toBe(2) // 首次 + 重试一次
    const toolMsg = received[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('result-of-web_search')
    const parsed = parseGuardrail(toolMsg?.content ?? '', DMN_GUARDRAIL_KEY)
    expect(parsed.wrapped).toBe(true)
    expect(parsed.valid).toBe(true)
    expect(parsed.source).toBe('web-search')
  })

  it('蒸馏抛错也走重试一次，仍失败保留原文', async () => {
    const { llm, received } = mockLlm([
      {
        content: '',
        toolCalls: [toolCall('call_t', 'calc', '{}')],
        finishReason: 'tool_calls'
      },
      { content: 'final', toolCalls: [], finishReason: 'stop' }
    ])
    const runner = new DmnRunner(llm)
    let distillCalls = 0
    await runner.run(
      runnerArgs({
        distillToolResult: async () => {
          distillCalls++
          throw new Error('distill boom')
        }
      })
    )
    expect(distillCalls).toBe(2)
    const toolMsg = received[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('result-of-calc')
    const parsed = parseGuardrail(toolMsg?.content ?? '', DMN_GUARDRAIL_KEY)
    expect(parsed.valid).toBe(true)
  })
})