/**
 * @category 工具
 * @summary 多实例接入配置 + AI 代理 + 账号管理局 IPC 注册
 * 接入 5 通道（multi:probeMaster / setPendingSatellite / getJoinInfo / rotateJoinCode / resetRole）
 * AI 代理 8 通道（ai-agent:*）+ 管理 7 通道（multi:admin*）
 * 为什么存在：接入配置/AI 代理/账号管理都是主进程行为（磁盘 + Electron API），UI 必须经 IPC 通道访问，故集中注册。
 */
import { shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { ipcMain as ipcMainType } from 'electron'
import type { UserStore } from '../../models/user-store'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import { AiAgentConfigStore } from '../ai-agent-config-store'
import { ChatStore } from '../friends/chat-store'
import type { MasterRegistry } from '../master/master-registry'
import { SearchUsersTool, GetUserProfileTool } from '../../tools/account-lookup'
import type { ToolContext } from '../../tools/base-tool'
import { purgeUserWorkspace } from '../../services/user-workspace-purge'

/** 接入/AI 代理/管理局所需上下文：以 getter/方法形式注入 MultiInstanceService 私有状态 */
export interface AccountIpcCtx {
  root: string
  getUserStore(): UserStore | null
  getRegistry(): MasterRegistry | null
  getAiAgentConfig(): AiAgentConfigStore
  probeMaster(baseUrl: string): Promise<{ ok: boolean; appName?: string; error?: string }>
  setPendingSatellite(link: string): { ok: boolean; error?: string }
  getJoinInfo(): { baseUrl: string; code: string; link: string } | null
  rotateJoinCode(): { ok: boolean; code?: string; link?: string; error?: string }
  resetRole(): { ok: boolean; error?: string }
}

/** 注册接入配置 + AI 代理 + 账号管理局 IPC 通道（共 20 个） */
export function registerAccountIpc(ipc: typeof ipcMainType, ctx: AccountIpcCtx): void {
  // ===== 接入配置（注册页意图） =====
  safeHandle(
    ipc, 'multi:probeMaster',
    (_e, baseUrl: unknown) => {
      if (typeof baseUrl !== 'string' || !/^https?:\/\/.+/i.test(baseUrl)) {
        return { ok: false, error: '请输入完整地址，如 http://192.0.2.10:62002' }
      }
      return ctx.probeMaster(baseUrl)
    },
    { ok: false, error: '探测失败' }
  )

  safeHandle(
    ipc, 'multi:setPendingSatellite',
    (_e, link: unknown) => {
      if (typeof link !== 'string' || !link.trim()) {
        return { ok: false, error: '请粘贴主系统接入链接' }
      }
      return ctx.setPendingSatellite(link)
    },
    { ok: false, error: '写入接入配置失败' }
  )

  safeHandle(
    ipc, 'multi:getJoinInfo',
    () => {
      const info = ctx.getJoinInfo()
      return info ? { ok: true, ...info } : { ok: false, error: '非主系统或无接入码' }
    },
    { ok: false, error: '读取接入信息失败' }
  )

  safeHandle(
    ipc, 'multi:rotateJoinCode',
    () => ctx.rotateJoinCode(),
    { ok: false, error: '轮换接入码失败' }
  )

  safeHandle(
    ipc, 'multi:resetRole',
    () => ctx.resetRole(),
    { ok: false, error: '重置失败' }
  )

  // ===== AI 代理（自动回复开关配置） =====
  safeHandle(
    ipc, 'ai-agent:setGlobal',
    (_e, enabled: unknown) => {
      if (typeof enabled !== 'boolean') return { ok: false, error: '参数不合法' }
      ctx.getAiAgentConfig().setEnabled(enabled)
      return { ok: true as const }
    },
    { ok: false, error: '设置失败' }
  )
  safeHandle(
    ipc, 'ai-agent:getGlobal',
    () => ({ ok: true as const, enabled: ctx.getAiAgentConfig().get().enabled }),
    { ok: false, error: '读取失败' }
  )
  safeHandle(
    ipc, 'ai-agent:setChatRoom',
    (_e, gid: unknown, enabled: unknown) => {
      if (typeof gid !== 'string' || typeof enabled !== 'boolean') return { ok: false, error: '参数不合法' }
      ctx.getAiAgentConfig().setChatRoom(gid, enabled)
      return { ok: true as const }
    },
    { ok: false, error: '设置失败' }
  )
  safeHandle(
    ipc, 'ai-agent:getChatRoom',
    (_e, gid: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return { ok: true as const, enabled: ctx.getAiAgentConfig().isChatRoomEnabled(gid) }
    },
    { ok: false, error: '读取失败' }
  )
  safeHandle(
    ipc, 'ai-agent:setDirectChat',
    (_e, peerUid: unknown, enabled: unknown) => {
      if (typeof peerUid !== 'number' || typeof enabled !== 'boolean') return { ok: false, error: '参数不合法' }
      const u = ctx.getUserStore()?.getCurrentUser()
      if (!u) return { ok: false, error: '未登录' }
      ctx.getAiAgentConfig().setDirectChat(ChatStore.chatId(u.UID, peerUid), enabled)
      return { ok: true as const }
    },
    { ok: false, error: '设置失败' }
  )
  safeHandle(
    ipc, 'ai-agent:getDirectChat',
    (_e, peerUid: unknown) => {
      if (typeof peerUid !== 'number') return { ok: false, error: '参数不合法' }
      const u = ctx.getUserStore()?.getCurrentUser()
      if (!u) return { ok: false, error: '未登录' }
      return { ok: true as const, enabled: ctx.getAiAgentConfig().isDirectChatEnabled(ChatStore.chatId(u.UID, peerUid)) }
    },
    { ok: false, error: '读取失败' }
  )
  safeHandle(
    ipc, 'ai-agent:setProactive',
    (_e, enabled: unknown) => {
      if (typeof enabled !== 'boolean') return { ok: false, error: '参数不合法' }
      ctx.getAiAgentConfig().setProactive(enabled)
      return { ok: true as const }
    },
    { ok: false, error: '设置失败' }
  )
  safeHandle(
    ipc, 'ai-agent:getProactive',
    () => ({
      ok: true as const,
      enabled: ctx.getAiAgentConfig().isProactiveEnabled(),
      intervalMs: ctx.getAiAgentConfig().getProactiveIntervalMs()
    }),
    { ok: false, error: '读取失败' }
  )

  // ===== 管理局（主系统视角：分系统状态 / 令牌） =====
  safeHandle(
    ipc, 'multi:adminSatellites',
    () => {
      if (!ctx.getRegistry()) return { ok: false, error: '非主系统' }
      return { ok: true, satellite: ctx.getRegistry()!.listSatellites().map(({ tokenHash: _th, tokenExp: _te, ...rest }) => { void _th; void _te; return rest }) }
    },
    { ok: false, error: '读取失败' }
  )

  safeHandle(
    ipc, 'multi:adminSetStatus',
    (_e, instanceId: unknown, status: unknown) => {
      if (!ctx.getRegistry()) return { ok: false, error: '非主系统' }
      if (typeof instanceId !== 'string' || (status !== 'active' && status !== 'disabled')) {
        return { ok: false, error: '参数不合法' }
      }
      const updated = ctx.getRegistry()!.setStatus(instanceId, status)
      if (!updated) return { ok: false, error: '分系统不存在' }
      const { tokenHash: _th, tokenExp: _te, ...rest } = updated
      void _th; void _te
      return { ok: true, satellite: rest }
    },
    { ok: false, error: '操作失败' }
  )

  safeHandle(
    ipc, 'multi:adminRevoke',
    (_e, instanceId: unknown) => {
      if (!ctx.getRegistry()) return { ok: false, error: '非主系统' }
      if (typeof instanceId !== 'string') return { ok: false, error: '参数不合法' }
      ctx.getRegistry()!.revokeToken(instanceId)
      return { ok: true }
    },
    { ok: false }
  )

  safeHandle(
    ipc, 'multi:adminAnomalies',
    () => {
      if (!ctx.getRegistry()) return { ok: false, error: '非主系统' }
      return { ok: true, anomalies: ctx.getRegistry()!.listAnomalies() }
    },
    { ok: false, error: '读取失败' }
  )

  // ===== 账号管理局（主系统自身账号 + 全部分系统账号统一管理） =====
  // users.json 同时存主系统账号与分系统账号（分系统注册时静默写入）；
  // 区分来源：registry 中出现的 uid 为分系统账号，其余为主系统本机账号。
  safeHandle(
    ipc, 'multi:adminAccounts',
    () => {
      const registry = ctx.getRegistry()
      if (!registry) return { ok: false, error: '非主系统' }
      const userStore = ctx.getUserStore()
      if (!userStore) return { ok: false, error: '账号库未就绪' }
      const satellites = registry.listSatellites()
      const uidToSat = new Map(satellites.map((s) => [s.uid, s]))
      const accounts = userStore.listUsers().map((u) => {
        const sat = uidToSat.get(u.UID)
        return sat
          ? { uid: u.UID, 用户名: u.用户名, 创建时间: u.创建时间, 禁用: !!u.禁用, 来源: 'satellite' as const, instanceId: sat.instanceId, satelliteStatus: sat.status, lastSyncAt: sat.lastSyncAt }
          : { uid: u.UID, 用户名: u.用户名, 创建时间: u.创建时间, 禁用: !!u.禁用, 来源: 'master' as const }
      })
      accounts.sort((a, b) => a.uid - b.uid)
      return { ok: true, accounts }
    },
    { ok: false, error: '读取失败' }
  )

  // 禁用/恢复账号：分系统账号同时同步 registry 状态（令牌作废/恢复可登录）
  safeHandle(
    ipc, 'multi:adminSetAccountDisabled',
    (_e, uid: unknown, disabled: unknown) => {
      const registry = ctx.getRegistry()
      if (!registry) return { ok: false, error: '非主系统' }
      const userStore = ctx.getUserStore()
      if (!userStore) return { ok: false, error: '账号库未就绪' }
      if (typeof uid !== 'number' || typeof disabled !== 'boolean') return { ok: false, error: '参数不合法' }
      const result = userStore.setUserDisabled(uid, disabled)
      if (!result.ok) return { ok: false, error: result.error ?? '操作失败' }
      const sat = registry.listSatellites().find((s) => s.uid === uid)
      if (sat) {
        registry.setStatus(sat.instanceId, disabled ? 'disabled' : 'active')
      }
      return { ok: true }
    },
    { ok: false, error: '操作失败' }
  )

  // 打开账号记忆文件夹（主/分账号统一 memory/U{uid}[/AI{aiId}]，uid 全局唯一不冲突）
  safeHandle(
    ipc, 'multi:adminOpenMemory',
    (_e, uid: unknown, aiId?: unknown) => {
      if (!ctx.getRegistry()) return { ok: false, error: '非主系统' }
      if (typeof uid !== 'number' || (aiId != null && typeof aiId !== 'number')) return { ok: false, error: '参数不合法' }
      const baseDir = join(ctx.root, 'memory', `U${uid}`)
      const dir = typeof aiId === 'number' && aiId > 0 ? join(baseDir, `AI${aiId}`) : baseDir
      if (!existsSync(dir)) return { ok: false, error: '该账号暂无记忆目录' }
      shell.showItemInFolder(dir)
      return { ok: true, path: dir }
    },
    { ok: false, error: '打开失败' }
  )

  // 清理账号本机工作域（主系统账号管理：清空该账号在本机的 memory/NNG/cache/sessions/
  // skills/config/ABYSS/backup/分系统归集会话等全部工作域内容；仅清数据，不动账号记录）
  // 为什么存在——多账号治理：主系统账号管理局可清理本机自身账号或分系统账号的工作域
  // 数据（与「注销账号（deleteAccount，保留数据）」互补：本条是「保留账号、清空数据」）。
  // 安全：必须主系统 + uid 为正整数 + 账号存在；删除前 UI 必须二次确认（数据不可恢复）。
  safeHandle(
    ipc, 'multi:adminPurgeUser',
    (_e, uid: unknown) => {
      if (!ctx.getRegistry()) return { ok: false, error: '非主系统' }
      const userStore = ctx.getUserStore()
      if (!userStore) return { ok: false, error: '账号库未就绪' }
      if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) return { ok: false, error: '参数不合法' }
      if (!userStore.listUsers().some((u) => u.UID === uid)) return { ok: false, error: '账号不存在' }
      const result = purgeUserWorkspace(ctx.root, uid)
      return { ok: true, removedDirs: result.removedDirs.length, removedFiles: result.removedFiles.length }
    },
    { ok: false, error: '清理失败，请查看日志' }
  )

  // ===== 账号资料检索（人用 UI：账号管理局抽屉复用 AI 侧检索工具逻辑） =====
  // 复用 account-lookup.ts 的 SearchUsersTool / GetUserProfileTool（已按 code-review 评审：
  // 只读 users.json + ABYSS/U{uid}/USER.md，绝不返回密码哈希/盐；带截断保护）。
  // ctx.root 即 abyssac_data 根目录（与 paths.ts:88 的 root 一致），故：
  // usersJson = {root}/users/users.json，abyss = {root}/ABYSS
  const lookupCtx = (): ToolContext => ({
    paths: {
      usersJson: join(ctx.root, 'users', 'users.json'),
      abyss: join(ctx.root, 'ABYSS')
    } as unknown as ToolContext['paths']
  })

  // 账号管理局检索与资料查看均为主系统视角操作（与其它 multi:admin* 一致：分系统本机
  // 也有自己的 users.json/ABYSS，读的是自身数据、语义与主系统统一账号管理者不一致，故限制仅主系统可调）
  const requireMaster = (): { ok: boolean; error: string } | null =>
    ctx.getRegistry() ? null : { ok: false, error: '非主系统' }

  // 按关键词检索账号（匹配 用户名/昵称/USER.md 姓名，模糊包含）
  safeHandle(
    ipc, 'multi:adminSearchUsers',
    async (_e, keyword: unknown) => {
      const denied = requireMaster()
      if (denied) return denied
      if (typeof keyword !== 'string') return { ok: false, error: '参数不合法' }
      if (keyword.length > 100) return { ok: false, error: '关键词过长（最多 100 字符）' }
      const r = await new SearchUsersTool().execute({ keyword }, lookupCtx())
      if (!r.ok) return { ok: false, error: r.error ?? '检索失败' }
      return { ok: true, ...(r.data as object) }
    },
    { ok: false, error: '检索失败' }
  )

  // 按 UID 读取该账号 USER.md 个人资料（人用 UI 无需权限弹框——管理员本人操作）
  safeHandle(
    ipc, 'multi:adminGetUserProfile',
    async (_e, uid: unknown) => {
      const denied = requireMaster()
      if (denied) return denied
      if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) {
        return { ok: false, error: '参数不合法' }
      }
      const r = await new GetUserProfileTool().execute({ uid }, lookupCtx())
      if (!r.ok) return { ok: false, error: r.error ?? '读取失败' }
      return { ok: true, ...(r.data as object) }
    },
    { ok: false, error: '读取失败' }
  )
}