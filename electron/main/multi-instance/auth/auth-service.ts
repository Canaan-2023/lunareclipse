/**
 * 为什么存在：引入多开后认证分化为本机注册登录与分系统接入两条路径，须以统一契约按角色分流权限（主系统拒绝重复接入）。
 * 作用：定义 AuthService 契约（注册/登录/登出/删除/分系统恢复等）；MasterAuth 等实现按角色落地。
 */

import type { UserStore } from '../../models/user-store'
import type { InstanceConfigStore } from '../instance-config'
import type { AuthResult, AuthUser, RegisterIntent } from '../types'
import { SatelliteClient } from '../satellite/satellite-client'
import { SatelliteTokenCache, type SatelliteToken } from './satellite-token'

export interface AuthService {
  register(用户名: string, password: string, intent: RegisterIntent): Promise<AuthResult>
  login(用户名: string, password: string): Promise<AuthResult>
  getCurrentUser(): AuthUser | null
  logout(): void
  deleteUser(uid: number): AuthResult
  listUsers(): Array<{ UID: number; 用户名: string; 创建时间: string }>
  /** 卫星启动免密恢复：本地缓存令牌刷新后回登；失败清缓存返回 null */
  restoreSatellite(): Promise<AuthUser | null>
}

/**
 * 本机账号认证（standalone / master 模式）：
 * 行为与现状完全一致——注册建本机账号、UID 自管、scrypt 校验本机 users.json。
 * createMaster 意图额外把本机标记为主系统并暴露 /api/v1。
 */
export class MasterAuth implements AuthService {
  constructor(
    private readonly userStore: UserStore,
    private readonly instanceConfig: InstanceConfigStore
  ) {}

  async register(用户名: string, password: string, intent: RegisterIntent): Promise<AuthResult> {
    if (intent === 'joinSatellite') {
      return { ok: false, error: '本机已是主系统/单机账号模式，不能接入其他主系统' }
    }
    const result = this.userStore.register(用户名, password)
    if (result.ok && intent === 'createMaster') {
      this.instanceConfig.becomeMaster()
    }
    return result.ok && result.user ? { ok: true, user: result.user } : { ok: false, error: result.error }
  }

  async login(用户名: string, password: string): Promise<AuthResult> {
    const result = this.userStore.login(用户名, password)
    return result.ok && result.user ? { ok: true, user: result.user } : { ok: false, error: result.error }
  }

  getCurrentUser(): AuthUser | null {
    return this.userStore.getCurrentUser()
  }

  logout(): void {
    this.userStore.logout()
  }

  deleteUser(uid: number): AuthResult {
    const result = this.userStore.deleteUser(uid)
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  }

  listUsers(): Array<{ UID: number; 用户名: string; 创建时间: string }> {
    return this.userStore.listUsers()
  }

  async restoreSatellite(): Promise<AuthUser | null> {
    return null
  }
}

/**
 * 分系统认证（satellite 模式）：
 * - 注册/登录直达主系统，UID 由主系统发放；本机不落账号库，仅缓存令牌三元组。
 * - 离线：本机缓存令牌照常登录（不降级），记忆同步暂缓、连上补推。
 * - 账号生命周期（禁用/注销/恢复）由主系统侧控制，本机只认令牌有效期。
 */
export class SatelliteAuth implements AuthService {
  private readonly client: SatelliteClient

  constructor(
    private readonly userStore: UserStore,
    private readonly instanceConfig: InstanceConfigStore,
    private readonly tokenCache: SatelliteTokenCache
  ) {
    const master = instanceConfig.get().master
    if (!master) {
      throw new Error('satellite 模式缺少主系统接入配置')
    }
    this.client = new SatelliteClient(master.baseUrl)
  }

  async register(用户名: string, password: string): Promise<AuthResult> {
    const master = this.requireMaster()
    try {
      const issued = await this.client.register(用户名, password, master.joinCode ?? '')
      if (!issued.ok || !issued.uid || !issued.token || !issued.instanceId) {
        return { ok: false, error: issued.error ?? '主系统注册失败' }
      }
      this.instanceConfig.becomeSatellite({
        baseUrl: master.baseUrl,
        instanceId: issued.instanceId,
        accessToken: issued.token
      })
      this.applySession({ UID: issued.uid, 用户名 }, issued.token)
      return { ok: true, user: { UID: issued.uid, 用户名 } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  async login(用户名: string, password: string): Promise<AuthResult> {
    // 本机已有缓存令牌（未登出）→ 免密直接登录
    const cached = this.tokenCache.load()
    if (cached && cached.accessToken) {
      this.applySession({ UID: cached.UID, 用户名: cached.用户名 }, cached.accessToken)
      return { ok: true, user: { UID: cached.UID, 用户名: cached.用户名 } }
    }
    try {
      const issued = await this.client.login(用户名, password)
      if (!issued.ok || !issued.uid || !issued.token) {
        return { ok: false, error: issued.error ?? '主系统登录失败' }
      }
      this.applySession({ UID: issued.uid, 用户名 }, issued.token)
      return { ok: true, user: { UID: issued.uid, 用户名 } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  getCurrentUser(): AuthUser | null {
    return this.userStore.getCurrentUser()
  }

  logout(): void {
    this.userStore.logout()
    this.tokenCache.save(null)
  }

  deleteUser(): AuthResult {
    return { ok: false, error: '分系统不持有账号，注销请前往主系统管理' }
  }

  listUsers(): Array<{ UID: number; 用户名: string; 创建时间: string }> {
    const cur = this.getCurrentUser()
    return cur ? [{ UID: cur.UID, 用户名: cur.用户名, 创建时间: '' }] : []
  }

  async restoreSatellite(): Promise<AuthUser | null> {
    const cached = this.tokenCache.load()
    if (!cached || !cached.accessToken) return null
    try {
      const refreshed = await this.client.refresh(cached.accessToken)
      if (refreshed.ok && refreshed.token) {
        this.applySession({ UID: cached.UID, 用户名: cached.用户名 }, refreshed.token)
        return { UID: cached.UID, 用户名: cached.用户名 }
      }
    } catch {
      // 主系统不可达：离线场景不强制刷新，直接沿用缓存令牌登录
    }
    // 刷新失败（令牌被废）：清除缓存，等待用户重新在线登录
    if (!this.isTokenFresh(cached)) {
      this.tokenCache.save(null)
      return null
    }
    this.applySession({ UID: cached.UID, 用户名: cached.用户名 }, cached.accessToken)
    return { UID: cached.UID, 用户名: cached.用户名 }
  }

  private requireMaster(): NonNullable<import('../types').InstanceConfig['master']> {
    const master = this.instanceConfig.get().master
    if (!master) {
      throw new Error('缺少主系统接入配置')
    }
    return master
  }

  private isTokenFresh(token: SatelliteToken): boolean {
    return token.exp > Date.now() + 60_000
  }

  private applySession(user: AuthUser, accessToken: string, expiresInSec?: number): void {
    const exp = expiresInSec ? Date.now() + expiresInSec * 1000 : Date.now() + 7 * 24 * 3600 * 1000
    this.tokenCache.save({ ...user, accessToken, exp })
    this.userStore.setCurrentUser(user)
    // 运行期注册/登录/恢复统一补建本机骨架：satellite 首次接入（运行期拿到 UID）或
    // 登录时 UID 对应目录可能尚未创建（启动兜底只覆盖下次重启），此处幂等建全量骨架，
    // 避免首次写记忆/技能/会话前目录缺失。ensureScope 走 scopeInitializer，已注入时等价
    // ensureUserScopeSkeleton；未注入（测试/降级路径）为 no-op，不影响认证本身。
    this.userStore.ensureScope(user.UID)
  }
}