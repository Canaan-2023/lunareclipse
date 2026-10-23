/**
 * @category 多实例
 * @summary 路径规划（纯函数）：自动最短路径 + 跳数上限 + 环路剪枝 + 可转发性
 *
 * 为什么存在：交接单 §6② 要求「多跳路径选择、逐跳转发、跳数上限与环路检测」，且用户裁决
 * 「信息发送自动算最短路径」——路径是**自动**算出来的，调用方不指定。本模块是这条要求的唯一实现。
 *
 * 不删理由：删掉即转发退化为直连（LAN 现状），跨网段/分段场景无解；跳数上限与环路剪枝
 * 是防「转发风暴」的硬闸，缺一即在环状拓扑上打转。
 *
 * 纯函数：只吃 `ReachabilityGraph`，不读文件、不联网、不依赖 Electron。
 */
import type {
  ReachabilityGraph,
  RouteFailureReason,
  RouteRequest,
  RouteResult
} from './routing-types'

/** 硬跳数上限：超过即拒（防转发风暴；与转发期的 `hopsLeft` 双保险）。 */
export const MAX_HOPS = 8

interface QueueEntry {
  uid: number
  hops: number
  cost: number
  path: number[]
}

/** 主序 = 跳数少；同跳数 = 延迟之和小的优先。 */
function isBetter(a: { hops: number; cost: number }, b: { hops: number; cost: number }): boolean {
  return a.hops < b.hops || (a.hops === b.hops && a.cost < b.cost)
}

/**
 * 环路检测：`uid` 是否已在路径上。
 * 供转发期使用——规划期返回的路径按构造即简单路径，但分布式转发仍须自查（消息可能被重放/绕回）。
 */
export function detectLoop(path: readonly number[], uid: number): boolean {
  return path.includes(uid)
}

/**
 * 自动最短路径规划。见文件头「为什么存在」。
 * 失败原因：`same_node` / `offline`（起终点不在线）/ `unreachable` / `hop_limit`（存在路径但超上限）。
 */
export function planRoute(graph: ReachabilityGraph, req: RouteRequest): RouteResult {
  const maxHops = req.maxHops ?? MAX_HOPS
  if (req.from === req.to) return { ok: false, reason: 'same_node' }

  const start = graph.nodes.get(req.from)
  const goal = graph.nodes.get(req.to)
  if (!start || !goal) return { ok: false, reason: 'unreachable' }
  if (!start.online || !goal.online) return { ok: false, reason: 'offline' }

  // 图规模小（单局域网节点数），线性取最小足够；不引第三方优先队列。
  const queue: QueueEntry[] = [{ uid: req.from, hops: 0, cost: 0, path: [req.from] }]
  const best = new Map<number, { hops: number; cost: number }>([[req.from, { hops: 0, cost: 0 }]])

  while (queue.length > 0) {
    let idx = 0
    for (let i = 1; i < queue.length; i++) {
      if (isBetter(queue[i], queue[idx])) idx = i
    }
    const cur = queue.splice(idx, 1)[0]
    if (cur.uid === req.to) return { ok: true, hops: cur.path, cost: cur.cost }
    if (cur.hops >= maxHops) continue

    const node = graph.nodes.get(cur.uid)
    if (!node) continue
    for (const nextUid of node.links) {
      const next = graph.nodes.get(nextUid)
      if (!next || !next.online) continue
      // 中间跳必须愿意替他人中转；终点不要求（它是收货方，不是中转方）
      if (nextUid !== req.to && !next.forwardWilling) continue
      // 环路剪枝：路径上已有的节点不再进入
      if (detectLoop(cur.path, nextUid)) continue

      const hops = cur.hops + 1
      const cost = cur.cost + (node.latencyMs ?? 0)
      const prev = best.get(nextUid)
      if (prev && !isBetter({ hops, cost }, prev)) continue
      best.set(nextUid, { hops, cost })
      queue.push({ uid: nextUid, hops, cost, path: [...cur.path, nextUid] })
    }
  }

  // 走到这里 = 上限内无解。区分「超上限」与「真的不可达」。
  return { ok: false, reason: reachableIgnoringCap(graph, req) ? 'hop_limit' : 'unreachable' }
}

/** 无跳数上限的 BFS：只用于区分 `hop_limit` 与 `unreachable`。 */
function reachableIgnoringCap(graph: ReachabilityGraph, req: RouteRequest): boolean {
  const seen = new Set<number>([req.from])
  const queue: number[] = [req.from]
  while (queue.length > 0) {
    const uid = queue.shift() as number
    if (uid === req.to) return true
    const node = graph.nodes.get(uid)
    if (!node) continue
    for (const nextUid of node.links) {
      if (seen.has(nextUid)) continue
      const next = graph.nodes.get(nextUid)
      if (!next || !next.online) continue
      if (nextUid !== req.to && !next.forwardWilling) continue
      seen.add(nextUid)
      queue.push(nextUid)
    }
  }
  return false
}

/** 供调用方判断失败语义（如 UI 显示「跳数超限」而非「不可达」）。 */
export function isRouteFailure(result: RouteResult): result is { ok: false; reason: RouteFailureReason } {
  return result.ok === false
}
