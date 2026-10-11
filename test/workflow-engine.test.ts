/**
 * T5 L2：workflow/engine.ts 引擎单测

 * 用 mock 替身隔离四个边界依赖（持久化 / 节点处理器 / HOOK 执行 / detail 存储），
 * 保留真实的 template-var 解析与模板校验逻辑，覆盖 engine 的调度行为：
 * - DAG 线性执行 / 隐式完成 / condition 分支
 * - human 节点（requestHumanInput 挂起-恢复 / 用户取消 → cancelled）
 * - answer 节点（chatflow 暂停-恢复 / on_user_message HOOK）
 * - 节点失败（on_fail）/ HOOK（before_node block / after_node / on_complete 顺序）
 * - cancel / pause / updateContext / M1 迭代保护 / validateTemplate 全分支
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type { WorkflowTemplate, WorkflowEngineEvent, NodeHandlerContext } from '../shared/workflow/types'

// ===== mock 边界依赖（vi.hoisted 容器共享状态） =====

const h = vi.hoisted(() => {
  type AnyInstance = {
    id: string
    status: string
    context: Record<string, unknown>
    currentNode: string | null
    history: Array<{ nodeId: string; status: string; output?: string; error?: string }>
    messages?: Array<{ role: string; content: string }>
    pauseReason?: string
    completedAt?: number
    error?: string
  }
  const state = {
    idCounter: 0,
    instances: new Map<string, AnyInstance>(),
    archived: new Map<string, AnyInstance>(),
    saveCalls: [] as AnyInstance[],
    archiveCalls: [] as AnyInstance[],
    events: [] as WorkflowEngineEvent[],
    handlerCalls: [] as Array<{ type: string; nodeId: string }>,
    // nodeId → 可编程行为
    behaviors: new Map<string, (ctx: NodeHandlerContext) => Promise<{ output: string }>>(),
    hookCalls: [] as Array<{ event: string; ctx: Record<string, unknown> }>,
    hookRunImpl: undefined as
      | undefined
      | ((hooks: unknown, event: string, ctx: Record<string, unknown>) => Promise<{ action: string; message?: string }>),
    llmAbortCount: 0,
    humanCleaned: [] as string[],
    humanRequests: [] as Array<{
      instanceId: string
      prompt: string
      inputType: string
      options?: string[]
      timeoutMs?: number
    }>,
    humanControl: null as null | { resolve: (r: string) => void; reject: (e: Error) => void }
  }
  return { state }
})

vi.mock('../electron/main/workflow/persister', () => ({
  generateId: (prefix: string) => `${prefix}-t${h.state.idCounter++}`,
  WorkflowInstanceStore: class {
    save = (inst: unknown) => {
      const c = structuredClone(inst)
      h.state.instances.set((c as { id: string }).id, c)
      h.state.saveCalls.push(c)
    }
    load = (id: string) => {
      const i = h.state.instances.get(id)
      if (i) return structuredClone(i)
      const a = h.state.archived.get(id)
      return a ? structuredClone(a) : null
    }
    archive = (inst: unknown) => {
      const c = structuredClone(inst)
      const id = (c as { id: string }).id
      h.state.instances.delete(id)
      h.state.archived.set(id, c)
      h.state.archiveCalls.push(c)
    }
    delete = (id: string) => h.state.instances.delete(id)
  }
}))

vi.mock('../electron/main/workflow/handlers', () => ({
  getNodeHandler: (type: string) => ({
    handle: async (ctx: NodeHandlerContext) => {
      h.state.handlerCalls.push({ type, nodeId: ctx.node.id })
      const behavior = h.state.behaviors.get(ctx.node.id)
      if (behavior) return behavior(ctx)
      return { output: `out-${ctx.node.id}` }
    }
  })
}))

vi.mock('../electron/main/workflow/hook-runner', () => ({
  WorkflowHookRunner: class {
    async run(hooks: unknown, event: string, ctx: Record<string, unknown>) {
      h.state.hookCalls.push({ event, ctx })
      if (h.state.hookRunImpl) return h.state.hookRunImpl(hooks, event, ctx)
      return { action: 'continue' }
    }
  }
}))

// ===== 测试辅助 =====

import { WorkflowEngine, type EngineDeps } from '../electron/main/workflow/engine'
import { WorkflowInstanceStore } from '../electron/main/workflow/persister'
import { WorkflowHookRunner } from '../electron/main/workflow/hook-runner'

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: 'tpl-1',
    name: '测试模板',
    description: '',
    mode: 'workflow',
    nodes: [
      { id: 'start', type: 'llm', name: '起点', config: { prompt: 'hi' } },
      { id: 'end', type: 'end', name: '终点', config: { output: 'done' } }
    ],
    edges: [{ from: 'start', to: 'end' }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeDeps(overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    instanceStore: new (WorkflowInstanceStore as unknown as new () => EngineDeps['instanceStore'])(),
    hookRunner: new (WorkflowHookRunner as unknown as new () => EngineDeps['hookRunner'])(),
    emit: (e: WorkflowEngineEvent) => h.state.events.push(e),
    ...overrides
  }
}

/** 自旋等待条件成立（runLoop 是异步 void，需轮询最终状态） */
async function waitFor(cond: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    // 报错带上实际预算：超时失败时必须能一眼看出「生效的超时值是多少」——
    // 否则调用方误传的参数被静默丢弃时，报错只显示条件名，根因藏在下游无从追查
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor 超时: ${label}（预算 ${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function getStored(id: string) {
  return h.state.instances.get(id) ?? h.state.archived.get(id)
}
/**
 * 等待实例收敛到指定状态。
 * 为什么存在：多数用例的等待目标都是「状态收敛」，集中一处可避免超时值散落成各自的魔法数。
 * 作用：按 id 取实例比对 status；timeoutMs 可覆盖默认值——runLoop 是 fire-and-forget 的
 *   无限异步链，长链路用例（如 M1 迭代保护需跑满 101 次循环）必须能放宽上界。
 * 不删理由：删掉则每个用例都要重复展开 waitFor 的条件与标签。
 * 注意：调用方传第 3 个参数前必须确认本函数有形参——0.30 前此处只声明两个形参，
 *   M1 用例传的 10000 被 JS 静默丢弃（静默失效、无任何报错），实际仍是 5000ms，
 *   在 CPU 被并发任务抢占时即超时失败。新增形参即修复该类静默失效。
 */
function waitForStatus(id: string, status: string, timeoutMs = 5000): Promise<void> {
  return waitFor(() => getStored(id)?.status === status, timeoutMs, `status=${status}`)
}
function eventsOfType(type: WorkflowEngineEvent['type']): WorkflowEngineEvent[] {
  return h.state.events.filter((e) => e.type === type)
}

beforeEach(() => {
  h.state.idCounter = 0
  h.state.instances.clear()
  h.state.archived.clear()
  h.state.saveCalls = []
  h.state.archiveCalls = []
  h.state.events = []
  h.state.handlerCalls = []
  h.state.behaviors.clear()
  h.state.hookCalls = []
  h.state.hookRunImpl = undefined
  h.state.llmAbortCount = 0
  h.state.humanCleaned = []
  h.state.humanRequests = []
  h.state.humanControl = null
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkflowEngine · startInstance 与模板校验', () => {
  it('校验失败：非法 mode', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({ mode: 'bogus' as never })
    await expect(engine.startInstance(tpl)).rejects.toThrow('mode 非法')
  })

  it('校验失败：nodes 为空数组', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({ nodes: [] })
    await expect(engine.startInstance(tpl)).rejects.toThrow('nodes 必须为非空数组')
  })

  it('校验失败：name 为空字符串', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({ name: '   ' })
    await expect(engine.startInstance(tpl)).rejects.toThrow('name 必须为非空字符串')
  })

  it('校验失败：节点 ID 重复', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({
      nodes: [
        { id: 'a', type: 'llm', name: 'A', config: { prompt: 'x' } },
        { id: 'a', type: 'llm', name: 'A2', config: { prompt: 'y' } }
      ],
      edges: []
    })
    await expect(engine.startInstance(tpl)).rejects.toThrow('节点 ID 重复')
  })

  it('校验失败：edge 引用不存在的节点', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({ edges: [{ from: 'start', to: 'ghost' }] })
    await expect(engine.startInstance(tpl)).rejects.toThrow('连线终点不存在')
  })

  it('校验失败：chatflow 模式出现 end 节点', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({
      mode: 'chatflow',
      nodes: [
        { id: 'start', type: 'llm', name: '起点', config: { prompt: 'hi' } },
        { id: 'end', type: 'end', name: '终点', config: { output: 'x' } }
      ]
    })
    await expect(engine.startInstance(tpl)).rejects.toThrow('Chatflow 模式不应有 end 节点')
  })

  it('校验失败：workflow 模式出现 answer 节点', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({
      mode: 'workflow',
      nodes: [
        { id: 'start', type: 'llm', name: '起点', config: { prompt: 'hi' } },
        { id: 'ans', type: 'answer', name: '答', config: { content: 'hi' } }
      ],
      edges: [{ from: 'start', to: 'ans' }]
    })
    await expect(engine.startInstance(tpl)).rejects.toThrow('Workflow 模式不应有 answer 节点')
  })

  it('校验失败：无起始节点（所有节点都有入边成环）', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({
      nodes: [
        { id: 'a', type: 'llm', name: 'A', config: { prompt: 'x' } },
        { id: 'b', type: 'llm', name: 'B', config: { prompt: 'y' } }
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' }
      ]
    })
    await expect(engine.startInstance(tpl)).rejects.toThrow('无起始节点')
  })

  it('校验失败：startNode 指定但不存在 → 用无入边节点兜底', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({ startNode: 'ghost' })
    const instance = await engine.startInstance(tpl)
    expect(instance.currentNode).toBe('start')
  })
})

describe('WorkflowEngine · DAG 线性执行与完成', () => {
  it('线性执行 llm → end：节点顺序、context 写入、history 状态、归档', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate()
    const instance = await engine.startInstance(tpl)
    await waitForStatus(instance.id, 'completed')

    // 执行顺序
    expect(h.state.handlerCalls.map((c) => c.nodeId)).toEqual(['start', 'end'])
    // context 写入节点输出
    const stored = getStored(instance.id)!
    expect(stored.context['start']).toBe('out-start')
    expect(stored.context['end']).toBe('out-end')
    expect(stored.output).toBe('out-end')
    expect(stored.currentNode).toBeNull()
    // history 顺序与状态
    expect(stored.history.map((x: { nodeId: string; status: string }) => [x.nodeId, x.status])).toEqual([
      ['start', 'done'],
      ['end', 'done']
    ])
    // 事件
    expect(eventsOfType('wf:started').length).toBe(1)
    expect(eventsOfType('wf:node_start').length).toBe(2)
    expect(eventsOfType('wf:node_done').length).toBe(2)
    // end 节点路径不发 wf:completed（只有隐式完成才发）
    expect(eventsOfType('wf:completed').length).toBe(0)
    // 归档
    expect(h.state.instances.has(instance.id)).toBe(false)
    expect(h.state.archived.has(instance.id)).toBe(true)
  })

  it('隐式完成：无出边节点 → emit wf:completed + on_complete HOOK', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({ edges: [] }) // start 无出边
    const instance = await engine.startInstance(tpl)
    await waitForStatus(instance.id, 'completed')

    expect(eventsOfType('wf:completed').length).toBe(1)
    expect(h.state.hookCalls.some((c) => c.event === 'on_complete')).toBe(true)
  })

  it('上下文传递：condition 分支按 evaluateCondition 走满足的边', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({
      nodes: [
        { id: 'start', type: 'llm', name: '起点', config: { prompt: 'hi' } },
        { id: 'cond', type: 'condition', name: '分叉', config: {} },
        { id: 'good', type: 'llm', name: '合格', config: { prompt: 'g' } },
        { id: 'nok', type: 'llm', name: '不合格', config: { prompt: 'n' } },
        { id: 'end', type: 'end', name: '终点', config: { output: 'x' } }
      ],
      edges: [
        { from: 'start', to: 'cond' },
        { from: 'cond', to: 'good', condition: "context.input.qualify == 'yes'" },
        { from: 'cond', to: 'nok', condition: 'default' },
        { from: 'good', to: 'end' },
        { from: 'nok', to: 'end' }
      ]
    })
    // 走满足条件的边
    const okInst = await engine.startInstance(tpl, { qualify: 'yes' })
    await waitForStatus(okInst.id, 'completed')
    expect(h.state.handlerCalls.map((c) => c.nodeId)).toEqual(['start', 'cond', 'good', 'end'])

    // 全部不满足 → 走 default 边
    h.state.handlerCalls = []
    const nokInst = await engine.startInstance(tpl, { qualify: 'no' })
    await waitForStatus(nokInst.id, 'completed')
    expect(h.state.handlerCalls.map((c) => c.nodeId)).toEqual(['start', 'cond', 'nok', 'end'])
  })

  it('condition 分支：无条件满足且无 default → 隐式完成', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const tpl = makeTemplate({
      nodes: [
        { id: 'start', type: 'llm', name: '起点', config: { prompt: 'hi' } },
        { id: 'cond', type: 'condition', name: '分叉', config: {} },
        { id: 'good', type: 'llm', name: '合格', config: { prompt: 'g' } }
      ],
      edges: [
        { from: 'start', to: 'cond' },
        { from: 'cond', to: 'good', condition: "context.input.qualify == 'yes'" }
      ]
    })
    const instance = await engine.startInstance(tpl, { qualify: 'no' })
    await waitForStatus(instance.id, 'completed')
    expect(eventsOfType('wf:completed').length).toBe(1)
    // 未走 good
    expect(h.state.handlerCalls.map((c) => c.nodeId)).toEqual(['start', 'cond'])
  })
})

describe('WorkflowEngine · human 节点', () => {
  function humanTemplate(): WorkflowTemplate {
    return makeTemplate({
      nodes: [
        { id: 'start', type: 'llm', name: '起点', config: { prompt: 'hi' } },
        { id: 'ask', type: 'human', name: '确认', config: { prompt: '继续吗？', inputType: 'confirm' } },
        { id: 'end', type: 'end', name: '终点', config: { output: 'x' } }
      ],
      edges: [
        { from: 'start', to: 'ask' },
        { from: 'ask', to: 'end' }
      ]
    })
  }

  it('human 节点：挂起等待用户输入，resolve 后继续执行', async () => {
    const engine = new WorkflowEngine(
      makeDeps({
        requestHumanInput: (instanceId, prompt, inputType, options, timeoutMs) => {
          h.state.humanRequests.push({ instanceId, prompt, inputType, options, timeoutMs })
          return new Promise((resolve, reject) => {
            h.state.humanControl = { resolve, reject }
          })
        }
      })
    )
    h.state.behaviors.set('ask', async (ctx) => {
      await ctx.requestHumanInput!(ctx.node.config.prompt, (ctx.node.config as { inputType: string }).inputType)
      return { output: 'user-said-yes' }
    })
    const instance = await engine.startInstance(humanTemplate())
    // 挂起在 human 请求点
    await waitFor(() => h.state.humanRequests.length === 1, 3000, 'humanRequests')
    expect(h.state.humanRequests[0]).toMatchObject({
      instanceId: instance.id,
      prompt: '继续吗？',
      inputType: 'confirm'
    })
    // 用户响应
    h.state.humanControl!.resolve('yes')
    await waitForStatus(instance.id, 'completed')
    const stored = getStored(instance.id)!
    expect(stored.context['ask']).toBe('user-said-yes')
    expect(h.state.handlerCalls.map((c) => c.nodeId)).toEqual(['start', 'ask', 'end'])
  })

  it('human 节点：用户取消输入 → 实例标记 cancelled（非 failed），归档', async () => {
    const engine = new WorkflowEngine(
      makeDeps({
        requestHumanInput: () =>
          new Promise((_resolve, reject) => {
            h.state.humanControl = { resolve: _resolve, reject }
          })
      })
    )
    h.state.behaviors.set('ask', async (ctx) => {
      await ctx.requestHumanInput!(ctx.node.config.prompt, 'confirm')
      return { output: 'x' }
    })
    const instance = await engine.startInstance(humanTemplate())
    await waitFor(() => h.state.humanControl !== null, 3000, 'humanControl')
    h.state.humanControl!.reject(new Error('用户取消了输入'))
    await waitForStatus(instance.id, 'cancelled')
    expect(eventsOfType('wf:cancelled').length).toBe(1)
    expect(eventsOfType('wf:failed').length).toBe(0)
    expect(h.state.archived.has(instance.id)).toBe(true)
  })
})

describe('WorkflowEngine · answer 节点（chatflow）', () => {
  function chatflowTemplate(withBackEdge: boolean): WorkflowTemplate {
    return makeTemplate({
      mode: 'chatflow',
      nodes: [
        { id: 'start', type: 'llm', name: '对话', config: { prompt: 'hi' } },
        { id: 'ans', type: 'answer', name: '回复', config: { content: 'hi' } }
      ],
      edges: withBackEdge ? [{ from: 'start', to: 'ans' }, { from: 'ans', to: 'start' }] : [{ from: 'start', to: 'ans' }],
      startNode: 'start'
    })
  }

  it('answer 节点：暂停 await_user，assistant 消息入 messages', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const instance = await engine.startInstance(chatflowTemplate(false))
    await waitFor(() => getStored(instance.id)?.status === 'paused', 3000, 'paused')

    const stored = getStored(instance.id)!
    expect(stored.pauseReason).toBe('await_user')
    expect(stored.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'out-ans' })
    ])
    expect(eventsOfType('wf:resumed').length).toBe(0)
  })

  it('resumeInstance：追加用户消息、触发 on_user_message、走回边继续对话', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const instance = await engine.startInstance(chatflowTemplate(true))
    await waitFor(() => getStored(instance.id)?.status === 'paused', 3000, 'paused')

    await engine.resumeInstance(instance.id, chatflowTemplate(true), '你好呀')
    // 恢复后 start → ans 再次暂停（第二轮对话完成），messages = 1 条 assistant + 1 条 user + 1 条 assistant
    await waitFor(() => {
      const stored = getStored(instance.id)!
      return stored.status === 'paused' && stored.messages!.length === 3
    }, 3000, 'second round')

    const stored = getStored(instance.id)!
    expect(stored.messages!.map((m) => `${m.role}:${m.content}`)).toEqual([
      'assistant:out-ans',
      'user:你好呀',
      'assistant:out-ans'
    ])
    expect(stored.context['user_message']).toBe('你好呀')
    // on_user_message HOOK 已触发
    expect(h.state.hookCalls.some((c) => c.event === 'on_user_message')).toBe(true)
    expect(eventsOfType('wf:resumed').length).toBe(1)
  })

  it('resumeInstance：answer 无出边 → 保持 paused 等待（消息不丢）', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const instance = await engine.startInstance(chatflowTemplate(false))
    await waitFor(() => getStored(instance.id)?.status === 'paused', 3000, 'paused')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await engine.resumeInstance(instance.id, chatflowTemplate(false), '第二条')
    const stored = getStored(instance.id)!
    expect(stored.status).toBe('paused')
    expect(stored.messages!.map((m) => m.content)).toEqual(['out-ans', '第二条'])
    expect(warnSpy).toHaveBeenCalled()
  })

  it('resumeInstance：实例不存在 → throw', async () => {
    const engine = new WorkflowEngine(makeDeps())
    await expect(engine.resumeInstance('nope', chatflowTemplate(false))).rejects.toThrow('不存在')
  })

  it('resumeInstance：非 paused 状态 → throw', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const instance = await engine.startInstance(makeTemplate()) // workflow 模式直接 completed
    await waitForStatus(instance.id, 'completed')
    await expect(engine.resumeInstance(instance.id, makeTemplate())).rejects.toThrow('无法恢复')
  })
})

describe('WorkflowEngine · 节点失败与 HOOK', () => {
  it('节点失败：node_failed 事件 + on_fail HOOK + 实例 failed + 归档', async () => {
    const engine = new WorkflowEngine(makeDeps())
    h.state.behaviors.set('start', async () => {
      throw new Error('boom')
    })
    const instance = await engine.startInstance(makeTemplate())
    await waitForStatus(instance.id, 'failed')

    const stored = getStored(instance.id)!
    expect(stored.error).toBe('boom')
    expect(eventsOfType('wf:node_failed').length).toBe(1)
    expect(eventsOfType('wf:failed').length).toBe(1)
    // on_fail HOOK 带 error
    const failHook = h.state.hookCalls.find((c) => c.event === 'on_fail')
    expect(failHook).toBeDefined()
    expect(failHook!.ctx.error).toBe('boom')
    expect(h.state.archived.has(instance.id)).toBe(true)
  })

  it('HOOK 顺序：before_node → after_node → … → on_complete', async () => {
    const engine = new WorkflowEngine(
      makeDeps({
        hookRunner: new (WorkflowHookRunner as unknown as new () => EngineDeps['hookRunner'])()
      })
    )
    const tpl = makeTemplate({ hooks: [] })
    tpl.hooks = [
      { event: 'before_node', action: { type: 'javascript', code: '() => ({action:"continue"})' } },
      { event: 'after_node', action: { type: 'javascript', code: '() => ({action:"continue"})' } },
      { event: 'on_complete', action: { type: 'javascript', code: '() => ({action:"continue"})' } }
    ]
    await engine.startInstance(tpl).then((instance) => waitForStatus(instance.id, 'completed'))

    const events = h.state.hookCalls.map((c) => c.event)
    expect(events).toEqual([
      'before_node',
      'after_node',
      'before_node',
      'after_node',
      'on_complete'
    ])
  })

  it('before_node HOOK block：跳过当前节点（skipped）而非失败', async () => {
    const engine = new WorkflowEngine(
      makeDeps({
        hookRunner: new (WorkflowHookRunner as unknown as new () => EngineDeps['hookRunner'])()
      })
    )
    h.state.hookRunImpl = async (_hooks, event, ctx) => {
      // 仅 block start 节点，end 节点放行（验证 block 是跳过而非终止工作流）
      if (event === 'before_node' && ctx.nodeId === 'start') return { action: 'block', message: 'not now' }
      return { action: 'continue' }
    }
    const instance = await engine.startInstance(makeTemplate())
    await waitForStatus(instance.id, 'completed')

    // start 被跳过：handler 未执行，但 end 正常执行
    expect(h.state.handlerCalls.map((c) => c.nodeId)).toEqual(['end'])
    const stored = getStored(instance.id)!
    expect(stored.history[0]).toMatchObject({ nodeId: 'start', status: 'skipped' })
    expect(stored.context['start']).toBeUndefined()
  })

  })

describe('WorkflowEngine · cancel / pause / updateContext / getInstance', () => {
  it('cancelInstance：触发取消、清理 human 输入、abort LLM、归档、防重复取消', async () => {
    const clean = vi.fn()
    const abort = vi.fn()
    const engine = new WorkflowEngine(makeDeps({ onCleanHumanInput: clean, onAbortLlm: abort }))
    // 让 start 节点挂起（模拟执行中取消）
    h.state.behaviors.set('start', () => new Promise(() => {}))
    const instance = await engine.startInstance(makeTemplate())
    await waitFor(() => h.state.handlerCalls.length === 1, 3000, 'start running')

    const cancelled = engine.cancelInstance(instance.id)
    expect(cancelled!.status).toBe('cancelled')
    expect(clean).toHaveBeenCalledWith(instance.id)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(eventsOfType('wf:cancelled').length).toBe(1)
    expect(h.state.archived.has(instance.id)).toBe(true)

    // 重复取消：防御直接返回，不再发事件
    const before = h.state.events.length
    engine.cancelInstance(instance.id)
    expect(h.state.events.length).toBe(before)
  })

  it('cancelInstance：实例不存在 → null', () => {
    const engine = new WorkflowEngine(makeDeps())
    expect(engine.cancelInstance('nope')).toBeNull()
  })

  it('pauseInstance：运行中实例 → paused（manual），runLoop 节点边界优雅暂停', async () => {
    const engine = new WorkflowEngine(makeDeps())
    h.state.behaviors.set('start', async () => {
      await new Promise((r) => setTimeout(r, 30))
      return { output: 'slow' }
    })
    const instance = await engine.startInstance(makeTemplate())
    await waitFor(() => h.state.handlerCalls.length === 1, 3000, 'start running')
    engine.pauseInstance(instance.id)
    // runLoop 在 start 完成后发现 pausing，优雅暂停
    await waitForStatus(instance.id, 'paused')
    expect(eventsOfType('wf:paused').length).toBe(1)
  })

  it('pauseInstance：非 running 实例直接返回原对象', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const instance = await engine.startInstance(makeTemplate())
    await waitForStatus(instance.id, 'completed')
    const paused = engine.pauseInstance(instance.id)
    expect(paused!.status).toBe('completed') // 不改状态
  })

  it('updateContext：running/paused 可更新；终态不可更新', async () => {
    const engine = new WorkflowEngine(makeDeps())
    h.state.behaviors.set('start', () => new Promise(() => {})) // 挂起保持 running
    const instance = await engine.startInstance(makeTemplate())
    await waitFor(() => h.state.handlerCalls.length === 1, 3000, 'start running')

    const updated = engine.updateContext(instance.id, { extra: 42 })
    expect(updated!.context['extra']).toBe(42)

    // 终态（completed）不可更新
    h.state.behaviors.delete('start')
    const engine2 = new WorkflowEngine(makeDeps())
    const done = await engine2.startInstance(makeTemplate())
    await waitForStatus(done.id, 'completed')
    const noop = engine2.updateContext(done.id, { extra: 1 })
    expect(noop!.context['extra']).toBeUndefined()
  })

  it('getInstance：存在返回实例，不存在返回 null', async () => {
    const engine = new WorkflowEngine(makeDeps())
    const instance = await engine.startInstance(makeTemplate())
    expect(engine.getInstance(instance.id)).not.toBeNull()
    expect(engine.getInstance('nope')).toBeNull()
  })
})

describe('WorkflowEngine · M1 迭代保护', () => {
  /**
   * 为什么这样等待：runLoop 是 fire-and-forget 的 101 次循环链，用例自身只需毫秒级 CPU
   *   （实测隔离运行 16ms）；但「墙钟预算 + 5ms 轮询」在机器被并发任务压满时，预算会被
   *   调度空档吃光——实证：健康检查里本文件与 16 个 vitest worker、真实 tsc 子进程同跑，
   *   5000ms 与 10000ms 两档预算都超时，报错文本完全相同（都是「等不到 status=failed」）。
   * 作用：改为直接等引擎自己的终态事件（wf:failed / wf:completed）——微任务级完成信号，
   *   不依赖任何计时器被唤醒；上界交给用例自身的 timeout。
   * 不删理由：这是本用例唯一的完成判定；退回「预算 + 轮询」即回到「能否通过取决于机器闲忙」。
   * 为什么上界放宽到 30s：全局 testTimeout（10s）与等待预算都按墙钟计，两者相等时谁先触发
   *   是竞态，用例永远无法先自证；30s 留给饱和环境，真挂死仍会被 vitest 明确报成 Test timed out。
   */
  it('条件循环无出口 → 超过最大迭代次数 → failed', { timeout: 30_000 }, async () => {
    // 用持有器对象承接 resolver：resolver 只能在 Promise 构造器内拿到，
    //   而 let + 嵌套作用域单次赋值会触发 prefer-const（语法上会变，读起来却像常量）
    const terminalSignal: { fire?: () => void } = {}
    const terminal = new Promise<void>((resolve) => {
      terminalSignal.fire = resolve
    })
    const engine = new WorkflowEngine(
      makeDeps({
        // 引擎在失败分支里「先落盘 status/error、再 emit wf:failed」，事件到达即状态可读
        emit: (e) => {
          h.state.events.push(e)
          if (e.type === 'wf:failed' || e.type === 'wf:completed') terminalSignal.fire?.()
        }
      })
    )
    // start → cond → work → cond → work …（cond/work 成环，通过起始校验的循环）
    const tpl = makeTemplate({
      nodes: [
        { id: 'start', type: 'llm', name: '起点', config: { prompt: 'x' } },
        { id: 'cond', type: 'condition', name: '分叉', config: {} },
        { id: 'work', type: 'llm', name: '循环体', config: { prompt: 'y' } }
      ],
      edges: [
        { from: 'start', to: 'cond' },
        { from: 'cond', to: 'work' },
        { from: 'work', to: 'cond' }
      ],
      startNode: 'start'
    })
    const instance = await engine.startInstance(tpl)
    await terminal
    const stored = getStored(instance.id)!
    // 先定性终态本身：若哪天真退化成「隐式完成」，这里会直接指出，而不是含糊地等超时
    expect(stored.status).toBe('failed')
    expect(stored.error).toContain('最大迭代次数')
    // 循环次数被上限约束（nodes=3 → max=100）
    expect(h.state.handlerCalls.length).toBe(100)
  })
})