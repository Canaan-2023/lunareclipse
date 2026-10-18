/**
 * @category 多实例
 * @summary 路由栈装配：把可达性/规划/转发与权限检查点、审计、拓扑同步接成一个可用的路由层
 *
 * 为什么存在：`routing-service` 只管「怎么转发」，但一个能跑的路由层还需要三件事——
 * ① 每跳授权走 ADR-11 的唯一 policy 检查点（含审计落盘）；② 周期性拓扑上报；③ 入站 `route.*` 分派。
 * 这三件在本模块装配，使 `MultiInstanceService` 只需几行接线（`index.ts` 在体量棘轮台账内，不得增行）。
 *
 * 不删理由：删掉即调用方要各自拼装权限/审计/拓扑三件事，且 `t1.relay-forward` 的授予读取
 * 会在多处各写一份、口径漂移。
 */
import type { AppConfig, AuditSink } from '@shared/types'
import type { PolicyDecision, PolicyRequest, SecurityGrants } from '@shared/types/permission'
import { EMPTY_GRANTS, evaluatePolicy } from '../../tools/security-engine/policy-gate'
import { createFileAuditSink, defaultAuditFilePath } from '../../tools/security-engine/audit-log'
import type { LanEnvelope, LanPeer } from '../lan/lan-types'
import { ROUTE_ENVELOPE_TYPE } from './routing-types'
import type { RosterInput } from './reachability'
import { createTopologySync, type TopologyPeer, type TopologySync } from './topology-sync'
import { createRoutingService, type RoutingService } from './routing-service'

/** 「替他人中转」能力键（本节点是否可作中间跳）。 */
export const RELAY_FORWARD_CAPABILITY = 't1.relay-forward'

/** 名册条目 → 可达性输入（延迟未知填 null，由拓扑/心跳后续补）。 */
export function toRosterInput(peer: LanPeer): RosterInput {
  return {
    uid: peer.uid,
    role: peer.role,
    online: peer.online,
    lastSeen: peer.lastSeen,
    latencyMs: null
  }
}

/** 从生效配置读授予表（缺省空表 = 无授予，安全默认）。 */
export function readGrants(config: AppConfig | undefined | null): SecurityGrants {
  return config?.securityGrants ?? EMPTY_GRANTS
}

/** 本机是否已授予 `t1.relay-forward`。 */
export function isForwardWilling(config: AppConfig | undefined | null): boolean {
  return readGrants(config).grants[RELAY_FORWARD_CAPABILITY] != null
}

export interface RoutingStackDeps {
  /** 本机 uid；未登录返回 null */
  selfUid: () => number | null
  /** 全员名册 */
  listRoster: () => LanPeer[]
  /** 直连对端表 */
  listPeers: () => TopologyPeer[]
  /** 仅直连发送（不经路由） */
  sendDirect: (uid: number, env: LanEnvelope) => boolean
  /** 生效配置读取（授予表来源） */
  getAppConfig: () => AppConfig | undefined
  /** 广播一条信封（拓扑上报用；直连失败时内部会走路由） */
  broadcast: (env: LanEnvelope) => void
  now?: () => number
  /** 审计落点；缺省写锚点派生的 JSONL 文件 */
  audit?: AuditSink
}

export interface RoutingStack {
  routing: RoutingService
  /** 入站 `route.*` 信封分派（终点交付交给 `deliver`） */
  handleEnvelope: (env: LanEnvelope, deliver: (inner: LanEnvelope) => void) => void
  /** 启动周期拓扑上报；返回停止函数 */
  startTopologySync: () => () => void
}

/** 入站 `route.*` 分派。非 `route.*` 一律忽略（调用方按前缀路由到此）。 */
export function handleRouteEnvelope(
  routing: RoutingService,
  env: LanEnvelope,
  deliver: (inner: LanEnvelope) => void
): void {
  switch (env.type) {
    case ROUTE_ENVELOPE_TYPE.forward: {
      const outcome = routing.handleForward(env)
      if (outcome.action === 'deliver') deliver(outcome.inner)
      return
    }
    case ROUTE_ENVELOPE_TYPE.topology:
      routing.handleTopology(env)
      return
    case ROUTE_ENVELOPE_TYPE.status:
      routing.handleStatus(env)
      return
    default:
      return
  }
}

/** 装配路由栈。见文件头「为什么存在」。 */
export function createRoutingStack(deps: RoutingStackDeps): RoutingStack {
  const now = deps.now ?? (() => Date.now())
  const audit = deps.audit ?? createFileAuditSink(defaultAuditFilePath())

  const routing = createRoutingService({
    selfUid: deps.selfUid,
    listRoster: () => deps.listRoster().map(toRosterInput),
    listPeers: deps.listPeers,
    isForwardWilling: () => isForwardWilling(deps.getAppConfig()),
    sendDirect: deps.sendDirect,
    evaluate: (req: PolicyRequest): PolicyDecision =>
      evaluatePolicy(req, { getGrants: () => readGrants(deps.getAppConfig()), now, audit }),
    now
  })

  const topology: TopologySync = createTopologySync({
    selfUid: deps.selfUid,
    listPeers: deps.listPeers,
    isForwardWilling: () => isForwardWilling(deps.getAppConfig()),
    now,
    broadcast: (type, payload) => {
      const selfUid = deps.selfUid()
      if (selfUid == null) return
      // 拓扑上报走广播式直发：逐节点发送（小规模局域网；对端离线时静默失败，下轮重报）
      for (const peer of deps.listPeers()) {
        if (!peer.online) continue
        deps.broadcast({
          id: `${type}:${selfUid}:${payload.at}:${peer.uid}`,
          type,
          from: selfUid,
          to: peer.uid,
          ts: payload.at,
          payload
        })
      }
    }
  })

  return {
    routing,
    handleEnvelope: (env, deliver) => handleRouteEnvelope(routing, env, deliver),
    startTopologySync: () => topology.start()
  }
}
