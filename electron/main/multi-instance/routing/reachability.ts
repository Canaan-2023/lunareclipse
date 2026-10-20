/**
 * @category 多实例
 * @summary 可达性图构建与拓扑合并（纯函数）：名册 + 直连表 → 全网拓扑图
 *
 * 为什么存在：路由需要「谁在线、谁连谁、谁愿意中转」三件事，而既有名册（`LanPeer`）只有
 * 在线态与地址、没有拓扑边与转发意愿。本模块把这三件事聚成一张可规划、可测试的图，
 * 且**不碰 LAN 协议面**（`LanPeer` 一行不改）。
 *
 * 不删理由：删掉即路径规划无处取图；且「可转发意愿 = 该节点自身的 T1 授予状态」这条
 * 每跳授权语义会退回散落判断。
 *
 * 纯函数：不读文件、不联网、不依赖 Electron；`now` 由调用方注入，便于单测。
 */
import type { NodeReachability, ReachabilityGraph, RouteTopologyPayload } from './routing-types'

/** 在线判定窗口：与既有 roster 的 90s 语义一致（`multi-instance/index.ts` 主系统侧口径）。 */
export const ONLINE_WINDOW_MS = 90_000

/** 构建图的输入项（名册条目 + 路由关心的补充字段；`links`/`forwardWilling` 可缺省）。 */
export interface RosterInput {
  uid: number
  role: 'master' | 'satellite'
  /** 活 socket / 心跳确认在线 */
  online?: boolean
  lastSeen?: number | null
  latencyMs?: number | null
  /** 该节点是否已授予 `t1.relay-forward`（未给 = false，安全默认） */
  forwardWilling?: boolean
  /** 该节点的直连 uid 列表（拓扑同步聚合而来） */
  links?: number[]
}

export interface BuildReachabilityOptions {
  /** 当前时刻（epoch ms），由调用方注入 */
  now: number
  version?: number
  updatedAt?: number
}

/**
 * 在线判定：**显式 `online` 优先**（活 socket 的权威判定）；只有 `online` 缺省时才看
 * `lastSeen` 是否落在窗口内（主系统侧按 90s 窗口推导在线态的等价口径）。
 * 为什么显式优先：`online:false` + 近期 `lastSeen` 并存时，前者是「连接已断」的明确信号，
 * 不能被窗口兜底翻成在线，否则会规划出一条实际不通的路径。
 */
export function isOnline(
  node: { online?: boolean; lastSeen?: number | null },
  now: number,
  windowMs: number = ONLINE_WINDOW_MS
): boolean {
  if (node.online === true) return true
  if (node.online === false) return false
  if (node.lastSeen == null) return false
  return now - node.lastSeen <= windowMs
}

/** 直连表清洗：只保留正整数、去重、剔除自身（自环不入图）。 */
function sanitizeLinks(links: number[] | undefined, selfUid: number): number[] {
  if (!links || links.length === 0) return []
  const seen = new Set<number>()
  for (const uid of links) {
    if (!Number.isInteger(uid) || uid <= 0 || uid === selfUid) continue
    seen.add(uid)
  }
  return [...seen].sort((a, b) => a - b)
}

/** 由名册构建可达性图。非法 uid 条目跳过（与 LAN uid 校验口径一致）。 */
export function buildReachability(
  roster: readonly RosterInput[],
  opts: BuildReachabilityOptions
): ReachabilityGraph {
  const nodes = new Map<number, NodeReachability>()
  for (const r of roster) {
    if (!Number.isInteger(r.uid) || r.uid <= 0) continue
    nodes.set(r.uid, {
      uid: r.uid,
      role: r.role,
      online: isOnline(r, opts.now),
      lastSeen: r.lastSeen ?? null,
      latencyMs: r.latencyMs ?? null,
      forwardWilling: r.forwardWilling === true,
      links: sanitizeLinks(r.links, r.uid)
    })
  }
  return {
    version: opts.version ?? 1,
    updatedAt: opts.updatedAt ?? opts.now,
    nodes
  }
}

/**
 * 合并一条拓扑上报：把上报者的直连表写进图中对应节点（返回新图，不改原图）。
 * 未在图中的上报者忽略（先有节点、后有边）。
 * `version` 只增不减：上报不带版本，由调用方在聚合/广播时统一升版。
 */
export function mergeTopologyReport(
  graph: ReachabilityGraph,
  report: RouteTopologyPayload
): ReachabilityGraph {
  const node = graph.nodes.get(report.reporterUid)
  if (!node) return graph
  const links = sanitizeLinks(report.links, report.reporterUid)
  const nodes = new Map(graph.nodes)
  nodes.set(node.uid, { ...node, links })
  return { ...graph, nodes }
}

/** 只接受更新版本的图（拓扑抖动防护：乱序到达的旧图不得覆盖新图）。 */
export function acceptIfNewer(
  current: ReachabilityGraph | null,
  incoming: ReachabilityGraph
): ReachabilityGraph {
  if (!current || incoming.version > current.version) return incoming
  return current
}
