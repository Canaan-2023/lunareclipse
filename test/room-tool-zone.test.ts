/**
 * 工具区（B9）回归测试：声明式自造工具的校验、执行与持久化。
 *
 * 为什么存在：工具区是「AI 自造工具给执行器用」的承载面（§0 T1-8）。两条安全性质必须有回归网：
 * ① 步骤工具必须在**可用工具集合内**（否则等于开了一个任意调用口）；② 任一步失败**即停**（不继续跑）。
 *
 * 覆盖：validateEntry（合法 / 缺名称 / 空步骤 / 超步数 / 工具不在集合 / 缺 tool / id 生成）/
 * runZoneTool（逐步串行、失败即停、fromToolZone 恒真）/ ToolZoneStore（真实 FS，mkdtemp）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateEntry, runZoneTool, routeToolName, ToolZoneStore, TOOL_ZONE_MAX_STEPS } from '../electron/main/room/tool-zone'
import type { ExecutorDecision, ExecutorResult } from '../electron/main/room/executor'

const TOOLS = ['read', 'write', 'glob']

function okResult(): ExecutorResult {
  return { ok: true, decision: { allowed: true, tier: 'T1', code: 'allowed', reason: 'ok', auditId: 'a' } }
}
function denyResult(reason: string): ExecutorResult {
  return { ok: false, decision: { allowed: false, tier: 'T1', code: 't1_not_granted', reason, auditId: 'a' }, rejectedAt: 'action' }
}

describe('validateEntry：声明式校验', () => {
  it('合法条目 → 规范化（id 自动生成）', () => {
    const r = validateEntry({ name: '看环境', description: 'd', steps: [{ tool: 'read', params: { path: 'x' } }], enabled: true }, TOOLS, 1000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.entry.name).toBe('看环境')
      expect(r.entry.enabled).toBe(true)
      expect(r.entry.id).toContain('tz_1000')
      expect(r.entry.steps).toEqual([{ tool: 'read', params: { path: 'x' } }])
    }
  })

  it('缺名称 / 空步骤 / 超步数 → 拒绝', () => {
    expect(validateEntry({ steps: [{ tool: 'read' }] }, TOOLS, 1).ok).toBe(false)
    expect(validateEntry({ name: 'a', steps: [] }, TOOLS, 1).ok).toBe(false)
    const many = Array.from({ length: TOOL_ZONE_MAX_STEPS + 1 }, () => ({ tool: 'read' }))
    expect(validateEntry({ name: 'a', steps: many }, TOOLS, 1).ok).toBe(false)
  })

  it('步骤工具不在可用集合 → 拒绝（安全咽喉）', () => {
    const r = validateEntry({ name: 'a', steps: [{ tool: 'rm_rf' }] }, TOOLS, 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('rm_rf')
  })

  it('步骤缺 tool → 拒绝', () => {
    expect(validateEntry({ name: 'a', steps: [{}] }, TOOLS, 1).ok).toBe(false)
  })
})

describe('runZoneTool：逐步串行、失败即停', () => {
  const entry = {
    id: 't1',
    name: '组合',
    description: '',
    steps: [
      { tool: 'read', params: { path: 'a' } },
      { tool: 'write', params: { path: 'b' } }
    ],
    enabled: true,
    createdAt: 0
  }

  it('全部成功 → ok，逐步记录', async () => {
    const seen: ExecutorDecision[] = []
    const r = await runZoneTool(entry, async (d) => {
      seen.push(d)
      return okResult()
    })
    expect(r.ok).toBe(true)
    expect(r.steps.map((s) => s.tool)).toEqual(['read', 'write'])
    expect(seen).toHaveLength(2)
    // 工具区产物一律带 fromToolZone（执行器据此先过 t1.tool-zone-enable）
    expect(seen.every((d) => d.fromToolZone === true)).toBe(true)
  })

  it('首步失败 → 立即停止，不跑后续步骤', async () => {
    const seen: ExecutorDecision[] = []
    const r = await runZoneTool(entry, async (d) => {
      seen.push(d)
      return denyResult('未授予 t1.executor-high-risk')
    })
    expect(r.ok).toBe(false)
    expect(seen).toHaveLength(1)
    expect(r.steps[0].error).toContain('未授予')
  })

  it('末步失败 → 前面的步骤已执行并记录', async () => {
    let n = 0
    const r = await runZoneTool(entry, async () => (++n === 1 ? okResult() : denyResult('第二步被拒')))
    expect(r.ok).toBe(false)
    expect(r.steps).toHaveLength(2)
    expect(r.steps[0].ok).toBe(true)
    expect(r.steps[1].ok).toBe(false)
  })
})

describe('routeToolName：动作名路由（注册表优先）', () => {
  const zone = [
    { id: 'z1', name: '看环境', description: '', steps: [{ tool: 'read', params: {} }], enabled: true, createdAt: 0 },
    { id: 'z2', name: '停用的', description: '', steps: [{ tool: 'read', params: {} }], enabled: false, createdAt: 0 }
  ]

  it('注册表工具 → registry', () => {
    expect(routeToolName('read', TOOLS, zone)).toEqual({ kind: 'registry' })
  })

  it('启用中的自造工具 → zone（带条目）', () => {
    const r = routeToolName('看环境', TOOLS, zone)
    expect(r.kind).toBe('zone')
    if (r.kind === 'zone') expect(r.entry.id).toBe('z1')
  })

  it('未启用的自造工具 → unknown', () => {
    expect(routeToolName('停用的', TOOLS, zone)).toEqual({ kind: 'unknown' })
  })

  it('注册表优先：自造工具用同名遮蔽内置工具无效', () => {
    const shadow = [{ id: 'x', name: 'read', description: '', steps: [], enabled: true, createdAt: 0 }]
    expect(routeToolName('read', TOOLS, shadow)).toEqual({ kind: 'registry' })
  })

  it('空名 / 都不命中 → unknown', () => {
    expect(routeToolName('', TOOLS, zone)).toEqual({ kind: 'unknown' })
    expect(routeToolName('不存在', TOOLS, zone)).toEqual({ kind: 'unknown' })
  })
})

describe('ToolZoneStore：持久化（真实 FS）', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('保存后可读回；文件不存在返回空数组', () => {
    dir = mkdtempSync(join(tmpdir(), 'le-tz-'))
    const store = new ToolZoneStore(dir)
    expect(store.load()).toEqual([])
    store.save([
      { id: 'a', name: 'n', description: '', steps: [{ tool: 'read', params: {} }], enabled: true, createdAt: 1 }
    ])
    const back = store.load()
    expect(back).toHaveLength(1)
    expect(back[0].id).toBe('a')
  })

  it('损坏文件 → 返回空数组（不抛）', () => {
    dir = mkdtempSync(join(tmpdir(), 'le-tz-'))
    const store = new ToolZoneStore(dir)
    store.save([])
    const p = join(dir, 'tool-zone.json')
    // 写坏
    writeFileSync(p, '{ broken', 'utf-8')
    expect(store.load()).toEqual([])
  })
})
