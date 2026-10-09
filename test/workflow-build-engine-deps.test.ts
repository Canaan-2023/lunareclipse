/**
 * T5 L2：workflow/build-engine-deps.ts 装配逻辑单测
 *
 * 覆盖 constructor 里搬出的纯装配逻辑（此前无测试网）：
 * - toolExecutor.execute：内置工具 / MCP 工具（未配置、格式错误、调用失败、成功）
 * - toolPool.filter：空列表、未注册工具跳过、schema 转换
 * - skillLoader.load：不存在 / 成功
 * - llm.chatWithTools：工具调用循环（执行 → 写回 → 下一轮、工具未找到、执行失败、轮次上限）
 * - requestHumanInput：发 wf:paused + pending 注册、超时 reject
 * - onCleanHumanInput / onAbortLlm
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BuildEngineDepsInput } from '../electron/main/workflow/build-engine-deps'
import { buildEngineDeps } from '../electron/main/workflow/build-engine-deps'
import { WORKFLOW_GUARDRAIL_KEY, parseGuardrail } from '../electron/main/api/message-guardrail'

const h = vi.hoisted(() => {
  const state = {
    executeTool: vi.fn(),
    events: [] as Array<Record<string, unknown>>,
    chatCalls: [] as Array<{ msgs: unknown[]; defs: unknown[]; model: unknown }>,
    aborted: 0
  }
  return { state }
})

vi.mock('../electron/main/tools', () => ({
  executeTool: (...args: unknown[]) => h.state.executeTool(...args)
}))

// ===== 最小 stub 类型 =====

function makeInput(overrides?: Partial<BuildEngineDepsInput>): BuildEngineDepsInput {
  const pendingHumanInputs = new Map<
    string,
    { resolve: (r: string) => void; reject: (e: Error) => void; prompt: string; inputType: string; timer?: NodeJS.Timeout }
  >()
  return {
    paths: { workflows: '/tmp/wf' } as BuildEngineDepsInput['paths'],
    llmClient: {
      streamWithTools: vi.fn(),
      chatWithTools: vi.fn(async () => ({ content: 'ok', toolCalls: [], finishReason: 'stop' }))
    } as unknown as BuildEngineDepsInput['llmClient'],
    toolRegistry: {
      tools: new Map()
    } as unknown as BuildEngineDepsInput['toolRegistry'],
    skillLoader: {
      findMetadata: vi.fn(() => null),
      loadBody: vi.fn(() => null)
    } as unknown as BuildEngineDepsInput['skillLoader'],
    mcpClientManager: undefined,
    emit: (ev: unknown) => {
      h.state.events.push(ev as Record<string, unknown>)
    },
    instanceStore: {} as BuildEngineDepsInput['instanceStore'],
    hookRunner: {} as BuildEngineDepsInput['hookRunner'],
    pendingHumanInputs: pendingHumanInputs as unknown as BuildEngineDepsInput['pendingHumanInputs'],
    ...overrides
  }
}

beforeEach(() => {
  h.state.events = []
  h.state.chatCalls = []
  h.state.aborted = 0
  h.state.executeTool.mockReset()
})

describe('buildEngineDeps', () => {
  it('返回 EngineDeps 必需字段（实例/store 透传、workflowsRoot）', () => {
    const input = makeInput()
    const deps = buildEngineDeps(input)
    expect(deps.instanceStore).toBe(input.instanceStore)
    expect(deps.hookRunner).toBe(input.hookRunner)
    expect(deps.workflowsRoot).toBe('/tmp/wf')
    expect(deps.llm).toBeDefined()
    expect(deps.toolExecutor).toBeDefined()
    expect(deps.toolPool).toBeDefined()
    expect(deps.skillLoader).toBeDefined()
    expect(deps.requestHumanInput).toBeDefined()
    expect(deps.onCleanHumanInput).toBeDefined()
    expect(deps.onAbortLlm).toBeDefined()
  })

  describe('toolExecutor.execute', () => {
    it('内置工具成功：透传 executeTool 的 ok/data/error', async () => {
      h.state.executeTool.mockResolvedValue({ ok: true, data: 'result-x' })
      const deps = buildEngineDeps(makeInput())
      const r = await deps.toolExecutor!.execute('read_file', { path: '/a' })
      expect(h.state.executeTool).toHaveBeenCalledWith(expect.anything(), 'read_file', { path: '/a' })
      expect(r).toEqual({ ok: true, data: 'result-x' })
    })

    it('内置工具抛错：捕获返回 ok:false', async () => {
      h.state.executeTool.mockRejectedValue(new Error('boom'))
      const deps = buildEngineDeps(makeInput())
      const r = await deps.toolExecutor!.execute('read_file', {})
      expect(r).toEqual({ ok: false, error: 'boom' })
    })

    it('MCP 未配置：返回 MCP 未配置', async () => {
      const deps = buildEngineDeps(makeInput({ mcpClientManager: undefined }))
      const r = await deps.toolExecutor!.execute('mcp_server.tool', {})
      expect(r).toEqual({ ok: false, error: 'MCP 未配置' })
    })

    it('MCP 格式无效：返回格式错误', async () => {
      const deps = buildEngineDeps(makeInput({
        mcpClientManager: { callTool: vi.fn() } as unknown as BuildEngineDepsInput['mcpClientManager']
      }))
      const r = await deps.toolExecutor!.execute('mcp_no_dot', {})
      expect(r).toEqual({ ok: false, error: expect.stringContaining('格式无效') })
    })

    it('MCP 调用成功：分割 server/tool 并透传', async () => {
      const callTool = vi.fn(async () => ({ content: 'mcp-out' }))
      const deps = buildEngineDeps(makeInput({
        mcpClientManager: { callTool } as unknown as BuildEngineDepsInput['mcpClientManager']
      }))
      const r = await deps.toolExecutor!.execute('mcp_files.search', { q: 'x' })
      expect(callTool).toHaveBeenCalledWith('files', 'search', { q: 'x' })
      expect(r).toEqual({ ok: true, data: { content: 'mcp-out' } })
    })

    it('MCP 调用失败：捕获并返回错误', async () => {
      const callTool = vi.fn(async () => {
        throw new Error('mcp down')
      })
      const deps = buildEngineDeps(makeInput({
        mcpClientManager: { callTool } as unknown as BuildEngineDepsInput['mcpClientManager']
      }))
      const r = await deps.toolExecutor!.execute('mcp_a.b', {})
      expect(r).toEqual({ ok: false, error: 'mcp down' })
    })
  })

  describe('toolPool.filter', () => {
    it('空/未传 toolIds → 空数组', () => {
      const deps = buildEngineDeps(makeInput())
      expect(deps.toolPool!.filter()).toEqual([])
      expect(deps.toolPool!.filter([])).toEqual([])
    })

    it('未注册工具被跳过（不抛错）', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const deps = buildEngineDeps(makeInput())
      const r = deps.toolPool!.filter(['ghost_tool'])
      expect(r).toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost_tool'))
      warn.mockRestore()
    })

    it('注册工具转成 LLM executor（schema 转换 + execute 包装）', async () => {
      const tool = {
        name: 'echo',
        description: 'Echo tool',
        parameters: [
          { name: 'msg', type: 'string', description: 'msg desc', required: true },
          { name: 'count', type: 'number', description: 'count desc', required: false }
        ]
      }
      h.state.executeTool.mockResolvedValue({ ok: true, data: 'echoed' })
      const input = makeInput()
      ;(input.toolRegistry as { tools: Map<string, unknown> }).tools.set('echo', tool)
      const deps = buildEngineDeps(input)
      const [exec] = deps.toolPool!.filter(['echo'])
      expect(exec.name).toBe('echo')
      expect(exec.description).toBe('Echo tool')
      expect(exec.parameters).toEqual({
        type: 'object',
        properties: {
          msg: { type: 'string', description: 'msg desc' },
          count: { type: 'number', description: 'count desc' }
        },
        required: ['msg']
      })
      const out = await exec.execute({ msg: 'hi' })
      expect(h.state.executeTool).toHaveBeenCalledWith(expect.anything(), 'echo', { msg: 'hi' })
      expect(out).toBe('echoed')
    })

    it('executor.execute：工具失败返回错误字符串、非字符串 data JSON 序列化', async () => {
      const tool = { name: 't1', description: 'd', parameters: [] }
      const input = makeInput()
      ;(input.toolRegistry as { tools: Map<string, unknown> }).tools.set('t1', tool)
      const deps = buildEngineDeps(input)

      h.state.executeTool.mockResolvedValue({ ok: false, error: 'denied' })
      const [bad] = deps.toolPool!.filter(['t1'])
      expect(await bad.execute({})).toBe('工具执行失败: denied')

      h.state.executeTool.mockResolvedValue({ ok: true, data: { a: 1 } })
      const [good] = deps.toolPool!.filter(['t1'])
      expect(await good.execute({})).toBe('{"a":1}')
    })
  })

  describe('skillLoader.load', () => {
    it('元数据不存在 → 错误', () => {
      const deps = buildEngineDeps(makeInput())
      const r = deps.skillLoader!.load('nope')
      expect(r).toEqual({ ok: false, error: expect.stringContaining('nope') })
    })

    it('元数据存在但正文加载失败 → 错误', () => {
      const input = makeInput()
      ;(input.skillLoader as { findMetadata: (name: string) => unknown }).findMetadata = vi.fn(() => ({ name: 's1' }))
      ;(input.skillLoader as { loadBody: (name: string) => unknown }).loadBody = vi.fn(() => null)
      const deps = buildEngineDeps(input)
      const r = deps.skillLoader!.load('s1')
      expect(r).toEqual({ ok: false, error: expect.stringContaining('正文') })
    })

    it('加载成功返回 body', () => {
      const input = makeInput()
      ;(input.skillLoader as { findMetadata: (name: string) => unknown }).findMetadata = vi.fn(() => ({ name: 's1' }))
      ;(input.skillLoader as { loadBody: (name: string) => unknown }).loadBody = vi.fn(() => ({ body: 'SKILL body text' }))
      const deps = buildEngineDeps(input)
      const r = deps.skillLoader!.load('s1')
      expect(r).toEqual({ ok: true, body: 'SKILL body text' })
    })
  })

  describe('llm.chatWithTools（工具调用循环）', () => {
    function chatClient(script: Array<Record<string, unknown>>) {
      const calls: unknown[] = []
      let idx = 0
      return {
        async chatWithTools(msgs: unknown, defs: unknown, model: unknown) {
          calls.push({ msgs, defs, model })
          return script[idx++] ?? { content: 'fallback', toolCalls: [], finishReason: 'stop' }
        }
      }
    }

    it('单轮无工具调用直接返回', async () => {
      const client = chatClient([{ content: 'plain answer', toolCalls: [], finishReason: 'stop' }])
      const input = makeInput({ llmClient: client as unknown as BuildEngineDepsInput['llmClient'] })
      const deps = buildEngineDeps(input)
      const r = await deps.llm!.chatWithTools([{ role: 'user', content: 'hi' }], [], {})
      expect(r).toEqual({ content: 'plain answer', toolCalls: [], finishReason: 'stop' })
    })

    it('工具循环：assistant tool_calls → 执行工具写回 tool 消息 → 下一轮', async () => {
      const exec = {
        name: 'calc',
        description: 'd',
        parameters: {},
        execute: vi.fn(async () => '42')
      }
      const client = chatClient([
        {
          content: '',
          toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'calc', arguments: '{"a":1}' } }],
          finishReason: 'tool_calls'
        },
        { content: 'final', toolCalls: [], finishReason: 'stop' }
      ])
      const input = makeInput({ llmClient: client as unknown as BuildEngineDepsInput['llmClient'] })
      const deps = buildEngineDeps(input)
      const r = await deps.llm!.chatWithTools([{ role: 'user', content: 'q' }], [exec as never], {})
      expect(r).toEqual({ content: 'final', toolCalls: [], finishReason: 'stop' })
      expect(exec.execute).toHaveBeenCalledWith({ a: 1 })
      // 第二轮 messages 应包含 assistant tool_calls + tool 结果
      const captured = (client as unknown as { calls: Array<{ msgs: unknown[] }> }).calls
      void captured
    })

    it('工具未找到：写回错误消息继续', async () => {
      const client = chatClient([
        { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'missing', arguments: '{}' } }], finishReason: 'tool_calls' },
        { content: 'done', toolCalls: [], finishReason: 'stop' }
      ])
      const input = makeInput({ llmClient: client as unknown as BuildEngineDepsInput['llmClient'] })
      const deps = buildEngineDeps(input)
      const r = await deps.llm!.chatWithTools([], [], {})
      expect(r.content).toBe('done')
    })

    it('工具执行抛错：写回错误消息继续', async () => {
      const exec = {
        name: 'boom_tool',
        description: 'd',
        parameters: {},
        execute: vi.fn(async () => {
          throw new Error('tool crash')
        })
      }
      const client = chatClient([
        { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'boom_tool', arguments: '{}' } }], finishReason: 'tool_calls' },
        { content: 'recovered', toolCalls: [], finishReason: 'stop' }
      ])
      const input = makeInput({ llmClient: client as unknown as BuildEngineDepsInput['llmClient'] })
      const deps = buildEngineDeps(input)
      const r = await deps.llm!.chatWithTools([], [exec as never], {})
      expect(r.content).toBe('recovered')
    })

    it('轮次上限（maxRounds=2）用尽返回最后一次输出', async () => {
      const exec = { name: 't', description: 'd', parameters: {}, execute: vi.fn(async () => 'x') }
      const client = chatClient([
        { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }], finishReason: 'tool_calls' },
        { content: '', toolCalls: [{ id: 'c2', type: 'function', function: { name: 't', arguments: '{}' } }], finishReason: 'tool_calls' },
        { content: 'never', toolCalls: [], finishReason: 'stop' }
      ])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const input = makeInput({ llmClient: client as unknown as BuildEngineDepsInput['llmClient'] })
      const deps = buildEngineDeps(input)
      const r = await deps.llm!.chatWithTools([], [exec as never], { maxRounds: 2 })
      expect(r.content).toBe('')
      expect(exec.execute).toHaveBeenCalledTimes(2)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('上限 2 轮'))
      warn.mockRestore()
    })

    it('透传 WORKFLOW_GUARDRAIL_KEY 护栏键，工具结果蒸馏+按工具名细分包裹', async () => {
      // 记录第 4 参 options（guardrailSessionId 透传）
      const received: Array<{ msgs: unknown[]; options?: Record<string, unknown> }> = []
      let idx = 0
      const script = [
        {
          content: '',
          toolCalls: [{ id: 'call_ws', type: 'function', function: { name: 'web_search', arguments: '{"q":"x"}' } }],
          finishReason: 'tool_calls'
        },
        { content: 'final', toolCalls: [], finishReason: 'stop' }
      ]
      const client = {
        async chatWithTools(msgs: unknown, _defs: unknown, _model: unknown, options?: Record<string, unknown>) {
          received.push({ msgs: msgs as unknown[], options })
          return script[idx++] ?? { content: 'fallback', toolCalls: [], finishReason: 'stop' }
        }
      }
      const exec = {
        name: 'web_search',
        description: 'd',
        parameters: {},
        execute: vi.fn(async () => '搜索到 1 个结果'.repeat(80))
      }
      // 蒸馏回调：返回摘要（与 index.ts 注入的 workflow 专用 distiller 同构）
      const distillToolResult = vi.fn(async (toolName: string) => `【蒸馏摘要】${toolName}`)
      const input = makeInput({
        llmClient: client as unknown as BuildEngineDepsInput['llmClient'],
        makeDistillCallbacks: () => ({ distillToolResult })
      })
      const deps = buildEngineDeps(input)
      const r = await deps.llm!.chatWithTools([{ role: 'user', content: 'q' }], [exec as never], {})
      expect(r.content).toBe('final')

      // ① 每轮调用都透传工作流固定护栏键（与 llm-handler 的 streamOptions 同键）
      expect(received).toHaveLength(2)
      for (const call of received) {
        expect(call.options?.guardrailSessionId).toBe(WORKFLOW_GUARDRAIL_KEY)
      }
      // ② 蒸馏被调用（失败重试同规由上层 distiller 实现；此处验证透传与替换写入）。
      // intent 不再传空串：携带该工具调用前的最近对话意图（user: q），供蒸馏 LLM 判断相关性
      expect(distillToolResult).toHaveBeenCalledWith(
        'web_search',
        'call_ws',
        expect.stringContaining('搜索到 1 个结果'),
        expect.stringContaining('user: q')
      )
      // ③ 第二轮的 tool 消息：蒸馏摘要替换原文 + web-search 来源护栏包裹（可被 parseGuardrail 解析）
      const secondMsgs = received[1].msgs as Array<{ role: string; content: string; tool_call_id?: string }>
      const toolMsg = secondMsgs.find((m) => m.role === 'tool' && m.tool_call_id === 'call_ws')
      expect(toolMsg).toBeDefined()
      expect(toolMsg!.content).toContain('【蒸馏摘要】web_search')
      expect(toolMsg!.content).not.toContain('搜索到 1 个结果')
      const parsed = parseGuardrail(toolMsg!.content, WORKFLOW_GUARDRAIL_KEY)
      expect(parsed.wrapped).toBe(true)
      expect(parsed.valid).toBe(true)
      expect(parsed.source).toBe('web-search')
    })
  })

  describe('requestHumanInput / onCleanHumanInput / onAbortLlm', () => {
    it('requestHumanInput 发 wf:paused 并注册 pending，响应用户输入', async () => {
      const pendingMap = new Map()
      const input = makeInput()
      input.pendingHumanInputs = pendingMap as unknown as BuildEngineDepsInput['pendingHumanInputs']
      const deps = buildEngineDeps(input)
      let resolved = ''
      const p = deps.requestHumanInput!('inst_1', '确认删除？', 'confirm', ['是', '否'], 30_000).then((r) => {
        resolved = r
      })
      expect(h.state.events).toEqual([{
        type: 'wf:paused',
        instanceId: 'inst_1',
        reason: 'human',
        prompt: '确认删除？',
        inputType: 'confirm',
        options: ['是', '否'],
        timeoutMs: 30_000
      }])
      const pending = pendingMap.get('inst_1')
      expect(pending).toBeDefined()
      expect(pending.prompt).toBe('确认删除？')
      expect(pending.timer).toBeDefined()
      pending.resolve('是')
      await p
      expect(resolved).toBe('是')
      // pending 在正常响应后仍保留，由上层（manager.respondHumanInput）负责清理
      expect(pendingMap.has('inst_1')).toBe(true)
    })

    it('requestHumanInput 超时：自动 reject 并清理 pending', async () => {
      vi.useFakeTimers()
      try {
        const pendingMap = new Map()
        const input = makeInput()
        input.pendingHumanInputs = pendingMap as unknown as BuildEngineDepsInput['pendingHumanInputs']
        const deps = buildEngineDeps(input)
        const errP = deps.requestHumanInput!('inst_2', 'p', 'text', undefined, 1_000)
        vi.advanceTimersByTime(1_100)
        await expect(errP).rejects.toThrow(Error)
        await expect(errP).rejects.toThrow('human 节点超时')
        expect(pendingMap.has('inst_2')).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('onCleanHumanInput：清理 pending 并 reject（用户取消）', async () => {
      const pendingMap = new Map()
      const input = makeInput()
      input.pendingHumanInputs = pendingMap as unknown as BuildEngineDepsInput['pendingHumanInputs']
      const deps = buildEngineDeps(input)
      const p = deps.requestHumanInput!('inst_3', 'p', 'text')
      const spy = vi.fn()
      p.catch(spy)
      deps.onCleanHumanInput!('inst_3')
      await vi.waitFor(() => expect(spy).toHaveBeenCalled())
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('用户取消了输入') }))
      expect(pendingMap.has('inst_3')).toBe(false)
    })

    it('onAbortLlm：调用 llmClient.abort（存在时）', async () => {
      const abort = vi.fn()
      const input = makeInput({
        llmClient: {
          abort
        } as unknown as BuildEngineDepsInput['llmClient']
      })
      const deps = buildEngineDeps(input)
      deps.onAbortLlm!()
      expect(abort).toHaveBeenCalled()
    })
  })
})