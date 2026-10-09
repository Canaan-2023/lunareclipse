import { describe, it, expect } from 'vitest'
import { SubAgentManager } from '../electron/main/sub-agent'
import type { SubAgentEvent, SubAgentExecuteFn } from '../electron/main/sub-agent'
import type { ToolContext } from '../electron/main/tools/base-tool'

/**
 * 子 agent 过程事件流测试。
 * 验证：start/tool_start/tool_end/done 事件发射、agentId/parentToolCallId 补齐、
 * 嵌套深度检查不发射事件、serial 模式 index/total 正确。
 */

interface TestTool {
  name: string
  execute: () => Promise<string>
}

const makeTool = (name: string): TestTool => ({ name, execute: async () => 'ok' })

const baseCtx: ToolContext = {}

/** 构造一个 executeFn：可选 emit 内部工具事件，返回固定输出 */
function makeExecuteFn(opts?: {
  emitToolEvents?: boolean
  output?: string
}): SubAgentExecuteFn<TestTool> {
  return async (_messages, _tools, execOpts) => {
    if (opts?.emitToolEvents && execOpts.emit) {
      execOpts.emit({ type: 'tool_start', agentId: '', toolName: 'Read', toolCallId: 'call_1', args: { file_path: 'a.ts' } })
      execOpts.emit({ type: 'tool_end', agentId: '', toolName: 'Read', toolCallId: 'call_1', result: 'file content' })
    }
    return opts?.output ?? '子任务完成'
  }
}

describe('SubAgentManager 过程事件流', () => {
  it('launchOne 发射 start/done 事件，agentId 与 parentToolCallId 补齐', async () => {
    const events: SubAgentEvent[] = []
    const manager = new SubAgentManager<TestTool>(
      makeExecuteFn({ output: '结论：全部通过' }),
      [makeTool('Read'), makeTool('Grep')],
      baseCtx,
      { maxConcurrent: 10, maxSpawnDepth: 1 },
      (evt) => events.push(evt)
    )

    const result = await manager.launchBatch(
      [{ systemPrompt: '审查代码', userMessage: '开始', allowedTools: ['Read'] }],
      'serial',
      0,
      'parent_call_1'
    )

    expect(result[0].output).toBe('结论：全部通过')

    // start 事件
    const start = events.find((e) => e.type === 'start')
    expect(start).toBeDefined()
    expect(start!.type).toBe('start')
    if (start!.type === 'start') {
      expect(start!.agentId).toMatch(/^sa_/)
      expect(start!.prompt).toBe('审查代码')
      expect(start!.mode).toBe('serial')
      expect(start!.index).toBe(0)
      expect(start!.total).toBe(1)
      expect(start!.parentToolCallId).toBe('parent_call_1')
    }

    // done 事件：完整输出 + 归属信息
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done!.type === 'done') {
      expect(done!.output).toBe('结论：全部通过')
      expect(done!.agentId).toMatch(/^sa_/)
      expect(done!.parentToolCallId).toBe('parent_call_1')
      expect(done!.error).toBeUndefined()
    }

    // 事件顺序：start 在前，done 在后
    expect(events[0].type).toBe('start')
    expect(events[events.length - 1].type).toBe('done')
  })

  it('executeFn 内部 emit 的 tool_start/tool_end 被补齐 agentId + parentToolCallId', async () => {
    const events: SubAgentEvent[] = []
    const manager = new SubAgentManager<TestTool>(
      makeExecuteFn({ emitToolEvents: true }),
      [makeTool('Read')],
      baseCtx,
      { maxConcurrent: 10, maxSpawnDepth: 1 },
      (evt) => events.push(evt)
    )

    await manager.launchBatch(
      [{ systemPrompt: '读文件', userMessage: '开始' }],
      'serial',
      0,
      'parent_2'
    )

    const toolStarts = events.filter((e) => e.type === 'tool_start')
    expect(toolStarts.length).toBe(1)
    if (toolStarts[0]!.type === 'tool_start') {
      expect(toolStarts[0]!.toolName).toBe('Read')
      expect(toolStarts[0]!.agentId).toMatch(/^sa_/) // 补上了 agentId
      expect(toolStarts[0]!.parentToolCallId).toBe('parent_2') // 补上了 parentToolCallId
    }

    const toolEnds = events.filter((e) => e.type === 'tool_end')
    expect(toolEnds.length).toBe(1)
    if (toolEnds[0]!.type === 'tool_end') {
      expect(toolEnds[0]!.result).toBe('file content')
      expect(toolEnds[0]!.agentId).toMatch(/^sa_/)
    }
  })

  it('parallel 模式：index/total 正确、每个 agent 独立事件序列', async () => {
    const events: SubAgentEvent[] = []
    const manager = new SubAgentManager<TestTool>(
      makeExecuteFn({ emitToolEvents: true }),
      [makeTool('Read')],
      baseCtx,
      { maxConcurrent: 10, maxSpawnDepth: 1 },
      (evt) => events.push(evt)
    )

    await manager.launchBatch(
      [
        { systemPrompt: '任务A', userMessage: '开始' },
        { systemPrompt: '任务B', userMessage: '开始' }
      ],
      'parallel',
      0,
      'parent_3'
    )

    const starts = events.filter((e) => e.type === 'start')
    expect(starts.length).toBe(2)
    const indices = starts.map((e) => (e.type === 'start' ? e.index : -1)).sort()
    expect(indices).toEqual([0, 1])
    starts.forEach((e) => {
      if (e.type === 'start') expect(e.total).toBe(2)
    })
    // 每个 agent 的事件都带父调用 id
    const toolStarts = events.filter((e) => e.type === 'tool_start')
    expect(toolStarts.length).toBe(2)
    toolStarts.forEach((e) => {
      expect(e.parentToolCallId).toBe('parent_3')
    })
    // done 数量 = 2
    expect(events.filter((e) => e.type === 'done').length).toBe(2)
  })

  it('嵌套深度超限：直接返回错误，不发射任何事件', async () => {
    const events: SubAgentEvent[] = []
    const manager = new SubAgentManager<TestTool>(
      makeExecuteFn(),
      [makeTool('Read')],
      baseCtx,
      { maxConcurrent: 10, maxSpawnDepth: 1 },
      (evt) => events.push(evt)
    )

    // currentDepth=1 >= maxSpawnDepth=1 → 拒绝
    const result = await manager.launchOne(
      { systemPrompt: '嵌套', userMessage: '开始' },
      1,
      { mode: 'serial', index: 0, total: 1, parentToolCallId: 'x' }
    )

    expect(result.error).toContain('嵌套深度')
    expect(events.length).toBe(0)
  })

  it('执行失败（executeFn throw）：done 事件携带 error', async () => {
    const events: SubAgentEvent[] = []
    const failExecute: SubAgentExecuteFn<TestTool> = async () => {
      throw new Error('执行爆炸')
    }
    const manager = new SubAgentManager<TestTool>(
      failExecute,
      [makeTool('Read')],
      baseCtx,
      { maxConcurrent: 10, maxSpawnDepth: 1 },
      (evt) => events.push(evt)
    )

    const result = await manager.launchBatch(
      [{ systemPrompt: '会失败的任务', userMessage: '开始' }],
      'serial',
      0
    )

    expect(result[0].error).toBe('执行爆炸')
    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done!.type === 'done') {
      expect(done!.error).toBe('执行爆炸')
      expect(done!.output).toBe('')
    }
  })
})
