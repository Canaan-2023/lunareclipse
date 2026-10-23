/**
 * 权限授予面（`security:*`）+ 告知义务的回归。
 *
 * 为什么测：用户 2026-10-19 指出「前端 UI 没有权限授予的入口，也就是说当前无法授予任何权限
 * （还得有一份权限授予，所造成的损失，用户需自行承担的协议，做到告知义务）」。补入口的同时
 * 立了三条**结构性**约束，它们错了都不会报错，只会静默放开权限：
 * 1. **未确认告知义务 → 授不出去**（不是「弹个提示但照样能点」）；
 * 2. **撤回永不设门**（收紧权限的方向必须永远畅通）；
 * 3. **scoped 能力必须把范围填在目录自述的那个字段上**（填错字段 = 授予看似成功、动作全被拒，
 *    比直接拒绝更坏）。
 *
 * 另锁两条一致性：授予/撤回要进审计；条款小节的键必须在 i18n 字典里真的有（否则界面会显示
 * 一串键名——`useT` 对未知 key 回退为 key 原文，不报错）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import type { AppConfig, AuditEntry, SecurityGrant, SecurityGrants } from '@shared/types'
import { SECURITY_NOTICE_KEYS, SECURITY_NOTICE_VERSION, needsAcknowledgement } from '@shared/security/notice'
import { registerSecurityHandlers } from '../electron/main/ipc/handlers/security'
import { clearWakeArbiters, createWakeArbiter, registerWakeArbiter } from '../electron/main/room/wake'
import { getDictEntry } from '../src/i18n/locales'

// ===== 夹具：最小 ConfigStore + 假 ipcMain（只实现 handle/invoke 两个面）=====

function makeDeps(initial: SecurityGrants = { grants: {} }, extra: Partial<AppConfig> = {}) {
  let cfg = { securityGrants: initial, ...extra } as AppConfig
  const audit: AuditEntry[] = []
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc = {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  }
  registerSecurityHandlers(ipc as never, {
    configStore: {
      get: () => cfg,
      save: (next: AppConfig) => {
        cfg = next
      }
    } as never,
    getAuditFilePath: () => null,
    appendAudit: (e) => audit.push(e)
  })
  const invoke = async (channel: string, ...args: unknown[]): Promise<Record<string, unknown>> => {
    const h = handlers.get(channel)
    if (!h) throw new Error(`未注册的通道：${channel}`)
    return (await h({}, ...args)) as Record<string, unknown>
  }
  return { invoke, audit, grants: () => cfg.securityGrants ?? { grants: {} } }
}

const ACKED: SecurityGrants = {
  grants: {},
  acknowledged: { at: 1_700_000_000_000, version: SECURITY_NOTICE_VERSION }
}

// ===== 0.53.1：授权即事件（只唤醒真正被解锁的采集，且不惊群）=====

describe('授权即事件：授予 t1.collector 且采集器已开 → user-action 唤醒', () => {
  afterEach(() => clearWakeArbiters())

  const hits: string[] = []
  const arm = (): void => {
    clearWakeArbiters()
    hits.length = 0
    registerWakeArbiter(1, createWakeArbiter((source, detail) => hits.push(`${source}:${detail ?? ''}`)))
  }

  it('两层都满足才唤醒（采集器开 + 授予 t1.collector）', async () => {
    arm()
    const { invoke } = makeDeps({ ...ACKED, grants: {} }, { collector: { enabled: true } as AppConfig['collector'] })
    const r = await invoke('security:grant', { key: 't1.collector' })
    expect(r.ok).toBe(true)
    expect(hits).toEqual(['user-action:已授予 t1.collector'])
  })

  it('采集器开关没开 → 不唤醒（授了也采不到，白烧一轮）', async () => {
    arm()
    const { invoke } = makeDeps({ ...ACKED, grants: {} }, { collector: { enabled: false } as AppConfig['collector'] })
    const r = await invoke('security:grant', { key: 't1.collector' })
    expect(r.ok).toBe(true)
    expect(hits).toEqual([])
  })

  it('与采集无关的授予 → 不唤醒（不再广播惊群）', async () => {
    arm()
    const { invoke } = makeDeps({ ...ACKED, grants: {} }, { collector: { enabled: true } as AppConfig['collector'] })
    const r = await invoke('security:grant', { key: 't1.credentials' })
    expect(r.ok).toBe(true)
    expect(hits).toEqual([])
  })
})

// ===== 纯函数：是否需要告知义务确认 =====

describe('needsAcknowledgement：确认态判定（纯函数，双端同一份）', () => {
  it('从未确认 / 只有授予表 → 欠一次确认', () => {
    expect(needsAcknowledgement(undefined)).toBe(true)
    expect(needsAcknowledgement({ grants: {} })).toBe(true)
  })

  it('确认过且版本一致 → 不欠', () => {
    expect(needsAcknowledgement(ACKED)).toBe(false)
  })

  it('确认的是**旧条款**（版本落后）→ 视为未确认，要求重新确认', () => {
    const old: SecurityGrants = { grants: {}, acknowledged: { at: 1, version: SECURITY_NOTICE_VERSION - 1 } }
    expect(needsAcknowledgement(old)).toBe(true)
  })

  it('条款小节键与字典对得上（否则界面会显示一串键名，且不报错）', () => {
    expect(SECURITY_NOTICE_KEYS.length).toBeGreaterThan(0)
    for (const k of SECURITY_NOTICE_KEYS) {
      const entry = getDictEntry(k)
      expect(entry, `字典缺少条款小节 ${k}`).toBeTruthy()
      expect(entry?.zh?.trim()).toBeTruthy()
      expect(entry?.en?.trim()).toBeTruthy()
    }
  })
})

// ===== 告知义务门 =====

describe('告知义务：未确认则授不出去（门在主进程，不只是界面上的提示）', () => {
  it('未确认时授予被拒，原因说清「先确认条款」', async () => {
    const { invoke, grants } = makeDeps()
    const r = await invoke('security:grant', { key: 't1.collector' })
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('确认')
    expect(grants().grants['t1.collector']).toBeUndefined()
  })

  it('确认后授予通过；确认本身**不动任何授予**（两步分开）', async () => {
    const { invoke, grants } = makeDeps()
    const a = await invoke('security:acknowledge')
    expect(a.ok).toBe(true)
    expect(a.noticeVersion).toBe(SECURITY_NOTICE_VERSION)
    expect(Object.keys(grants().grants)).toEqual([])
    const r = await invoke('security:grant', { key: 't1.collector' })
    expect(r.ok).toBe(true)
    expect((r.grants as Record<string, SecurityGrant>)['t1.collector'].key).toBe('t1.collector')
  })

  it('**撤回永不设门**：未确认也能撤回（收紧权限的方向永远畅通）', async () => {
    const { invoke, grants } = makeDeps({ grants: { 't1.collector': { key: 't1.collector', grantedAt: 1 } } })
    const r = await invoke('security:revoke', 't1.collector')
    expect(r.ok).toBe(true)
    expect(grants().grants['t1.collector']).toBeUndefined()
  })

  it('确认会保留已有授予（确认不是重置）', async () => {
    const { invoke, grants } = makeDeps({ grants: { 't1.collector': { key: 't1.collector', grantedAt: 7 } } })
    await invoke('security:acknowledge')
    expect(grants().grants['t1.collector'].grantedAt).toBe(7)
    expect(grants().acknowledged?.version).toBe(SECURITY_NOTICE_VERSION)
  })
})

// ===== 授予表本身的校验纪律（既有约束，此处一并锁住）=====

describe('授予：只接受 T1，且 scoped 必须填对字段', () => {
  it('T0 永不可授予；T2 无需授予；未登记的能力一律拒', async () => {
    const { invoke } = makeDeps(ACKED)
    for (const key of ['t0.bypass-approval', 't2.room-avatar', 'nope.nope']) {
      const r = await invoke('security:grant', { key })
      expect(r.ok, key).toBe(false)
    }
  })

  it('范围条目在主进程 trim / 去重 / 截断（与渲染侧同口径）', async () => {
    const { invoke, grants } = makeDeps(ACKED)
    const long = 'x'.repeat(300)
    const r = await invoke('security:grant', {
      key: 't1.migrate',
      scope: { nodes: [' 2 ', '2', '   ', long] }
    })
    expect(r.ok).toBe(true)
    expect(grants().grants['t1.migrate']?.scope?.nodes).toEqual(['2', 'x'.repeat(200)])
  })
  it('scoped 能力缺范围 → 拒；范围填错字段 → 也拒（否则授予看似成功、动作全被拒）', async () => {
    const { invoke, grants } = makeDeps(ACKED)
    expect((await invoke('security:grant', { key: 't1.authorized-target-ops' })).ok).toBe(false)
    const wrong = await invoke('security:grant', {
      key: 't1.authorized-target-ops',
      scope: { endpoints: ['https://example.com'] }
    })
    expect(wrong.ok).toBe(false)
    expect(String(wrong.error)).toContain('targets')
    const ok = await invoke('security:grant', {
      key: 't1.authorized-target-ops',
      scope: { targets: ['10.0.0.5'] }
    })
    expect(ok.ok).toBe(true)
    expect(grants().grants['t1.authorized-target-ops'].scope?.targets).toEqual(['10.0.0.5'])
  })
})

// ===== 审计 =====

describe('审计：授予与撤回也留痕（不只裁决）', () => {
  it('授予 / 撤回各落一条，actor=user；确认不落（确认记录本身带时间戳，在授予表里）', async () => {
    const { invoke, audit } = makeDeps(ACKED)
    await invoke('security:grant', { key: 't1.collector' })
    await invoke('security:revoke', 't1.collector')
    await invoke('security:acknowledge')
    expect(audit.map((e) => e.action)).toEqual(['security:grant', 'security:revoke'])
    for (const e of audit) {
      expect(e.actor).toBe('user')
      expect(e.capability).toBe('t1.collector')
      expect(e.decision).toBe('allow')
    }
  })

  it('撤回一个从未授予的键：不报错、也不留假审计', async () => {
    const { invoke, audit } = makeDeps(ACKED)
    const r = await invoke('security:revoke', 't1.collector')
    expect(r.ok).toBe(true)
    expect(audit).toHaveLength(0)
  })
})

// ===== 读取面 =====

describe('security:listCapabilities：目录 + 授予 + 确认态', () => {
  it('未确认时 acknowledged=false；确认后为 true 且带确认时刻', async () => {
    const { invoke } = makeDeps()
    const before = await invoke('security:listCapabilities')
    expect(before.ok).toBe(true)
    expect(before.acknowledged).toBe(false)
    expect(before.acknowledgedAt).toBeNull()
    expect(before.noticeVersion).toBe(SECURITY_NOTICE_VERSION)
    await invoke('security:acknowledge')
    const after = await invoke('security:listCapabilities')
    expect(after.acknowledged).toBe(true)
    expect(typeof after.acknowledgedAt).toBe('number')
  })

  it('目录来自唯一真源（不是本 handler 里另写的一份清单）', async () => {
    const { invoke } = makeDeps()
    const r = await invoke('security:listCapabilities')
    const caps = r.capabilities as Array<{ key: string; tier: string }>
    expect(caps.some((c) => c.key === 't1.collector' && c.tier === 'T1')).toBe(true)
    expect(caps.some((c) => c.tier === 'T0')).toBe(true)
    expect(caps.some((c) => c.tier === 'T2')).toBe(true)
  })
})
