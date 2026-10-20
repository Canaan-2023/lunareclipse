import { describe, it, expect, afterEach } from 'vitest'
import { createToolRegistry, executeTool } from '../electron/main/tools/index'
import type { AnyTool, ToolBehavior } from '../electron/main/tools/base-tool'
import { isPlanModeActive, resetPlanModeState } from '../electron/main/tools/plan-mode'

/**
 * 计划模式（enter_plan_mode / exit_plan_mode + 执行链只读闸）
 * 为什么存在：复杂任务应先只读探索、方案获批再动手。执行链（execute-tool.ts）
 * 在行为解析后消费 plan-mode 的会话级状态：计划模式下一切非只读工具被拒。
 * 本测试覆盖：闸的放行/拒绝边界、batch_tools 不可旁路、exit 审批 fail-closed、
 * 非计划模式零回归、状态清理。
 */

function makeRegistry(tool: AnyTool): ReturnType<typeof createToolRegistry> {
  const r = createToolRegistry({ config: {} } as never, {} as never)
  r.tools.set(tool.name, tool)
  return r
}

/** 执行体带副作用计数的可写 probe（behavior.readOnly=false，模拟 Write/run_command 等有副作用工具） */
function makeWriteProbe(name: string): { tool: AnyTool; calls: () => number } {
  let callCount = 0
  const tool: AnyTool = {
    name,
    description: `probe write ${name}`,
    parameters: [{ name: 'key', type: 'string', description: '输入键' }],
    behavior: { readOnly: false } satisfies ToolBehavior,
    execute: () => {
      callCount++
      return { ok: true, data: { wrote: true } }
    }
  }
  return { tool, calls: () => callCount }
}

/** 只读 probe（behavior.readOnly=true，模拟 Read/Glob/Grep/LS） */
function makeReadProbe(name: string): AnyTool {
  return {
    name,
    description: `probe read ${name}`,
    parameters: [{ name: 'key', type: 'string', description: '输入键' }],
    behavior: { readOnly: true } satisfies ToolBehavior,
    execute: () => ({ ok: true, data: { read: true } })
  }
}

/** 模拟 batch_tools 编排：子步骤经 ctx.executeSubTool 走同一条执行链 */
function makeBatchProbe(): AnyTool {
  return {
    name: 'batch_tools',
    description: 'probe batch',
    parameters: [],
    execute: async (params, ctx) => {
      const steps = (params as { steps?: Array<{ tool: string; params: Record<string, unknown> }> }).steps ?? []
      const results = []
      for (const s of steps) {
        results.push(await ctx?.executeSubTool?.(s.tool, s.params))
      }
      return { ok: true, data: { results } }
    }
  }
}

afterEach(() => {
  resetPlanModeState()
})

describe('计划模式 × 执行链只读闸', () => {
  it('非计划模式：写工具照常执行（改造零回归）', async () => {
    const { tool, calls } = makeWriteProbe('__pm_write_off__')
    const registry = makeRegistry(tool)
    registry.ctx.sessionId = 's-off'

    const r = await executeTool(registry, tool.name, {})
    expect(r.ok).toBe(true)
    expect(calls()).toBe(1)
  })

  it('进入计划模式后：写工具被拒、只读工具放行', async () => {
    const w = makeWriteProbe('__pm_write_blocked__')
    const rtool = makeReadProbe('__pm_read_allowed__')
    const registry = makeRegistry(w.tool)
    registry.tools.set(rtool.name, rtool)
    registry.ctx.sessionId = 's-block'

    const entered = await executeTool(registry, 'enter_plan_mode', {})
    expect(entered.ok).toBe(true)
    expect(isPlanModeActive('s-block')).toBe(true)

    const writeR = await executeTool(registry, w.tool.name, {})
    expect(writeR.ok).toBe(false)
    expect(writeR.error).toContain('计划模式只读阶段')
    expect(w.calls()).toBe(0)

    const readR = await executeTool(registry, rtool.name, {})
    expect(readR.ok).toBe(true)
  })

  it('重复进入计划模式幂等：仍处于计划模式且提示继续探索', async () => {
    const registry = makeRegistry(makeReadProbe('__pm_idem_read__'))
    registry.ctx.sessionId = 's-idem'

    await executeTool(registry, 'enter_plan_mode', {})
    const again = await executeTool(registry, 'enter_plan_mode', {})
    expect(again.ok).toBe(true)
    expect(String((again.data as { message?: string } | undefined)?.message)).toContain('已在计划模式')
    expect(isPlanModeActive('s-idem')).toBe(true)
  })

  it('batch_tools 放行（编排层），但子步骤写工具仍被闸拒绝——不可旁路', async () => {
    const batch = makeBatchProbe()
    const w = makeWriteProbe('__pm_batch_write__')
    const rtool = makeReadProbe('__pm_batch_read__')
    const registry = makeRegistry(batch)
    registry.tools.set(w.tool.name, w.tool)
    registry.tools.set(rtool.name, rtool)
    registry.ctx.sessionId = 's-batch'
    // 模拟 server.ts 宿主注入：子工具走同一条 executeTool 执行链
    registry.ctx.executeSubTool = (name, params) => executeTool(registry, name, params)

    await executeTool(registry, 'enter_plan_mode', {})

    const batchR = await executeTool(registry, 'batch_tools', {
      steps: [
        { tool: w.tool.name, params: {} },
        { tool: rtool.name, params: {} }
      ]
    })
    expect(batchR.ok).toBe(true)
    const results = (batchR.data as { results: Array<{ ok: boolean; error?: string }> }).results
    expect(results[0].ok).toBe(false)
    expect(results[0].error).toContain('计划模式只读阶段')
    expect(results[1].ok).toBe(true)
    expect(w.calls()).toBe(0)
  })

  it('exit_plan_mode 无审批通道时 fail-closed：仍保持计划模式', async () => {
    const registry = makeRegistry(makeReadProbe('__pm_exit_nwf__'))
    registry.ctx.sessionId = 's-nwf'

    await executeTool(registry, 'enter_plan_mode', {})
    const r = await executeTool(registry, 'exit_plan_mode', { plan: '方案A' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不支持用户审批')
    expect(isPlanModeActive('s-nwf')).toBe(true)
  })

  it('exit_plan_mode 用户批准：退出计划模式并回显方案，写工具恢复', async () => {
    const w = makeWriteProbe('__pm_exit_approved_write__')
    const registry = makeRegistry(w.tool)
    registry.ctx.sessionId = 's-ok'
    // 假 WorkflowManager：askUser 同步返回 requestId，waitForAskUserResponse 立即批准
    const fakeWf = {
      askUser: () => 'req-ok',
      waitForAskUserResponse: async () => 'approved'
    }
    registry.ctx.getWorkflowManager = () => fakeWf as never

    await executeTool(registry, 'enter_plan_mode', {})
    const r = await executeTool(registry, 'exit_plan_mode', { plan: '方案B' })
    expect(r.ok).toBe(true)
    expect((r.data as { plan?: string } | undefined)?.plan).toBe('方案B')
    expect(isPlanModeActive('s-ok')).toBe(false)

    const writeR = await executeTool(registry, w.tool.name, {})
    expect(writeR.ok).toBe(true)
    expect(w.calls()).toBe(1)
  })

  it('exit_plan_mode 用户取消：保持计划模式，可继续完善方案', async () => {
    const registry = makeRegistry(makeReadProbe('__pm_exit_cancel__'))
    registry.ctx.sessionId = 's-cancel'
    const fakeWf = {
      askUser: () => 'req-cancel',
      waitForAskUserResponse: async () => {
        throw new Error('user cancelled')
      }
    }
    registry.ctx.getWorkflowManager = () => fakeWf as never

    await executeTool(registry, 'enter_plan_mode', {})
    const r = await executeTool(registry, 'exit_plan_mode', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('未批准')
    expect(isPlanModeActive('s-cancel')).toBe(true)
  })

  it('非计划模式调用 exit_plan_mode：明确报错引导', async () => {
    const registry = makeRegistry(makeReadProbe('__pm_exit_wrong__'))
    registry.ctx.sessionId = 's-wrong'

    const r = await executeTool(registry, 'exit_plan_mode', { plan: '无所谓' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不在计划模式')
  })

  it('resetPlanModeState 清理全部会话状态', async () => {
    const registry = makeRegistry(makeReadProbe('__pm_reset__'))
    registry.ctx.sessionId = 's-reset'

    await executeTool(registry, 'enter_plan_mode', {})
    expect(isPlanModeActive('s-reset')).toBe(true)
    resetPlanModeState()
    expect(isPlanModeActive('s-reset')).toBe(false)
  })
})

describe('计划模式 × 会话隔离（不同会话互不影响）', () => {
  it('仅当前会话进入计划模式，其他会话不受闸影响', async () => {
    const { tool, calls } = makeWriteProbe('__pm_iso_write__')
    const registry = makeRegistry(tool)
    registry.ctx.sessionId = 's-a'

    await executeTool(registry, 'enter_plan_mode', {})
    expect(isPlanModeActive('s-a')).toBe(true)
    expect(isPlanModeActive('s-b')).toBe(false)

    // 同一 registry 但换会话：s-b 未进入计划模式，写工具放行
    registry.ctx.sessionId = 's-b'
    const r = await executeTool(registry, tool.name, {})
    expect(r.ok).toBe(true)
    expect(calls()).toBe(1)
  })
})