/**
 * 局域网启停工具（B2）回归测试：`t1.lan-control` 授权门 + 配置写入。
 *
 * 为什么存在：用户裁决「局域网启停用户和 AI 都能操作」。AI 侧若不过权限层就能开关监听面，
 * 「AI 不能给自己授权」这条边界会在最高危的动作（改网络暴露面）上破口——必须有回归网。
 *
 * 覆盖：status 查询 / 未授予 enable 被拒且带授予提示 / 授予后 enable 写配置 /
 * 授予后 disable 写配置 / 未授予 disable 同样被拒 / 未知 action / 多实例不可用。
 */
import { describe, it, expect } from 'vitest'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { AuditEntry, SecurityGrants } from '../shared/types/permission'
import { LanControlTool } from '../electron/main/tools/lan-control'

const GRANTED: SecurityGrants = {
  grants: { 't1.lan-control': { key: 't1.lan-control', grantedAt: 1_700_000_000_000 } }
}

interface CtxResult {
  ctx: ToolContext
  updated: () => Record<string, unknown> | null
}

function makeCtx(opts: { grants?: SecurityGrants; hasMi?: boolean } = {}): CtxResult {
  const config: Record<string, unknown> = { securityGrants: opts.grants ?? { grants: {} } }
  let updated: Record<string, unknown> | null = null
  const fakeMi = {
    getRoutingStack: () => ({ routing: { getGraph: () => ({ nodes: new Map([[1, {}], [2, {}]]) }) } }),
    getRole: () => 'master'
  }
  const ctx = {
    config,
    getMultiInstance: () => (opts.hasMi === false ? null : fakeMi),
    updateConfig: (updater: (c: Record<string, unknown>) => Record<string, unknown>) => {
      updated = updater(config)
    }
  } as unknown as ToolContext
  return { ctx, updated: () => updated }
}

/** 审计 sink 注入 no-op：单测不得写仓库 data/（CODE-RULES §二 R-T2） */
function makeTool(): LanControlTool {
  const noop = (_e: AuditEntry) => undefined
  return new LanControlTool(noop)
}

describe('lan_control：status 查询（无需授权）', () => {
  it('返回运行态 / 角色 / 节点数', async () => {
    const { ctx } = makeCtx()
    const r = await makeTool().execute({ action: 'status' }, ctx)
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ running: true, role: 'master', nodeCount: 2 })
  })
})

describe('lan_control：enable/disable 过 t1.lan-control 授权', () => {
  it('未授予 enable → 拒绝 + 授予提示，且不写配置', async () => {
    const { ctx, updated } = makeCtx()
    const r = await makeTool().execute({ action: 'enable' }, ctx)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('t1.lan-control')
    expect(String(r.error)).toContain('授予方式')
    expect(updated()).toBeNull()
  })

  it('未授予 disable → 同样被拒（不能靠关来绕过）', async () => {
    const { ctx } = makeCtx()
    const r = await makeTool().execute({ action: 'disable' }, ctx)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('t1.lan-control')
  })

  it('授予后 enable → 写入 lan.enabled=true', async () => {
    const { ctx, updated } = makeCtx({ grants: GRANTED })
    const r = await makeTool().execute({ action: 'enable' }, ctx)
    expect(r.ok).toBe(true)
    expect(updated()).toMatchObject({ lan: { enabled: true } })
  })

  it('授予后 disable → 写入 lan.enabled=false', async () => {
    const { ctx, updated } = makeCtx({ grants: GRANTED })
    const r = await makeTool().execute({ action: 'disable' }, ctx)
    expect(r.ok).toBe(true)
    expect(updated()).toMatchObject({ lan: { enabled: false } })
  })
})

describe('lan_control：边界', () => {
  it('未知 action → 报错并列出可选值', async () => {
    const { ctx } = makeCtx()
    const r = await makeTool().execute({ action: 'reboot' }, ctx)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('status')
  })

  it('多实例服务不可用 → 报错', async () => {
    const { ctx } = makeCtx({ hasMi: false })
    const r = await makeTool().execute({ action: 'status' }, ctx)
    expect(r.ok).toBe(false)
  })
})
