/**
 * 认证 IPC：账号注册/登录与用户态管理的通道；用户名/密码按长度与
 * 类型严格校验后交给 multi-instance 的 authService（含主/伴生实例
 * 注册意图）处理，是登录态与多用户隔离的前端入口。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { DEFAULT_AI_ID } from '@shared/types'
import type { BaseDataPaths } from '../../models/paths'
import type { UserStore } from '../../models/user-store'
import type { SessionStore } from '../../api/session-store'
import { safeHandle } from './safe-handle'
import { resolveScopePaths } from '../../models/paths'
import { purgeUserWorkspace } from '../../services/user-workspace-purge'
import { getAuthService } from '../../multi-instance/auth/registry'
import type { RegisterIntent } from '../../multi-instance/types'

const USERNAME_MIN_LENGTH = 1
const USERNAME_MAX_LENGTH = 50
const PASSWORD_MIN_LENGTH = 1
const PASSWORD_MAX_LENGTH = 200

function validateUsername(value: unknown): string | null {
  if (typeof value !== 'string') return '用户名必须为字符串'
  if (value.length < USERNAME_MIN_LENGTH) return `用户名不能为空`
  if (value.length > USERNAME_MAX_LENGTH) return `用户名不能超过 ${USERNAME_MAX_LENGTH} 字符`
  return null
}

function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string') return '密码必须为字符串'
  if (value.length < PASSWORD_MIN_LENGTH) return '密码不能为空'
  if (value.length > PASSWORD_MAX_LENGTH) return `密码不能超过 ${PASSWORD_MAX_LENGTH} 字符`
  return null
}

function validateUid(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 'uid 必须为整数'
  if (value <= 0) return 'uid 必须为正整数'
  return null
}

function normalizeIntent(value: unknown): RegisterIntent {
  if (value === 'createMaster' || value === 'joinSatellite') return value
  return 'local'
}

export function registerAuthHandlers(
  ipc: typeof ipcMainType,
  getUserStore: () => UserStore | null,
  getSessionStore?: () => SessionStore | null,
  getDataPaths?: () => BaseDataPaths | null,
  onAuthSuccess?: () => void
): void {
  /** 登录/切换用户后：SessionStore 切到该用户目录（看到退前状态），并确保用户目录骨架存在 */
  const switchSessionToUser = (uid: number): void => {
    const sessionStore = getSessionStore?.()
    const dataPaths = getDataPaths?.()
    if (!sessionStore || !dataPaths) return
    const scoped = resolveScopePaths(dataPaths, { uid, aiId: DEFAULT_AI_ID })
    sessionStore.switchUser(scoped.sessions)
  }

  /**
   * 认证入口统一走多实例门面注入的 AuthService（standalone/master=本机、satellite=主系统 API）。
   * 未注入（测试/降级）回退为直接操作 UserStore 的现状行为。
   */
  safeHandle(
    ipc, 'auth:login',
    async (_event, username: unknown, password: unknown) => {
      const usernameErr = validateUsername(username)
      if (usernameErr) return { ok: false, error: usernameErr }
      const passwordErr = validatePassword(password)
      if (passwordErr) return { ok: false, error: passwordErr }
      const auth = getAuthService()
      if (auth) {
        const result = await auth.login(username as string, password as string)
        if (result.ok && result.user) {
          switchSessionToUser(result.user.UID)
          onAuthSuccess?.()
        }
        return result
      }
      const userStore = getUserStore()
      if (!userStore) return { ok: false, error: 'userStore not ready' }
      const result = userStore.login(username as string, password as string)
      if (result.ok && result.user) {
        switchSessionToUser(result.user.UID)
        // 与 AuthService 分支一致：登录成功必须触发成功回调（lilith 桌宠启动等依赖它）
        onAuthSuccess?.()
      }
      return result
    },
    { ok: false, error: '登录失败，请查看日志' }
  )

  safeHandle(
    ipc, 'auth:register',
    async (_event, username: unknown, password: unknown, intent: unknown) => {
      const usernameErr = validateUsername(username)
      if (usernameErr) return { ok: false, error: usernameErr }
      const passwordErr = validatePassword(password)
      if (passwordErr) return { ok: false, error: passwordErr }
      const auth = getAuthService()
      if (auth) {
        const result = await auth.register(username as string, password as string, normalizeIntent(intent))
        if (result.ok && result.user) {
          switchSessionToUser(result.user.UID)
          onAuthSuccess?.()
        }
        return result
      }
      const userStore = getUserStore()
      if (!userStore) return { ok: false, error: 'userStore not ready' }
      const result = userStore.register(username as string, password as string)
      if (result.ok && result.user) {
        switchSessionToUser(result.user.UID)
        // 与 AuthService 分支一致：注册成功同样触发成功回调
        onAuthSuccess?.()
      }
      return result
    },
    { ok: false, error: '注册失败，请查看日志' }
  )

  safeHandle(
    ipc, 'auth:getCurrentUser',
    () => {
      const auth = getAuthService()
      if (auth) return auth.getCurrentUser()
      const userStore = getUserStore()
      if (!userStore) return null
      return userStore.getCurrentUser()
    },
    null
  )

  // 清理当前登录账号的本机工作域（注销询问确认后调用，仅清数据不动账号记录）
  safeHandle(
    ipc, 'auth:purgeWorkspace',
    () => {
      const dataPaths = getDataPaths?.()
      if (!dataPaths) return { ok: false, error: '数据目录未就绪' }
      const auth = getAuthService()
      const current = auth ? auth.getCurrentUser() : getUserStore()?.getCurrentUser()
      if (!current) return { ok: false, error: '未登录' }
      const result = purgeUserWorkspace(dataPaths.root, current.UID)
      // 清理后同步切回全局会话目录（前端随后自会刷新登录态）
      getSessionStore?.()?.switchUser(dataPaths.sessions)
      return { ok: true, removedDirs: result.removedDirs.length, removedFiles: result.removedFiles.length }
    },
    { ok: false, error: '清理失败，请查看日志' }
  )

  safeHandle(
    ipc, 'auth:logout',
    () => {
      const auth = getAuthService()
      if (auth) {
        auth.logout()
      } else {
        const userStore = getUserStore()
        userStore?.logout()
      }
      // 分层：登出后切回全局会话目录（前端会清空会话列表）
      const sessionStore = getSessionStore?.()
      const dataPaths = getDataPaths?.()
      if (sessionStore && dataPaths) {
        sessionStore.switchUser(dataPaths.sessions)
      }
      return { ok: true }
    },
    { ok: false }
  )

  // 注销账号：master/standalone 删除账号记录但保留记忆数据；satellite 不持账号、拒绝并提供指引
  safeHandle(
    ipc, 'auth:deleteAccount',
    (_event, uid: unknown) => {
      const auth = getAuthService()
      if (auth) {
        if (!auth.getCurrentUser()) return { ok: false, error: '请先登录后再注销账号' }
        const uidErr = validateUid(uid)
        if (uidErr) return { ok: false, error: uidErr }
        return auth.deleteUser(uid as number)
      }
      const userStore = getUserStore()
      if (!userStore) return { ok: false, error: 'userStore not ready' }
      if (!userStore.getCurrentUser()) return { ok: false, error: '请先登录后再注销账号' }
      const uidErr = validateUid(uid)
      if (uidErr) return { ok: false, error: uidErr }
      return userStore.deleteUser(uid as number)
    },
    { ok: false, error: '注销失败，请查看日志' }
  )

  // 返回所有用户列表（不含密码），用于前端切换用户
  safeHandle<unknown[]>(
    ipc, 'auth:listUsers',
    () => {
      const auth = getAuthService()
      if (auth) return auth.listUsers()
      const userStore = getUserStore()
      if (!userStore) return []
      return userStore.listUsers()
    },
    []
  )
}