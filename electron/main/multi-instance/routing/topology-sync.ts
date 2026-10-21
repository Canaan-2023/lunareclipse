/**
 * @category 多实例
 * @summary 拓扑同步：各节点上报自己的直连表，全网汇总成同一张图（自动发现，无需人工画边）
 *
 * 为什么存在：多跳路由的前提是**每个节点都能看到全网拓扑**，而单机只知道自己直连了谁。
 * 用户裁决「节点接入之后，全部局域网同步地图」——本模块负责这条同步的**上报侧**
 * （收集本机直连表 → 广播 `route.topology`）；**应用侧**由 `reachability.mergeTopologyReport` 完成。
 *
 * 不删理由：删掉即每个节点只有自己的一跳视野，跨网段/分段场景永远算不出路径。
 *
 * 同步策略：**泛洪式上报**（每个节点周期性广播自己的直连表）——不依赖主系统中转，
 * 小规模局域网下自然收敛；每条报告带 `at` 时间戳，`mergeTopologyReport` 侧只接受更新的。
 * 选择理由：主系统可能在目标链路之外（分段场景正是主系统不可直达时才有意义），
 * 让拓扑同步依赖主系统会把路由层锁死在「主系统可达」这一前提上。
 */
import type { RouteTopologyPayload } from './routing-types'

/** 拓扑上报周期：与 LAN 心跳（60s）同量级，保证节点上下线在一分钟内进入全网图。 */
export const TOPOLOGY_REPORT_INTERVAL_MS = 60_000

export interface TopologyPeer {
  uid: number
  online: boolean
}

export interface TopologySyncDeps {
  /** 本机 uid；未登录返回 null（不上报） */
  selfUid: () => number | null
  /** 本机直连对端表（`LanService.listPeers()`） */
  listPeers: () => TopologyPeer[]
  /** 本机是否已授予 `t1.relay-forward`（自报给全网，供规划期提示） */
  isForwardWilling: () => boolean
  /** 广播一条 `route.topology`（由调用方接到 LAN 发送通道） */
  broadcast: (type: string, payload: RouteTopologyPayload) => void
  now: () => number
}

/**
 * 收集本机直连表：只收**在线**对端，剔除自身与非法 uid。
 * 语义：直连 = 存在活连接；离线对端不构成可转发边。
 */
export function collectLocalLinks(peers: readonly TopologyPeer[], selfUid: number | null): number[] {
  const out = new Set<number>()
  for (const p of peers) {
    if (!p.online) continue
    if (!Number.isInteger(p.uid) || p.uid <= 0) continue
    if (selfUid != null && p.uid === selfUid) continue
    out.add(p.uid)
  }
  return [...out].sort((a, b) => a - b)
}

export interface TopologySync {
  /** 立即上报一次（启动时 / 对端状态变化时调用） */
  report(): void
  /** 启动周期上报；返回停止函数 */
  start(): () => void
}

export function createTopologySync(deps: TopologySyncDeps): TopologySync {
  const report = (): void => {
    const selfUid = deps.selfUid()
    if (selfUid == null) return
    const links = collectLocalLinks(deps.listPeers(), selfUid)
    deps.broadcast('route.topology', {
      reporterUid: selfUid,
      links,
      forwardWilling: deps.isForwardWilling(),
      at: deps.now()
    })
  }

  const start = (): (() => void) => {
    report()
    const timer = setInterval(report, TOPOLOGY_REPORT_INTERVAL_MS)
    // 定时器不应阻止进程退出（与 LAN 心跳同处理原则）
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }

  return { report, start }
}
