/**
 * 前置规划两段式规划路由（2026-10-31 前置规划功能）回归测试。
 *
 * 为什么存在：前置规划是每个有 aiId 主AI的专属影子——它只给方向、不执行、不写 RAW。
 * 两段式（前置规划轮 → 指令注入主AI规划轮）的顺序与回落纪律是这条链路的咽喉：
 * - 顺序反了 = 主AI看不到前置规划指令，前置规划形同虚设；
 * - 回落错了（前置规划故障弄停主AI）= 一个可选功能变成了新的单点故障。
 *
 * 覆盖：缺省零变化 / 两段式顺序与指令注入 / 前置规划失败回落不传播 llmFailed /
 * 前置规划空回复回落 / 历史环写入（onResult 与手动 tick 两条收尾路径）/ 未启用不写历史 /
 * 未绑定承载会话时前置规划轮不跑。
 */
import { describe, it, expect, vi } from 'vitest'
import { createRoomRuntime, type RoomRuntimeDeps } from '../electron/main/room/runtime'
import type { Executor } from '../electron/main/room/executor'
import type { PreplanHistoryEntry } from '../electron/main/room/preplan-store'

function makeExecutor(): Executor {
  return {
    execute: async (d) => ({
      ok: true,
      decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' },
      result: { ok: true, data: { tool: d.toolName } }
    })
  }
}

function makeRuntime(deps: RoomRuntimeDeps) {
  const rt = createRoomRuntime(deps)
  rt.setHostSession('chat-1')
  return rt
}

/** 让驱动（rt.start 起的异步循环）跑完至少一轮并 park。 */
async function flushDrive(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}

describe('前置规划两段式：缺省与回落纪律', () => {
  it('缺省（无 plannerRoute）→ 主AI自规划，提示词无【前置规划】段（行为与引入前逐字一致）', async () => {
    let mainPrompt = ''
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async (p) => {
        mainPrompt = p
        return '{"decisions":[]}'
      },
      executor: makeExecutor(),
      allowedTools: () => []
    })
    await rt.tick()
    expect(mainPrompt).not.toContain('【前置规划】')
    expect(rt.getState().planner?.kind).toBe('self')
  })

  it('启用前置规划 → 两段式顺序：前置规划轮先跑，指令进入主AI提示词的【前置规划】段', async () => {
    const calls: string[] = []
    let mainPrompt = ''
    let preplanPrompt = ''
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async (p) => {
        calls.push('main')
        mainPrompt = p
        return '{"decisions":[]}'
      },
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async (p) => {
        calls.push('preplan')
        preplanPrompt = p
        return '先整理记忆区，再观察环境变化'
      },
      loadPreplanHistory: () => [],
      preplanAiName: '月蚀'
    })
    await rt.tick()
    expect(calls).toEqual(['preplan', 'main'])
    expect(preplanPrompt).toContain('你是 月蚀 的前置规划')
    expect(preplanPrompt).toContain('有输入')
    expect(mainPrompt).toContain('【前置规划】')
    expect(mainPrompt).toContain('先整理记忆区，再观察环境变化')
    expect(mainPrompt).toContain('建议，不是命令')
    expect(rt.getState().planner?.kind).toBe('preplan')
  })

  it('前置规划轮抛错 → 回落主AI自规划：主AI照常规划、不传播 llmFailed、事件留痕', async () => {
    let mainPrompt = ''
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async (p) => {
        mainPrompt = p
        return '{"decisions":[]}'
      },
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => {
        throw new Error('前置规划 LLM 故障')
      }
    })
    const r = await rt.tick()
    expect(r.llmFailed).toBeFalsy()
    expect(mainPrompt).not.toContain('【前置规划】')
    expect(rt.getState().events.some((e) => e.detail?.includes('前置规划轮失败，本轮回落自规划'))).toBe(true)
  })

  it('前置规划返回空 → 回落自规划（无指令段，不算故障）', async () => {
    let mainPrompt = ''
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async (p) => {
        mainPrompt = p
        return '{"decisions":[]}'
      },
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => '   '
    })
    const r = await rt.tick()
    expect(r.llmFailed).toBeFalsy()
    expect(mainPrompt).not.toContain('【前置规划】')
  })

  it('前置规划已启用但未接线（无 runPreplan）→ 回落自规划并留痕', async () => {
    let mainPrompt = ''
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async (p) => {
        mainPrompt = p
        return '{"decisions":[]}'
      },
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' })
    })
    await rt.tick()
    expect(mainPrompt).not.toContain('【前置规划】')
    expect(rt.getState().events.some((e) => e.detail?.includes('前置规划已启用但未接线'))).toBe(true)
  })

  it('未绑定承载会话 → 前置规划轮也不跑（主AI都不会动，给方向没有意义）', async () => {
    const runPreplan = vi.fn(async () => '方向')
    const rt = createRoomRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan
    })
    await rt.tick()
    expect(runPreplan).not.toHaveBeenCalled()
  })
})

describe('前置规划历史环（指令 + 执行结果摘要）', () => {
  it('手动 tick 路径：一轮结束后写入 {instruction, results}（手动 tick 不走 onResult）', async () => {
    const appended: PreplanHistoryEntry[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[{"tool":"read","params":{"path":"x"}}]}',
      executor: makeExecutor(),
      allowedTools: () => ['read'],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => '读一下 x',
      loadPreplanHistory: () => [],
      appendPreplanHistory: (e) => {
        appended.push(e)
      }
    })
    await rt.tick()
    expect(appended).toHaveLength(1)
    expect(appended[0].instruction).toBe('读一下 x')
    expect(appended[0].results).toContain('read 成功')
  })

  it('驱动（rt.start）路径：onResult 收尾同样写入历史环', async () => {
    const appended: PreplanHistoryEntry[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      // decisions 空 → acted=false → 驱动一轮即 park（确定性收尾）
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => '安静待着',
      loadPreplanHistory: () => [],
      appendPreplanHistory: (e) => {
        appended.push(e)
      }
    })
    rt.start()
    await flushDrive()
    expect(appended).toHaveLength(1)
    expect(appended[0].instruction).toBe('安静待着')
    rt.stop()
  })

  it('前置规划回落（失败/未启用）的轮次不写历史——历史环只记「前置规划真的给了方向」的轮次', async () => {
    const appended: PreplanHistoryEntry[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      // 未启用前置规划
      appendPreplanHistory: (e) => {
        appended.push(e)
      }
    })
    await rt.tick()
    expect(appended).toHaveLength(0)
  })

  it('第二轮前置规划提示词带【近期节奏】（历史环回流，旧→新）', async () => {
    let secondPreplanPrompt = ''
    let call = 0
    const appended: PreplanHistoryEntry[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async (p) => {
        call += 1
        if (call === 2) secondPreplanPrompt = p
        return `第${call}次方向`
      },
      loadPreplanHistory: () => appended,
      appendPreplanHistory: (e) => {
        appended.push(e)
      }
    })
    await rt.tick()
    await rt.tick()
    expect(secondPreplanPrompt).toContain('【近期节奏】')
    expect(secondPreplanPrompt).toContain('第1次方向')
  })
})

describe('M5 可观测：事件带 planner 标记 / 快照附历史条数', () => {
  it('前置规划轮事件条目带 planner=preplan（指令 / 失败回落 / 未接线三条路径），其余条目不染', async () => {
    // 路径一：前置规划正常给方向
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => '先整理记忆区',
      loadPreplanHistory: () => []
    })
    await rt.tick()
    const events = rt.getState().events
    const preplanEvents = events.filter((e) => e.planner === 'preplan')
    expect(preplanEvents).toHaveLength(1)
    expect(preplanEvents[0].detail).toContain('前置规划：先整理记忆区')
    // 其余条目（loop 相位事件等）不带 planner 字段
    expect(events.some((e) => e.planner === undefined)).toBe(true)

    // 路径二：前置规划抛错回落——留痕条目同样带标记
    const rtFail = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => {
        throw new Error('前置规划 LLM 故障')
      }
    })
    await rtFail.tick()
    const failEv = rtFail.getState().events.find((e) => e.detail?.includes('前置规划轮失败'))
    expect(failEv?.planner).toBe('preplan')

    // 路径三：启用但未接线
    const rtNoWire = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' })
    })
    await rtNoWire.tick()
    const noWireEv = rtNoWire.getState().events.find((e) => e.detail?.includes('前置规划已启用但未接线'))
    expect(noWireEv?.planner).toBe('preplan')
  })

  it('快照附前置规划历史条数：preplan 路由带条数（来自历史环长度），self 路由不带（零额外读盘）', async () => {
    const appended: PreplanHistoryEntry[] = []
    const rt = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'preplan' }),
      runPreplan: async () => '读一下 x',
      loadPreplanHistory: () => appended,
      appendPreplanHistory: (e) => {
        appended.push(e)
      }
    })
    // 起跑前：历史为空 → 条数 0（preplan 路由仍带字段）
    expect(rt.getState().preplanHistoryCount).toBe(0)
    await rt.tick()
    // 一轮写入历史后，快照条数 = 1
    expect(rt.getState().preplanHistoryCount).toBe(1)

    // self 路由：不带字段，且不应触发历史读取
    const loadHistory = vi.fn(() => appended)
    const rtSelf = makeRuntime({
      collect: async () => ({ ok: true, text: '有输入' }),
      plan: async () => '{"decisions":[]}',
      executor: makeExecutor(),
      allowedTools: () => [],
      plannerRoute: () => ({ kind: 'self' }),
      loadPreplanHistory: loadHistory
    })
    expect(rtSelf.getState().preplanHistoryCount).toBeUndefined()
    expect(loadHistory).not.toHaveBeenCalled()
  })
})
