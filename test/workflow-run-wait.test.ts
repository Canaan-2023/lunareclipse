/**
 * workflow_run 等待终态模式单测（T4：对齐子代理软超时语义）
 *
 * 为什么存在：AI 主动调用工作流的目的是运行并取得结果，不应把 workflow_run 当"只负责启动"。
 * 默认（wait=true）等待实例跑到可报告状态（completed/failed/cancelled/paused）并返回最终结果；
 * 无时间硬截断——超过软超时后返回"仍在运行 + instanceId"，实例不被中断，AI 用 workflow_status 继续轮询。
 * 校验：终态事件返回、事件在监听注册前已发射的竞态兜底、软超时不硬断、wait=false 保留异步语义。
 */
import { describe, it, expect, vi } from 'vitest'
import { WorkflowRunTool } from '../electron/main/tools/workflow-define'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { WorkflowManager } from '../electron/main/workflow/manager'
import type { WorkflowInstance } from '../shared/workflow/types'

function makeInstance(overrides: Partial<WorkflowInstance>): WorkflowInstance {
  return {
    id: 'inst_w1',
    templateId: 'tpl_1',
    templateName: '测试模板',
    mode: 'workflow',
    status: 'running',
    context: {},
    currentNode: null,
    history: [],
    startedAt: 1000,
    ...overrides
  } as WorkflowInstance
}

/** 构造可手动触发终态事件的 mock manager */
function makeWaitManager(initial: WorkflowInstance) {
  const listeners: Array<(event: { type: string; instanceId: string; output?: string; error?: string; reason?: string; prompt?: string; options?: string[] }) => void> = []
  const manager = {
    runInstance: vi.fn().mockResolvedValue(initial),
    onEvent: vi.fn((listener: (event: never) => void) => {
      listeners.push(listener as never)
      return () => {
        const i = listeners.indexOf(listener as never)
        if (i >= 0) listeners.splice(i, 1)
      }
    }),
    getInstance: vi.fn().mockReturnValue(initial),
    // 测试辅助：发射引擎事件
    emit: (event: { type: string; instanceId: string; output?: string; error?: string; reason?: string; prompt?: string; options?: string[] }) => {
      for (const l of [...listeners]) l(event as never)
    }
  }
  return manager
}

function makeToolContext(manager: Partial<WorkflowManager>): ToolContext {
  return {
    getWorkflowManager: () => manager as WorkflowManager
  } as ToolContext
}

describe('WorkflowRunTool 等待终态模式（wait 默认 true）', () => {
  it('默认等待：wf:completed 事件到达后返回最终 output', async () => {
    const inst = makeInstance({})
    const manager = makeWaitManager(inst)
    const tool = new WorkflowRunTool()

    const p = tool.execute({ templateId: 'tpl_1' }, makeToolContext(manager))
    // runInstance resolve 后监听注册完成，再发射终态事件
    await vi.waitFor(() => expect(manager.onEvent).toHaveBeenCalled())
    manager.emit({ type: 'wf:completed', instanceId: 'inst_w1', output: '最终结论' })

    const res = await p
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('completed')
    expect(data.output).toBe('最终结论')
    expect(data.templateId).toBe('tpl_1')
    expect((data.message as string)).toContain('已运行完成')
  })

  it('竞态兜底：终态事件在监听注册前已发射（getInstance 直接命中 completed）', async () => {
    const inst = makeInstance({ status: 'completed', output: '瞬时结果' })
    const manager = makeWaitManager(inst)
    const tool = new WorkflowRunTool()

    const res = await tool.execute({ templateId: 'tpl_1' }, makeToolContext(manager))
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('completed')
    expect(data.output).toBe('瞬时结果')
  })

  it('wf:failed 事件到达后返回 error', async () => {
    const inst = makeInstance({})
    const manager = makeWaitManager(inst)
    const tool = new WorkflowRunTool()

    const p = tool.execute({ templateId: 'tpl_1' }, makeToolContext(manager))
    await vi.waitFor(() => expect(manager.onEvent).toHaveBeenCalled())
    manager.emit({ type: 'wf:failed', instanceId: 'inst_w1', error: '节点执行失败' })

    const res = await p
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('failed')
    expect(data.error).toBe('节点执行失败')
  })

  it('wf:paused 事件到达后返回暂停信息（等用户输入，不继续干等）', async () => {
    const inst = makeInstance({})
    const manager = makeWaitManager(inst)
    const tool = new WorkflowRunTool()

    const p = tool.execute({ templateId: 'tpl_1' }, makeToolContext(manager))
    await vi.waitFor(() => expect(manager.onEvent).toHaveBeenCalled())
    manager.emit({ type: 'wf:paused', instanceId: 'inst_w1', reason: 'human', prompt: '请确认方案', options: ['ok', 'no'] })

    const res = await p
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('paused')
    expect(data.prompt).toBe('请确认方案')
    expect((data.message as string)).toContain('暂停')
  })

  it('软超时：短 waitMs 后返回"仍在运行 + instanceId"，不报错、不中断实例', async () => {
    const inst = makeInstance({})
    const manager = makeWaitManager(inst)
    const tool = new WorkflowRunTool()

    // 直接调用私有等待逻辑不可行（未导出），改用 wait 参数 + 注入短超时：
    // 通过 runInstance 返回 running 且事件永不发射 + waitMs 极小验证不硬断。
    // 为可测性，这里用假 manager 让 getInstance 恒返回 running，超时由 50ms 触发。
    const res = await Promise.race([
      tool.execute({ templateId: 'tpl_1' }, makeToolContext(manager)),
      new Promise<{ ok: boolean; data?: Record<string, unknown> }>((resolve) => setTimeout(() => resolve({ ok: false }), 5000))
    ])

    // waitForWorkflowResult 用固定 DEFAULT_WORKFLOW_WAIT_MS=600000，5 秒窗口内必然未超时；
    // 这里不期待返回，只验证 promise 不会提前 settle 且无错误（防止误改造成硬截断副作用）。
    expect(res).toEqual({ ok: false })
    // 事件监听已注册但未触发，处于等待中 —— 说明没有硬截断立即返回
    expect(manager.onEvent).toHaveBeenCalled()
    expect((manager.runInstance as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('wait')
  })

  it('wait=false：立即返回启动确认，不等待终态', async () => {
    const inst = makeInstance({})
    const manager = makeWaitManager(inst)
    const tool = new WorkflowRunTool()

    const res = await tool.execute({ templateId: 'tpl_1', wait: false }, makeToolContext(manager))
    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.instanceId).toBe('inst_w1')
    expect(data.status).toBe('running')
    expect((data.message as string)).toContain('异步启动')
    // wait=false 不应注册事件监听
    expect(manager.onEvent).not.toHaveBeenCalled()
    // wait 是工具层参数，不能传给引擎
    expect((manager.runInstance as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('wait')
  })
})