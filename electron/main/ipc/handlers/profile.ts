/**
 * 个人中心 IPC：昵称/头像（多 AI 用户记录）与用户级资料 USER.md
 * 的读写通道，供个人中心面板与头像菜单调用，资料跨 AI 会话共享注入。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { DEFAULT_AI_ID } from '@shared/types'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import type { BaseDataPaths } from '../../models/paths'
import type { UserStore } from '../../models/user-store'
import { resolveScopePaths } from '../../models/paths'
import { safeHandle } from './safe-handle'
import { saveAvatarImage } from '../../models/avatars'

/**
 * 个人中心 IPC handler（：昵称/头像 + USER.md 用户资料文件）。
 *
 * 调用面（ProfilePanel / AvatarMenu）：
 * profile:update → { ok, user?, error? } 改昵称/头像（写入 users.json 记录）
 * profile:saveAvatarImage → { ok, ref?, error? } 保存用户头像图片（dataURL → avatars/user/{uid}/avatar.ext）
 * profile:readUserMd → { ok, content?, error? } 读当前用户级资料 ABYSS/U{uid}/USER.md（无登录返回空）
 * profile:writeUserMd → { ok, error? } 写当前用户级资料 ABYSS/U{uid}/USER.md（无登录报错）
 *
 * 目标：ABYSS/U{uid}/USER.md（用户级个人资料，所有 AI 会话注入；preload 暴露 readUserMd/writeUserMd）；上限 4000 与 update_user_preference 工具一致。
 */
const USER_MD_MAX_CHARS = 4000

export function registerProfileHandlers(
  ipc: typeof ipcMainType,
  getUserStore: () => UserStore | null,
  getDataPaths: () => BaseDataPaths | null
): void {
  const getUid = (): number | null => getUserStore()?.getCurrentUser()?.UID ?? null

  // 读当前用户级资料 USER.md（ABYSS/U{uid}/USER.md；无登录返回空；用于个人中心编辑展示）
  safeHandle(
    ipc,
    'profile:readUserMd',
    () => {
      const base = getDataPaths()
      if (!base) return { ok: false, error: '数据路径未就绪' }
      const uid = getUid()
      // 用户级资料：ABYSS/U{uid}/USER.md（所有 AI 会话注入；无登录用户没有归属文件 → 空）
      const scoped = uid != null ? resolveScopePaths(base, { uid, aiId: DEFAULT_AI_ID }).userMd : null
      if (scoped == null || !existsSync(scoped)) return { ok: true, content: '' }
      try {
        return { ok: true, content: readFileSync(scoped, 'utf-8') }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    { ok: false, error: '读取失败，请查看日志' }
  )

  // 写当前用户级资料 USER.md（无登录报错；≤4000 字符，与 update_user_preference 一致）
  safeHandle(
    ipc,
    'profile:writeUserMd',
    (_e, content: unknown) => {
      const base = getDataPaths()
      if (!base) return { ok: false, error: '数据路径未就绪' }
      const text = typeof content === 'string' ? content : ''
      if (text.length > USER_MD_MAX_CHARS) {
        return { ok: false, error: `USER.md 内容过长（≤${USER_MD_MAX_CHARS} 字符）` }
      }
      const uid = getUid()
      if (uid == null) return { ok: false, error: '请先登录后再编辑个人资料' }
      const target = resolveScopePaths(base, { uid, aiId: DEFAULT_AI_ID }).userMd
      try {
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, text, 'utf-8')
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    { ok: false, error: '写入失败，请查看日志' }
  )

  // 更新当前用户资料（昵称/头像/用户名；用户名修改同步 users.json 账号表，UID 不变，
  // 修改后登录凭据校验按新用户名进行，与其他账号冲突时返回错误）
  safeHandle(
    ipc,
    'profile:update',
    (_e, patch: unknown) => {
      const userStore = getUserStore()
      const uid = getUid()
      if (!userStore || uid == null) return { ok: false, error: '请先登录' }
      const p = (patch ?? {}) as { 用户名?: unknown; 昵称?: unknown; 头像?: unknown }
      const clean: { 用户名?: string; 昵称?: string; 头像?: string } = {}
      if (p.用户名 !== undefined) {
        if (typeof p.用户名 !== 'string') return { ok: false, error: '用户名必须为字符串' }
        clean.用户名 = p.用户名
      }
      if (p.昵称 !== undefined) {
        if (typeof p.昵称 !== 'string') return { ok: false, error: '昵称必须为字符串' }
        clean.昵称 = p.昵称
      }
      if (p.头像 !== undefined) {
        if (typeof p.头像 !== 'string') return { ok: false, error: '头像必须为字符串' }
        clean.头像 = p.头像
      }
      // 用户名单独走账号表同步（UID 不变、全表唯一校验），昵称/头像走 updateProfile
      if (clean.用户名 !== undefined) {
        return userStore.renameUser(uid, clean.用户名)
      }
      return userStore.updateProfile(uid, clean)
    },
    { ok: false, error: '更新失败，请查看日志' }
  )

  // 保存用户头像图片（dataURL → avatars/user/{uid}/avatar.ext），返回 img: 引用由前端经 profile:update 写回
  safeHandle(
    ipc,
    'profile:saveAvatarImage',
    (_e, dataUrl: unknown) => {
      const base = getDataPaths()
      const uid = getUid()
      if (!base) return { ok: false, error: '数据路径未就绪' }
      if (uid == null) return { ok: false, error: '请先登录' }
      if (typeof dataUrl !== 'string') return { ok: false, error: '图片数据格式错误' }
      try {
        const r = saveAvatarImage(base.root, 'user', uid, dataUrl)
        return r.ok ? { ok: true, ref: r.ref } : { ok: false, error: r.error }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
    { ok: false, error: '保存失败，请查看日志' }
  )
}