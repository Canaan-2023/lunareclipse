/**
 * @category 多实例
 * @summary 局域网路由层类型：节点可达性 / 拓扑图 / 路由请求与结论 / `route.*` 信封负载
 *
 * 为什么存在：交接单 §6 的「需求 A：局域网路由层」要求一层**显式路由**（寻址 → 多跳路径 → 逐跳转发 →
 * 可观测），与既有 `relay/*`（主系统中转的异步存取）语义不同、互不侵入。类型单源落此文件，
 * 使可达性模型、路径规划、转发与 UI 读同一份契约。
 *
 * 不删理由：删掉即路由语义退回各处硬编码，`route.*` 信封形状失去单源，B2 地图 UI 与 B1 逻辑会漂移。
 *
 * 命名空间纪律：`route.*` 是与 `relay.*` 并列的**新信封命名空间**；`relay.*` 的信封 type 属
 * CODE-RULES §3.7 协议面红线，本层一行不改。
 */
import type { LanEnvelope } from '../lan/lan-types'

/** `route.*` 信封 type 常量（新增命名空间，不侵入 relay.*）。 */
export const ROUTE_ENVELOPE_TYPE = {
  /** 逐跳转发：携带端到端原始信封 + 规划路径 + 游标 */
  forward: 'route.forward',
  /** 拓扑上报/同步：节点上报自己的直连表，主系统聚合后下发全网地图 */
  topology: 'route.topology',
  /** 路径状态回执：投递成功 / 被拒（含被哪个节点拒） / 失败 */
  status: 'route.status'
} as const

/**
 * 单节点可达性（在既有 `LanPeer` 之上补「路由需要而 roster 没有」的字段）。
 * 为什么不直接扩展 `LanPeer`：`LanPeer` 是 LAN 协议面的一部分（`lan-types.ts`），
 * 路由是上层关注点，混进去会让协议面与路由演进互相牵制。
 */
export interface NodeReachability {
  uid: number
  role: 'master' | 'satellite'
  /** 是否在线（活 socket / 心跳窗口内） */
  online: boolean
  /** 最近一次确认在线时间（epoch ms） */
  lastSeen: number | null
  /** 到本机的往返延迟（心跳被动测；未知为 null） */
  latencyMs: number | null
  /**
   * 是否愿意替他人中转。**由该节点自身的 `t1.relay-forward` 授予状态决定**——
   * 把「每跳授权」（§6③）直接编码进可达性图：未授予的节点在图上不是可转发边。
   */
  forwardWilling: boolean
  /** 直连可达的 uid 列表（拓扑边；由拓扑同步聚合而来） */
  links: number[]
}

/** 全网可达性图（各节点持有同一张图；`version` 单调递增，只接受更新版本）。 */
export interface ReachabilityGraph {
  version: number
  updatedAt: number
  nodes: Map<number, NodeReachability>
}

/** 路由失败原因。`loop` 只在转发期出现（规划期的路径按构造即简单路径）。 */
export type RouteFailureReason =
  | 'same_node'
  | 'offline'
  | 'unreachable'
  | 'hop_limit'
  | 'loop'

export interface RouteRequest {
  from: number
  to: number
  /** 跳数上限，缺省 `MAX_HOPS` */
  maxHops?: number
}

export interface RoutePlan {
  ok: true
  /** 完整路径（含起点与终点），如 `[from, mid, to]` */
  hops: number[]
  /** 代价（跳数为主序，同跳数时按延迟之和） */
  cost: number
}

export interface RouteFailure {
  ok: false
  reason: RouteFailureReason
}

export type RouteResult = RoutePlan | RouteFailure

/** `route.forward` 负载：端到端原始信封 + 规划路径 + 游标 + 剩余跳数。 */
export interface RouteForwardPayload {
  /** 路径标识（可观测用，同一条消息的逐跳共享） */
  pathId: string
  /** 端到端原始信封（保留 from/to 语义，中间节点不改写） */
  inner: LanEnvelope
  /** 规划路径（起点→终点） */
  path: number[]
  /** 当前跳下标：`path[cursor]` 是当前持有该消息的节点 */
  cursor: number
  /** 剩余可转发跳数（转发期兜底；与规划期上限双保险） */
  hopsLeft: number
}

/** `route.topology` 负载：某节点上报自己的直连表（仅本机视角）。 */
export interface RouteTopologyPayload {
  /** 上报者 uid */
  reporterUid: number
  /** 上报者的直连 uid 列表 */
  links: number[]
  /**
   * 上报者是否愿意替他人中转（自报 = 其自身 `t1.relay-forward` 授予状态）。
   * 只作**规划期提示**（避免把路径规划穿过不愿中转的节点）；真正的强制点在转发期——
   * 每个中间跳收包时各自 `evaluatePolicy` 自查，因为**别人的授予状态不可被信任**。
   */
  forwardWilling?: boolean
  /** 上报时刻（epoch ms）；更旧的报告被丢弃 */
  at: number
}

/** `route.status` 负载：路径回执（可观测 §6④）。 */
export interface RouteStatusPayload {
  pathId: string
  /** 产生回执的节点 uid */
  at: number
  state: 'delivered' | 'rejected' | 'failed'
  /** 失败/被拒原因 */
  reason?: string
  /** 被哪个节点拒绝（per-hop 授权被拒时） */
  rejectedBy?: number
}

/** 一条路径的执行记录（可观测环的条目；B2 地图 UI 与「被拒原因」直接读它）。 */
export interface RouteTrace {
  pathId: string
  from: number
  to: number
  path: number[]
  /** 每跳状态：`pending` 未到 / `forwarded` 已转出 / `delivered` 已交付 / `rejected` 被拒 / `failed` 失败 */
  perHopStatus: Array<{ uid: number; state: 'pending' | 'forwarded' | 'delivered' | 'rejected' | 'failed' }>
  failureReason?: string
  rejectedBy?: number
  createdAt: number
}
