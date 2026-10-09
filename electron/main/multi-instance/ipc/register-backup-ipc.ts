/**
 * @category 工具
 * @summary 多实例备份中心 IPC 注册
 * 主系统：3 个 localBackup*（本机日归档 + 覆盖恢复）；分系统：4 个 satBackup*（从主系统提取/恢复）
 * 为什么存在：备份/恢复涉及文件对话框与磁盘写操作，只能由主进程承载，故注册为 IPC 通道供渲染层调用。
 * 注册策略（2026-10 修复）：全部通道无条件注册 + handler 内角色守卫。
 * 历史 BUG 与留存理由：旧实现按启动时角色条件注册（master 才注册 localBackup*、satellite 才注册
 * satBackup*）——启动后「注册成为主系统」走运行时路径（auth:register createMaster），通道不会补注册，
 * 导致打包版账号管理局/备份中心永久不可用。改为与账号管理局（register-account-ipc）同构的
 * 无条件注册模式：通道常驻，角色在调用时裁决，运行时角色变更（升级主系统/接入分系统）即插即用。
 */
import { dialog } from 'electron'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { ipcMain as ipcMainType, BrowserWindow } from 'electron'
import type { UserStore } from '../../models/user-store'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import { InstanceConfigStore } from '../instance-config'
import { SatelliteTokenCache } from '../auth/satellite-token'
import { SatelliteClient } from '../satellite/satellite-client'
import { restoreLocalScope } from '../satellite/local-restore'
import type { MasterRegistry } from '../master/master-registry'
import type { SatelliteStore } from '../master/satellite-store'

/** 备份中心所需上下文：以 getter/方法形式注入 MultiInstanceService 私有状态 */
export interface BackupIpcCtx {
  root: string
  getRegistry(): MasterRegistry | null
  getSatelliteStore(): SatelliteStore | null
  getConfig(): InstanceConfigStore
  getTokenCache(): SatelliteTokenCache
  getUserStore(): UserStore | null
  getMainWindow(): BrowserWindow | null
  stopSync(): Promise<void>
  startSync(): Promise<void>
  /** 备份收端（卫星侧 BackupStreamSink 装配后注入）：大备份经 LAN 分块面落盘后按 transferId 取回 zip 路径 */
  getBackupReceiver(): { awaitZipReady(transferId: string): Promise<string> } | null
}

/** 注册备份中心 IPC 通道（localBackup* 主系统侧 3 个；satBackup* 分系统侧 4 个；均无条件注册） */
export function registerBackupIpc(ipc: typeof ipcMainType, ctx: BackupIpcCtx): void {
  // ===== 备份中心（主系统账号自助：本机日归档 + 本机完全覆盖恢复，不操作分系统数据） =====
  // 角色守卫：非主系统（standalone/satellite）直接拒绝，避免对 null store 的非空断言抛 TypeError。
  const masterGuard = (): { ok: false; error: string } | null =>
    ctx.getRegistry() && ctx.getSatelliteStore() ? null : { ok: false, error: '非主系统' }

  safeHandle(
    ipc, 'multi:localBackupStatus',
    () => {
      const denied = masterGuard()
      if (denied) return denied
      const userStore = ctx.getUserStore()
      if (!userStore) return { ok: false, error: '账号库未就绪' }
      const satUids = new Set(ctx.getRegistry()!.listSatellites().map((s) => s.uid))
      const uidName = new Map(userStore.listUsers().map((u) => [u.UID, u.用户名]))
      const archives = ctx
        .getSatelliteStore()!
        .listLocalArchives()
        .filter((a) => !satUids.has(a.uid))
        .map((a) => ({ ...a, 用户名: uidName.get(a.uid) ?? `UID ${a.uid}` }))
      return { ok: true, archives }
    },
    { ok: false, error: '读取失败' }
  )

  safeHandle(
    ipc, 'multi:localBackupInspect',
    (_e, uid: unknown, date: unknown) => {
      if (typeof uid !== 'number' || typeof date !== 'string') {
        return { ok: false, error: '参数不合法' }
      }
      const denied = masterGuard()
      if (denied) return denied
      const detail = ctx.getSatelliteStore()!.inspectLocalArchive(uid, date)
      if (detail.count === 0) return { ok: false, error: '备份不存在或为空' }
      return { ok: true, detail }
    },
    { ok: false, error: '读取失败' }
  )

  safeHandle(
    ipc, 'multi:localBackupRestoreOverwrite',
    (_e, uid: unknown, date: unknown) => {
      if (typeof uid !== 'number' || typeof date !== 'string') {
        return { ok: false, error: '参数不合法' }
      }
      const denied = masterGuard()
      if (denied) return denied
      const result = ctx.getSatelliteStore()!.restoreLocalOverwrite(uid, date)
      if (!result.ok) return { ok: false, error: result.error ?? '恢复失败' }
      return { ok: true, restored: result.restored }
    },
    { ok: false, error: '恢复失败' }
  )

  // ===== 备份中心（分系统账号自助：从主系统提取自己账号备份，本机完全覆盖恢复） =====
  // 角色守卫：非分系统（standalone/master）直接拒绝；分系统但未连接/令牌缺失走 satClient 空值分支。
  const satelliteGuard = (): { ok: false; error: string } | null =>
    ctx.getConfig().isSatellite() ? null : { ok: false, error: '非分系统' }

  const satClient = (): { client: SatelliteClient; token: string; uid: number; 用户名: string } | null => {
    const master = ctx.getConfig().get().master
    const cached = ctx.getTokenCache().load()
    if (!master || !cached || !cached.accessToken) return null
    return { client: new SatelliteClient(master.baseUrl), token: cached.accessToken, uid: cached.UID, 用户名: cached.用户名 }
  }

  safeHandle(
    ipc, 'multi:satBackupArchives',
    async () => {
      const denied = satelliteGuard()
      if (denied) return denied
      const c = satClient()
      if (!c) return { ok: false, error: '未连接主系统' }
      try {
        const r = await c.client.listBackupArchives(c.token, c.uid)
        return r.ok && r.archives ? { ok: true, archives: r.archives, 用户名: c.用户名 } : { ok: false, error: r.error ?? '读取失败' }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    { ok: false, error: '读取失败' }
  )

  safeHandle(
    ipc, 'multi:satBackupInspect',
    async (_e, uid: unknown, date: unknown) => {
      const denied = satelliteGuard()
      if (denied) return denied
      const c = satClient()
      if (!c) return { ok: false, error: '未连接主系统' }
      if (typeof uid !== 'number' || typeof date !== 'string') {
        return { ok: false, error: '参数不合法' }
      }
      try {
        const r = await c.client.inspectBackup(c.token, uid, date)
        return r.ok && r.detail ? { ok: true, detail: r.detail } : { ok: false, error: r.error ?? '读取失败' }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    { ok: false, error: '读取失败' }
  )

  safeHandle(
    ipc, 'multi:satBackupSave',
    async (_e, uid: unknown, date: unknown) => {
      const denied = satelliteGuard()
      if (denied) return denied
      const c = satClient()
      if (!c) return { ok: false, error: '未连接主系统' }
      if (typeof uid !== 'number' || typeof date !== 'string') {
        return { ok: false, error: '参数不合法' }
      }
      try {
        // 备份下载一律走 LAN 分块面（无体积分级、无 HTTP 整包、无时间上限），
        // 传输与完整性由 downloadBackupZip 内部处理（主系统推流完成后响应就绪通知）
        const bytes = await c.client.downloadBackupZip(c.token, uid, date, ctx.getBackupReceiver())
        const win = ctx.getMainWindow()
        const target = win
          ? await dialog.showSaveDialog(win, {
              title: '保存备份包',
              defaultPath: `restore-${uid}-${date}.zip`,
              filters: [{ name: 'ZIP 归档', extensions: ['zip'] }]
            })
          : null
        if (!target || target.canceled || !target.filePath) return { ok: false, canceled: true }
        mkdirSync(dirname(target.filePath), { recursive: true })
        writeFileSync(target.filePath, Buffer.from(bytes))
        return { ok: true, path: target.filePath }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    { ok: false, error: '提取失败' }
  )

  // 本机完全覆盖恢复：提取期间暂停同步，防恢复产生的 oplog 回流主系统；恢复完成重启同步（指纹对账收敛）
  safeHandle(
    ipc, 'multi:satBackupRestoreOverwrite',
    async (_e, uid: unknown, date: unknown) => {
      const denied = satelliteGuard()
      if (denied) return denied
      const c = satClient()
      if (!c) return { ok: false, error: '未连接主系统' }
      if (typeof uid !== 'number' || typeof date !== 'string') {
        return { ok: false, error: '参数不合法' }
      }
      let bytes: Uint8Array
      try {
        // 与 satBackupSave 同策略：一律 LAN 分块面，无大小/时间限制，传输在 downloadBackupZip 内部
        bytes = await c.client.downloadBackupZip(c.token, uid, date, ctx.getBackupReceiver())
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      await ctx.stopSync()
      try {
        const restored = await restoreLocalScope(ctx.root, uid, bytes)
        return { ok: true, restored }
      } catch (err) {
        return { ok: false, error: `本机恢复失败：${(err as Error).message}` }
      } finally {
        await ctx.startSync()
      }
    },
    { ok: false, error: '恢复失败' }
  )
}