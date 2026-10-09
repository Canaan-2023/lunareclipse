import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock openai：让 streamWithTools 的蒸馏接线测试可控（复用 llm-failure-halt 范式）
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

import {
  ToolResultDistiller,
  DEFAULT_DISTILL_CONFIG,
  DISTILL_TOOL_WHITELIST,
  type DistillConfig,
  type DistillLLM
} from '../electron/main/services/tool-result-distiller'
import { LLMClient } from '../electron/main/api/llm'
import type { LLMConfig, ChatMessage } from '@shared/types'

/**
 * 工具结果蒸馏层测试

 * 背景：工具返回的大段内容里通常只有一小部分有用，原样进上下文无边际消耗 token。
 * 本层在工具结果消息进上下文前用 LLM 二次提取，成功则摘要直接替换 conversation 原文。
 * 失败/跳过一律返回 null，上游保留原文进上下文（不落盘、不截断）。
 */

function cfg(partial: Partial<DistillConfig> = {}): DistillConfig {
  return { ...DEFAULT_DISTILL_CONFIG, ...partial }
}

/** 构造一条「成功且足够长」的工具结果（默认 10000 字符；0.17 起默认 minChars=0 全量蒸馏，此长度远超任何体积门槛） */
function bigResult(payload = 'x', size = 10000): string {
  return JSON.stringify({ ok: true, data: payload.repeat(size) })
}

/** 构造 fake LLM：返回固定 content，并记录调用参数 */
function fakeLlm(content: string | null = '{"useful":true,"summary":"要点","facts":["a"]}'): {
  llm: DistillLLM
  calls: Array<{ messages: unknown; tools: unknown; model?: string }>
} {
  const calls: Array<{ messages: unknown; tools: unknown; model?: string }> = []
  const llm: DistillLLM = {
    chatWithTools: async (messages, tools, model) => {
      calls.push({ messages, tools, model })
      return { content }
    }
  }
  return { llm, calls }
}

describe('ToolResultDistiller - 触发条件', () => {
  it('低于 minChars 不蒸馏，且不调用 LLM', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ minChars: 4000 }))
    const short = JSON.stringify({ ok: true, data: 'tiny' })

    expect(await d.distill('web_search', short)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('ok=false 的错误结果不蒸馏（错误原文必须完整交给模型）', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    const errResult = JSON.stringify({ ok: false, error: 'e'.repeat(5000) })

    expect(await d.distill('web_search', errResult)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('带 error 字段的成功结果同样跳过', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    const errResult = JSON.stringify({ ok: true, error: 'partial fail', data: 'y'.repeat(5000) })

    expect(await d.distill('grep', errResult)).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('非 JSON 结果也蒸馏（0.17 全量过滤：纯文本同样只留有用信息）', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('read_file', 'plain text '.repeat(600))).toBe('要点；a')
    expect(calls).toHaveLength(1)
  })

  it('默认配置为全量蒸馏（minChars=0 / onlyListSearchTools=false / maxPerTurn=60）', () => {
    expect(DEFAULT_DISTILL_CONFIG.minChars).toBe(0)
    expect(DEFAULT_DISTILL_CONFIG.onlyListSearchTools).toBe(false)
    expect(DEFAULT_DISTILL_CONFIG.maxPerTurn).toBe(60)
  })

  it('enabled=false 时完全跳过', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ enabled: false }))
    expect(await d.distill('web_search', bigResult())).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('onlyListSearchTools=true 时白名单外的工具跳过', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ onlyListSearchTools: true }))
    expect(await d.distill('run_command', bigResult())).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('onlyListSearchTools=false 时白名单外工具也蒸馏', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ onlyListSearchTools: false }))
    expect(await d.distill('run_command', bigResult())).toBe('要点；a')
    expect(calls).toHaveLength(1)
  })

  it('白名单覆盖搜索/读取/局域网三工具', () => {
    for (const name of ['web_search', 'grep', 'read_file', 'friend_manage', 'chat_room_manage', 'publish_board_manage']) {
      expect(DISTILL_TOOL_WHITELIST.has(name)).toBe(true)
    }
  })

  it('skipTools 默认含 use_skill（指令型技能正文逐字保留）', () => {
    // 2026-10-08：use_skill 返回 SKILL.md 完整正文——审查清单/方法论步骤/输出纪律是指令
    // 契约，蒸馏压缩即丢语义；默认名单保护 code-review、ai-perspective-prompting 等技能
    expect(DEFAULT_DISTILL_CONFIG.skipTools).toContain('use_skill')
  })

  it('skipTools 中的工具永不蒸馏：即便 onlyListSearchTools=false 且体积达标', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ skipTools: ['use_skill'] }))
    // 默认 minChars=0 / onlyListSearchTools=false 本应进入蒸馏，但 use_skill 在豁免名单内：
    // 豁免优先于白名单与体积阈值，无条件逐字保留原文
    expect(await d.distill('use_skill', bigResult())).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('skipTools 只豁免名单内工具，名单外工具仍正常蒸馏', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ skipTools: ['use_skill'] }))
    expect(await d.distill('web_search', bigResult())).toBe('要点；a')
    expect(calls).toHaveLength(1)
  })

  it('skipTools 豁免优先于 onlyListSearchTools=false（用户清空名单后保护解除）', async () => {
    const { llm, calls } = fakeLlm()
    // 用户显式配置 skipTools: [] 表示关闭豁免 → use_skill 结果按常规流程进入蒸馏
    const d = new ToolResultDistiller(() => llm, () => cfg({ skipTools: [] }))
    expect(await d.distill('use_skill', bigResult())).toBe('要点；a')
    expect(calls).toHaveLength(1)
  })
})

describe('ToolResultDistiller - 输出契约与解析', () => {
  it('命中时返回 summary + facts 拼接文本', async () => {
    const { llm } = fakeLlm('{"useful":true,"summary":"找到 3 篇","facts":["A","B"]}')
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBe('找到 3 篇；A；B')
  })

  it('容忍 ```json 围栏与前后噪声', async () => {
    const { llm } = fakeLlm('好的，结果如下：\n```json\n{"useful":true,"summary":"结论","facts":[]}\n```\n以上。')
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('grep', bigResult())).toBe('结论')
  })

  it('useful=false 返回「无有用信息」', async () => {
    const { llm } = fakeLlm('{"useful":false,"summary":"","facts":[]}')
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBe('无有用信息')
  })

  it('解析失败返回 null（上游保留原文）', async () => {
    const { llm } = fakeLlm('这不是 JSON')
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBeNull()
  })

  it('空 content 返回 null', async () => {
    const { llm } = fakeLlm(null)
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBeNull()
  })

  it('摘要空白压平并限长（不再归一化符号）', async () => {
    const { llm } = fakeLlm('{"useful":true,"summary":"a]b\\nc","facts":[]}')
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBe('a]b c')
  })
})

describe('ToolResultDistiller - 控本与防护', () => {
  it('同结果第二次走缓存，LLM 只调一次', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    const result = bigResult('same')

    expect(await d.distill('web_search', result)).toBe('要点；a')
    expect(await d.distill('web_search', result)).toBe('要点；a')
    expect(calls).toHaveLength(1)
  })

  it('意图参与缓存指纹：同工具同结果不同意图需重新蒸馏', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    const result = bigResult('same-result')

    // 同一结果在 A/B 两个任务背景下（意图不同），提取要点可能不同——
    // 缓存键必须含意图，否则 B 上下文直接复用 A 的摘要导致错配
    expect(await d.distill('web_search', result, '意图 A：对比竞品价格')).toBe('要点；a')
    expect(await d.distill('web_search', result, '意图 B：找供应商联系方式')).toBe('要点；a')
    // 两次意图不同 → 两次真实调用（不在第二次命中原摘要缓存）
    expect(calls).toHaveLength(2)
    // 第二次同意图（意图 A 再次出现）→ 命中意图 A 的摘要缓存
    expect(await d.distill('web_search', result, '意图 A：对比竞品价格')).toBe('要点；a')
    expect(calls).toHaveLength(2)
  })

  it('意图传入蒸馏 LLM 的 user 消息（调用背景），供其判断相关性', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    await d.distill('web_search', bigResult(), '前一轮 user：查一下竞品动态')

    const msgs = calls[0].messages as Array<{ role: string; content: string }>
    const userMsg = msgs.find((m) => m.role === 'user')!
    expect(userMsg.content).toContain('调用背景')
    expect(userMsg.content).toContain('查一下竞品动态')
    expect(userMsg.content).toContain('原始返回')
  })

  it('并发超过 maxConcurrent 时排队执行而非静默丢弃', async () => {
    // 信号量语义：超限调用进队列等待，槽位释放后继续执行（不返回 null 弃流）。
    // 旧实现用 inFlight 布尔在 acquire 前直接 return null，maxConcurrent=2 形同虚设。
    const pending: Array<(v: { content: string | null }) => void> = []
    let callCount = 0
    const llm: DistillLLM = {
      chatWithTools: () => {
        callCount++
        return new Promise((r) => pending.push(r))
      }
    }
    const d = new ToolResultDistiller(() => llm, () => cfg({ maxConcurrent: 1 }))

    const first = d.distill('web_search', bigResult('a'))
    const second = d.distill('web_search', bigResult('b'))
    // 第一个占用唯一槽位，第二个应排队等待（不提前调用 LLM）
    await new Promise((r) => setTimeout(r, 10))
    expect(callCount).toBe(1)

    // 释放第一个 → 第二个获得槽位继续执行，两次都返回结果
    pending.shift()?.({ content: '{"useful":true,"summary":"ok1","facts":[]}' })
    expect(await first).toBe('ok1')
    // 第一个的 release 把槽位转交给排队者；等待微任务推进让第二个真正进入 callLlm
    await new Promise((r) => setTimeout(r, 10))
    expect(callCount).toBe(2)
    pending.shift()?.({ content: '{"useful":true,"summary":"ok2","facts":[]}' })
    expect(await second).toBe('ok2')
  })

  it('滚动窗口限流：超过 maxPerTurn 后返回 null', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ maxPerTurn: 2 }))

    expect(await d.distill('web_search', bigResult('1'))).toBe('要点；a')
    expect(await d.distill('web_search', bigResult('2'))).toBe('要点；a')
    expect(await d.distill('web_search', bigResult('3'))).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it('超时回退 null', async () => {
    const llm: DistillLLM = { chatWithTools: () => new Promise(() => {}) }
    const d = new ToolResultDistiller(() => llm, () => cfg({ timeoutMs: 50 }))

    const started = Date.now()
    expect(await d.distill('web_search', bigResult())).toBeNull()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('LLM 抛错时返回 null 而不冒泡', async () => {
    const llm: DistillLLM = {
      chatWithTools: async () => {
        throw new Error('network down')
      }
    }
    const d = new ToolResultDistiller(() => llm, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBeNull()
  })

  it('未注入 LLM 时返回 null', async () => {
    const d = new ToolResultDistiller(() => null, () => cfg())
    expect(await d.distill('web_search', bigResult())).toBeNull()
  })

  it('递归防护：蒸馏调用的 tools 恒为空数组', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg())
    await d.distill('web_search', bigResult())

    expect(calls).toHaveLength(1)
    expect(calls[0].tools).toEqual([])
  })

  it('超长输入被截断到 maxInputChars 以内', async () => {
    const { llm, calls } = fakeLlm()
    const d = new ToolResultDistiller(() => llm, () => cfg({ maxInputChars: 1000, minChars: 10 }))
    await d.distill('web_search', bigResult('z', 50000))

    const msgs = calls[0].messages as Array<{ role: string; content: string }>
    const userMsg = msgs.find((m) => m.role === 'user')!
    // 截断后：工具名提示 + 头 80% + 尾 20%，总长应显著小于原始 50000
    expect(userMsg.content.length).toBeLessThan(2000)
    expect(userMsg.content).toContain('中间已截断')
  })

  it('蒸馏输出不设长度上限：超长摘要/要点原样保留，不被截断', async () => {
    // 用户要求「蒸馏结果不要有什么限制」：摘要与要点长度由蒸馏 LLM 决定，本层不硬性截断
    const longSummary = '结'.repeat(5000)
    const { llm } = fakeLlm(
      JSON.stringify({ useful: true, summary: longSummary, facts: ['要点甲', '要'.repeat(3000)] })
    )
    const d = new ToolResultDistiller(() => llm, () => cfg())

    const out = await d.distill('web_search', bigResult())
    expect(out).not.toBeNull()
    // 完整保留超长摘要与超长要点，未按任何字符上限截断（旧行为 400 字符硬截断已移除）
    expect(out).toContain(longSummary)
    expect(out).toContain('要'.repeat(3000))
    expect(out!.length).toBeGreaterThan(8000)
  })
})

// ===== 蒸馏替换接线：distillToolResult 成功 → 摘要替换 tool 消息原文；失败重试一次仍失败 → 保留原文 =====

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

/** 构造「发出一次 web_search 调用」的流 */
function makeToolCallStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  function: { name: 'web_search', arguments: JSON.stringify({ query: 'k' }) }
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

describe('streamWithTools - 蒸馏替换接线', () => {
  let client: LLMClient

  beforeEach(() => {
    mockCreate.mockReset()
    client = new LLMClient(makeConfig())
  })

  it('distillToolResult 成功后，conversation 中 tool 消息原文被蒸馏摘要替换', async () => {
    mockCreate
      .mockImplementationOnce(() => Promise.resolve(makeToolCallStream()))
      .mockImplementationOnce(() => Promise.resolve(makeTextStream('完成')))

    const tool = {
      name: 'web_search',
      description: 'search',
      parameters: {},
      execute: async () => JSON.stringify({ ok: true, data: 'r'.repeat(5000) })
    }

    const distillCalls: Array<[string, string, string]> = []

    await client.streamWithTools([{ id: 'm1', role: 'user', content: 'hi', createdAt: Date.now() }] as ChatMessage[], [tool], {
      onToken: () => {},
      onDone: () => {},
      onError: (e) => {
        throw e
      },
      distillToolResult: async (toolName, toolCallId, result) => {
        distillCalls.push([toolName, toolCallId, result])
        return 'LLM 提炼摘要'
      }
    })

    expect(distillCalls).toHaveLength(1)
    expect(distillCalls[0][0]).toBe('web_search')
    // 第二轮 body：tool 消息内容已是蒸馏摘要，而非原始 5000 字符结果
    const body2 = mockCreate.mock.calls[1][0]
    const toolMsgs = (body2.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].content).toContain('LLM 提炼摘要')
    expect(toolMsgs[0].content).not.toContain('"data": "rrrr')
  })

  it('distillToolResult 抛错（重试一次仍抛错）时保留工具结果原文', async () => {
    mockCreate
      .mockImplementationOnce(() => Promise.resolve(makeToolCallStream()))
      .mockImplementationOnce(() => Promise.resolve(makeTextStream('完成')))

    const tool = {
      name: 'web_search',
      description: 'search',
      parameters: {},
      execute: async () => JSON.stringify({ ok: true, data: 'r'.repeat(5000) })
    }

    let distillCalls = 0

    await client.streamWithTools([{ id: 'm1', role: 'user', content: 'hi', createdAt: Date.now() }] as ChatMessage[], [tool], {
      onToken: () => {},
      onDone: () => {},
      onError: (e) => {
        throw e
      },
      distillToolResult: async () => {
        distillCalls++
        throw new Error('distill boom')
      }
    })

    expect(distillCalls).toBe(2)
    const body2 = mockCreate.mock.calls[1][0]
    const toolMsgs = (body2.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].content).toContain('"data":"rrrr')
  })
})
