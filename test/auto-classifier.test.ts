import { describe, it, expect, afterEach, vi } from 'vitest'

// LLM 通道 mock（分类请求的主模型）：decision 可切换 allow/deny/review/error，
// ready 可切换 isReady 结果。auto-classifier 依赖 `new LLMClient` 由模块级工厂构造，
// vi.mock 让集成测试无需真实网络即可验证执行链分类决策。
const mockState = vi.hoisted(() => ({
  decision: 'allow' as 'allow' | 'deny' | 'review' | 'error',
  ready: true as boolean
}))
vi.mock('../electron/main/api/llm', () => ({
  LLMClient: class {
    isReady(): boolean {
      return mockState.ready
    }
    async chatWithTools(): Promise<{ content: string; toolCalls: []; finishReason: string }> {
      if (mockState.decision === 'error') throw new Error('mock llm boom')
      return { content: mockState.decision, toolCalls: [], finishReason: 'stop' }
    }
  }
}))

import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import type { AnyTool, ToolBehavior } from '../electron/main/tools/base-tool'
import {
  EnterAutoPermissionModeTool,
  ExitAutoPermissionModeTool,
  isAutoPermissionActive,
  resetAutoPermissionState,
  parseAutoDecision,
  classifyToolCall,
  type AutoClassifierClientFactory
} from '../electron/main/tools/auto-classifier'
import type { LLMConfig } from '../shared/types'

/**
 * 自动权限模式（enter_auto_permission_mode / exit_auto_permission_mode + 主模型分类）
 * 为什么存在：参考项目的 yoloClassifier 用主模型对权限请求判 allow/deny/review，减少逐次
 * 人工打断；月蚀复用 LLM 通道（LLMClient 可独立 new、支持多请求并发）做同构替代。
 * 本测试覆盖：默认关闭、进入/退出、deny 优先、fail-closed（LLM 未配置/失败/输出乱码 →
 * 回退人工审批）、会话隔离、重复进入幂等、状态清理、执行链集成放行/拒绝/回退。
 */

const TEST_LLM_CONFIG: LLMConfig = {
  baseURL: 'https://example.com/v1',
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: null,
  streamingSpeed: 1,
  provider: 'custom'
}

function makeRegistry(): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.tools.set('enter_auto_permission_mode', new EnterAutoPermissionModeTool())
  r.tools.set('exit_auto_permission_mode', new ExitAutoPermissionModeTool())
  return r
}

/** 无副作用计数 probe（模拟任意 require-approval 工具） */
function makeProbe(name: string, behavior: ToolBehavior): { tool: AnyTool; calls: () => number } {
  let callCount = 0
  const tool: AnyTool = {
    name,
    description: `probe ${name}`,
    parameters: [{ name: 'key', type: 'string', description: '输入键' }],
    behavior,
    execute: () => {
      callCount++
      return { ok: true, data: { done: true } }
    }
  }
  return { tool, calls: () => callCount }
}

/** 内置 LLM 配置到应用配置形态 */
function withLlmConfig(config: Record<string, unknown>): Record<string, unknown> {
  return { ...config, llm: { ...TEST_LLM_CONFIG } }
}

afterEach(() => {
  resetAutoPermissionState()
  mockState.decision = 'allow'
  mockState.ready = true
})

describe('自动权限模式 × 状态管理', () => {
  it('默认关闭：未进入任何会话时均不激活', () => {
    expect(isAutoPermissionActive('s-any')).toBe(false)
  })

  it('进入/退出：状态激活与清除', async () => {
    const registry = makeRegistry()
    registry.ctx.sessionId = 's-ok'
    const entered = await executeTool(registry, 'enter_auto_permission_mode', {})
    expect(entered.ok).toBe(true)
    expect(isAutoPermissionActive('s-ok')).toBe(true)

    const exited = await executeTool(registry, 'exit_auto_permission_mode', {})
    expect(exited.ok).toBe(true)
    expect(isAutoPermissionActive('s-ok')).toBe(false)
  })

  it('重复进入幂等：仍激活且提示已在模式中', async () => {
    const registry = makeRegistry()
    registry.ctx.sessionId = 's-idem'
    await executeTool(registry, 'enter_auto_permission_mode', {})
    const again = await executeTool(registry, 'enter_auto_permission_mode', {})
    expect(again.ok).toBe(true)
    expect(String(again.data?.message)).toContain('已在自动权限模式')
    expect(isAutoPermissionActive('s-idem')).toBe(true)
  })

  it('会话隔离：仅当前会话激活，其他会话不受影响', async () => {
    const registry = makeRegistry()
    registry.ctx.sessionId = 's-a'
    await executeTool(registry, 'enter_auto_permission_mode', {})
    expect(isAutoPermissionActive('s-a')).toBe(true)
    expect(isAutoPermissionActive('s-b')).toBe(false)
  })

  it('resetAutoPermissionState 清理全部会话状态', async () => {
    const registry = makeRegistry()
    registry.ctx.sessionId = 's-reset'
    await executeTool(registry, 'enter_auto_permission_mode', {})
    expect(isAutoPermissionActive('s-reset')).toBe(true)
    resetAutoPermissionState()
    expect(isAutoPermissionActive('s-reset')).toBe(false)
  })
})

describe('自动权限模式 × parseAutoDecision', () => {
  it('明确结论只认首词：allow/deny/review', () => {
    expect(parseAutoDecision('allow')).toBe('allow')
    expect(parseAutoDecision('deny')).toBe('deny')
    expect(parseAutoDecision('review')).toBe('review')
  })

  it('大小写、标点、代码围栏清洗后仍正确', () => {
    expect(parseAutoDecision('ALLOW')).toBe('allow')
    expect(parseAutoDecision('Deny.')).toBe('deny')
    expect(parseAutoDecision('```json\nreview\n```')).toBe('review')
    expect(parseAutoDecision('allow, because safe')).toBe('allow')
  })

  it('fail-closed：非规范输出一律回退 review（绝不误判 allow）', () => {
    expect(parseAutoDecision('not allow')).toBe('review')
    expect(parseAutoDecision('maybe')).toBe('review')
    expect(parseAutoDecision('')).toBe('review')
    expect(parseAutoDecision(null)).toBe('review')
    expect(parseAutoDecision(undefined)).toBe('review')
    expect(parseAutoDecision('idk: 123 words')).toBe('review')
  })
})

describe('自动权限模式 × classifyToolCall 单元', () => {
  function fakeFactory(decision: string, opts?: { ready?: boolean; throwOnChat?: boolean }): AutoClassifierClientFactory {
    return () => ({
      isReady: () => opts?.ready ?? true,
      chatWithTools: async () => {
        if (opts?.throwOnChat) throw new Error('mock chat boom')
        return { content: decision, toolCalls: [], finishReason: 'stop' }
      }
    })
  }

  it('LLM 未配置（无 llm / 缺 baseURL / 缺 model）→ review（fail-closed）', async () => {
    expect(await classifyToolCall({}, 'RunCommand', 'desc', {})).toBe('review')
    expect(await classifyToolCall({ llm: {} }, 'RunCommand', 'desc', {})).toBe('review')
    expect(await classifyToolCall({ llm: { baseURL: 'x' } }, 'RunCommand', 'desc', {})).toBe('review')
    expect(await classifyToolCall({ llm: { model: 'm' } }, 'RunCommand', 'desc', {})).toBe('review')
  })

  it('client 未就绪 → review（不发起请求）', async () => {
    const factory = fakeFactory('allow', { ready: false })
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', {}, factory)).toBe('review')
  })

  it('client 工厂构造抛错 → review', async () => {
    const factory: AutoClassifierClientFactory = () => {
      throw new Error('construct boom')
    }
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', {}, factory)).toBe('review')
  })

  it('chatWithTools 抛错 → review（fail-closed）', async () => {
    const factory = fakeFactory('allow', { throwOnChat: true })
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', {}, factory)).toBe('review')
  })

  it('模型结论透传：allow/deny/review', async () => {
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', {}, fakeFactory('allow'))).toBe('allow')
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', {}, fakeFactory('deny'))).toBe('deny')
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', {}, fakeFactory('review'))).toBe('review')
  })

  it('超大参数不抛且正常分类（请求体内截断）', async () => {
    const bigParams = { data: 'x'.repeat(10000) }
    const factory = fakeFactory('deny')
    expect(await classifyToolCall(withLlmConfig({}), 'RunCommand', 'desc', bigParams, factory)).toBe('deny')
  })
})

describe('自动权限模式 × 执行链集成', () => {
  it('默认关闭：require-approval 工具仍走原审批（未进入模式不调用分类，即使分类器会 allow）', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-default'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'allow'

    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('requestPermission 未初始化')
    expect(probe.calls()).toBe(0)
  })

  it('模式激活 + 分类 allow：自动放行（即使无 requestPermission，不触碰授权通道）', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-allow'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'allow'

    await executeTool(registry, 'enter_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(true)
    expect(probe.calls()).toBe(1)
  })

  it('deny 优先：模式激活 + 分类 deny → 直接拒绝，不执行工具', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-deny'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'deny'

    await executeTool(registry, 'enter_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('被自动权限分类器拒绝')
    expect(probe.calls()).toBe(0)
  })

  it('fail-closed：LLM 未配置（无 llm）时分类不可用 → 回退原审批', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-nollm'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    // 不注入 llm 配置 → classifyToolCall 返回 review → 走原人工审批
    let permissionCalls = 0
    registry.ctx.requestPermission = async () => {
      permissionCalls++
      return { allowed: true, reason: 'granted' }
    }

    await executeTool(registry, 'enter_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(true)
    expect(permissionCalls).toBe(1)
  })

  it('fail-closed：分类请求失败（error）→ 回退原审批', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-err'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'error'
    let permissionCalls = 0
    registry.ctx.requestPermission = async () => {
      permissionCalls++
      return { allowed: true, reason: 'granted' }
    }

    await executeTool(registry, 'enter_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(true)
    expect(permissionCalls).toBe(1)
  })

  it('fail-closed：分类 review → 回退原审批，用户拒绝则拒绝执行', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-review'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'review'
    registry.ctx.requestPermission = async () => ({ allowed: false, reason: 'user said no' })

    await executeTool(registry, 'enter_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('用户拒绝了工具调用')
    expect(probe.calls()).toBe(0)
  })

  it('管理员 deny 覆写优先：模式激活下 deny 仍直接拒绝（不触发分类）', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-override'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'deny'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'allow' // 若分类被调用会放行，但 deny 覆写必须优先

    await executeTool(registry, 'enter_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('已被权限策略拒绝')
    expect(probe.calls()).toBe(0)
  })

  it('退出模式：恢复严格确认', async () => {
    const probe = makeProbe('RunCommand', { readOnly: false })
    const registry = makeRegistry()
    registry.tools.set(probe.tool.name, probe.tool)
    registry.ctx.sessionId = 's-exit'
    ;(registry.ctx.config as Record<string, unknown>).toolPermissionOverrides = {
      RunCommand: 'require-approval'
    }
    ;(registry.ctx.config as Record<string, unknown>).llm = { ...TEST_LLM_CONFIG }
    mockState.decision = 'allow'

    await executeTool(registry, 'enter_auto_permission_mode', {})
    await executeTool(registry, 'exit_auto_permission_mode', {})
    const r = await executeTool(registry, 'RunCommand', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('requestPermission 未初始化')
    expect(probe.calls()).toBe(0)
  })
})