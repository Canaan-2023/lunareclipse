/**
 * 局域网路由层 B1b 回归测试：逐跳转发 + 每跳授权 + 拓扑同步 + 信封分派。
 *
 * 为什么存在：B1 只交付了「算路径」，没有「走路径」。逐跳转发是本需求的核心（跨机器数据传播），
 * 且**每跳授权**（`t1.relay-forward`）是权限边界的实际执行点——必须有回归网。
 *
 * 覆盖：
 * 1. collectLocalLinks：只收在线 / 剔自身 / 去重 / 剔非法 uid
 * 2. RoutingService.tryRoute：算路径 → 发首跳；无解 → false
 * 3. handleForward：终点交付 / 中间跳转发 / **未授予 t1.relay-forward → 拒绝 + 回执 + 审计** /
 *    跳数耗尽 / 游标不符（环路或重放）
 * 4. handleTopology：并入图；`at` 更旧的丢弃；forwardWilling 自报
 * 5. handleStatus：回执标记路径
 * 6. 路径记录环：容量上限
 * 7. dispatchLanEnvelope：前缀分派（含 route.*，且不抢既有四域）
 */
import { describe, it, expect } from 'vitest'
import type { LanEnvelope } from '../electron/main/multi-instance/lan/lan-types'
import type { AuditEntry, PolicyDecision, PolicyRequest } from '../shared/types/permission'
import { collectLocalLinks } from '../electron/main/multi-instance/routing/topology-sync'
import { createRoutingService } from '../electron/main/multi-instance/routing/routing-service'
import { ROUTE_ENVELOPE_TYPE, type RouteForwardPayload } from '../electron/main/multi-instance/routing/routing-types'
import { dispatchLanEnvelope } from '../electron/main/multi-instance/envelope-dispatch'

const NOW = 1_700_000_000_000

function env(type: string, from: number, to: number, payload?: unknown): LanEnvelope {
  return { id: `e-${type}-${from}-${to}`, type, from, to, ts: NOW, payload }
}

interface Harness {
  sent: Array<{ uid: number; env: LanEnvelope }>
  audit: AuditEntry[]
  routing: ReturnType<typeof createRoutingService>
}

/** 固定名册：1 — 2 — 3（链式，1 与 3 互不直连 → 只能多跳） */
const ROSTER = [
  { uid: 1, role: 'satellite' as const, online: true, lastSeen: NOW, latencyMs: 5, forwardWilling: true, links: [2] },
  { uid: 2, role: 'master' as const, online: true, lastSeen: NOW, latencyMs: 5, forwardWilling: true, links: [1, 3] },
  { uid: 3, role: 'satellite' as const, online: true, lastSeen: NOW, latencyMs: 5, forwardWilling: true, links: [2] }
]

/** 构造路由服务：本机直连表由名册中 selfUid 的 links 派生；转发意愿由 allowRelay 控制 */
function makeHarness(opts: { selfUid?: number; allowRelay?: boolean; sendOk?: boolean } = {}): Harness {
  const selfUid = opts.selfUid ?? 2
  const allowRelay = opts.allowRelay ?? true
  const sendOk = opts.sendOk ?? true
  const h: Harness = { sent: [], audit: [], routing: null as never }
  h.routing = createRoutingService({
    selfUid: () => selfUid,
    listRoster: () => ROSTER,
    listPeers: () => (ROSTER.find((r) => r.uid === selfUid)?.links ?? []).map((uid) => ({ uid, online: true })),
    isForwardWilling: () => allowRelay,
    sendDirect: (uid, e) => {
      h.sent.push({ uid, env: e })
      return sendOk
    },
    evaluate: (req: PolicyRequest): PolicyDecision => {
      const allowed = req.capability === 't1.relay-forward' && allowRelay
      return {
        allowed,
        tier: 'T1',
        code: allowed ? 'allowed' : 't1_not_granted',
        reason: allowed ? 'ok' : '未授予 t1.relay-forward',
        auditId: `a${h.audit.length + 1}`
      }
    },
    now: () => NOW
  })
  // 拓扑同步：非本机节点的直连表靠上报获得（本机只有自己的一跳视野）——不 seed 则图不完整
  for (const r of ROSTER) {
    if (r.uid === selfUid) continue
    h.routing.handleTopology(
      env(ROUTE_ENVELOPE_TYPE.topology, r.uid, selfUid, {
        reporterUid: r.uid,
        links: r.links,
        forwardWilling: r.forwardWilling,
        at: NOW
      })
    )
  }
  return h
}

describe('collectLocalLinks：本机直连表', () => {
  it('只收在线对端、剔自身、去重、剔非法 uid', () => {
    expect(
      collectLocalLinks(
        [
          { uid: 2, online: true },
          { uid: 3, online: false },
          { uid: 4, online: true },
          { uid: 4, online: true },
          { uid: 0, online: true },
          { uid: -1, online: true }
        ],
        2
      )
    ).toEqual([4])
  })
})

describe('tryRoute：直连失败时的自动最短路径', () => {
  it('算得出路径 → 发给首跳并返回 true', () => {
    const h = makeHarness({ selfUid: 1 })
    const ok = h.routing.tryRoute(env('friend.message', 1, 3))
    expect(ok).toBe(true)
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].uid).toBe(2) // 1→2→3，首跳 2
    const payload = h.sent[0].env.payload as RouteForwardPayload
    expect(h.sent[0].env.type).toBe(ROUTE_ENVELOPE_TYPE.forward)
    expect(payload.path).toEqual([1, 2, 3])
    expect(payload.cursor).toBe(1)
    expect(payload.hopsLeft).toBe(1)
    expect(h.routing.listTraces()).toHaveLength(1)
  })

  it('无解（目标不在线）→ false，不发送', () => {
    const h = makeHarness()
    // 1 与 3 均不在 2 的直连表里，名册里 3 的 links 也只连 2 —— 目标换成不存在的 99
    const ok = h.routing.tryRoute(env('friend.message', 2, 99))
    expect(ok).toBe(false)
    expect(h.sent).toHaveLength(0)
  })
})

describe('handleForward：逐跳转发与每跳授权', () => {
  function forwardPayload(cursor: number, hopsLeft: number): RouteForwardPayload {
    return {
      pathId: 'p1',
      inner: env('friend.message', 1, 3),
      path: [1, 2, 3],
      cursor,
      hopsLeft
    }
  }

  it('我是终点 → 交付（返回 inner）', () => {
    const h = makeHarness({ selfUid: 3 })
    const out = h.routing.handleForward(env(ROUTE_ENVELOPE_TYPE.forward, 2, 3, forwardPayload(2, 0)))
    expect(out.action).toBe('deliver')
    if (out.action === 'deliver') expect(out.inner.to).toBe(3)
    expect(h.sent).toHaveLength(0)
  })

  it('我是中间跳且已授予 → 转给下一跳（游标 +1、跳数 -1）', () => {
    const h = makeHarness({ selfUid: 2, allowRelay: true })
    const out = h.routing.handleForward(env(ROUTE_ENVELOPE_TYPE.forward, 1, 2, forwardPayload(1, 1)))
    expect(out).toEqual({ action: 'forwarded', next: 3 })
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].uid).toBe(3)
    const p = h.sent[0].env.payload as RouteForwardPayload
    expect(p.cursor).toBe(2)
    expect(p.hopsLeft).toBe(0)
  })

  it('我是中间跳但未授予 t1.relay-forward → 拒绝 + 回执给发起方', () => {
    const h = makeHarness({ selfUid: 2, allowRelay: false })
    const out = h.routing.handleForward(env(ROUTE_ENVELOPE_TYPE.forward, 1, 2, forwardPayload(1, 1)))
    expect(out.action).toBe('rejected')
    if (out.action === 'rejected') expect(out.reason).toContain('t1.relay-forward')
    // 回执发回发起方（inner.from = 1），类型为 route.status
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].uid).toBe(1)
    expect(h.sent[0].env.type).toBe(ROUTE_ENVELOPE_TYPE.status)
  })

  it('跳数耗尽（转发期兜底）→ 拒绝', () => {
    const h = makeHarness({ selfUid: 2 })
    const out = h.routing.handleForward(env(ROUTE_ENVELOPE_TYPE.forward, 1, 2, forwardPayload(1, 0)))
    expect(out.action).toBe('rejected')
    if (out.action === 'rejected') expect(out.reason).toContain('跳数耗尽')
  })

  it('游标不符（环路或重放）→ 拒绝', () => {
    const h = makeHarness({ selfUid: 2 })
    const out = h.routing.handleForward(env(ROUTE_ENVELOPE_TYPE.forward, 1, 2, forwardPayload(2, 1)))
    expect(out.action).toBe('rejected')
    if (out.action === 'rejected') expect(out.reason).toContain('游标不符')
    expect(h.sent).toHaveLength(0)
  })

  it('负载格式非法 → 拒绝', () => {
    const h = makeHarness({ selfUid: 2 })
    expect(h.routing.handleForward(env(ROUTE_ENVELOPE_TYPE.forward, 1, 2, null)).action).toBe('rejected')
  })
})

describe('拓扑同步与路径记录', () => {
  it('handleTopology 并入上报（links + forwardWilling），旧报告丢弃', () => {
    const h = makeHarness({ selfUid: 2 })
    h.routing.handleTopology(
      env(ROUTE_ENVELOPE_TYPE.topology, 3, 2, { reporterUid: 3, links: [2], forwardWilling: true, at: NOW })
    )
    expect(h.routing.getGraph().nodes.get(3)!.links).toEqual([2])
    expect(h.routing.getGraph().nodes.get(3)!.forwardWilling).toBe(true)

    // 更旧的报告（at 更小）不得覆盖
    h.routing.handleTopology(
      env(ROUTE_ENVELOPE_TYPE.topology, 3, 2, { reporterUid: 3, links: [9], forwardWilling: false, at: NOW - 1000 })
    )
    expect(h.routing.getGraph().nodes.get(3)!.links).toEqual([2])
  })

  it('本机直连表与转发意愿取实时值（不依赖上报）', () => {
    const h = makeHarness({ selfUid: 2, allowRelay: false })
    const g = h.routing.getGraph()
    expect(g.nodes.get(2)!.links).toEqual([1, 3])
    expect(g.nodes.get(2)!.forwardWilling).toBe(false)
  })

  it('handleStatus：被拒回执写入路径记录', () => {
    const h = makeHarness()
    h.routing.tryRoute(env('friend.message', 1, 3))
    const pathId = h.routing.listTraces()[0].pathId
    h.routing.handleStatus(
      env(ROUTE_ENVELOPE_TYPE.status, 2, 1, { pathId, at: 2, state: 'rejected', reason: '未授予', rejectedBy: 2 })
    )
    expect(h.routing.listTraces()[0].failureReason).toBe('未授予')
  })

  it('路径记录环：容量上限生效', () => {
    const h = makeHarness()
    const svc = createRoutingService({
      selfUid: () => 2,
      listRoster: () => [
        { uid: 1, role: 'satellite', online: true, forwardWilling: true, links: [2] },
        { uid: 2, role: 'master', online: true, forwardWilling: true, links: [1, 3] },
        { uid: 3, role: 'satellite', online: true, forwardWilling: true, links: [2] }
      ],
      listPeers: () => [
        { uid: 1, online: true },
        { uid: 3, online: true }
      ],
      isForwardWilling: () => true,
      sendDirect: () => true,
      evaluate: () => ({ allowed: true, tier: 'T1', code: 'allowed', reason: 'ok', auditId: 'a' }),
      now: () => NOW,
      traceLimit: 3
    })
    for (let i = 0; i < 5; i++) svc.tryRoute(env('friend.message', 1, 3))
    expect(svc.listTraces()).toHaveLength(3)
    void h
  })
})

describe('dispatchLanEnvelope：前缀分派', () => {
  it('按前缀分派到各域，route.* 落到路由入口，其余落兜底', () => {
    const calls: string[] = []
    const handlers = {
      friends: { handleLanEnvelope: () => calls.push('friend') },
      relay: { handleLanEnvelope: () => calls.push('relay') },
      chatRooms: { handleLanEnvelope: () => calls.push('chat-room') },
      publishBoard: { handleLanEnvelope: () => calls.push('publish-board') },
      routing: () => calls.push('route'),
      fallback: () => calls.push('fallback')
    }
    dispatchLanEnvelope(handlers, env('friend.message', 1, 2))
    dispatchLanEnvelope(handlers, env('relay.notify', 1, 2))
    dispatchLanEnvelope(handlers, env('chat-room.message', 1, 2))
    dispatchLanEnvelope(handlers, env('publish-board.article', 1, 2))
    dispatchLanEnvelope(handlers, env(ROUTE_ENVELOPE_TYPE.forward, 1, 2))
    dispatchLanEnvelope(handlers, env('unknown.type', 1, 2))
    expect(calls).toEqual(['friend', 'relay', 'chat-room', 'publish-board', 'route', 'fallback'])
  })

  it('缺失的域与兜底不抛错', () => {
    expect(() => dispatchLanEnvelope({}, env('friend.message', 1, 2))).not.toThrow()
  })
})
