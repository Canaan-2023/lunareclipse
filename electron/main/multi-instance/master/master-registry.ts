/**
 * 为什么存在：主系统须识别"谁在申请接入"，校验令牌合法性与过期状态，并集中留存分系统上报的异常。
 * 作用：持久化 master-registry.json：卫星记录登记（令牌哈希 + 7 天 TTL）、异常报告收集与查询。
 */

import { randomBytes, createHash } from 'crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import type { AnomalyReport, SatelliteRecord } from '../types'

const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000

interface RegistryData {
  satellite: SatelliteRecord[]
  anomalies: AnomalyReport[]
}

/**
 * 主系统分系统账本（abyssac_data/master-registry.json）：
 * 账号本体（用户名/密码哈希/UID）在 users.json；本表只管主分维度——
 * 分系统归属 instanceId、令牌哈希（只存哈希、不存明文）、状态、同步游标、异常汇报。
 */
export class MasterRegistry {
  private data: RegistryData

  constructor(private readonly root: string) {
    const path = this.filePath()
    this.data = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as RegistryData) : { satellite: [], anomalies: [] }
  }

  private filePath(): string {
    return join(this.root, 'master-registry.json')
  }

  private save(): void {
    mkdirSync(dirname(this.filePath()), { recursive: true })
    writeFileSync(this.filePath(), JSON.stringify(this.data, null, 2), 'utf-8')
  }

  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  registerSatellite(uid: number, 用户名: string): { instanceId: string; token: string; tokenExp: number } {
    const instanceId = `satellite-${randomBytes(3).toString('hex').toUpperCase()}`
    const token = randomBytes(32).toString('hex')
    const tokenExp = Date.now() + TOKEN_TTL_MS
    this.data.satellite.push({
      instanceId,
      uid,
      用户名,
      status: 'active',
      createdAt: new Date().toISOString(),
      lastSyncAt: null,
      lastSeq: 0,
      tokenHash: MasterRegistry.hashToken(token),
      tokenExp
    })
    this.save()
    return { instanceId, token, tokenExp }
  }

  /** 校验令牌 → 分系统记录；无效/过期/已禁用一律返回 null */
  verifyToken(token: string): SatelliteRecord | null {
    const hash = MasterRegistry.hashToken(token)
    const satellite = this.data.satellite.find((s) => s.tokenHash === hash)
    if (!satellite || satellite.status !== 'active') return null
    if (satellite.tokenExp < Date.now()) return null
    return satellite
  }

  /** 换发新令牌（refresh 用；禁用的分系统不可续签，须重新 login） */
  refreshToken(instanceId: string): { token: string; tokenExp: number } | null {
    const satellite = this.data.satellite.find((s) => s.instanceId === instanceId)
    if (!satellite || satellite.status !== 'active') return null
    const token = randomBytes(32).toString('hex')
    const tokenExp = Date.now() + TOKEN_TTL_MS
    satellite.tokenHash = MasterRegistry.hashToken(token)
    satellite.tokenExp = tokenExp
    this.save()
    return { token, tokenExp }
  }

  /** 作废当前令牌（revoke/禁用）：清空哈希与过期点，线上令牌立即失效 */
  revokeToken(instanceId: string): void {
    const satellite = this.data.satellite.find((s) => s.instanceId === instanceId)
    if (!satellite) return
    satellite.tokenHash = ''
    satellite.tokenExp = 0
    this.save()
  }

  setStatus(instanceId: string, status: 'active' | 'disabled'): SatelliteRecord | null {
    const satellite = this.data.satellite.find((s) => s.instanceId === instanceId)
    if (!satellite) return null
    satellite.status = status
    if (status === 'disabled') {
      satellite.tokenHash = ''
      satellite.tokenExp = 0
    }
    this.save()
    return satellite
  }

  updateSync(instanceId: string, seq: number): void {
    const satellite = this.data.satellite.find((s) => s.instanceId === instanceId)
    if (!satellite) return
    satellite.lastSeq = seq
    satellite.lastSyncAt = new Date().toISOString()
    this.save()
  }

  /** 局域网在线状态上报（分系统启动/心跳/离线时调用）：写地址、在线态与最近确认时间 */
  updateLanStatus(instanceId: string, info: { lanIp: string | null; lanPort: number; online: boolean }): void {
    const satellite = this.data.satellite.find((s) => s.instanceId === instanceId)
    if (!satellite) return
    satellite.lanIp = info.lanIp
    satellite.lanPort = info.lanPort
    if (info.online) {
      satellite.lastSeen = Date.now()
    }
    this.save()
  }

  addAnomaly(report: AnomalyReport): void {
    this.data.anomalies.push(report)
    this.save()
  }

  listSatellites(): SatelliteRecord[] {
    return this.data.satellite.map((s) => ({ ...s }))
  }

  listAnomalies(): AnomalyReport[] {
    return [...this.data.anomalies]
  }
}