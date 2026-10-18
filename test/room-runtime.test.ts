/**
 * ROOM 规划解析 + 运行时（B8）回归测试。
 *
 * 为什么存在：「AI 文本 → 结构化动作」的转换是自主模式的**安全咽喉**——转错一个字段就可能
 * 执行不该执行的动作。工具白名单过滤是这条咽喉的闸门，必须有回归网。
 *
 * 覆盖：JSON 抽取（围栏块 / 裸对象 / 无）/ 解析（合法、白名单外丢弃、缺 tool 丢弃、actions 别名、
 * 无 JSON 报错）/ 召回块与提示词形状 / 运行时（注入 fake 依赖跑通一条链路）。
 */
import { describe, it, expect } from 'vitest'
import { extractJsonObject, parsePlan } from '../electron/main/room/plan'
import { buildRecallBlock, buildPlanPrompt, createRoomRuntime } from '../electron/main/room/runtime'
import type { Executor } from '../electron/main/room/executor'

const TOOLS = ['read', 'write', 'glob']

describe('extractJsonObject', () => {
  it('优先取围栏代码块', () => {
    const t = '前言\n```json\n{"decisions":[]}\n```\n后记'
    expect(JSON.parse(extractJsonObject(t)!)).toEqual({ decisions: [] })
  })

  it('无围栏时取第一个平衡的 {...}', () => {
    const t = '说明 {"note":"a","decisions":[{"tool":"read"}]} 结束'
    expect(JSON.parse(extractJsonObject(t)!)).toEqual({ note: 'a', decisions: [{ tool: 'read' }] })
  })

  it('无 JSON → null', () => {
    expect(extractJsonObject('没有计划')).toBeNull()
  })
})

describe('parsePlan：工具白名单过滤（安全咽喉）', () => {
  it('合法计划 → 逐条结构化（AI 自述的 readOnly 被丢弃，见 P0-2）', () => {
    const r = parsePlan('{"note":"查一下","decisions":[{"tool":"read","params":{"path":"a"},"description":"读 a","readOnly":true}]}', TOOLS)
    expect(r.parseError).toBeUndefined()
    expect(r.note).toBe('查一下')
    expect(r.decisions).toEqual([
      { kind: 'tool', toolName: 'read', params: { path: 'a' }, fromToolZone: false, description: '读 a' }
    ])
    expect(r.dropped).toEqual([])
  })

  it('白名单外的工具被丢弃（不抛错）', () => {
    const r = parsePlan('{"decisions":[{"tool":"rm_rf"},{"tool":"read"}]}', TOOLS)
    expect(r.decisions).toHaveLength(1)
    expect(r.decisions[0].toolName).toBe('read')
    expect(r.dropped[0]).toContain('rm_rf')
  })

  it('缺 tool 字段被丢弃', () => {
    const r = parsePlan('{"decisions":[{"params":{}}]}', TOOLS)
    expect(r.decisions).toHaveLength(0)
    expect(r.dropped[0]).toContain('缺少 tool')
  })

  it('兼容 actions 别名', () => {
    const r = parsePlan('{"actions":[{"tool":"glob"}]}', TOOLS)
    expect(r.decisions[0].toolName).toBe('glob')
  })

  it('无 JSON → parseError，decisions 空', () => {
    const r = parsePlan('我什么也不做', TOOLS)
    expect(r.parseError).toBeTruthy()
    expect(r.decisions).toHaveLength(0)
  })

  it('description 缺省由工具名生成', () => {
    const r = parsePlan('{"decisions":[{"tool":"read"}]}', TOOLS)
    expect(r.decisions[0].description).toContain('read')
  })
})

describe('召回块与提示词', () => {
  it('buildRecallBlock：无会话返回空串；有则列出标题与摘要', () => {
    expect(buildRecallBlock([])).toBe('')
    const b = buildRecallBlock([{ title: 'T1', summary: 'S1', updatedAt: 1 }])
    expect(b).toContain('最近内部管理会话')
    expect(b).toContain('T1')
  })

  it('buildPlanPrompt：含采集输入 / 分诊 / 工具白名单 / 输出契约', () => {
    const p = buildPlanPrompt({ text: '环境正常', mode: 'immediate', allowedTools: ['read'] })
    expect(p).toContain('环境正常')
    expect(p).toContain('即时')
    expect(p).toContain('read')
    expect(p).toContain('decisions')
  })
})

describe('createRoomRuntime：链路装配', () => {
  function makeExecutor(): { executor: Executor; executed: string[] } {
    const executed: string[] = []
    return {
      executed,
      executor: {
        execute: async (d) => {
          executed.push(d.toolName ?? '')
          return { ok: true, decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' } }
        }
      }
    }
  }

  it('采集 → 规划 → 执行 跑通，并暴露状态', async () => {
    const { executor, executed } = makeExecutor()
    const rt = createRoomRuntime({
      collect: async () => ({ ok: true, text: '现在的状态怎么样' }),
      plan: async () => '```json\n{"note":"看一眼","decisions":[{"tool":"read","params":{"path":"x"}}]}\n```',
      executor,
      allowedTools: () => ['read'],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.phase).toBe('execute')
    expect(r.mode).toBe('immediate')
    expect(executed).toEqual(['read'])
    const st = rt.getState()
    expect(st.running).toBe(false)
    expect(st.lastPlan?.decisions).toHaveLength(1)
    expect(st.events.length).toBeGreaterThan(0)
  })

  it('规划返回非法 JSON → 无动作、不崩', async () => {
    const { executor } = makeExecutor()
    const rt = createRoomRuntime({
      collect: async () => ({ ok: true, text: '现在的状态' }),
      plan: async () => '我不会做',
      executor,
      allowedTools: () => ['read'],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.acted).toBe(false)
    expect(rt.getState().lastPlan?.decisions).toHaveLength(0)
  })

  it('规划抛错 → 无动作、不崩', async () => {
    const { executor } = makeExecutor()
    const rt = createRoomRuntime({
      collect: async () => ({ ok: true, text: '现在的状态' }),
      plan: async () => {
        throw new Error('LLM 未配置')
      },
      executor,
      allowedTools: () => ['read'],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.acted).toBe(false)
  })

  it('采集失败 → idle', async () => {
    const { executor } = makeExecutor()
    const rt = createRoomRuntime({
      collect: async () => ({ ok: false, error: '采集器未开启' }),
      plan: async () => '{}',
      executor,
      allowedTools: () => [],
      now: () => 0
    })
    const r = await rt.tick()
    expect(r.phase).toBe('idle')
    expect(r.error).toContain('采集器未开启')
  })
})
