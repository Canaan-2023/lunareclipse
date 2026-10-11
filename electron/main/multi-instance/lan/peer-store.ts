/**
 * 为什么存在：对端身份与花名册变化慢，落盘可避免每次重启重复广播发现与拉取。
 * 作用：读写 federation/peers.json 与 roster-cache.json，提供在线对端与花名册的查询/删除/刷新。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LanPeer } from './lan-types'

/**
 * 局域网对端表持久化（federation/ 目录，不在 oplog 同步白名单内）：
 * - roster-cache.json：主系统下发的全员名册（含 UDP 装备的 lanIp/lanPort/online），拉取后写缓存
 * - peers.json：本机已知直连对端（roster 合并 + 直连成功后补 lastSeen）
 * 崩溃安全：每次整文件覆写（写临时文件再 rename，避免半写 JSON）。
 */
export interface RosterCache {
  fetchedAt: string
  items: LanPeer[]
}

interface PeersFile {
  updatedAt: string
  peers: Record<number, LanPeer>
}

export class LanPeerStore {
  private readonly federationDir: string
  private rosterPath: string
  private peersPath: string

  constructor(root: string) {
    this.federationDir = join(root, 'federation')
    this.rosterPath = join(this.federationDir, 'roster-cache.json')
    this.peersPath = join(this.federationDir, 'peers.json')
    mkdirSync(this.federationDir, { recursive: true })
  }

  // ===== roster-cache（主系统名册快照） =====

  loadRosterCache(): RosterCache | null {
    try {
      if (!existsSync(this.rosterPath)) return null
      const raw = JSON.parse(readFileSync(this.rosterPath, 'utf-8')) as RosterCache
      return Array.isArray(raw.items) ? raw : null
    } catch {
      return null
    }
  }

  saveRosterCache(items: LanPeer[]): void {
    this.atomicWrite(this.rosterPath, { fetchedAt: new Date().toISOString(), items } satisfies RosterCache)
  }

  // ===== peers（本机直连对端，含最后活跃时间） =====

  loadPeers(): Record<number, LanPeer> {
    try {
      if (!existsSync(this.peersPath)) return {}
      const raw = JSON.parse(readFileSync(this.peersPath, 'utf-8')) as PeersFile
      return typeof raw.peers === 'object' && raw.peers !== null ? raw.peers : {}
    } catch {
      return {}
    }
  }

  /** 合并保存：保持已有 peer 的 lastSeen；roster 提供权威地址与在线态 */
  savePeers(peers: Record<number, LanPeer>): void {
    const prev = this.loadPeers()
    for (const [key, peer] of Object.entries(peers)) {
      const uid = Number(key)
      const old = prev[uid]
      if (old) {
        peer.lastSeen = old.lastSeen ?? peer.lastSeen ?? null
      }
      prev[uid] = peer
    }
    this.atomicWrite(this.peersPath, { updatedAt: new Date().toISOString(), peers: prev } satisfies PeersFile)
  }

  /** 单点更新（直连成功 / 收到 hello / 心跳到达时写 lastSeen 与 online） */
  updatePeer(peer: LanPeer): void {
    const peers = this.loadPeers()
    peers[peer.uid] = { ...(peers[peer.uid] ?? {}), ...peer }
    this.atomicWrite(this.peersPath, { updatedAt: new Date().toISOString(), peers } satisfies PeersFile)
  }

  getPeer(uid: number): LanPeer | null {
    return this.loadPeers()[uid] ?? null
  }

  listPeers(): LanPeer[] {
    return Object.values(this.loadPeers())
  }

  /** 由 roster 刷新，保留在线态与 lastSeen（roster 的 online 来自主系统账本，可合并） */
  applyRoster(items: LanPeer[]): void {
    const peers = this.loadPeers()
    for (const item of items) {
      const old = peers[item.uid]
      peers[item.uid] = { ...item, lastSeen: old?.lastSeen ?? item.lastSeen ?? null }
    }
    this.atomicWrite(this.peersPath, { updatedAt: new Date().toISOString(), peers } satisfies PeersFile)
  }

  private atomicWrite(path: string, data: unknown): void {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    // rename 在同一目录内原子替换；Windows 上 renameSync 可覆盖已存在目标
    renameSync(tmp, path)
  }
}