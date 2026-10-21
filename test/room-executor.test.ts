/**
 * ROOM 执行器（B5）回归测试：`t1.executor-high-risk` / `t1.tool-zone-enable` 门控与结果回传。
 *
 * 为什么存在：自主循环里没有「逐次弹窗」，授权只能来自 §0 的逐项授予——执行器是这条边界的
 * 唯一执行点。若它不过权限层，自主模式就变成「无门控执行」，直接破 §0。
 *
 * 覆盖：只读走 T2 免授予 / 高风险未授予 → 拒绝且**不执行** / 授予后执行并回传结果 /
 * 工具区产物先过 `t1.tool-zone-enable`（顺序纪律）/ 双授予通过 / 执行体抛错 → 标记失败但保留放行裁决。
 *
 * P0-2（2026-10-18 工程保障团队）：只读性**由工具元数据判定**（`isReadOnly` 注入），
 * 决策对象里已无 `readOnly` 字段——本文件用「只读工具名白名单」模拟注册表元数据。
 */
import { describe, it, expect } from 'vitest'
import type { AuditEntry, PolicyDecision, PolicyRequest, SecurityGrants } from '../shared/types/permission'
import { createExecutor, capabilityForReadOnly, type ExecutorDecision } from '../electron/main/room/executor'

const GRANTS_ACTION: SecurityGrants = {
  grants: { 't1.executor-high-risk': { key: 't1.executor-high-risk', grantedAt: 1 } }
}
const GRANTS_BOTH: SecurityGrants = {
  grants: {
    't1.executor-high-risk': { key: 't1.executor-high-risk', grantedAt: 1 },
    't1.tool-zone-enable': { key: 't1.tool-zone-enable', grantedAt: 1 }
  }
}

/** 用真实语义近似 evaluatePolicy：T2 放行；T1 看授予表 */
function makeEvaluate(grants: SecurityGrants, calls: PolicyRequest[]): (req: PolicyRequest) => PolicyDecision {
  return (req) => {
    calls.push(req)
    const t2 = req.capability.startsWith('t2.')
    const granted = grants.grants[req.capability] != null
    const allowed = t2 || granted
    return {
      allowed,
      tier: t2 ? 'T2' : 'T1',
      code: allowed ? 'allowed' : 't1_not_granted',
      reason: allowed ? 'ok' : `${req.capability} 未授予`,
      ...(allowed ? {} : { grantHint: `授予方式：…${req.capability}` }),
      auditId: `a${calls.length}`
    }
  }
}

function makeHarness(
  grants: SecurityGrants,
  runImpl?: () => Promise<{ ok: boolean; error?: string }>,
  /** 模拟工具注册表元数据：列在这里的工具名视为 `behavior.readOnly === true` */
  readOnlyTools: string[] = []
) {
  const calls: PolicyRequest[] = []
  const ran: ExecutorDecision[] = []
  const executor = createExecutor({
    getGrants: () => grants,
    evaluate: makeEvaluate(grants, calls),
    isReadOnly: (toolName) => readOnlyTools.includes(toolName),
    run: async (d) => {
      ran.push(d)
      return runImpl ? runImpl() : { ok: true }
    }
  })
  return { executor, calls, ran }
}

const HIGH_RISK: ExecutorDecision = { kind: 'command', description: '执行命令 npm test' }
const READ_ONLY: ExecutorDecision = { kind: 'tool', toolName: 'read', description: '读取文件' }
const TOOL_ZONE: ExecutorDecision = {
  kind: 'tool',
  toolName: 'my-custom-tool',
  description: '运行 AI 自造工具',
  fromToolZone: true
}

describe('capabilityForReadOnly：只读性 → 能力键', () => {
  it('只读 → T2；其余 → T1-2', () => {
    expect(capabilityForReadOnly(true)).toBe('t2.readonly-tools')
    expect(capabilityForReadOnly(false)).toBe('t1.executor-high-risk')
  })
})

describe('executor：动作授权', () => {
  it('只读工具（元数据判定）免授予，直接执行', async () => {
    const h = makeHarness({ grants: {} }, undefined, ['read'])
    const r = await h.executor.execute(READ_ONLY)
    expect(r.ok).toBe(true)
    expect(h.ran).toHaveLength(1)
  })

  it('未声明只读的工具 → 按高风险，未授予即拒（不得因名字像只读而放行）', async () => {
    const h = makeHarness({ grants: {} }) // 白名单为空 = 元数据未声明只读
    const r = await h.executor.execute(READ_ONLY)
    expect(r.ok).toBe(false)
    expect(r.rejectedAt).toBe('action')
    expect(String(r.decision.grantHint)).toContain('t1.executor-high-risk')
    expect(h.ran).toHaveLength(0)
  })

  it('非 tool 类动作（command/device/external）一律按高风险（fail-closed）', async () => {
    const h = makeHarness({ grants: {} }, undefined, ['read'])
    const r = await h.executor.execute({ kind: 'device', description: '操作设备' })
    expect(r.ok).toBe(false)
    expect(String(r.decision.grantHint)).toContain('t1.executor-high-risk')
  })

  it('高风险未授予 → 拒绝且不执行', async () => {
    const h = makeHarness({ grants: {} })
    const r = await h.executor.execute(HIGH_RISK)
    expect(r.ok).toBe(false)
    expect(r.rejectedAt).toBe('action')
    expect(String(r.decision.grantHint)).toContain('t1.executor-high-risk')
    expect(h.ran).toHaveLength(0)
  })

  it('高风险已授予 → 执行并回传结果', async () => {
    const h = makeHarness(GRANTS_ACTION)
    const r = await h.executor.execute(HIGH_RISK)
    expect(r.ok).toBe(true)
    expect(r.result).toEqual({ ok: true })
    expect(h.ran).toHaveLength(1)
  })
})

describe('executor：工具区授权（顺序纪律）', () => {
  it('工具区产物未授予 t1.tool-zone-enable → 拒绝，且不再问动作授权', async () => {
    const h = makeHarness(GRANTS_ACTION)
    const r = await h.executor.execute(TOOL_ZONE)
    expect(r.ok).toBe(false)
    expect(r.rejectedAt).toBe('tool-zone')
    expect(h.ran).toHaveLength(0)
    // 只应问过 tool-zone，不应继续问动作授权
    expect(h.calls.map((c) => c.capability)).toEqual(['t1.tool-zone-enable'])
  })

  it('双授予 → 先工具区后动作，两问都发生并执行', async () => {
    const h = makeHarness(GRANTS_BOTH)
    const r = await h.executor.execute(TOOL_ZONE)
    expect(r.ok).toBe(true)
    expect(h.calls.map((c) => c.capability)).toEqual(['t1.tool-zone-enable', 't1.executor-high-risk'])
    expect(h.ran).toHaveLength(1)
  })
})

describe('executor：执行体异常', () => {
  it('抛错 → 结果标记失败，但保留「已放行」的裁决语义', async () => {
    const h = makeHarness(GRANTS_ACTION, async () => {
      throw new Error('boom')
    })
    const r = await h.executor.execute(HIGH_RISK)
    expect(r.ok).toBe(false)
    expect(r.decision.allowed).toBe(true)
    expect(String(r.result?.error)).toContain('boom')
  })

  it('执行体返回失败 → ok=false 但保留结果', async () => {
    const h = makeHarness(GRANTS_ACTION, async () => ({ ok: false, error: '工具内部失败' }))
    const r = await h.executor.execute(HIGH_RISK)
    expect(r.ok).toBe(false)
    expect(r.result).toEqual({ ok: false, error: '工具内部失败' })
  })
})

describe('executor：审计可观测', () => {
  it('每次裁决都被问到（可据此落审计）', async () => {
    const audit: AuditEntry[] = []
    const calls: PolicyRequest[] = []
    const grants = GRANTS_ACTION
    const executor = createExecutor({
      getGrants: () => grants,
      evaluate: (req) => {
        calls.push(req)
        const d = makeEvaluate(grants, [])(req)
        audit.push({ id: d.auditId, ts: 0, capability: req.capability, action: req.action, actor: req.actor, tier: d.tier as never, decision: d.allowed ? 'allow' : 'deny', code: d.code, reason: d.reason })
        return d
      },
      isReadOnly: () => false,
      run: async () => ({ ok: true })
    })
    await executor.execute(HIGH_RISK)
    expect(audit).toHaveLength(1)
    expect(audit[0].capability).toBe('t1.executor-high-risk')
    expect(audit[0].actor).toBe('ai')
  })
})
