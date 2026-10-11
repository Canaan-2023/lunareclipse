/**
 * 用户账号存储：维护 users.json（注册/登录、scrypt 密码哈希与校验、
 * 账号禁用、昵称头像等个人资料），并持久化最后登录状态供重启自动恢复。
 * 通过 setScopeInitializer 注入回调，在注册/登录时按用户建立目录骨架——
 * 是账号体系与多用户分层数据的基础。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

export interface UserRecord {
  UID: number
  用户名: string
  密码哈希: string
  盐: string
  创建时间: string
  /** 账号禁用标记（账号管理局设置；登录/凭据校验/分系统令牌续签均拦截） */
  禁用?: boolean
  /** 显示昵称（个人中心可改；缺省回退用户名展示） */
  昵称?: string
  /** 头像标识（emoji 或 img:avatars/... 本地图片引用，个人中心可改） */
  头像?: string
}

export interface UsersJson {
  users: UserRecord[]
  next_uid: number
  // 最后登录的用户 UID，用于持久化登录状态（重启后自动恢复）
  last_login_uid?: number | null
}

export interface CurrentUser {
  UID: number
  用户名: string
  /** 显示昵称（个人中心可改；缺省回退用户名展示） */
  昵称?: string
  /** 头像标识（emoji 或 img:avatars/... 本地图片引用） */
  头像?: string
}

// 用户列表项（不含密码等敏感字段），用于前端展示和切换
export interface UserListItem {
  UID: number
  用户名: string
  创建时间: string
  禁用?: boolean
  昵称?: string
  头像?: string
}

const ILLEGAL_CHARS = /[\\/:*?"<>|]/

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function verifyPassword(password: string, record: UserRecord): boolean {
  const hash = hashPassword(password, record.盐)
  const a = Buffer.from(hash, 'hex')
  const b = Buffer.from(record.密码哈希, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 从用户记录构造会话用户（带上昵称/头像，供登录/恢复/凭据校验统一使用） */
function toCurrentUser(record: UserRecord): CurrentUser {
  const user: CurrentUser = { UID: record.UID, 用户名: record.用户名 }
  if (record.昵称) user.昵称 = record.昵称
  if (record.头像) user.头像 = record.头像
  return user
}

export class UserStore {
  private usersJsonPath: string
  private data: UsersJson
  private current: CurrentUser | null = null
  /** 用户目录骨架创建回调（index.ts 注入：建 {uid}/{aiId}/ 的 memory/raw_memory/sessions 等） */
  private scopeInitializer: ((uid: number) => void) | null = null

  constructor(usersJsonPath: string) {
    this.usersJsonPath = usersJsonPath
    this.data = this.load()
    // 恢复持久化的登录状态
    if (this.data.last_login_uid != null) {
      const record = this.data.users.find((u) => u.UID === this.data.last_login_uid)
      if (record) {
        this.current = toCurrentUser(record)
      }
    }
  }

  /** 注入目录骨架创建回调（index.ts 调用；注册/登录时触发） */
  setScopeInitializer(fn: (uid: number) => void): void {
    this.scopeInitializer = fn
  }

  /** 确保用户目录骨架存在（幂等：已存在跳过）。注册/登录/启动恢复时调用。 */
  ensureScope(uid: number): void {
    this.scopeInitializer?.(uid)
  }

  private load(): UsersJson {
    if (!existsSync(this.usersJsonPath)) {
      mkdirSync(dirname(this.usersJsonPath), { recursive: true })
      const empty: UsersJson = { users: [], next_uid: 1, last_login_uid: null }
      writeFileSync(this.usersJsonPath, JSON.stringify(empty, null, 2), 'utf-8')
      return empty
    }
    const raw = readFileSync(this.usersJsonPath, 'utf-8')
    const parsed = JSON.parse(raw) as UsersJson
    if (!parsed.users || typeof parsed.next_uid !== 'number') {
      return { users: [], next_uid: 1, last_login_uid: null }
    }
    return parsed
  }

  private save(): void {
    mkdirSync(dirname(this.usersJsonPath), { recursive: true })
    writeFileSync(this.usersJsonPath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  /**
   * @param silent 静默注册（主系统代分系统创建账号）：不写入 last_login_uid、不 setCurrent、不建目录骨架。
   * 用于 master API 的代注册，避免污染本机的登录状态与作用域扫描。
   */
  register(用户名: string, password: string, silent?: boolean): { ok: boolean; error?: string; user?: CurrentUser } {
    if (!用户名 || 用户名.trim().length === 0) {
      return { ok: false, error: '用户名不能为空' }
    }
    if (ILLEGAL_CHARS.test(用户名)) {
      return { ok: false, error: '用户名含非法字符' }
    }
    if (!password || password.length < 4) {
      return { ok: false, error: '密码至少 4 位' }
    }
    if (this.data.users.some((u) => u.用户名 === 用户名)) {
      return { ok: false, error: '用户名已存在' }
    }
    const salt = randomBytes(16).toString('hex')
    const record: UserRecord = {
      UID: this.data.next_uid,
      用户名,
      密码哈希: hashPassword(password, salt),
      盐: salt,
      创建时间: new Date().toISOString()
    }
    this.data.users.push(record)
    this.data.next_uid += 1
    const user: CurrentUser = toCurrentUser(record)
    if (!silent) {
      // 持久化登录状态
      this.data.last_login_uid = record.UID
      this.current = user
      // 分层：注册即建用户目录骨架（{uid}/{aiId}/ 各子目录）
      this.ensureScope(record.UID)
    }
    this.save()
    return { ok: true, user }
  }

  /**
   * 纯凭据校验（不改任何登录状态）：主系统 API 为分系统远程登录验明身份用。
   * 不写 last_login_uid、不 setCurrent、不 ensureScope。
   */
  verifyCredentials(用户名: string, password: string): { ok: boolean; error?: string; user?: CurrentUser } {
    const record = this.data.users.find((u) => u.用户名 === 用户名)
    if (!record) {
      return { ok: false, error: '用户名或密码错误' }
    }
    if (record.禁用) {
      return { ok: false, error: '账号已被禁用，请联系主系统管理员' }
    }
    if (!verifyPassword(password, record)) {
      return { ok: false, error: '用户名或密码错误' }
    }
    return { ok: true, user: toCurrentUser(record) }
  }

  login(用户名: string, password: string): { ok: boolean; error?: string; user?: CurrentUser } {
    const record = this.data.users.find((u) => u.用户名 === 用户名)
    if (!record) {
      return { ok: false, error: '用户名或密码错误' }
    }
    if (record.禁用) {
      return { ok: false, error: '账号已被禁用，请联系主系统管理员' }
    }
    if (!verifyPassword(password, record)) {
      return { ok: false, error: '用户名或密码错误' }
    }
    const user: CurrentUser = toCurrentUser(record)
    this.current = user
    // 持久化登录状态
    this.data.last_login_uid = record.UID
    this.save()
    // 分层：登录也确保骨架存在（旧用户目录可能缺失）
    this.ensureScope(record.UID)
    return { ok: true, user }
  }

  /**
   * 更新用户资料（昵称/头像；用户名是登录标识不可改）。
   * 返回更新后的 CurrentUser；同步更新当前会话用户（若正登录该账号）。
   */
  updateProfile(
    uid: number,
    patch: { 昵称?: string; 头像?: string }
  ): { ok: true; user: CurrentUser } | { ok: false; error: string } {
    const record = this.data.users.find((u) => u.UID === uid)
    if (!record) {
      return { ok: false, error: '用户不存在' }
    }
    if (patch.昵称 !== undefined) {
      const nick = patch.昵称.trim()
      if (nick.length === 0 || nick.length > 24) {
        return { ok: false, error: '昵称长度需在 1-24 字符之间' }
      }
      if (ILLEGAL_CHARS.test(nick)) {
        return { ok: false, error: '昵称含非法字符' }
      }
      record.昵称 = nick
    }
    if (patch.头像 !== undefined) {
      record.头像 = patch.头像 || undefined
    }
    this.save()
    const user = toCurrentUser(record)
    if (this.current?.UID === uid) {
      this.current = user
    }
    return { ok: true, user }
  }

  /**
   * 修改用户名：UID 与账号表记录本体保持不变，仅更新 users.json 中该用户的 用户名 字段，
   * 并同步当前会话用户（若正登录该账号）。登录凭据校验按新用户名进行。
   * 校验规则与 register 一致：非空、无非法字符、全表唯一（排除自身）。
   */
  renameUser(uid: number, 新用户名: string): { ok: true; user: CurrentUser } | { ok: false; error: string } {
    const name = (新用户名 ?? '').trim()
    if (name.length === 0) {
      return { ok: false, error: '用户名不能为空' }
    }
    if (ILLEGAL_CHARS.test(name)) {
      return { ok: false, error: '用户名含非法字符' }
    }
    const record = this.data.users.find((u) => u.UID === uid)
    if (!record) {
      return { ok: false, error: '用户不存在' }
    }
    if (this.data.users.some((u) => u.UID !== uid && u.用户名 === name)) {
      return { ok: false, error: '用户名已存在' }
    }
    record.用户名 = name
    this.save()
    const user = toCurrentUser(record)
    if (this.current?.UID === uid) {
      this.current = user
    }
    return { ok: true, user }
  }

  logout(): void {
    this.current = null
    this.data.last_login_uid = null
    this.save()
  }

  /**
   * 注销账号：从 users.json 删除指定用户记录
   * - 仅删除账号本身（用户名 + 密码哈希），解放该用户名让他人可重新注册
   * - 不删除任何记忆数据（raw_memory / memory / NNG / cache / DMN 各目录均保留）
   * - UID 不回收（next_uid 保持递增），避免新旧数据混乱
   * - 如果当前登录的就是该用户，会同时执行 logout
   */
  deleteUser(uid: number): { ok: boolean; error?: string } {
    const idx = this.data.users.findIndex((u) => u.UID === uid)
    if (idx < 0) {
      return { ok: false, error: '用户不存在' }
    }
    this.data.users.splice(idx, 1)
    // 如果删除的是当前登录用户，一并登出
    if (this.current?.UID === uid) {
      this.current = null
    }
    // 如果删除的是 last_login_uid，清空避免下次启动自动登录到已删除用户
    if (this.data.last_login_uid === uid) {
      this.data.last_login_uid = null
    }
    this.save()
    return { ok: true }
  }

  /**
   * 账号管理：禁用/恢复账号。
   * 仅改账号本体标记 + 持久化；若当前登录的就是该账号不强制登出（下次登录被拦截）。
   */
  setUserDisabled(uid: number, disabled: boolean): { ok: boolean; error?: string } {
    const record = this.data.users.find((u) => u.UID === uid)
    if (!record) {
      return { ok: false, error: '用户不存在' }
    }
    record.禁用 = disabled
    this.save()
    return { ok: true }
  }

  /** 返回所有用户（不含密码哈希等敏感字段），用于前端切换用户 */
  listUsers(): UserListItem[] {
    return this.data.users.map((u) => ({
      UID: u.UID,
      用户名: u.用户名,
      创建时间: u.创建时间,
      禁用: u.禁用,
      昵称: u.昵称,
      头像: u.头像
    }))
  }

  getCurrentUser(): CurrentUser | null {
    return this.current
  }

  setCurrentUser(user: CurrentUser | null): void {
    this.current = user
  }
}