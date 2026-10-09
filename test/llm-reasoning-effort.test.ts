/**
 * LLM 思考挡位 wire 装配回归（7 档 reasoningEffort → reasoning_effort / thinking 映射锁定）
 *
 * 背景：用户档位 off/minimal/low/medium/high/very_high/max 是 UI 层概念；
 * wire 层必须按 provider 能力契约归一，否则「挡位选了但没生效」。
 * 通用解法（2026-10-08 重构）：归一规则集中在 @shared/reasoning-profiles 的
 * provider 能力契约表（每个接入方声明档位集合 + 7 档 → wire 组装），
 * 主进程 buildReasoningParams 与前端挡位下拉共用同一张表，新增 provider 只加一行。
 *
 * 锁定点（与能力表一致）：
 * 1. DeepSeek：off→thinking disabled；minimal/low→enabled+low；medium/high→enabled+high；very_high/max→enabled+max
 * 2. OpenAI 官方：off→不传；minimal/low/medium/high 原样透传；very_high/max→high
 * 3. Gemini：minimal→low；low/medium/high 原样；very_high/max→high；off→thinking disabled
 * 4. 千问：off→enable_thinking:false；其余→enable_thinking:true（无档位细分）
 * 5. Claude/自定义网关（兜底 default）：off→不传；minimal/low/medium/high 原样；very_high/max→high
 * 6. chatWithTools 的 options.reasoningEffort 可覆盖 config（缺省回退 config.reasoningEffort）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMClient } from '../electron/main/api/llm'
import {
  resolveReasoningProfile,
  displayEffort,
  buildReasoningWireParams
} from '../shared/reasoning-profiles'
import type { LLMConfig, ChatMessage, ReasoningEffort } from '@shared/types'

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

function makeConfig(overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'test-key',
    model: 'deepseek-chat',
    temperature: 0.7,
    maxTokens: 2048,
    reasoningEffort: 'medium',
    streamingSpeed: 1,
    ...overrides
  }
}

/** 取一次非流式请求的完整 body（stream=false 路径；body 即 create 第一参） */
async function captureBody(cfg: LLMConfig, effort?: ReasoningEffort): Promise<Record<string, unknown>> {
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: 'ok', tool_calls: null }, finish_reason: 'stop' }] })
  const client = new LLMClient(cfg)
  await client.chatWithTools([{ role: 'user', content: 'hi' } as ChatMessage], [], undefined, effort ? { reasoningEffort: effort } : undefined)
  return mockCreate.mock.calls[mockCreate.mock.calls.length - 1][0] as Record<string, unknown>
}

describe('能力表解析 - resolveReasoningProfile 按 baseURL 命中各 provider 契约', () => {
  it('deepseek 官方 / 兼容网关 → deepseek profile', () => {
    expect(resolveReasoningProfile('https://api.deepseek.com/v1').id).toBe('deepseek')
    expect(resolveReasoningProfile('https://gateway.deepseek-x.com/v1').id).toBe('deepseek')
  })
  it('api.openai.com → openai profile（档位到 high 为止）', () => {
    const p = resolveReasoningProfile('https://api.openai.com/v1')
    expect(p.id).toBe('openai')
    expect(p.uiEfforts).toEqual(['off', 'minimal', 'low', 'medium', 'high'])
  })
  it('gemini / generativelanguage → gemini profile（无 minimal 档）', () => {
    const p = resolveReasoningProfile('https://generativelanguage.googleapis.com/v1beta/openai')
    expect(p.id).toBe('gemini')
    expect(p.uiEfforts).toEqual(['off', 'low', 'medium', 'high'])
  })
  it('dashscope / qwen → qwen profile（仅开关）', () => {
    const p = resolveReasoningProfile('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(p.id).toBe('qwen')
    expect(p.uiEfforts).toEqual(['off', 'medium'])
  })
  it('anthropic / claude → anthropic profile', () => {
    expect(resolveReasoningProfile('https://api.anthropic.com/v1').id).toBe('anthropic')
  })
  it('未知自定义网关 → default 兜底（全 7 档）', () => {
    const p = resolveReasoningProfile('https://my-gateway.example.com/v1')
    expect(p.id).toBe('default')
    expect(p.uiEfforts).toHaveLength(7)
  })
})

describe('就近归一 - displayEffort 把不可区分档位映射到可见档', () => {
  it('DeepSeek 无 minimal/medium/very_high → 归一 low/high/max', () => {
    const p = resolveReasoningProfile('https://api.deepseek.com/v1')
    expect(displayEffort(p, 'minimal')).toBe('low')
    expect(displayEffort(p, 'medium')).toBe('high')
    expect(displayEffort(p, 'very_high')).toBe('max')
    expect(displayEffort(p, 'low')).toBe('low')
  })
  it('OpenAI 无 very_high/max → 归一 high', () => {
    const p = resolveReasoningProfile('https://api.openai.com/v1')
    expect(displayEffort(p, 'very_high')).toBe('high')
    expect(displayEffort(p, 'max')).toBe('high')
  })
  it('千问任何强度档 → 归一 medium（档位折叠为开/关）', () => {
    const p = resolveReasoningProfile('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(displayEffort(p, 'minimal')).toBe('medium')
    expect(displayEffort(p, 'max')).toBe('medium')
    expect(displayEffort(p, 'off')).toBe('off')
  })
})

describe('wire 组装 - buildReasoningWireParams 直接锁定各契约', () => {
  it('DeepSeek off → thinking disabled', () => {
    expect(buildReasoningWireParams('https://api.deepseek.com/v1', 'off')).toEqual({
      thinking: { type: 'disabled' }
    })
  })
  it('DeepSeek minimal→enabled+low / medium→enabled+high / max→enabled+max', () => {
    expect(buildReasoningWireParams('https://api.deepseek.com/v1', 'minimal')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'low'
    })
    expect(buildReasoningWireParams('https://api.deepseek.com/v1', 'medium')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    })
    expect(buildReasoningWireParams('https://api.deepseek.com/v1', 'max')).toEqual({
      thinking: { type: 'enabled' },
      reasoning_effort: 'max'
    })
  })
  it('千问 off→enable_thinking:false；任意档→enable_thinking:true', () => {
    expect(buildReasoningWireParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'off')).toEqual({
      enable_thinking: false
    })
    expect(buildReasoningWireParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'high')).toEqual({
      enable_thinking: true
    })
  })
})

describe('LLM 思考挡位映射 - DeepSeek 官方 API（经 LLMClient 全链路）', () => {
  it('off → thinking disabled（显式关闭思考）', async () => {
    const body = await captureBody(makeConfig({ reasoningEffort: 'off' }))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.reasoning_effort).toBeUndefined()
  })

  it.each(['minimal', 'low'] as const)(
    '%s → thinking enabled + reasoning_effort=low（官方兼容映射 minimal→low）',
    async (effort) => {
      const body = await captureBody(makeConfig({ reasoningEffort: effort }))
      expect(body.thinking).toEqual({ type: 'enabled' })
      expect(body.reasoning_effort).toBe('low')
    }
  )

  it.each(['medium', 'high'] as const)(
    '%s → thinking enabled + reasoning_effort=high（官方兼容映射 medium→high）',
    async (effort) => {
      const body = await captureBody(makeConfig({ reasoningEffort: effort }))
      expect(body.thinking).toEqual({ type: 'enabled' })
      expect(body.reasoning_effort).toBe('high')
    }
  )

  it.each(['very_high', 'max'] as const)('%s → thinking enabled + reasoning_effort=max', async (effort) => {
    const body = await captureBody(makeConfig({ reasoningEffort: effort }))
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })
})

describe('LLM 思考挡位映射 - OpenAI 官方（同名枚举透传，档位到 high）', () => {
  const openaiBase = { baseURL: 'https://api.openai.com/v1', model: 'gpt-5' }

  it('off → 不传思考参数（依赖模型自身默认行为）', async () => {
    const body = await captureBody(makeConfig({ ...openaiBase, reasoningEffort: 'off' }))
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('minimal/low/medium/high 原样透传', async () => {
    for (const effort of ['minimal', 'low', 'medium', 'high'] as const) {
      const body = await captureBody(makeConfig({ ...openaiBase, reasoningEffort: effort }))
      expect(body.reasoning_effort).toBe(effort)
    }
  })

  it('very_high/max → 归一为 high（OpenAI 档位到 high 为止）', async () => {
    for (const effort of ['very_high', 'max'] as const) {
      const body = await captureBody(makeConfig({ ...openaiBase, reasoningEffort: effort }))
      expect(body.reasoning_effort).toBe('high')
    }
  })
})

describe('LLM 思考挡位 - 调用级覆盖', () => {
  it('chatWithTools options.reasoningEffort 覆盖 config（config=medium → options=max → wire=max）', async () => {
    const body = await captureBody(makeConfig({ reasoningEffort: 'medium' }), 'max')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })

  it('缺省 options 时回退 config.reasoningEffort（config 为唯一生效源）', async () => {
    const body = await captureBody(makeConfig({ reasoningEffort: 'high' }))
    expect(body.reasoning_effort).toBe('high')
  })
})