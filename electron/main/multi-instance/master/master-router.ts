/**
 * 为什么存在：分系统与主系统可能跨机部署，接入/认证/花名册/同步水位等远端流程须以 HTTP 承载。
 * 作用：Express 路由：注册分系统、签发认证令牌，回环地址放行并校验令牌，组装注册表/水位/用户等依赖处理请求。
 */

import { Router, type NextFunction, type Request, type Response } from 'express'
import JSZip from 'jszip'
import { randomBytes } from 'crypto'
import type { UserStore } from '../../models/user-store'
import type { InstanceConfigStore } from '../instance-config'
import type { AnomalyReport, RosterItem, SatelliteRecord } from '../types'
import { MasterRegistry } from './master-registry'
import { SatelliteStore } from './satellite-store'
import { BACKUP_STREAM_PREFIX } from './backup-stream-sink'
import { isLoopback } from '../../api/server-utils'

/**
 * 局域网推流门面（master 模式 LanService 装配后由 MultiInstanceService 注入）。
 * backup 下载一律经此分块面传输：任意字节、无体积上限、块级停滞判定 + 整体 sha256
 * 终校验、无固定时间上限——不再有"小包 HTTP 整包 / 大包 LAN"的体积分级。
 */
export interface BackupLanPush {
  /** 经 LAN 分块面推送内存 Buffer（lan-stream sendBytes：块级 sha256 + 整体 sha256，无体积上限） */
  sendBytes(uid: number, name: string, data: Buffer, options?: { transferId?: string }): Promise<{
    ok: boolean
    error?: string
    ackedBytes: number
  }>
  /** 局域网在线对端（按 uid 寻址；离线对端不可推送） */
  listPeers(): Array<{ uid: number }>
}

export interface MasterRouterDeps {
  registry: MasterRegistry
  satelliteStore: SatelliteStore
  userStore: UserStore
  instanceConfig: InstanceConfigStore
  appName?: string
  /** 主系统本机局域网地址（master 模式启动 LanService 后由 MultiInstanceService 注入；roster 组装用） */
  getMasterLan?: () => { lanIp: string | null; lanPort: number } | null
  /** 局域网推流门面（master 模式启动 LanService 后注入；大备份分级走 LAN 分块面时消费，未装配则明确报错不降级） */
  getLanPush?: () => BackupLanPush | null
}

type AuthedRequest = Request & { satellite?: SatelliteRecord }

function publicSatellite(s: SatelliteRecord): Omit<SatelliteRecord, 'tokenHash' | 'tokenExp'> {
  const { tokenHash: _th, tokenExp: _te, ...rest } = s
  void _th
  void _te
  return rest
}

/** 主系统 /api/v1：分系统令牌鉴权 + 本机管理路由（loopback only） */
export function createMasterRouter(deps: MasterRouterDeps): Router {
  const router = Router()

  const requireSatellite = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization
    const token = header && header.startsWith('Bearer ') ? header.slice(7) : ''
    const satellite = token ? deps.registry.verifyToken(token) : null
    if (!satellite) {
      res.status(401).json({ ok: false, error: '令牌无效或已过期' })
      return
    }
    ;(req as AuthedRequest).satellite = satellite
    next()
  }

  const requireLoopback = (req: Request, res: Response, next: NextFunction): void => {
    if (!isLoopback(req.socket.remoteAddress)) {
      res.status(403).json({ ok: false, error: '仅限主系统本机调用' })
      return
    }
    next()
  }

  router.get('/hello', (_req, res) => {
    res.json({ ok: true, appName: deps.appName ?? '月蚀主系统', version: 1 })
  })

  // ===== 分系统账号（UID 由主系统统一发放；账号本体落 users.json，静默注册不碰本机登录态） =====
  // 准入凭证：请求必须携带主系统当前接入码（joinCode），校验通过才发账号；本机注册不走此路由。
  router.post('/auth/register', (req: Request, res: Response) => {
    const 用户名 = typeof req.body?.用户名 === 'string' ? req.body.用户名.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const joinCode = typeof req.body?.joinCode === 'string' ? req.body.joinCode.trim() : ''
    if (!用户名 || !password) {
      res.status(400).json({ ok: false, error: '用户名与密码不能为空' })
      return
    }
    const expectCode = deps.instanceConfig.getJoinCode()
    if (!expectCode) {
      res.status(403).json({ ok: false, error: '主系统未启用接入，拒绝注册' })
      return
    }
    if (joinCode !== expectCode) {
      res.status(403).json({ ok: false, error: '接入码无效，请向主系统获取最新接入链接' })
      return
    }
    const created = deps.userStore.register(用户名, password, true)
    if (!created.ok || !created.user) {
      res.status(400).json({ ok: false, error: created.error ?? '注册失败' })
      return
    }
    // silent 注册不写登录态，也不触发 userStore.register 的 ensureScope；
    // 这里在注册成功后显式补建 master 侧骨架（幂等），避免运行期新接入的分系统
    // 账号在下次重启前无 memory/U{uid}/AI{aiId} 等目录（判断多账号管理/打开记忆目录）
    deps.userStore.ensureScope(created.user.UID)
    const issued = deps.registry.registerSatellite(created.user.UID, created.user.用户名)
    res.json({
      ok: true,
      uid: created.user.UID,
      instanceId: issued.instanceId,
      token: issued.token,
      tokenExp: issued.tokenExp
    })
  })

  router.post('/auth/login', (req: Request, res: Response) => {
    const 用户名 = typeof req.body?.用户名 === 'string' ? req.body.用户名.trim() : ''
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const satellite = deps.registry.listSatellites().find((s) => s.用户名 === 用户名)
    if (!satellite) {
      res.status(403).json({ ok: false, error: '该账号未接入为分系统，请先在主系统注册' })
      return
    }
    if (satellite.status === 'disabled') {
      res.status(403).json({ ok: false, error: '账号已被禁用，请联系主系统管理员' })
      return
    }
    const verified = deps.userStore.verifyCredentials(用户名, password)
    if (!verified.ok) {
      res.status(401).json({ ok: false, error: '用户名或密码错误' })
      return
    }
    const issued = deps.registry.refreshToken(satellite.instanceId)
    if (!issued) {
      res.status(500).json({ ok: false, error: '令牌签发失败' })
      return
    }
    res.json({ ok: true, uid: satellite.uid, instanceId: satellite.instanceId, token: issued.token, tokenExp: issued.tokenExp })
  })

  router.post('/auth/refresh', requireSatellite, (req: AuthedRequest, res) => {
    const issued = deps.registry.refreshToken(req.satellite!.instanceId)
    if (!issued) {
      res.status(500).json({ ok: false, error: '令牌签发失败' })
      return
    }
    res.json({ ok: true, token: issued.token, tokenExp: issued.tokenExp })
  })

  router.post('/auth/revoke', requireSatellite, (req: AuthedRequest, res) => {
    deps.registry.revokeToken(req.satellite!.instanceId)
    res.json({ ok: true })
  })

  // ===== 单向数据同步（oplog 推送，seq 单调收敛） =====
  router.post('/sync/push', requireSatellite, (req: AuthedRequest, res) => {
    const entries = req.body?.entries
    if (!Array.isArray(entries)) {
      res.status(400).json({ ok: false, error: 'entries 必须为数组' })
      return
    }
    const result = deps.satelliteStore.applyPush(req.satellite!.uid, req.satellite!.instanceId, entries)
    deps.registry.updateSync(req.satellite!.instanceId, result.ackedSeq)
    // 被动日归档：数据到达即评估，前一天无变化时零 IO
    if (result.ok) deps.satelliteStore.maybeArchiveDaily(req.satellite!.instanceId)
    res.json(result)
  })

  router.post('/sync/anomaly', requireSatellite, (req: AuthedRequest, res) => {
    const { uid, type, message } = (req.body ?? {}) as { uid?: unknown; type?: unknown; message?: unknown }
    if (typeof uid !== 'number' || typeof type !== 'string' || typeof message !== 'string') {
      res.status(400).json({ ok: false, error: 'uid/type/message 不合法' })
      return
    }
    const report: AnomalyReport = {
      instanceId: req.satellite!.instanceId,
      uid,
      type,
      message,
      ts: new Date().toISOString()
    }
    deps.registry.addAnomaly(report)
    res.json({ ok: true })
  })

  // ===== 全员名册（分系统显示全体成员/局域网直连发现用） =====
  router.get('/roster', requireSatellite, (_req: AuthedRequest, res) => {
    const satellites = deps.registry.listSatellites()
    const uidToSat = new Map(satellites.map((s) => [s.uid, s]))
    const masterLan = deps.getMasterLan?.() ?? null
    const roster: RosterItem[] = deps.userStore
      .listUsers()
      .map((u) => {
        const sat = uidToSat.get(u.UID)
        if (!sat) {
          // 主系统本机账号：直连地址来自本机 LanService（无则 null）
          return {
            uid: u.UID,
            用户名: u.用户名,
            role: 'master' as const,
            status: 'active' as const,
            lanIp: masterLan?.lanIp ?? null,
            lanPort: masterLan?.lanPort ?? null,
            online: masterLan ? true : false,
            lastSeen: masterLan ? Date.now() : null
          }
        }
        return {
          uid: u.UID,
          用户名: u.用户名,
          role: 'satellite' as const,
          status: sat.status === 'disabled' ? 'disabled' as const : 'active' as const,
          lanIp: sat.lanIp ?? null,
          lanPort: sat.lanPort ?? null,
          online: sat.status === 'active' && sat.lastSeen != null && Date.now() - sat.lastSeen < 90_000,
          lastSeen: sat.lastSeen ?? null
        }
      })
    res.json({ ok: true, roster })
  })

  // ===== 局域网在线状态上报（分系统启动/心跳/离线时调用） =====
  router.post('/lan/online', requireSatellite, (req: AuthedRequest, res) => {
    const lanIp = typeof req.body?.lanIp === 'string' ? req.body.lanIp : null
    const lanPort = typeof req.body?.lanPort === 'number' ? req.body.lanPort : 62003
    const online = req.body?.online === true
    if (online && lanIp == null) {
      res.status(400).json({ ok: false, error: '上线上报必须携带 lanIp' })
      return
    }
    deps.registry.updateLanStatus(req.satellite!.instanceId, { lanIp, lanPort, online })
    res.json({ ok: true })
  })

  // ===== 管理窗口（仅主系统本机，渲染进程经 IPC 代理调用） =====
  router.get('/admin/satellites', requireLoopback, (_req, res) => {
    res.json({ ok: true, satellite: deps.registry.listSatellites().map(publicSatellite) })
  })

  router.post('/admin/satellites/:instanceId/status', requireLoopback, (req: Request, res) => {
    const status = req.body?.status
    if (status !== 'active' && status !== 'disabled') {
      res.status(400).json({ ok: false, error: 'status 必须为 active/disabled' })
      return
    }
    const updated = deps.registry.setStatus(String(req.params.instanceId), status)
    if (!updated) {
      res.status(404).json({ ok: false, error: '分系统不存在' })
      return
    }
    res.json({ ok: true, satellite: publicSatellite(updated) })
  })

  router.post('/admin/satellites/:instanceId/revoke', requireLoopback, (req: Request, res) => {
    deps.registry.revokeToken(String(req.params.instanceId))
    res.json({ ok: true })
  })

  router.get('/admin/anomalies', requireLoopback, (_req, res) => {
    res.json({ ok: true, anomalies: deps.registry.listAnomalies() })
  })

  // ===== 备份自助（分系统凭令牌提取自己账号的备份；服务端强制只能访问本实例本账号；备份按账号/日期粒度，含 memory/NNG/cache/ABYSS 四域） =====
  router.post('/backup/list', requireSatellite, (req: AuthedRequest, res) => {
    const archives = deps.satelliteStore
      .listArchiveDetails(req.satellite!.instanceId)
      .filter((d) => d.uid === req.satellite!.uid)
    res.json({ ok: true, archives })
  })

  router.post('/backup/inspect', requireSatellite, (req: AuthedRequest, res) => {
    const { uid, date } = (req.body ?? {}) as Record<string, unknown>
    if (typeof uid !== 'number' || typeof date !== 'string') {
      res.status(400).json({ ok: false, error: 'uid/date 必填' })
      return
    }
    if (uid !== req.satellite!.uid) {
      res.status(403).json({ ok: false, error: '只能查看本账号备份' })
      return
    }
    const detail = deps.satelliteStore.inspectArchive(uid, date)
    if (detail.count === 0) {
      res.status(404).json({ ok: false, error: '备份不存在或为空' })
      return
    }
    res.json({ ok: true, detail })
  })

  router.post('/backup/download', requireSatellite, async (req: AuthedRequest, res) => {
    const { uid, date } = (req.body ?? {}) as Record<string, unknown>
    if (typeof uid !== 'number' || typeof date !== 'string') {
      res.status(400).json({ ok: false, error: 'uid/date 必填' })
      return
    }
    if (uid !== req.satellite!.uid) {
      res.status(403).json({ ok: false, error: '只能提取本账号备份' })
      return
    }
    const items = deps.satelliteStore.collectArchive(uid, date)
    if (items.length === 0) {
      res.status(404).json({ ok: false, error: '备份不存在或为空' })
      return
    }
    const zip = new JSZip()
    for (const item of items) {
      zip.file(item.key, item.content)
    }
    const buffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }))

    // 备份下载统一走 LAN 分块面（lan-stream：任意字节、无体积上限、块级停滞判定 + 整体
    // sha256 终校验，无固定时间上限，可靠性不由 HTTP 超时承担）。不做体积分级、不保留
    // HTTP 整包回传路径——整包路径必然受 body limit / 全内存发送 / 固定超时约束，分级
    // 判断本身就是"大小限制"残留。LAN 不可达/未装配时明确报错，绝不静默降级回整包。
    const push = deps.getLanPush?.() ?? null
    const uidOf = req.satellite!.uid
    if (!push) {
      res.status(503).json({ ok: false, error: '主系统局域网推流通道不可用' })
      return
    }
    if (!push.listPeers().some((p) => p.uid === uidOf)) {
      res.status(503).json({ ok: false, error: '分系统未建立局域网直连' })
      return
    }
    // transferId 含 uid/日期/毫秒时间戳/4 字节随机段：备份收端（BackupStreamSink）按它隔离落盘，
    // 随机段防猜测（对端只能写自己发起下载的 backup_dl 名，且须先拿到该 id）
    const transferId = `backup-${uidOf}-${date}-${Date.now()}-${randomBytes(4).toString('hex')}`
    const r = await push.sendBytes(uidOf, `${BACKUP_STREAM_PREFIX}${date}`, buffer, { transferId })
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `局域网推送失败：${r.error ?? '未知错误'}` })
      return
    }
    // 推流完成（收端整体校验通过）才响应：卫星侧本请求既是下载入口也是"就绪通知"，
    // 收到 mode='lan' 即从 BackupStreamSink 取落盘 zip
    res.json({ ok: true, mode: 'lan', transferId, bytes: buffer.length })
  })

  return router
}