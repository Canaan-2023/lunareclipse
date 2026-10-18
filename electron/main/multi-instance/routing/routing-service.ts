/**
 * @category 多实例
 * @summary 路由服务：自动最短路径 + 逐跳转发 + 每跳授权 + 路径可观测
 *
 * 为什么存在：交接单 §6②③④ 要求「多跳路径选择 / 逐跳转发 / 每跳授权 / 可观测」。本模块把
 * 纯逻辑（`path-finder`）与传输（`LanService` 直连发送）接起来，并在**每个中间跳**执行
 * `evaluatePolicy({capability:'t1.relay-forward'})`——即「替他人中转」这条 T1 能力真正的执行点。
 *
 * 不删理由：删掉即 LAN 退回直连（`sendTo` 只查 socket），跨网段/分段场景无解；
 * 且每跳授权失去唯一执行点，「AI 不得替未授权用户中转」这条边界会落空。
 *
 * 与 `relay/*` 的区别：本服务只做**在线逐跳**转发（`route.forward`），
 * 不碰 `relay/*` 的主系统中转状态机（上传→通知→确认取件）。
 */
import { randomUUID } from 'crypto'
import type { LanEnvelope } from '../lan/lan-types'
import type { PolicyDecision, PolicyRequest } from '@shared/types/permission'
import type {
  ReachabilityGraph,
  RouteForwardPayload,
  RouteStatusPayload,
  RouteTopologyPayload,
  RouteTrace
} from './routing-types'
import { ROUTE_ENVELOPE_TYPE } from './routing-types'
import { buildReachability, type RosterInput } from './reachability'
import { planRoute, MAX_HOPS } from './path-finder'
import { collectLocalLinks, type TopologyPeer } from './topology-sync'

/** 中间跳被拒 / 失败时回给发起方的状态信封。 */
function statusEnvelope(
  pathId: string,
  atUid: number,
  state: RouteStatusPayload['state'],
  reason?: string
): RouteStatusPayload {
  return { pathId, at: atUid, state, ...(reason ? { reason } : {}), ...(state === 'rejected' ? { rejectedBy: atUid } : {}) }
}

export interface RoutingServiceDeps {
  /** 本机 uid；未登录返回 null（不参与路由） */
  selfUid: () => number | null
  /** 全员名册（节点来源；`LanService.listRoster()`） */
  listRoster: () => RosterInput[]
  /** 直连对端表（本机拓扑边来源；`LanService.listPeers()`） */
  listPeers: () => TopologyPeer[]
  /** 本机是否已授予 `t1.relay-forward`（决定本机在图上是否可中转） */
  isForwardWilling: () => boolean
  /** **仅直连**发送（不经路由，避免递归）；返回是否送达 */
  sendDirect: (uid: number, env: LanEnvelope) => boolean
  /** 每跳授权裁决（ADR-11 唯一 policy 检查点） */
  evaluate: (req: PolicyRequest) => PolicyDecision
  now: () => number
  maxHops?: number
  /** 路径记录环容量（可观测） */
  traceLimit?: number
}

export type ForwardOutcome =
  | { action: 'deliver'; inner: LanEnvelope }
  | { action: 'forwarded'; next: number }
  | { action: 'rejected'; reason: string }

interface PeerTopology {
  links: number[]
  forwardWilling: boolean
  at: number
}

/**
 * 路由服务（有状态簇：拓扑报告表 + 路径记录环）。
 * 无外部依赖注入时也可构造（全部经 `deps`），便于单测。
 */
export class RoutingService {
  private readonly peerTopology = new Map<number, PeerTopology>()
  private traces: RouteTrace[] = []
  private version = 0

  constructor(private readonly deps: RoutingServiceDeps) {}

  // ===== 拓扑 =====

  /** 本机直连表（上报用） */
  localLinks(): number[] {
    return collectLocalLinks(this.deps.listPeers(), this.deps.selfUid())
  }

  /** 构造本机拓扑上报负载；未登录返回 null。 */
  buildTopologyPayload(): RouteTopologyPayload | null {
    const selfUid = this.deps.selfUid()
    if (selfUid == null) return null
    return {
      reporterUid: selfUid,
      links: this.localLinks(),
      forwardWilling: this.deps.isForwardWilling(),
      at: this.deps.now()
    }
  }

  /** 并入一条拓扑上报；`at` 更旧的丢弃（防乱序覆盖）。 */
  handleTopology(env: LanEnvelope): void {
    const p = env.payload as RouteTopologyPayload | undefined
    if (!p || typeof p.reporterUid !== 'number' || !Array.isArray(p.links)) return
    const prev = this.peerTopology.get(p.reporterUid)
    if (prev && typeof p.at === 'number' && p.at < prev.at) return
    this.peerTopology.set(p.reporterUid, {
      links: p.links.filter((u) => Number.isInteger(u) && u > 0),
      forwardWilling: p.forwardWilling === true,
      at: typeof p.at === 'number' ? p.at : this.deps.now()
    })
    this.version++
  }

  /**
   * 构建当前可达性图：节点来自名册；**本机**直连表/转发意愿取实时值（最准），
   * 其余节点取拓扑上报（自报）。
   */
  getGraph(): ReachabilityGraph {
    const now = this.deps.now()
    const selfUid = this.deps.selfUid()
    const localLinks = this.localLinks()
    const selfWilling = this.deps.isForwardWilling()
    const inputs: RosterInput[] = this.deps.listRoster().map((r) => {
      const isSelf = selfUid != null && r.uid === selfUid
      const reported = this.peerTopology.get(r.uid)
      return {
        uid: r.uid,
        role: r.role,
        online: r.online,
        lastSeen: r.lastSeen,
        latencyMs: r.latencyMs,
        forwardWilling: isSelf ? selfWilling : (reported?.forwardWilling ?? false),
        links: isSelf ? localLinks : (reported?.links ?? [])
      }
    })
    return buildReachability(inputs, { now, version: this.version, updatedAt: now })
  }

  // ===== 发送侧：直连失败时自动算最短路径并转发 =====

  /**
   * 路由兜底：直连不可达时调用。能算出路径 → 发给首跳并返回 true（已接管）；无解 → false（调用方落 outbox）。
   */
  tryRoute(env: LanEnvelope): boolean {
    const selfUid = this.deps.selfUid()
    if (selfUid == null) return false
    const plan = planRoute(this.getGraph(), { from: selfUid, to: env.to, maxHops: this.deps.maxHops ?? MAX_HOPS })
    if (!plan.ok) return false
    const next = plan.hops[1]
    if (next == null) return false
    const pathId = randomUUID()
    const payload: RouteForwardPayload = {
      pathId,
      inner: env,
      path: plan.hops,
      cursor: 1,
      hopsLeft: plan.hops.length - 2
    }
    this.pushTrace({
      pathId,
      from: selfUid,
      to: env.to,
      path: plan.hops,
      perHopStatus: plan.hops.map((uid) => ({ uid, state: uid === selfUid ? 'forwarded' : 'pending' })),
      createdAt: this.deps.now()
    })
    const ok = this.deps.sendDirect(next, {
      id: randomUUID(),
      type: ROUTE_ENVELOPE_TYPE.forward,
      from: selfUid,
      to: next,
      ts: this.deps.now(),
      payload
    })
    if (!ok) {
      this.markHop(pathId, next, 'failed')
      this.finishTrace(pathId, '首跳发送失败')
    }
    return ok
  }

  // ===== 接收侧：逐跳转发 =====

  /**
   * 处理一条 `route.forward`：
   * - 我是终点 → 交付（返回 inner 交业务分派）；
   * - 我是中间跳 → **先过每跳授权**（`t1.relay-forward`），通过则转给下一跳；
   * - 游标不符 / 跳数耗尽 / 被拒 → 拒绝并回执。
   */
  handleForward(env: LanEnvelope): ForwardOutcome {
    const p = env.payload as RouteForwardPayload | undefined
    const selfUid = this.deps.selfUid()
    if (!p || selfUid == null || !Array.isArray(p.path) || typeof p.cursor !== 'number') {
      return { action: 'rejected', reason: 'route.forward 负载格式非法' }
    }
    const { path, cursor } = p
    if (path[cursor] !== selfUid) {
      return { action: 'rejected', reason: `路径游标不符（期望 ${String(path[cursor])}，实为 ${selfUid}）——可能环路或重放` }
    }

    // 终点：直接交付，不要求中转意愿
    if (cursor === path.length - 1) {
      this.markHop(p.pathId, selfUid, 'delivered')
      this.finishTrace(p.pathId)
      return { action: 'deliver', inner: p.inner }
    }

    // 中间跳：每跳授权（§6③）
    const decision = this.deps.evaluate({
      capability: 't1.relay-forward',
      action: `route.forward:${p.pathId}`,
      actor: 'ai'
    })
    if (!decision.allowed) {
      this.markHop(p.pathId, selfUid, 'rejected')
      this.finishTrace(p.pathId, decision.reason)
      this.replyStatus(p, selfUid, 'rejected', decision.reason)
      return { action: 'rejected', reason: decision.reason }
    }

    // 跳数耗尽（与规划期上限双保险）
    if (p.hopsLeft <= 0) {
      const reason = '跳数耗尽（转发期兜底）'
      this.markHop(p.pathId, selfUid, 'failed')
      this.finishTrace(p.pathId, reason)
      this.replyStatus(p, selfUid, 'failed', reason)
      return { action: 'rejected', reason }
    }

    const next = path[cursor + 1]
    const ok = this.deps.sendDirect(next, {
      id: randomUUID(),
      type: ROUTE_ENVELOPE_TYPE.forward,
      from: selfUid,
      to: next,
      ts: this.deps.now(),
      payload: { ...p, cursor: cursor + 1, hopsLeft: p.hopsLeft - 1 } satisfies RouteForwardPayload
    })
    this.markHop(p.pathId, selfUid, ok ? 'forwarded' : 'failed')
    if (!ok) {
      this.finishTrace(p.pathId, `转给 ${next} 失败`)
      this.replyStatus(p, selfUid, 'failed', `转给 ${next} 失败`)
      return { action: 'rejected', reason: `转给 ${next} 失败` }
    }
    return { action: 'forwarded', next }
  }

  /** 处理路径回执（可观测）。 */
  handleStatus(env: LanEnvelope): void {
    const p = env.payload as RouteStatusPayload | undefined
    if (!p || typeof p.pathId !== 'string') return
    if (p.state === 'rejected' || p.state === 'failed') {
      this.markHop(p.pathId, p.rejectedBy ?? p.at, p.state)
      this.finishTrace(p.pathId, p.reason)
    } else {
      this.finishTrace(p.pathId)
    }
  }

  // ===== 可观测（§6④）=====

  listTraces(): readonly RouteTrace[] {
    return this.traces
  }

  private pushTrace(trace: RouteTrace): void {
    this.traces.push(trace)
    const limit = this.deps.traceLimit ?? 100
    if (this.traces.length > limit) this.traces.splice(0, this.traces.length - limit)
  }

  private markHop(pathId: string, uid: number, state: RouteTrace['perHopStatus'][number]['state']): void {
    const trace = this.traces.find((t) => t.pathId === pathId)
    if (!trace) return
    const hop = trace.perHopStatus.find((h) => h.uid === uid)
    if (hop) hop.state = state
    else trace.perHopStatus.push({ uid, state })
  }

  private finishTrace(pathId: string, failureReason?: string): void {
    const trace = this.traces.find((t) => t.pathId === pathId)
    if (!trace) return
    if (failureReason) trace.failureReason = failureReason
  }

  private replyStatus(p: RouteForwardPayload, selfUid: number, state: RouteStatusPayload['state'], reason?: string): void {
    const origin = p.inner.from
    if (origin === selfUid) return
    this.deps.sendDirect(origin, {
      id: randomUUID(),
      type: ROUTE_ENVELOPE_TYPE.status,
      from: selfUid,
      to: origin,
      ts: this.deps.now(),
      payload: statusEnvelope(p.pathId, selfUid, state, reason)
    })
  }
}

/** 便捷构造。 */
export function createRoutingService(deps: RoutingServiceDeps): RoutingService {
  return new RoutingService(deps)
}
