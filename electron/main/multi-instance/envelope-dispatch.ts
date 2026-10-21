/**
 * @category 多实例
 * @summary LAN 信封分派 + 分系统侧 LAN 回调（从 `index.ts` 抽出）
 *
 * 为什么存在：`MultiInstanceService`（`index.ts`）在**体量棘轮台账**内（≥800 行），
 * 任何新增接线都必须先等量移出。本模块承接两块纯搬运逻辑——① 按信封 type 前缀分派到各业务域
 * （并新增 `route.*` 分支）；② 分系统模式的 `reportLanStatus` / `fetchRoster` 闭包——
 * 使路由层接线得以在 `index.ts` 里**净减行数**地落地。
 *
 * 不删理由：删掉即这两块退回 `index.ts`，路由接线会顶破棘轮（CODE-RULES §3.1 硬红线 + §3.6 台账）。
 */
import type { LanEnvelope, LanPeer } from './lan/lan-types'
import { LAN_DEFAULT_PORT } from './lan/lan-types'
import { SatelliteClient } from './satellite/satellite-client'
import type { InstanceConfigStore } from './instance-config'
import type { SatelliteTokenCache } from './auth/satellite-token'

/** 各业务域的信封入口（结构类型，避免与各服务强耦合）。 */
export interface LanEnvelopeHandlers {
  friends?: { handleLanEnvelope(env: LanEnvelope): void } | null
  relay?: { handleLanEnvelope(env: LanEnvelope): void } | null
  chatRooms?: { handleLanEnvelope(env: LanEnvelope): void } | null
  publishBoard?: { handleLanEnvelope(env: LanEnvelope): void } | null
  /** 路由层入口（`route.*`；由 routing-stack 提供） */
  routing?: ((env: LanEnvelope) => void) | null
  /** 兜底（未被任何前缀命中的信封） */
  fallback?: ((env: LanEnvelope) => void) | null
}

/**
 * 按信封 type 前缀分派。
 * 顺序与拆分前逐字一致（friend → relay → chat-room → publish-board），`route.*` 为**新增**分支
 * （B1b 路由层），落在 publish-board 之后、兜底之前——不与既有四个域争抢前缀。
 */
export function dispatchLanEnvelope(handlers: LanEnvelopeHandlers, env: LanEnvelope): void {
  if (env.type.startsWith('friend.')) {
    handlers.friends?.handleLanEnvelope(env)
  } else if (env.type.startsWith('relay.')) {
    handlers.relay?.handleLanEnvelope(env)
  } else if (env.type.startsWith('chat-room.')) {
    handlers.chatRooms?.handleLanEnvelope(env)
  } else if (env.type.startsWith('publish-board.')) {
    handlers.publishBoard?.handleLanEnvelope(env)
  } else if (env.type.startsWith('route.')) {
    handlers.routing?.(env)
  } else {
    handlers.fallback?.(env)
  }
}

export interface SatelliteLanDeps {
  tokenCache: SatelliteTokenCache
  config: InstanceConfigStore
}

/**
 * 分系统模式的 LAN 回调：向主系统上报在线/离线 + 拉全员名册。
 * 未连接主系统（无令牌/无 master）时返回空结果，不抛错（LAN 仍可直连已缓存对端）。
 */
export function createSatelliteLanCallbacks(deps: SatelliteLanDeps): {
  reportLanStatus: (info: { lanIp: string | null; lanPort: number; online: boolean }) => Promise<{ ok: boolean; error?: string }>
  fetchRoster: () => Promise<LanPeer[]>
} {
  return {
    reportLanStatus: async (info) => {
      const token = deps.tokenCache.load()?.accessToken
      const master = deps.config.get().master
      if (!token || !master) return { ok: false, error: '未连接主系统' }
      try {
        return await new SatelliteClient(master.baseUrl).reportLanOnline(token, info)
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    fetchRoster: async () => {
      const token = deps.tokenCache.load()?.accessToken
      const master = deps.config.get().master
      if (!token || !master) return []
      const r = await new SatelliteClient(master.baseUrl).getRoster(token)
      if (!r.ok || !r.roster) return []
      return r.roster
        .filter((i) => i.status === 'active')
        .map(
          (i): LanPeer => ({
            uid: i.uid,
            用户名: i.用户名,
            role: i.role,
            lanIp: i.lanIp ?? null,
            lanPort: i.lanPort ?? LAN_DEFAULT_PORT,
            online: i.online === true,
            lastSeen: i.lastSeen ?? null
          })
        )
    }
  }
}
