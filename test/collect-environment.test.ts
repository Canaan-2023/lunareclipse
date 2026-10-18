/**
 * 采集器（B4）回归测试：`t1.collector` 授权门 + 环境快照形状。
 *
 * 为什么存在：采集器读的是「本机环境 + 桌面」，属 §0 T1-1 的显式授予能力（默认关）。
 * 若 AI 侧不过权限层就能读屏，「默认关」这条边界形同虚设——必须有回归网。
 *
 * 覆盖：未授予 env/desktop 被拒且带授予提示、不采集；授予后 env 返回快照形状；
 * 授予后 desktop 在无 getSystemInput 时优雅降级；未知 scope 报错。
 */
import { describe, it, expect } from 'vitest'
import type { ToolContext } from '../electron/main/tools/base-tool'
import type { AuditEntry, SecurityGrants } from '../shared/types/permission'
import { CollectEnvironmentTool, collectEnvironment } from '../electron/main/tools/collect-environment'

const GRANTED: SecurityGrants = { grants: { 't1.collector': { key: 't1.collector', grantedAt: 1_700_000_000_000 } } }

function makeCtx(opts: { grants?: SecurityGrants; withSystemInput?: boolean } = {}): ToolContext {
  return {
    config: { securityGrants: opts.grants ?? { grants: {} } },
    ...(opts.withSystemInput
      ? { getSystemInput: () => ({ captureScreen: async () => ({ ok: true, imagePath: '/tmp/x.png', width: 1, height: 1 }) }) }
      : {})
  } as unknown as ToolContext
}

/** 审计 sink 注入 no-op：单测不得写仓库 data/（CODE-RULES §二 R-T2） */
function makeTool(): CollectEnvironmentTool {
  const noop = (_e: AuditEntry) => undefined
  return new CollectEnvironmentTool(noop)
}

describe('collect_environment：t1.collector 授权门', () => {
  it('未授予 env → 拒绝 + 授予提示，不采集', async () => {
    const r = await makeTool().execute({ scope: 'env' }, makeCtx())
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('t1.collector')
    expect(String(r.error)).toContain('授予方式')
    expect(r.data).toBeUndefined()
  })

  it('未授予 desktop → 同样被拒（桌面更敏感，不能绕）', async () => {
    const r = await makeTool().execute({ scope: 'desktop' }, makeCtx({ withSystemInput: true }))
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('t1.collector')
  })

  it('授予后 env → 返回环境快照（只读元数据）', async () => {
    const r = await makeTool().execute({ scope: 'env' }, makeCtx({ grants: GRANTED }))
    expect(r.ok).toBe(true)
    const env = (r.data as { environment: Record<string, unknown> }).environment
    expect(typeof env.platform).toBe('string')
    expect(typeof env.cpuUsagePct).toBe('number')
    expect(typeof env.totalMemGB).toBe('number')
  })

  it('授予后 desktop 但无系统输入引擎 → 优雅降级（不抛错）', async () => {
    const r = await makeTool().execute({ scope: 'desktop' }, makeCtx({ grants: GRANTED }))
    expect(r.ok).toBe(true)
    const d = (r.data as { desktop: { ok: boolean; error?: string } }).desktop
    expect(d.ok).toBe(false)
    expect(String(d.error)).toContain('系统输入引擎')
  })

  it('授予后 desktop 且有引擎 → 返回截图结果', async () => {
    const r = await makeTool().execute({ scope: 'desktop' }, makeCtx({ grants: GRANTED, withSystemInput: true }))
    expect(r.ok).toBe(true)
    const d = (r.data as { desktop: { ok: boolean; imagePath?: string } }).desktop
    expect(d.ok).toBe(true)
    expect(d.imagePath).toBe('/tmp/x.png')
  })

  it('未知 scope → 报错并列出可选值', async () => {
    const r = await makeTool().execute({ scope: 'camera' }, makeCtx({ grants: GRANTED }))
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('env')
  })
})

describe('collectEnvironment：快照形状（复用 runtime-profile 单源）', () => {
  it('返回结构化元数据且不含用户数据', () => {
    const snap = collectEnvironment()
    expect(Object.keys(snap).sort()).toEqual(
      ['cpuModel', 'cpuUsagePct', 'freeMemGB', 'logicalCores', 'physicalCores', 'platform', 'sampledAt', 'totalMemGB'].sort()
    )
    expect(snap.totalMemGB).toBeGreaterThan(0)
  })
})
