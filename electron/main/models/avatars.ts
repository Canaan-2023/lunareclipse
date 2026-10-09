/**
 * 头像图片落盘：AI 自定义头像与用户个人头像共用同一套保存逻辑，
 * 将 base64 dataUrl 转存为本地文件并返回 img:avatars/... 引用。
 * 独立成文件是为了让头像引用统一走 lune-media 协议加载，
 * 并集中处理格式校验、大小限制与旧扩展名文件清理。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 头像图片保存（AI 自定义头像 / 用户个人头像共用）。
 *
 * 调用方式：
 * saveAvatarImage(dataRoot, 'ai', aiId, dataUrl) → { ok:true, ref:'img:avatars/ai/{aiId}/avatar.png' }
 * saveAvatarImage(dataRoot, 'user', uid, dataUrl) → { ok:true, ref:'img:avatars/user/{uid}/avatar.png' }
 *
 * - dataUrl 仅接受 data:image/{png|jpeg|webp|gif};base64,...
 * - 落盘 {dataRoot}/avatars/{kind}/{id}/avatar.{ext}（lune-media:///avatars/... 可加载，
 * media-protocol.ts 已放行该前缀）
 * - 返回的 ref 直接存入 AI 注册表 avatar 字段或用户记录头像字段
 */
const MAX_AVATAR_BYTES = 4 * 1024 * 1024 // 4MB
const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export type AvatarKind = 'ai' | 'user'

export function saveAvatarImage(
  dataRoot: string,
  kind: AvatarKind,
  id: number,
  dataUrl: string
): { ok: true; ref: string } | { ok: false; error: string } {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ''))
  if (!m) {
    return { ok: false, error: '图片格式仅支持 png/jpg/webp/gif' }
  }
  const ext = ALLOWED_MIME[m[1]]
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length === 0) {
    return { ok: false, error: '图片内容为空' }
  }
  if (buf.length > MAX_AVATAR_BYTES) {
    return { ok: false, error: '图片过大（不超过 4MB）' }
  }
  const dir = join(dataRoot, 'avatars', kind, String(id))
  const file = join(dir, `avatar.${ext}`)
  mkdirSync(dir, { recursive: true })
  // 已存在同 kind/id 但扩展名不同的旧文件：不残留（换格式上传时清掉旧扩展名文件）
  for (const oldExt of Object.values(ALLOWED_MIME)) {
    if (oldExt !== ext) {
      const oldFile = join(dir, `avatar.${oldExt}`)
      try {
        if (existsSync(oldFile)) rmSync(oldFile, { force: true })
      } catch {
        // 忽略清理失败（不影响本次写入）
      }
    }
  }
  writeFileSync(file, buf)
  return { ok: true, ref: `img:avatars/${kind}/${id}/avatar.${ext}` }
}