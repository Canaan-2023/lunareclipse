/**
 * 局域网路由层（B1）回归测试：可达性图 + 自动最短路径 + 跳数上限 + 环路剪枝 + 可转发性。
 *
 * 为什么存在：交接单 §6② 的多跳能力此前**零实现、零测试**（LAN 只有直连 + 本机 outbox）。
 * 路由是「跨机器数据传播」的核心，跳数上限/环路剪枝是防转发风暴的硬闸，必须有回归网。
 *
 * 覆盖：
 * 1. buildReachability：uid 过滤 / 在线窗口 / forwardWilling 安全默认 / links 清洗（去自环·去重·剔非法）
 * 2. mergeTopologyReport：写入上报者直连表、未知上报者忽略、不改原图
 * 3. acceptIfNewer：旧版本图不得覆盖新图（拓扑抖动防护）
 * 4. planRoute：直连 / 两跳 / 多跳 / 最短优先 / 同跳数按延迟 / 确定性
 * 5. planRoute 失败：same_node / offline / unreachable / hop_limit
 * 6. 可转发性：forwardWilling=false 的中间节点被排除（可作终点）
 * 7. detectLoop
 */
import { describe, it, expect } from 'vitest'
import type { NodeReachability, ReachabilityGraph } from '../electron/main/multi-instance/routing/routing-types'
import {
  buildReachability,
  isOnline,
  mergeTopologyReport,
  acceptIfNewer,
  ONLINE_WINDOW_MS
} from '../electron/main/multi-instance/routing/reachability'
import { planRoute, detectLoop, MAX_HOPS } from '../electron/main/multi-instance/routing/path-finder'

const NOW = 1_700_000_000_000

function mkNode(uid: number, over: Partial<NodeReachability> = {}): NodeReachability {
  return {
    uid,
    role: 'satellite',
    online: true,
    lastSeen: NOW,
    latencyMs: 10,
    forwardWilling: true,
    links: [],
    ...over
  }
}

function mkGraph(nodes: NodeReachability[]): ReachabilityGraph {
  return { version: 1, updatedAt: NOW, nodes: new Map(nodes.map((n) => [n.uid, n])) }
}

describe('buildReachability：名册 → 图', () => {
  it('透传在线态 / lastSeen / 延迟 / 转发意愿', () => {
    const g = buildReachability(
      [
        { uid: 1, role: 'master', online: true, lastSeen: NOW, latencyMs: 5, forwardWilling: true },
        { uid: 2, role: 'satellite', online: false, lastSeen: NOW - 10_000, latencyMs: null }
      ],
      { now: NOW }
    )
    expect(g.nodes.get(1)).toMatchObject({ online: true, latencyMs: 5, forwardWilling: true })
    expect(g.nodes.get(2)).toMatchObject({ online: false, forwardWilling: false })
  })

  it('forwardWilling 缺省为 false（安全默认：未授予 t1.relay-forward 即不中转）', () => {
    const g = buildReachability([{ uid: 3, role: 'satellite', online: true }], { now: NOW })
    expect(g.nodes.get(3)!.forwardWilling).toBe(false)
  })

  it('在线窗口：lastSeen 在窗口内视为在线，超窗视为离线', () => {
    const g = buildReachability(
      [
        { uid: 4, role: 'satellite', lastSeen: NOW - 1000 },
        { uid: 5, role: 'satellite', lastSeen: NOW - ONLINE_WINDOW_MS - 1 }
      ],
      { now: NOW }
    )
    expect(g.nodes.get(4)!.online).toBe(true)
    expect(g.nodes.get(5)!.online).toBe(false)
  })

  it('非法 uid 跳过（与 LAN uid 口径一致：正整数）', () => {
    const g = buildReachability(
      [
        { uid: 0, role: 'satellite' },
        { uid: -1, role: 'satellite' },
        { uid: 1.5, role: 'satellite' },
        { uid: 6, role: 'satellite' }
      ] as never,
      { now: NOW }
    )
    expect([...g.nodes.keys()]).toEqual([6])
  })

  it('links 清洗：去自环 / 去重 / 剔非正整数', () => {
    const g = buildReachability(
      [{ uid: 7, role: 'satellite', links: [7, 8, 8, 0, -3, 9.5, 9] }],
      { now: NOW }
    )
    expect(g.nodes.get(7)!.links).toEqual([8, 9])
  })

  it('isOnline：活 socket 优先于 lastSeen', () => {
    expect(isOnline({ online: true, lastSeen: null }, NOW)).toBe(true)
    expect(isOnline({ online: false, lastSeen: null }, NOW)).toBe(false)
  })
})

describe('拓扑合并', () => {
  it('mergeTopologyReport 写入上报者直连表，且不改原图', () => {
    const g = mkGraph([mkNode(1, { links: [] }), mkNode(2)])
    const merged = mergeTopologyReport(g, { reporterUid: 1, links: [2, 3], at: NOW })
    expect(merged.nodes.get(1)!.links).toEqual([2, 3])
    expect(g.nodes.get(1)!.links).toEqual([]) // 原图未变
  })

  it('未知上报者忽略（先有节点后有边）', () => {
    const g = mkGraph([mkNode(1)])
    const merged = mergeTopologyReport(g, { reporterUid: 99, links: [1], at: NOW })
    expect(merged).toBe(g)
  })

  it('acceptIfNewer 拒绝旧版本图（抖动防护）', () => {
    const older = mkGraph([mkNode(1)])
    const newer = { ...mkGraph([mkNode(1)]), version: 2 }
    expect(acceptIfNewer(newer, older)).toBe(newer)
    expect(acceptIfNewer(older, newer)).toBe(newer)
    expect(acceptIfNewer(null, older)).toBe(older)
  })
})

describe('planRoute：自动最短路径', () => {
  it('直连：1 跳', () => {
    const g = mkGraph([mkNode(1, { links: [2] }), mkNode(2, { links: [1] })])
    const r = planRoute(g, { from: 1, to: 2 })
    expect(r).toEqual({ ok: true, hops: [1, 2], cost: 10 })
  })

  it('两跳：经中间节点', () => {
    const g = mkGraph([
      mkNode(1, { links: [2] }),
      mkNode(2, { links: [1, 3] }),
      mkNode(3, { links: [2] })
    ])
    const r = planRoute(g, { from: 1, to: 3 })
    expect(r).toEqual({ ok: true, hops: [1, 2, 3], cost: 20 })
  })

  it('最短优先：跳数少者胜（即使延迟更大）', () => {
    const g = mkGraph([
      mkNode(1, { links: [2, 3], latencyMs: 100 }),
      mkNode(2, { links: [1, 4], latencyMs: 1 }),
      mkNode(3, { links: [1, 4], latencyMs: 1 }),
      mkNode(4, { links: [2, 3] })
    ])
    const r = planRoute(g, { from: 1, to: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hops).toHaveLength(3) // 1→X→4，两跳
  })

  it('同跳数按延迟之和取小', () => {
    const g = mkGraph([
      mkNode(1, { links: [2, 3], latencyMs: 50 }),
      mkNode(2, { links: [1, 4], latencyMs: 1 }),
      mkNode(3, { links: [1, 4], latencyMs: 1 }),
      mkNode(4, { links: [2, 3] })
    ])
    const r = planRoute(g, { from: 1, to: 4 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hops).toEqual([1, 2, 4]) // 2 与 3 同跳数，按起点延迟并列 → 取 uid 小者（确定性）
  })

  it('确定性：同图同请求必得同解', () => {
    const g = mkGraph([
      mkNode(1, { links: [2, 3] }),
      mkNode(2, { links: [1, 4] }),
      mkNode(3, { links: [1, 4] }),
      mkNode(4, { links: [2, 3] })
    ])
    const a = planRoute(g, { from: 1, to: 4 })
    const b = planRoute(g, { from: 1, to: 4 })
    expect(a).toEqual(b)
  })

  it('可转发性：forwardWilling=false 的中间节点被排除（但可作终点）', () => {
    const g = mkGraph([
      mkNode(1, { links: [2] }),
      mkNode(2, { links: [1, 3], forwardWilling: false }),
      mkNode(3, { links: [2] })
    ])
    // 2 不愿中转 → 1 到不了 3
    expect(planRoute(g, { from: 1, to: 3 })).toEqual({ ok: false, reason: 'unreachable' })
    // 但 2 作终点没问题
    expect(planRoute(g, { from: 1, to: 2 })).toEqual({ ok: true, hops: [1, 2], cost: 10 })
  })
})

describe('planRoute：失败语义', () => {
  it('same_node', () => {
    expect(planRoute(mkGraph([mkNode(1)]), { from: 1, to: 1 })).toEqual({ ok: false, reason: 'same_node' })
  })

  it('offline：起终点不在线', () => {
    const g = mkGraph([mkNode(1, { online: false, lastSeen: null }), mkNode(2, { links: [1] })])
    expect(planRoute(g, { from: 1, to: 2 })).toEqual({ ok: false, reason: 'offline' })
  })

  it('unreachable：节点存在但无路径', () => {
    const g = mkGraph([mkNode(1), mkNode(2)])
    expect(planRoute(g, { from: 1, to: 2 })).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('unreachable：目标节点不在图中', () => {
    expect(planRoute(mkGraph([mkNode(1)]), { from: 1, to: 42 })).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('hop_limit：存在路径但超过上限（链长 10，上限 8）', () => {
    const nodes: NodeReachability[] = []
    for (let i = 1; i <= 11; i++) {
      const links: number[] = []
      if (i > 1) links.push(i - 1)
      if (i < 11) links.push(i + 1)
      nodes.push(mkNode(i, { links }))
    }
    const g = mkGraph(nodes)
    const r = planRoute(g, { from: 1, to: 11 })
    expect(r).toEqual({ ok: false, reason: 'hop_limit' })
    expect(MAX_HOPS).toBe(8)
  })

  it('环路不挂：A↔B 环中 A 到 C 仍可得解', () => {
    const g = mkGraph([
      mkNode(1, { links: [2] }),
      mkNode(2, { links: [1, 3] }),
      mkNode(3, { links: [2, 1] })
    ])
    const r = planRoute(g, { from: 1, to: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.hops).toEqual([1, 2, 3])
  })

  it('detectLoop：命中路径上的节点', () => {
    expect(detectLoop([1, 2, 3], 2)).toBe(true)
    expect(detectLoop([1, 2, 3], 9)).toBe(false)
  })
})
