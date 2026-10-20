/**
 * @category ROOM
 * @summary 房间的**外观配置**（人物位置/大小 + 背景来源）——用户侧独立配置，不由 AI 决定
 *
 * 为什么存在（用户 2026-10-20）：「人物的图像也好，什么也罢，我觉得都可以单独配置比较好」。
 * 上一版把构图写死在 `ROOM_COMPOSITION`，背景只能代码绘制；用户只能接受设计者的选择。
 * 这里把「人物在哪、多大；背景用代码房间还是图片」变成**数据**：
 * - 人物：世界坐标 x / y + 缩放（在透视房间里仍然近大远小）；
 * - 背景：`code`（内置透视房间）或 `image`（`<data>/room/background/background.png`）。
 *
 * 边界：
 * - 纯声明式数据，**不是任意代码/任意路径**；图片文件名固定，且经 PNG 魔数 + 尺寸校验；
 * - 校验 fail-closed：越界/非法类型直接拒绝并给出原因（保存时），读取时回落默认并留痕。
 */
import { ROOM_COMPOSITION, ROOM_ZONES, type RoomZoneId } from './room-scene'

/** 分区场景的文件名集合（与 `ROOM_ZONES` 同源；`<zone>.png`） */
export const ROOM_SCENE_ZONES = Object.keys(ROOM_ZONES) as RoomZoneId[]

export interface RoomCharacterPlacement {
  /** 世界坐标 x（横向） */
  x: number
  /** 世界坐标 y（纵深；越大越远、越小） */
  y: number
  /** 垂直偏移（**画布逻辑像素**，正数向上）：不改变纵深/大小，只把人物抬离地面 */
  lift: number
  /** 人物缩放（1 = 默认身高；在 y 的透视缩放之上再乘） */
  scale: number
}

export interface RoomBackgroundConfig {
  mode: 'code' | 'image'
}

export interface RoomAppearance {
  version: 1
  character: RoomCharacterPlacement
  background: RoomBackgroundConfig
}

/** 人物参数边界（UI 的 min/max 与校验共用同一份，避免两处漂移） */
export const ROOM_CHARACTER_LIMITS = {
  x: { min: -2, max: 2 },
  y: { min: 0.8, max: 7 },
  /** 垂直偏移（画布逻辑像素）：-900 可把人物压到地板以下/画面外，+400 可抬到天花板以上 */
  lift: { min: -900, max: 400 },
  /** 0.53.6 放宽：舞台可直接拖动/滚轮缩放，允许近景特写到远景小人 */
  scale: { min: 0.4, max: 2.2 }
} as const

/** 背景图片约定：固定文件名，避免「让用户写路径」；PNG 优先，也接受 JPG（国内素材站常见） */
export const ROOM_BACKGROUND_FILE = 'background.png'
export const ROOM_BACKGROUND_FILES = ['background.png', 'background.jpg', 'background.jpeg'] as const
/** 背景图片边界（比立绘宽：背景通常 1920×1080） */
export const ROOM_BACKGROUND_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxDim: 4096
} as const

export const DEFAULT_ROOM_APPEARANCE: RoomAppearance = {
  version: 1,
  character: { x: ROOM_COMPOSITION.x, y: ROOM_COMPOSITION.y, lift: 0, scale: 1 },
  background: { mode: 'code' }
}

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

/**
 * 严格校验（保存路径用）。任何越界/类型错误都返回原因，**不静默夹紧**：
 * 用户输入 999 时应该被告知「超出范围」，而不是悄悄变成 2。
 */
export function parseRoomAppearance(
  raw: unknown
): { ok: true; appearance: RoomAppearance } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '外观配置必须是对象' }
  const o = raw as { version?: unknown; character?: unknown; background?: unknown }
  if (o.version !== 1) return { ok: false, error: '外观配置版本必须是 1' }
  if (!o.character || typeof o.character !== 'object' || Array.isArray(o.character)) {
    return { ok: false, error: 'character 必须是对象' }
  }
  const c = o.character as { x?: unknown; y?: unknown; lift?: unknown; scale?: unknown }
  if (!inRange(c.x, ROOM_CHARACTER_LIMITS.x.min, ROOM_CHARACTER_LIMITS.x.max)) {
    return { ok: false, error: `水平位置需在 ${ROOM_CHARACTER_LIMITS.x.min} ~ ${ROOM_CHARACTER_LIMITS.x.max} 之间` }
  }
  if (!inRange(c.y, ROOM_CHARACTER_LIMITS.y.min, ROOM_CHARACTER_LIMITS.y.max)) {
    return { ok: false, error: `纵深需在 ${ROOM_CHARACTER_LIMITS.y.min} ~ ${ROOM_CHARACTER_LIMITS.y.max} 之间` }
  }
  // 兼容旧配置：没有 lift 字段时按 0 处理（不把旧 appearance.json 判成非法）
  const lift = c.lift === undefined ? 0 : c.lift
  if (!inRange(lift, ROOM_CHARACTER_LIMITS.lift.min, ROOM_CHARACTER_LIMITS.lift.max)) {
    return { ok: false, error: `高度需在 ${ROOM_CHARACTER_LIMITS.lift.min} ~ ${ROOM_CHARACTER_LIMITS.lift.max} 之间` }
  }
  if (!inRange(c.scale, ROOM_CHARACTER_LIMITS.scale.min, ROOM_CHARACTER_LIMITS.scale.max)) {
    return { ok: false, error: `大小需在 ${ROOM_CHARACTER_LIMITS.scale.min} ~ ${ROOM_CHARACTER_LIMITS.scale.max} 之间` }
  }
  if (!o.background || typeof o.background !== 'object' || Array.isArray(o.background)) {
    return { ok: false, error: 'background 必须是对象' }
  }
  const mode = (o.background as { mode?: unknown }).mode
  if (mode !== 'code' && mode !== 'image') return { ok: false, error: '背景只能是 code 或 image' }
  return {
    ok: true,
    appearance: {
      version: 1,
      character: { x: c.x, y: c.y, lift, scale: c.scale },
      background: { mode }
    }
  }
}

/** 读取路径的宽容归一：非法 → 默认（错误由调用方另行留痕，不把房间弄崩） */
export function normalizeRoomAppearance(raw: unknown): RoomAppearance {
  const r = parseRoomAppearance(raw)
  return r.ok ? r.appearance : DEFAULT_ROOM_APPEARANCE
}

/** 渲染侧只信任 PNG data URL（看板娘，需要 alpha） */
export function isPngDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:image/png;base64,')
}

/** 背景/场景：PNG 或 JPEG（背景不需要 alpha；国内素材站大量是 JPG） */
export function isImageDataUrl(value: unknown): value is string {
  return (
    isPngDataUrl(value) ||
    (typeof value === 'string' && value.startsWith('data:image/jpeg;base64,'))
  )
}

/** `room-asset://` 只读协议（背景/分区场景走这里，不再 base64 过 IPC） */
export const ROOM_ASSET_PREFIX = 'room-asset://room/'

/**
 * 渲染侧接受的背景/场景源：本地只读协议 URL（当前）或 data URL（兼容旧配置）。
 *
 * 为什么改协议（0.53.6）：4K 背景经 base64 + IPC 传输要在主进程把每张图读全、
 * 编码成 1.33 倍大小的字符串，`appearance-get` 因此要等所有分区图读完才返回——
 * 这段时间里房间只能先画 2D 立绘，正是用户看到的「先立绘、后换 Live2D」。
 */
export function isRoomImageSrc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value.startsWith(ROOM_ASSET_PREFIX) || isImageDataUrl(value))
  )
}

/**
 * 当前分区该用哪张图：**分区图优先，主背景兜底**。
 * `null` = 没有可用的图（渲染侧回落到代码房间）。
 */
export function sceneImageFor(
  zone: RoomZoneId,
  scenes: Partial<Record<RoomZoneId, string>> | undefined,
  background: string | null | undefined
): string | null {
  return scenes?.[zone] ?? background ?? null
}
