/**
 * workflow_status 工具单测
 *
 * 为什么存在：workflow_run 是异步启动（立即返回 instanceId，不等待完成），
 * 此前 AI 工具侧没有"查询实例状态/获取最终输出"的能力，会话中启动工作流后拿不到结果。
 * workflow_status 补齐这一环：查询实例状态、当前节点、最终输出、失败原因与节点历史。
 * 校验：正常查询（running/completed/paused/failed/cancelled）、实例不存在、参数缺失。
 */
import { describe, it, expect, vi } from 'vitest'
import { WorkflowStatusTool } from '../electron/main/tools/workflow-define'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { WorkflowManager } from '../electron/main/workflow/manager'
import type { WorkflowInstance } from '../shared/workflow/types'

function makeInstance(overrides: Partial<WorkflowInstance>): WorkflowInstance {
  return {
    id: 'inst_1',
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

function makeToolContext(manager: Partial<WorkflowManager>): ToolContext {
  return {
    getWorkflowManager: () => manager as WorkflowManager
  } as ToolContext
}

describe('WorkflowStatusTool', () => {
  it('查询 running 实例：返回状态、当前节点与开始时间', async () => {
    const getInstance = vi.fn().mockReturnValue(
      makeInstance({ status: 'running', currentNode: 'llm_1' })
    )
    const tool = new WorkflowStatusTool()
    const res = await tool.execute({ instanceId: 'inst_1' }, makeToolContext({ getInstance }))

    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('running')
    expect(data.instanceId).toBe('inst_1')
    expect(data.templateId).toBe('tpl_1')
    expect(data.currentNode).toBe('llm_1')
    expect(data.history).toEqual([])
    expect(getInstance).toHaveBeenCalledWith('inst_1')
  })

  it('查询 completed 实例：返回最终 output 与节点历史', async () => {
    const getInstance = vi.fn().mockReturnValue(
      makeInstance({
        status: 'completed',
        output: '最终结论',
        completedAt: 2000,
        history: [
          { nodeId: 'n1', nodeName: '研究', nodeType: 'llm', status: 'done', startedAt: 1000, endedAt: 1500, output: '中间结果' }
        ]
      })
    )
    const tool = new WorkflowStatusTool()
    const res = await tool.execute({ instanceId: 'inst_1' }, makeToolContext({ getInstance }))

    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('completed')
    expect(data.output).toBe('最终结论')
    expect(Array.isArray(data.history)).toBe(true)
    expect((data.history as Array<Record<string, unknown>>)[0].nodeId).toBe('n1')
  })

  it('查询 failed 实例：返回 error', async () => {
    const getInstance = vi.fn().mockReturnValue(
      makeInstance({ status: 'failed', error: '模型调用超时' })
    )
    const tool = new WorkflowStatusTool()
    const res = await tool.execute({ instanceId: 'inst_1' }, makeToolContext({ getInstance }))

    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('failed')
    expect(data.error).toBe('模型调用超时')
  })

  it('查询 paused 实例：返回 pauseReason（human 节点等用户输入）', async () => {
    const getInstance = vi.fn().mockReturnValue(
      makeInstance({ status: 'paused', currentNode: 'human_1', pauseReason: 'human' })
    )
    const tool = new WorkflowStatusTool()
    const res = await tool.execute({ instanceId: 'inst_1' }, makeToolContext({ getInstance }))

    expect(res.ok).toBe(true)
    const data = res.data as Record<string, unknown>
    expect(data.status).toBe('paused')
    expect(data.pauseReason).toBe('human')
  })

  it('实例不存在：返回错误', async () => {
    const getInstance = vi.fn().mockReturnValue(null)
    const tool = new WorkflowStatusTool()
    const res = await tool.execute({ instanceId: 'inst_missing' }, makeToolContext({ getInstance }))

    expect(res.ok).toBe(false)
    expect((res.error ?? '').includes('inst_missing')).toBe(true)
  })

  it('缺少 instanceId 或 manager 未初始化：返回错误', async () => {
    const tool = new WorkflowStatusTool()
    const noId = await tool.execute({}, makeToolContext({}))
    expect(noId.ok).toBe(false)
    expect((noId.error ?? '').includes('instanceId')).toBe(true)

    const noManager = await tool.execute({ instanceId: 'x' }, {} as ToolContext)
    expect(noManager.ok).toBe(false)
    expect((noManager.error ?? '').includes('WorkflowManager')).toBe(true)
  })
})