/**
 * 房间外观配置的**唯一取数点**（按 AI 分层：每个 AI 一套人物位置/背景/分区场景）。
 *
 * 与 `use-mascot` 同范式：模块级缓存 + `useSyncExternalStore`，挂载/保存/手动重载时取一次，
 * **不轮询**。渲染侧不信任跨进程数据：外观再过一遍 `parseRoomAppearance`，
 * 背景/场景只认 `room-asset://` 本地协议 URL（或旧的 data URL）。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_AI_ID } from '@shared/types'
import {
  DEFAULT_ROOM_APPEARANCE,
  isRoomImageSrc,
  parseRoomAppearance,
  type RoomAppearance
} from '@shared/room/appearance'

export interface Live2DAssets {
  modelUrl: string
  coreUrl: string
  model: string
  /** 模型目录里的动作文件（`*.motion3.json`）；渲染侧据此补 Idle 组 */
  motions: string[]
  /** 模型目录里的表情文件（`.exp3.json`） */
  expressions: Array<{ name: string; file: string }>
}

export interface RoomAppearanceState {
  appearance: RoomAppearance
  /** 主背景图（`room-asset://…?v=`）；null = 用代码房间 */
  background: string | null
  /** 可选背景图（**文件名去扩展名 → `room-asset://…`**）；key 就是菜单里显示的选项名 */
  scenes: Record<string, string>
  /** 检测到的 Live2D 模型（模型 + 核心都在才非 null） */
  live2d: Live2DAssets | null
  /** 当前 AI 的背景目录 */
  dir: string | null
  /** 当前 AI 的分区场景目录 */
  scenesDir: string | null
  error: string | null
  loaded: boolean
}

const EMPTY: RoomAppearanceState = {
  appearance: DEFAULT_ROOM_APPEARANCE,
  background: null,
  scenes: {},
  live2d: null,
  dir: null,
  scenesDir: null,
  error: null,
  loaded: false
}

const states = new Map<number, RoomAppearanceState>()
const inFlight = new Map<number, Promise<void>>()
const listeners = new Map<number, Set<() => void>>()

function stateOf(aiId: number): RoomAppearanceState {
  return states.get(aiId) ?? EMPTY
}

function emit(aiId: number): void {
  for (const l of listeners.get(aiId) ?? []) l()
}

function subscribe(aiId: number, cb: () => void): () => void {
  let set = listeners.get(aiId)
  if (!set) {
    set = new Set()
    listeners.set(aiId, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
}

/** 重新读取指定 AI 的外观 + 背景/分区场景（同 AI 并发调用合并成一次）。 */
export function reloadAppearance(aiId: number = DEFAULT_AI_ID): Promise<void> {
  const existing = inFlight.get(aiId)
  if (existing) return existing
  const p = (async () => {
    try {
      const r = await window.lunareclipse?.roomAppearanceGet?.(aiId)
      if (!r?.ok) {
        states.set(aiId, { ...EMPTY, loaded: true, error: '读取外观配置失败：主进程未就绪或该通道不可用' })
      } else {
        const parsed = parseRoomAppearance(r.appearance)
        const scenes: Record<string, string> = {}
        if (r.scenes && typeof r.scenes === 'object') {
          for (const [key, url] of Object.entries(r.scenes)) {
            if (isRoomImageSrc(url)) scenes[key] = url
          }
        }
        const l2d = r.live2d
        const live2d: Live2DAssets | null =
          l2d &&
          typeof l2d.modelUrl === 'string' &&
          l2d.modelUrl.startsWith('room-asset://') &&
          typeof l2d.coreUrl === 'string' &&
          l2d.coreUrl.startsWith('room-asset://') &&
          typeof l2d.model === 'string'
            ? {
                modelUrl: l2d.modelUrl,
                coreUrl: l2d.coreUrl,
                model: l2d.model,
                motions: Array.isArray(l2d.motions) ? l2d.motions.filter((m) => typeof m === 'string') : [],
                expressions: Array.isArray(l2d.expressions)
                  ? l2d.expressions.filter(
                      (e) => e && typeof e.name === 'string' && typeof e.file === 'string'
                    )
                  : []
              }
            : null
        states.set(aiId, {
          appearance: parsed.ok ? parsed.appearance : DEFAULT_ROOM_APPEARANCE,
          background: isRoomImageSrc(r.background) ? r.background : null,
          scenes,
          live2d,
          dir: typeof r.dir === 'string' ? r.dir : null,
          scenesDir: typeof r.scenesDir === 'string' ? r.scenesDir : null,
          error:
            (parsed.ok ? null : `外观配置无效，已回落默认：${parsed.error}`) ??
            (typeof r.error === 'string' && r.error ? r.error : null),
          loaded: true
        })
      }
    } catch (err) {
      states.set(aiId, {
        ...EMPTY,
        loaded: true,
        error: `读取外观配置失败：${err instanceof Error ? err.message : String(err)}`
      })
    } finally {
      inFlight.delete(aiId)
      emit(aiId)
    }
  })()
  inFlight.set(aiId, p)
  return p
}

/** 保存指定 AI 的外观（用户路径）；成功后自动重读，让舞台立即生效。 */
export async function saveAppearance(
  aiId: number,
  raw: RoomAppearance
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await window.lunareclipse?.roomAppearanceSet?.(aiId, raw)
    if (!r) return { ok: false, error: '外观设置通道不可用' }
    if (!r.ok) return { ok: false, error: r.error ?? '保存失败' }
    await reloadAppearance(aiId)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 订阅指定 AI 的外观配置（SSR/并发渲染安全：只在取数完成时换引用）。 */
export function useAppearance(aiId: number = DEFAULT_AI_ID): RoomAppearanceState {
  return useSyncExternalStore(
    (cb) => subscribe(aiId, cb),
    () => stateOf(aiId),
    () => stateOf(aiId)
  )
}

/** 测试用：复位模块级缓存 */
export function __resetAppearanceForTest(): void {
  states.clear()
  inFlight.clear()
  listeners.clear()
}

/** 测试用：写入某个 AI 的外观状态（SSR 探针无法走 IPC，只能直接喂模块缓存） */
export function __setAppearanceForTest(aiId: number, state: Partial<RoomAppearanceState>): void {
  states.set(aiId, { ...EMPTY, ...state, loaded: true })
}
