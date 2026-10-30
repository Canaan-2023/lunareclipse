/**
 * 前置规划轮提示词（plan-preplan-prompt.ts）回归测试。
 *
 * 为什么存在：前置规划提示词是「只给方向、不执行」边界的唯一载体——边界段被改弱，
 * 前置规划就会越权输出计划格式；历史段丢了，前置规划就失去「近期节奏」的自管理闭环。
 *
 * 覆盖：角色身份 / 边界段 / 历史环渲染（空与非空）/ 只读工具段（有/无）/
 * 输出契约（自由文本、不要 JSON）/ 无硬编码路径与固定日期 / summarizeExecutions 截断与封顶。
 */
import { describe, it, expect } from 'vitest'
import { buildPreplanPrompt, summarizeExecutions } from '../electron/main/room/plan-preplan-prompt'
import type { ExecutorResult } from '../electron/main/room/executor'

const ALLOW: ExecutorResult = {
  ok: true,
  decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' }
}

describe('buildPreplanPrompt', () => {
  it('角色身份：你是 {aiName} 的前置规划；只给方向不执行', () => {
    const p = buildPreplanPrompt({ aiName: '月蚀', text: '环境正常', history: [], readonlyTools: [] })
    expect(p).toContain('你是 月蚀 的前置规划')
    expect(p).toContain('只给方向')
    expect(p).toContain('不执行')
  })

  it('采集输入原样进入提示词', () => {
    const p = buildPreplanPrompt({ aiName: 'X', text: 'CPU 87%', history: [], readonlyTools: [] })
    expect(p).toContain('【采集输入】')
    expect(p).toContain('CPU 87%')
  })

  it('历史为空 → 明说「第一轮」；非空 → 旧→新渲染指令与结果', () => {
    const empty = buildPreplanPrompt({ aiName: 'X', text: 't', history: [], readonlyTools: [] })
    expect(empty).toContain('第一轮')
    const withHistory = buildPreplanPrompt({
      aiName: 'X',
      text: 't',
      history: [
        { ts: 1, instruction: '先整理记忆', results: 'memory_search 成功' },
        { ts: 2, instruction: '再观察环境', results: '' }
      ],
      readonlyTools: []
    })
    expect(withHistory).toContain('【近期节奏】')
    expect(withHistory.indexOf('先整理记忆')).toBeLessThan(withHistory.indexOf('再观察环境'))
    expect(withHistory).toContain('memory_search 成功')
    expect(withHistory).toContain('（无记录）')
  })

  it('只读工具段：有工具才出现；空清单不列该段（写工具物理不可见，无需声明）', () => {
    const withTools = buildPreplanPrompt({ aiName: 'X', text: 't', history: [], readonlyTools: ['memory_search'] })
    expect(withTools).toContain('【查证】')
    expect(withTools).toContain('memory_search')
    expect(withTools).toContain('只读')
    const noTools = buildPreplanPrompt({ aiName: 'X', text: 't', history: [], readonlyTools: [] })
    expect(noTools).not.toContain('【查证】')
  })

  it('输出契约：自由文本、明确不要 JSON；「没有方向也是一种方向」', () => {
    const p = buildPreplanPrompt({ aiName: 'X', text: 't', history: [], readonlyTools: [] })
    expect(p).toContain('不要输出 JSON')
    expect(p).toContain('没有方向也是一种方向')
  })

  it('无硬编码本地路径、无固定日期（提示词规范红线）', () => {
    const p = buildPreplanPrompt({
      aiName: 'X',
      text: 't',
      history: [{ ts: 1, instruction: 'i', results: 'r' }],
      readonlyTools: ['a', 'b']
    })
    expect(p).not.toMatch(/[A-Za-z]:\\/)
    expect(p).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('summarizeExecutions', () => {
  it('空 → 空串（历史里显示「无记录」）', () => {
    expect(summarizeExecutions([])).toBe('')
  })

  it('按序配对 decisions 取工具名；成功/失败如实', () => {
    const fail: ExecutorResult = {
      ok: false,
      decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' },
      result: { ok: false, error: '磁盘满了' }
    }
    const s = summarizeExecutions(
      [ALLOW, fail],
      [
        { kind: 'tool', toolName: 'read', params: {}, fromToolZone: false, description: '读' },
        { kind: 'tool', toolName: 'write', params: {}, fromToolZone: false, description: '写' }
      ]
    )
    expect(s).toBe('read 成功；write 失败：磁盘满了')
  })

  it('被拒动作：原因取自裁决 reason（result 不存在时）', () => {
    const denied: ExecutorResult = {
      ok: false,
      decision: { allowed: false, tier: 'T1', code: 't1_not_granted', reason: '未授予写权限', auditId: 'a' },
      rejectedAt: 'action'
    }
    expect(summarizeExecutions([denied])).toBe('动作1 失败：未授予写权限')
  })

  it('超长错误逐条截断（≤200 字符）', () => {
    const fail: ExecutorResult = {
      ok: false,
      decision: { allowed: true, tier: 'T2', code: 'allowed', reason: 'ok', auditId: 'a' },
      result: { ok: false, error: 'x'.repeat(500) }
    }
    const s = summarizeExecutions([fail])
    expect(s.length).toBeLessThan(230)
    expect(s).toContain('x'.repeat(200))
  })

  it('总量封顶（≤2000 字符预算，超出即截断不再追加）', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      ok: false,
      decision: { allowed: true, tier: 'T2' as const, code: 'allowed' as const, reason: 'ok', auditId: 'a' },
      result: { ok: false, error: `错误${i}${'y'.repeat(150)}` }
    }))
    const s = summarizeExecutions(many)
    expect(s.length).toBeLessThanOrEqual(2000)
  })
})
