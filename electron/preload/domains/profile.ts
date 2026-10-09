/**
 * 个人中心 preload 域。
 * 为什么存在：昵称/头像与 USER.md 文件落在主进程管理的用户数据目录，更新须经主进程落盘
 * 并同步账号表，前端只提供编辑 UI。
 * 作用：暴露 window.lunareclipse.profile* 的用户资料更新、头像保存与 USER.md 读写方法
 * （调用面见下方原注释）。
 */
import { ipcRenderer } from 'electron'
import type { CurrentUser } from '@shared/types'

/**
 * 个人中心 preload 域（：昵称/头像 + USER.md 用户资料文件）。
 * window.lunareclipse.profile.* 由本域暴露（spread 组合进主 api 对象）。

 * 调用面：ProfilePanel（个人中心面板）+ AvatarMenu（右下角头像菜单）。
 */
export const api = {
  /** 更新当前用户资料（昵称/头像/用户名；用户名修改同步 users.json 账号表，UID 不变，login 校验按新用户名） */
  profileUpdate: (patch: { 用户名?: string; 昵称?: string; 头像?: string }) =>
    ipcRenderer.invoke('profile:update', patch) as Promise<{ ok: boolean; user?: CurrentUser; error?: string }>,
  /** 保存用户头像图片（dataURL → avatars/user/{uid}/avatar.ext），返回 img: 引用（再经 profile:update 写回 头像 字段） */
  profileSaveAvatarImage: (dataUrl: string) =>
    ipcRenderer.invoke('profile:saveAvatarImage', dataUrl) as Promise<{ ok: boolean; ref?: string; error?: string }>,
  /** 读当前用户 USER.md（ABYSS/U{uid}/USER.md；用户可编辑的个人资料/信息文件） */
  profileReadUserMd: () =>
    ipcRenderer.invoke('profile:readUserMd') as Promise<{ ok: boolean; content?: string; error?: string }>,
  /** 写当前用户 USER.md（ABYSS/U{uid}/USER.md；无登录报错；≤4000 字符，与 update_user_preference 工具一致） */
  profileWriteUserMd: (content: string) =>
    ipcRenderer.invoke('profile:writeUserMd', content) as Promise<{ ok: boolean; error?: string }>,
}