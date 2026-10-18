/**
 * 三层权限层（T0/T1/T2）与唯一 policy 检查点回归测试（B0 批次）。
 *
 * 为什么存在：交接单 §0 要求「T0 每条断言被拒；T1 每条授予后放行 / 未授予被拒**双向**测试进门禁」。
 * 权限层是分发产品的法律责任边界，无回归网等于随时被改回去。
 *
 * 覆盖：
 * 1. T0 六项逐条断言被拒（且即使授予表含 T0 键仍拒）
 * 2. T1 十一项逐条双向（未授予 → t1_not_granted；授予后 → allowed）
 * 3. scoped 能力越界即拒（t1_out_of_scope）；授予无范围 / 动作无范围亦拒
 * 4. 授予过期即拒（t1_expired）
 * 5. T2 默认放行；未登记能力 fail-closed
 * 6. actor 不参与放行判定（user / ai 同结论）
 * 7. 每次裁决（含放行）落一条审计；审计 sink 抛错不改变裁决
 * 8. 用户 IPC：grant 拒绝 T0/T2 键、scoped 必须带范围、revoke 生效（AI 不可自我授权的结构面）
 * 9. 审计文件 sink 追加 + 尾部读取（真实 FS，mkdtemp）
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AuditEntry, GrantScope, SecurityGrants } from '../shared/types/permission'
import {
  T0_CAPABILITIES,
  T1_CAPABILITIES,
  T2_CAPABILITIES,
  isGrantable,
  resolveCapability
} from '../shared/security/tiers'
import { evaluatePolicy, scopeWithin, EMPTY_GRANTS, type PolicyDeps } from '../electron/main/tools/security-engine/policy-gate'
import { createFileAuditSink, createMemoryAuditSink, readAuditTail } from '../electron/main/tools/security-engine/audit-log'
import { registerSecurityHandlers } from '../electron/main/ipc/handlers/security'

const FIXED_NOW = 1_700_000_000_000

/** 构造裁决依赖：固定时钟 + 递增 id + 可选审计 sink */
function makeDeps(grants: SecurityGrants = EMPTY_GRANTS, audit?: (e: AuditEntry) => void): PolicyDeps {
  let n = 0
  return { getGrants: () => grants, now: () => FIXED_NOW, audit, nextId: () => `a${++n}` }
}

/** scoped 能力的「合规范围」样例 */
const SCOPE_SAMPLE: Record<string, GrantScope> = {
  't1.authorized-target-ops': { targets: ['example.test'] },
  't1.migrate': { nodes: ['node-a'] },
  't1.declared-egress': { endpoints: ['https://declared.example/v1'] }
}

describe('T0 硬禁止：六项逐条被拒', () => {
  it('每条 T0 能力裁决为 deny / t0_denied', () => {
    const deps = makeDeps()
    for (const cap of T0_CAPABILITIES) {
      const d = evaluatePolicy({ capability: cap.key, action: 'probe', actor: 'ai' }, deps)
      expect(d.allowed, cap.key).toBe(false)
      expect(d.tier, cap.key).toBe('T0')
      expect(d.code, cap.key).toBe('t0_denied')
    }
  })

  it('即使授予表被塞入 T0 键，仍拒绝（配置不能打开硬禁止）', () => {
    const t0 = T0_CAPABILITIES[0]
    const grants: SecurityGrants = { grants: { [t0.key]: { key: t0.key, grantedAt: FIXED_NOW } } }
    const d = evaluatePolicy({ capability: t0.key, action: 'probe', actor: 'user' }, makeDeps(grants))
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('t0_denied')
  })

  it('T0 不可授予（isGrantable=false）', () => {
    for (const cap of T0_CAPABILITIES) expect(isGrantable(cap.key), cap.key).toBe(false)
  })
})

describe('T1 显式授予：十一项逐条双向', () => {
  it('未授予 → deny / t1_not_granted（附授予指引）', () => {
    const deps = makeDeps()
    for (const cap of T1_CAPABILITIES) {
      const d = evaluatePolicy({ capability: cap.key, action: 'act', actor: 'ai' }, deps)
      expect(d.allowed, cap.key).toBe(false)
      expect(d.code, cap.key).toBe('t1_not_granted')
      expect(d.grantHint, cap.key).toContain(cap.key)
    }
  })

  it('授予后 → allow（scoped 能力带合规范围）', () => {
    for (const cap of T1_CAPABILITIES) {
      const scope = SCOPE_SAMPLE[cap.key]
      const grants: SecurityGrants = { grants: { [cap.key]: { key: cap.key, grantedAt: FIXED_NOW, scope } } }
      const d = evaluatePolicy({ capability: cap.key, action: 'act', actor: 'ai', scope }, makeDeps(grants))
      expect(d.allowed, cap.key).toBe(true)
      expect(d.code, cap.key).toBe('allowed')
      expect(d.tier, cap.key).toBe('T1')
    }
  })

  it('T1 均可授予（isGrantable=true）', () => {
    for (const cap of T1_CAPABILITIES) expect(isGrantable(cap.key), cap.key).toBe(true)
  })
})

describe('T1 授权上下文：范围与有效期', () => {
  const key = 't1.authorized-target-ops'

  it('动作目标不在授予范围内 → t1_out_of_scope', () => {
    const grants: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW, scope: { targets: ['a.test'] } } } }
    const d = evaluatePolicy(
      { capability: key, action: 'scan', actor: 'ai', scope: { targets: ['b.test'] } },
      makeDeps(grants)
    )
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('t1_out_of_scope')
    expect(d.reason).toContain('b.test')
  })

  it('授予无范围 → 拒绝（scoped 能力必须有范围）', () => {
    const grants: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW } } }
    const d = evaluatePolicy({ capability: key, action: 'scan', actor: 'ai', scope: { targets: ['a.test'] } }, makeDeps(grants))
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('t1_out_of_scope')
  })

  it('动作未携带范围 → 拒绝', () => {
    const grants: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW, scope: { targets: ['a.test'] } } } }
    const d = evaluatePolicy({ capability: key, action: 'scan', actor: 'ai' }, makeDeps(grants))
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('t1_out_of_scope')
  })

  it('授予过期 → t1_expired', () => {
    const grants: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW - 1000, expiresAt: FIXED_NOW - 1 } } }
    const d = evaluatePolicy({ capability: key, action: 'scan', actor: 'ai', scope: { targets: ['a.test'] } }, makeDeps(grants))
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('t1_expired')
  })

  it('scopeWithin：子集放行、越界拒绝、空范围拒绝', () => {
    expect(scopeWithin({ targets: ['a'] }, { targets: ['a', 'b'] }).ok).toBe(true)
    expect(scopeWithin({ targets: ['c'] }, { targets: ['a', 'b'] }).ok).toBe(false)
    expect(scopeWithin(undefined, { targets: ['a'] }).ok).toBe(false)
  })
})

describe('T2 默认开 与 未登记能力 fail-closed', () => {
  it('每条 T2 能力默认放行，无需授予', () => {
    const deps = makeDeps()
    for (const cap of T2_CAPABILITIES) {
      const d = evaluatePolicy({ capability: cap.key, action: 'read', actor: 'ai' }, deps)
      expect(d.allowed, cap.key).toBe(true)
      expect(d.code, cap.key).toBe('allowed')
      expect(d.tier, cap.key).toBe('T2')
    }
  })

  it('T2 无需授予（isGrantable=false）', () => {
    for (const cap of T2_CAPABILITIES) expect(isGrantable(cap.key), cap.key).toBe(false)
  })

  it('未登记能力 → unknown_capability（fail-closed，不默认放行）', () => {
    const d = evaluatePolicy({ capability: 't9.nonexistent', action: 'x', actor: 'ai' }, makeDeps())
    expect(d.allowed).toBe(false)
    expect(d.code).toBe('unknown_capability')
    expect(d.tier).toBe('unknown')
  })
})

describe('actor 不参与放行判定（AI 不能自我放宽）', () => {
  it('同一能力、同一授予表下，user 与 ai 结论一致', () => {
    const key = 't1.executor-high-risk'
    const granted: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW } } }
    const ai = evaluatePolicy({ capability: key, action: 'exec', actor: 'ai' }, makeDeps(granted))
    const user = evaluatePolicy({ capability: key, action: 'exec', actor: 'user' }, makeDeps(granted))
    expect(ai.allowed).toBe(true)
    expect(user.allowed).toBe(true)

    const aiDenied = evaluatePolicy({ capability: key, action: 'exec', actor: 'ai' }, makeDeps())
    const userDenied = evaluatePolicy({ capability: key, action: 'exec', actor: 'user' }, makeDeps())
    expect(aiDenied.allowed).toBe(false)
    expect(userDenied.allowed).toBe(false)
  })
})

describe('审计：每次裁决落一条，且不影响裁决结果', () => {
  it('放行与拒绝都落审计，条目字段与裁决一致', () => {
    const mem = createMemoryAuditSink()
    const key = 't1.executor-high-risk'
    const granted: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW } } }

    const ok = evaluatePolicy({ capability: key, action: 'exec', actor: 'ai' }, makeDeps(granted, mem.sink))
    const no = evaluatePolicy({ capability: 't0.harm-others', action: 'wipe', actor: 'ai' }, makeDeps(granted, mem.sink))

    expect(mem.entries).toHaveLength(2)
    expect(mem.entries[0]).toMatchObject({ id: ok.auditId, decision: 'allow', code: 'allowed', capability: key, actor: 'ai' })
    expect(mem.entries[1]).toMatchObject({ id: no.auditId, decision: 'deny', code: 't0_denied' })
  })

  it('审计 sink 抛错不改变裁决（审计是旁路）', () => {
    const key = 't1.executor-high-risk'
    const granted: SecurityGrants = { grants: { [key]: { key, grantedAt: FIXED_NOW } } }
    const boom = () => {
      throw new Error('audit down')
    }
    const d = evaluatePolicy({ capability: key, action: 'exec', actor: 'ai' }, makeDeps(granted, boom))
    expect(d.allowed).toBe(true)
  })
})

describe('用户 IPC：授予/撤回（AI 不可自我授权的结构面）', () => {
  interface FakeIpc {
    handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void
  }
  function makeIpc(): FakeIpc {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    return { handlers, handle: (channel, fn) => handlers.set(channel, fn) }
  }
  function makeStore(initial: Record<string, unknown> = {}) {
    let cfg = { securityGrants: { grants: {} }, ...initial } as Record<string, unknown>
    return {
      get: () => cfg,
      save: (c: Record<string, unknown>) => {
        cfg = c
      }
    }
  }
  function register(ipc: FakeIpc, store: ReturnType<typeof makeStore>) {
    registerSecurityHandlers(ipc as never, {
      configStore: store as never,
      getAuditFilePath: () => null
    })
  }

  it('grant：T1 键成功写入并回传授予表', async () => {
    const ipc = makeIpc()
    const store = makeStore()
    register(ipc, store)
    const res = (await ipc.handlers.get('security:grant')!({}, { key: 't1.executor-high-risk' })) as {
      ok: boolean
      grants: Record<string, unknown>
    }
    expect(res.ok).toBe(true)
    expect(res.grants['t1.executor-high-risk']).toBeTruthy()
  })

  it('grant：拒绝 T0 与 T2 键（不可授予）', async () => {
    const ipc = makeIpc()
    register(ipc, makeStore())
    const t0 = (await ipc.handlers.get('security:grant')!({}, { key: T0_CAPABILITIES[0].key })) as { ok: boolean; error?: string }
    const t2 = (await ipc.handlers.get('security:grant')!({}, { key: T2_CAPABILITIES[0].key })) as { ok: boolean; error?: string }
    expect(t0.ok).toBe(false)
    expect(t2.ok).toBe(false)
  })

  it('grant：scoped 能力必须带范围', async () => {
    const ipc = makeIpc()
    register(ipc, makeStore())
    const noScope = (await ipc.handlers.get('security:grant')!({}, { key: 't1.authorized-target-ops' })) as { ok: boolean }
    const withScope = (await ipc.handlers.get('security:grant')!({}, {
      key: 't1.authorized-target-ops',
      scope: { targets: ['x.test'] }
    })) as { ok: boolean }
    expect(noScope.ok).toBe(false)
    expect(withScope.ok).toBe(true)
  })

  it('revoke：删除授予即生效', async () => {
    const ipc = makeIpc()
    const store = makeStore()
    register(ipc, store)
    await ipc.handlers.get('security:grant')!({}, { key: 't1.collector' })
    const res = (await ipc.handlers.get('security:revoke')!({}, 't1.collector')) as { ok: boolean; grants: Record<string, unknown> }
    expect(res.ok).toBe(true)
    expect(res.grants['t1.collector']).toBeUndefined()
  })
})

describe('审计文件 sink（真实 FS）', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('追加写 + 尾部读取（限制条数、跳过损坏行）', () => {
    dir = mkdtempSync(join(tmpdir(), 'le-sec-'))
    const file = join(dir, 'nested', 'audit.jsonl')
    const sink = createFileAuditSink(file)
    const base: Omit<AuditEntry, 'id'> = {
      ts: FIXED_NOW,
      capability: 't1.collector',
      action: 'collect',
      actor: 'ai',
      tier: 'T1',
      decision: 'allow',
      code: 'allowed',
      reason: 'ok'
    }
    sink({ ...base, id: '1' })
    sink({ ...base, id: '2' })
    sink({ ...base, id: '3' })
    expect(readAuditTail(file, 2).map((e) => e.id)).toEqual(['2', '3'])
    expect(readAuditTail(file, 10)).toHaveLength(3)
  })

  it('文件不存在返回空数组', () => {
    dir = mkdtempSync(join(tmpdir(), 'le-sec-'))
    expect(readAuditTail(join(dir, 'missing.jsonl'))).toEqual([])
  })
})

describe('分级目录自洽', () => {
  it('T0/T1/T2 共 26 条，key 唯一', () => {
    const all = [...T0_CAPABILITIES, ...T1_CAPABILITIES, ...T2_CAPABILITIES]
    expect(all).toHaveLength(26)
    expect(new Set(all.map((c) => c.key)).size).toBe(26)
  })

  it('scoped 能力恰为三项（授权目标 / 节点白名单 / 已声明端点）', () => {
    const scoped = [...T0_CAPABILITIES, ...T1_CAPABILITIES, ...T2_CAPABILITIES].filter((c) => c.scoped).map((c) => c.key)
    expect(scoped.sort()).toEqual(['t1.authorized-target-ops', 't1.declared-egress', 't1.migrate'])
  })

  it('resolveCapability 未登记返回 undefined', () => {
    expect(resolveCapability('t9.nope')).toBeUndefined()
    expect(resolveCapability('t1.collector')?.tier).toBe('T1')
  })
})
