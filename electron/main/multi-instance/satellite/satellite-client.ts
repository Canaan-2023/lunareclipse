/**
 * 为什么存在：分系统所有远端交互（接入、登录、刷新令牌、推送数据）需要统一封装 URL 拼接与鉴权头。
 * 作用：postJson 基于 baseUrl+path 发起 POST（可选带 token），提供 register/auth/refresh/push 等调用。
 */

import { readFileSync } from 'fs'
import type { OpEntry, SyncPushResult } from '../types'

/** 备份 LAN 收端依赖（卫星侧 BackupStreamSink 注入）：大备份经 LAN 分块面落盘后，按 transferId 取回 zip 绝对路径 */
export interface BackupLanReceiver {
  awaitZipReady(transferId: string): Promise<string>
}

export interface AuthIssued {
  ok: boolean
  uid?: number
  instanceId?: string
  token?: string
  error?: string
}

export interface RefreshResult {
  ok: boolean
  token?: string
  /** 新令牌过期时间（epoch ms），来自主系统 /auth/refresh */
  tokenExp?: number
  error?: string
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** 常规请求基准超时（30s）：fetch 默认无超时，主系统不可达时请求会挂起数分钟并阻塞 sync-engine 的 flush 循环。
 * 30s 是体积感知超时的基准项——小 payload（登录/注册/心跳）直接命中；大 payload 按体积追加传输预算（见 timeoutForBytes）。
 * 单独固定值不足以覆盖大文件场景：50MB 级批次在 2.4GHz 弱 Wi-Fi（~5MB/s）下就要 ~10s，批次再大就逼近阈值。 */
const REQUEST_BASE_TIMEOUT_MS = 30_000

/** 局域网最低保障带宽（1MB/s）：体积感知超时的除基。
 * 推导：同步/备份运行于局域网，最弱可用场景为 2.4GHz Wi-Fi 实传 ~1-5MB/s；有线百兆 12.5MB/s、
 * 千兆 125MB/s、5GHz Wi-Fi 约 20-100MB/s 均远高于此。以 1MB/s 作下限推导"最弱链路 + 体积"的
 * 可完成时间，正常链路实际远快于预算——超时只是保护上限，不拖慢正常请求。 */
const LAN_MIN_BYTES_PER_SEC = 1_000_000

/** 常规请求超时封顶（5min）：体积预算可能拉得很长，但 body 体积本身受主系统 /api/v1 的 express.json limit
 * （200mb）约束——200MB / 1MB/s ≈ 200s，封顶 5min 防单请求在极端异常下无限挂起。
 * 注意：仅约束控制面小请求（postJson）；备份下载不走此路径——大备份经 LAN 分块面传输，
 * 无时间上限，可靠性由块级停滞判定 + 整体 sha256 终校验承担（见 /backup/download 与 backup-stream-sink）。 */
const REQUEST_TIMEOUT_CAP_MS = 300_000

/** 按 payload 字节数推导超时：基准 + 体积/最低保障带宽，封顶 cap。
 * 为什么存在：固定超时对体积无感——大文件批次在弱网下会被 30s/120s 误判为网络失败而中断；
 * 体积感知让超时随数据量单调增长，小请求命中基准、大请求拿到与链路匹配的足够窗口。 */
function timeoutForBytes(baseMs: number, bytes: number, capMs: number): number {
  return Math.min(baseMs + Math.ceil(bytes / LAN_MIN_BYTES_PER_SEC) * 1000, capMs)
}

/** 带 HTTP 状态码的请求错误（sync-engine 据此区分令牌失效 401 与其他网络错误） */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

async function postJson<T>(baseUrl: string, path: string, body: unknown, token?: string): Promise<T> {
  const payload = JSON.stringify(body)
  const res = await fetch(`${stripSlash(baseUrl)}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: payload,
    // 为什么存在：default fetch 无超时，主系统不可达时请求可挂起数分钟；同步推送/登录等都
    // 走本封装，挂起会让 sync-engine 的 flush 卡死（flushing=true 阻塞后续批次）。超时即抛错，
    // 由上层按网络错误走退避重试，保证同步线程不被无期限阻塞。
    // 按实际 body 字节量推导超时：push 批次含文件全文（单批最多 200 条），大文件场景体积可达
    // 数十 MB，固定 30s 在弱网下会被击穿；体积感知后任何批次都有与链路匹配的窗口。
    signal: AbortSignal.timeout(timeoutForBytes(REQUEST_BASE_TIMEOUT_MS, Buffer.byteLength(payload, 'utf-8'), REQUEST_TIMEOUT_CAP_MS))
  })
  const data = (await res.json().catch(() => ({}))) as T
  if (!res.ok) {
    const err = data as { error?: unknown }
    throw new HttpError(typeof err?.error === 'string' ? err.error : `HTTP ${res.status}`, res.status)
  }
  return data
}

/**
 * 分系统 → 主系统 HTTP 客户端（纯 fetch，无第三方依赖）。
 * 只做请求封装；令牌缓存、推送编排、恢复落盘在 sync-engine / auth-service。
 */
export class SatelliteClient {
  constructor(private readonly baseUrl: string) {}

  async hello(): Promise<void> {
    const res = await fetch(`${stripSlash(this.baseUrl)}/api/v1/hello`)
    if (!res.ok) {
      throw new Error(`主系统不可达（HTTP ${res.status}）`)
    }
  }

  register(用户名: string, password: string, joinCode: string): Promise<AuthIssued> {
    return postJson(this.baseUrl, '/api/v1/auth/register', { 用户名, password, joinCode })
  }

  login(用户名: string, password: string): Promise<AuthIssued> {
    return postJson(this.baseUrl, '/api/v1/auth/login', { 用户名, password })
  }

  refresh(token: string): Promise<RefreshResult> {
    return postJson(this.baseUrl, '/api/v1/auth/refresh', {}, token)
  }

  revoke(token: string): Promise<{ ok: boolean }> {
    return postJson(this.baseUrl, '/api/v1/auth/revoke', {}, token)
  }

  push(token: string, entries: OpEntry[]): Promise<SyncPushResult> {
    return postJson(this.baseUrl, '/api/v1/sync/push', { entries }, token)
  }

  reportAnomaly(token: string, instanceId: string, uid: number, type: string, message: string): Promise<{ ok: boolean }> {
    return postJson(this.baseUrl, '/api/v1/sync/anomaly', { instanceId, uid, type, message }, token)
  }

  /** 局域网在线状态上报（启动/心跳/离线） */
  reportLanOnline(token: string, info: { lanIp: string | null; lanPort: number; online: boolean }): Promise<{ ok: boolean; error?: string }> {
    return postJson(this.baseUrl, '/api/v1/lan/online', info, token)
  }

  /** 拉取全员名册（含局域网直连地址与在线态） */
  async getRoster(token: string): Promise<{ ok: boolean; roster?: import('../types').RosterItem[]; error?: string }> {
    const res = await fetch(`${stripSlash(this.baseUrl)}/api/v1/roster`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; roster?: import('../types').RosterItem[]; error?: string }
    return { ok: res.ok, roster: data.roster ?? [], error: !res.ok ? (typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`) : undefined }
  }

  /** 分系统备份自助：列出自己账号在主系统的备份（服务端强校验只能取本账号；日期粒度） */
  listBackupArchives(token: string, uid: number): Promise<{ ok: boolean; archives?: Array<{ uid: number; date: string; entryCount: number }>; error?: string }> {
    return postJson(this.baseUrl, '/api/v1/backup/list', { uid }, token)
  }

  /** 分系统备份自助：查看某备份内容明细（域聚合 + 文件清单 + 预览） */
  inspectBackup(token: string, uid: number, date: string): Promise<{
    ok: boolean
    detail?: { count: number; bytes: number; domains: Array<{ domain: string; files: number; bytes: number }>; files: Array<{ path: string; size: number; preview?: string }> }
    error?: string
  }> {
    return postJson(this.baseUrl, '/api/v1/backup/inspect', { uid, date }, token)
  }

  /** 分系统备份自助：下载自己账号的备份 zip。
   * 主系统侧备份下载一律经 LAN 分块面（无体积分级、无 HTTP 整包路径）：主系统推流完成
   * （收端整体 sha256 通过、落盘 rename）后才响应 mode='lan'，本方法从 lanReceiver 取
   * 收端落盘的 zip 路径读文件返回。
   * 为什么没有超时：备份传输不设时间上限——LAN 分块面可靠性由块级停滞判定 + 整体 sha256
   * 终校验承担（见 lan-stream 与 backup-stream-sink）；固定/体积推导超时在 GB 级备份 + 弱网
   * 下只会在传输仍正常时误杀流程，故整体取消。LAN 未装配（lanReceiver 为空）时明确报错。 */
  async downloadBackupZip(token: string, uid: number, date: string, lanReceiver: BackupLanReceiver | null = null): Promise<Uint8Array> {
    const res = await fetch(`${stripSlash(this.baseUrl)}/api/v1/backup/download`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ uid, date })
      // 为什么存在：备份下载不再设任何超时。主系统推流完成（收端整体校验通过、落盘）后才
      // 响应，本请求仅作为"就绪通知"。传输进度与停滞由 LAN 层块级判定负责，HTTP 层不设
      // 时间上限——任何体积/网速下都不会因"传输超时"误杀正常流程。
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`提取备份失败：HTTP ${res.status} ${text.slice(0, 200)}`)
    }
    // 备份响应恒为 JSON（mode='lan'，主系统推流完成后才返回）；不再有 zip 字节流整包分支
    const body = (await res.json()) as { ok?: boolean; mode?: string; transferId?: string; error?: string }
    if (body.ok !== true || body.mode !== 'lan' || !body.transferId) {
      throw new Error(`提取备份失败：${body.error ?? '主系统返回异常'}`)
    }
    if (!lanReceiver) {
      throw new Error('提取备份失败：本地局域网收件器未就绪（备份经 LAN 分块面传输，无整包降级路径）')
    }
    const path = await lanReceiver.awaitZipReady(body.transferId)
    return new Uint8Array(readFileSync(path))
  }
}