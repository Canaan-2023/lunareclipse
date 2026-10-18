/**
 * @category ROOM
 * @summary AI 拟人化像素规格（声明式，唯一真源）：调色板 + 行字符串网格 + 相位帧
 *
 * 为什么存在：用户 2026-10-18 裁决「像素指的是图像，不是字体，就好比 AI 拟人化可视化」
 * 「AI 可操作性 = AI 决定像素点怎么摆放」。ROOM 因此要有**像素房间 + AI 形象**，且这份形象
 * 由 AI 自己画。本文件是那份画作的**数据格式与校验**（纯函数，主进程与渲染进程共用）。
 *
 * 形态选择（重要，勿改成位图/base64/任意代码）：
 * - **行字符串 + 调色板**：LLM 最擅长生成「ASCII art + 调色板」，且逐字符可读（改一个像素 = 改一个字符）；
 * - **可机械校验**：尺寸 / 颜色数 / 字符集全部可判定，越界即拒（`validateAvatarSpec`）；
 * - **可移植**：无外部资产、无 base64、无 URL（利好分发）；
 * - **渲染安全**：渲染端只按格子画 1×1 方块，不 eval、不加载资源。
 *
 * 字符约定：`'.'` = 透明；`'0'`-`'9'` / `'a'`-`'f'` = 调色板下标（0~15）。
 *
 * 不删理由：删掉即「AI 画自己」没有数据格式，`RoomScene` 只能显示写死的图。
 */

/** 一个像素精灵：w×h 像素，多帧（帧名 → 行字符串数组）。 */
export interface PixelSprite {
  /** 宽（像素） */
  w: number
  /** 高（像素） */
  h: number
  /** 调色板：`#rrggbb`，1~16 色 */
  palette: string[]
  /** 帧：帧名 → h 行 × w 字符 */
  frames: Record<string, string[]>
}

/** ROOM 的像素可视化规格（AI 可整份重画）。 */
export interface RoomAvatarSpec {
  version: 1
  /** 房间背景（帧名建议 `base`） */
  room: PixelSprite
  /** AI 形象（帧名建议 `idle` / `running` / `standby` / `stopped`；缺帧回落 `idle` 再回落第一帧） */
  avatar: PixelSprite
  /** 形象左上角在房间内的像素坐标（必须完整落在房间内） */
  avatarPos: { x: number; y: number }
}

/** 尺寸/数量上限（防 DoS，也是 AI 生成时的硬边界）。 */
export const AVATAR_LIMITS = {
  /** 单边最大像素数 */
  maxDim: 64,
  /** 单精灵最大颜色数 */
  maxColors: 16,
  /** 单精灵最大帧数 */
  maxFrames: 8
} as const

const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const CHAR_RE = /^[.0-9a-f]$/

type SpriteResult = { ok: true; sprite: PixelSprite } | { ok: false; error: string }

function validateSprite(raw: unknown, label: string): SpriteResult {
  const r = (raw ?? {}) as { w?: unknown; h?: unknown; palette?: unknown; frames?: unknown }
  const w = Number(r.w)
  const h = Number(r.h)
  if (!Number.isInteger(w) || w < 1 || w > AVATAR_LIMITS.maxDim) {
    return { ok: false, error: `${label}：宽必须是 1~${AVATAR_LIMITS.maxDim} 的整数` }
  }
  if (!Number.isInteger(h) || h < 1 || h > AVATAR_LIMITS.maxDim) {
    return { ok: false, error: `${label}：高必须是 1~${AVATAR_LIMITS.maxDim} 的整数` }
  }
  if (!Array.isArray(r.palette) || r.palette.length < 1 || r.palette.length > AVATAR_LIMITS.maxColors) {
    return { ok: false, error: `${label}：调色板需 1~${AVATAR_LIMITS.maxColors} 色` }
  }
  const palette: string[] = []
  for (const c of r.palette) {
    if (typeof c !== 'string' || !COLOR_RE.test(c)) return { ok: false, error: `${label}：颜色必须是 #rrggbb` }
    palette.push(c.toLowerCase())
  }
  if (!r.frames || typeof r.frames !== 'object' || Array.isArray(r.frames)) {
    return { ok: false, error: `${label}：缺少帧` }
  }
  const frameEntries = Object.entries(r.frames as Record<string, unknown>)
  if (frameEntries.length < 1 || frameEntries.length > AVATAR_LIMITS.maxFrames) {
    return { ok: false, error: `${label}：帧数需 1~${AVATAR_LIMITS.maxFrames}` }
  }
  const frames: Record<string, string[]> = {}
  for (const [name, rowsRaw] of frameEntries) {
    if (!Array.isArray(rowsRaw) || rowsRaw.length !== h) {
      return { ok: false, error: `${label}：帧「${name}」必须是 ${h} 行` }
    }
    const rows: string[] = []
    for (const row of rowsRaw) {
      if (typeof row !== 'string' || row.length !== w) {
        return { ok: false, error: `${label}：帧「${name}」每行必须是 ${w} 字符` }
      }
      for (const ch of row) {
        if (!CHAR_RE.test(ch)) {
          return { ok: false, error: `${label}：帧「${name}」含非法字符「${ch}」（只允许 . 与 0-9a-f）` }
        }
      }
      rows.push(row)
    }
    frames[name] = rows
  }
  return { ok: true, sprite: { w, h, palette, frames } }
}

/**
 * 校验并规范化一份像素规格（纯函数）。任何越界/非法形状都返回 `{ ok:false, error }`——
 * 调用方（store / IPC / 执行器）据此 fail-closed，**不得**先落盘再校验。
 */
export function validateAvatarSpec(raw: unknown): { ok: true; spec: RoomAvatarSpec } | { ok: false; error: string } {
  const r = (raw ?? {}) as { version?: unknown; room?: unknown; avatar?: unknown; avatarPos?: unknown }
  if (r.version !== 1) return { ok: false, error: '版本必须是 1' }
  const room = validateSprite(r.room, '房间')
  if (!room.ok) return room
  const avatar = validateSprite(r.avatar, '形象')
  if (!avatar.ok) return avatar
  const pos = (r.avatarPos ?? {}) as { x?: unknown; y?: unknown }
  const x = Number(pos.x)
  const y = Number(pos.y)
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    return { ok: false, error: '形象坐标必须是非负整数' }
  }
  if (x + avatar.sprite.w > room.sprite.w || y + avatar.sprite.h > room.sprite.h) {
    return { ok: false, error: '形象必须完整落在房间内' }
  }
  return { ok: true, spec: { version: 1, room: room.sprite, avatar: avatar.sprite, avatarPos: { x, y } } }
}

/**
 * 取帧：优先 `preferred`（相位名），再回落 `idle`，最后取第一帧。
 * 帧名大小写不敏感（AI 可能写 `Idle`）。
 */
export function pickFrame(sprite: PixelSprite, preferred: string): string[] {
  const candidates = [preferred, preferred.toLowerCase(), 'idle']
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(sprite.frames, name)) return sprite.frames[name]
  }
  const first = Object.keys(sprite.frames)[0]
  return first === undefined ? [] : sprite.frames[first]
}
