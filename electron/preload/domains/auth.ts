/**
 * 认证与主分系统 preload 域：账号登录态与 multi-instance 主/分角色由主进程独家持有，
 * 渲染进程无法直接访问用户数据，必须经此桥完成认证与主分系统接入。
 * 作用：暴露 window.lunareclipse.auth* / multi* 系列 IPC 通道（登录/注册/登出/注销/用户列表 + 主分系统状态与接入）。
 */
import { ipcRenderer } from 'electron'
import type { CurrentUser } from '@shared/types'

export const api = {
  authLogin: (username: string, password: string) =>
    ipcRenderer.invoke('auth:login', username, password) as Promise<{ ok: boolean; error?: string; user?: CurrentUser }>,
  authRegister: (username: string, password: string, intent?: string) =>
    ipcRenderer.invoke('auth:register', username, password, intent) as Promise<{ ok: boolean; error?: string; user?: CurrentUser }>,
  authGetCurrentUser: () =>
    ipcRenderer.invoke('auth:getCurrentUser') as Promise<CurrentUser | null>,
  authLogout: () => ipcRenderer.invoke('auth:logout') as Promise<{ ok: boolean }>,
  /** 清空当前登录账号的本机工作域（注销询问确认后调用；仅删数据，不动账号记录） */
  authPurgeWorkspace: () =>
    ipcRenderer.invoke('auth:purgeWorkspace') as Promise<{ ok: boolean; error?: string; removedDirs?: number; removedFiles?: number }>,
  /** 注销账号：删除账号记录但保留所有记忆数据（解放用户名可重新注册） */
  authDeleteAccount: (uid: number) =>
    ipcRenderer.invoke('auth:deleteAccount', uid) as Promise<{ ok: boolean; error?: string }>,
  authListUsers: () =>
    ipcRenderer.invoke('auth:listUsers') as Promise<{ UID: number; 用户名: string; 创建时间: string }[]>,

  // ===== 主分系统（multi-instance） =====
  multiGetStatus: () =>
    ipcRenderer.invoke('multi:getStatus') as Promise<{
      role: 'standalone' | 'master' | 'satellite'
      master: { baseUrl: string; instanceId: string } | null
    }>,
  multiProbeMaster: (baseUrl: string) =>
    ipcRenderer.invoke('multi:probeMaster', baseUrl) as Promise<{ ok: boolean; appName?: string; error?: string }>,
  /** 粘贴主系统接入链接 → 解析地址+码并暂存（填了链接=分系统；留空注册=主系统） */
  multiSetPendingSatellite: (link: string) =>
    ipcRenderer.invoke('multi:setPendingSatellite', link) as Promise<{ ok: boolean; error?: string }>,
  /** 主系统接入信息（设置页展示/复制/轮换） */
  multiGetJoinInfo: () =>
    ipcRenderer.invoke('multi:getJoinInfo') as Promise<{ ok: boolean; baseUrl?: string; code?: string; link?: string; error?: string }>,
  multiRotateJoinCode: () =>
    ipcRenderer.invoke('multi:rotateJoinCode') as Promise<{ ok: boolean; code?: string; link?: string; error?: string }>,
  multiResetRole: () =>
    ipcRenderer.invoke('multi:resetRole') as Promise<{ ok: boolean; error?: string }>,
  // 管理窗口（master）
  multiAdminSatellites: () =>
    ipcRenderer.invoke('multi:adminSatellites') as Promise<{
      ok: boolean
      error?: string
      satellite?: Array<{
        instanceId: string
        uid: number
        用户名: string
        status: 'active' | 'disabled'
        createdAt: string
        lastSyncAt: string | null
        lastSeq: number
      }>
    }>,
  multiAdminSetStatus: (instanceId: string, status: 'active' | 'disabled') =>
    ipcRenderer.invoke('multi:adminSetStatus', instanceId, status) as Promise<{ ok: boolean; error?: string; satellite?: unknown }>,
  multiAdminRevoke: (instanceId: string) =>
    ipcRenderer.invoke('multi:adminRevoke', instanceId) as Promise<{ ok: boolean; error?: string }>,
  multiAdminAnomalies: () =>
    ipcRenderer.invoke('multi:adminAnomalies') as Promise<{ ok: boolean; error?: string; anomalies?: Array<{ instanceId: string; uid: number; type: string; message: string; ts: string }> }>,
  // 账号管理局（master）：主系统自身账号 + 全部分系统账号统一管理
  multiAdminAccounts: () =>
    ipcRenderer.invoke('multi:adminAccounts') as Promise<{
      ok: boolean
      error?: string
      accounts?: Array<{
        uid: number
        用户名: string
        创建时间: string
        禁用: boolean
        来源: 'master' | 'satellite'
        instanceId?: string
        satelliteStatus?: 'active' | 'disabled'
        lastSyncAt?: string | null
      }>
    }>,
  multiAdminSetAccountDisabled: (uid: number, disabled: boolean) =>
    ipcRenderer.invoke('multi:adminSetAccountDisabled', uid, disabled) as Promise<{ ok: boolean; error?: string }>,
  /** 清理账号本机工作域（主系统账号管理局：保留账号、清空该 uid 全部工作域数据） */
  multiAdminPurgeUser: (uid: number) =>
    ipcRenderer.invoke('multi:adminPurgeUser', uid) as Promise<{ ok: boolean; error?: string; removedDirs?: number; removedFiles?: number }>,
  /** 打开账号记忆文件夹（主/分账号统一 memory/U{uid}[/AI{aiId}]，缺省打开账号层） */
  multiAdminOpenMemory: (uid: number, aiId?: number) =>
    ipcRenderer.invoke('multi:adminOpenMemory', uid, aiId) as Promise<{ ok: boolean; error?: string; path?: string }>,
  /** 按关键词检索账号（匹配 用户名/昵称/USER.md 姓名，模糊包含；人用账号管理局界面） */
  multiAdminSearchUsers: (keyword: string) =>
    ipcRenderer.invoke('multi:adminSearchUsers', keyword) as Promise<{
      ok: boolean
      error?: string
      users?: Array<{ UID: number; 用户名: string; 昵称?: string; 姓名?: string; 禁用: boolean }>
      count?: number
      keyword?: string
    }>,
  /** 按 UID 读取该账号 USER.md 个人资料（人用账号管理局界面，无权限弹框） */
  multiAdminGetUserProfile: (uid: number) =>
    ipcRenderer.invoke('multi:adminGetUserProfile', uid) as Promise<{
      ok: boolean
      error?: string
      UID?: number
      用户名?: string
      昵称?: string
      userMd?: string | null
      chars?: number
      truncated?: boolean
      message?: string
    }>,
  // 备份中心（master）：主系统账号本机备份（日备份 memory/U{uid}/AI{aiId} → backup/U{uid}/{date}/memory|NNG 完整镜像，日期恒为昨天一份），查看内容 + 本机完全覆盖恢复
  multiLocalBackupStatus: () =>
    ipcRenderer.invoke('multi:localBackupStatus') as Promise<{
      ok: boolean
      error?: string
      archives?: Array<{ uid: number; date: string; entryCount: number; 用户名?: string }>
    }>,
  multiLocalBackupInspect: (uid: number, date: string) =>
    ipcRenderer.invoke('multi:localBackupInspect', uid, date) as Promise<{
      ok: boolean
      error?: string
      detail?: {
        count: number
        bytes: number
        domains: Array<{ domain: string; files: number; bytes: number }>
        files: Array<{ path: string; size: number; preview?: string }>
      }
    }>,
  /** 主系统账号本机全量覆盖恢复（清空 memory/U{uid} 与 NNG 域该 uid 子树后由备份完全重建） */
  multiLocalBackupRestoreOverwrite: (uid: number, date: string) =>
    ipcRenderer.invoke('multi:localBackupRestoreOverwrite', uid, date) as Promise<{ ok: boolean; error?: string; restored?: number }>,
  // 备份中心（satellite）：从主系统提取自己账号备份，查看内容 / 提取 zip / 本机完全覆盖恢复
  multiSatBackupArchives: () =>
    ipcRenderer.invoke('multi:satBackupArchives') as Promise<{
      ok: boolean
      error?: string
      archives?: Array<{ uid: number; date: string; entryCount: number }>
      用户名?: string
    }>,
  multiSatBackupInspect: (uid: number, date: string) =>
    ipcRenderer.invoke('multi:satBackupInspect', uid, date) as Promise<{
      ok: boolean
      error?: string
      detail?: {
        count: number
        bytes: number
        domains: Array<{ domain: string; files: number; bytes: number }>
        files: Array<{ path: string; size: number; preview?: string }>
      }
    }>,
  multiSatBackupSave: (uid: number, date: string) =>
    ipcRenderer.invoke('multi:satBackupSave', uid, date) as Promise<{ ok: boolean; error?: string; canceled?: boolean; path?: string }>,
  /** 分系统账号本机全量覆盖恢复（提取备份 → 暂停同步 → 重建该 uid 的 memory/NNG 工作域 → 恢复同步） */
  multiSatBackupRestoreOverwrite: (uid: number, date: string) =>
    ipcRenderer.invoke('multi:satBackupRestoreOverwrite', uid, date) as Promise<{ ok: boolean; error?: string; restored?: number }>,
}