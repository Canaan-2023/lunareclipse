/**
 * 舞台直调人物：拖动移动 + 滚轮缩放 + 写回外观配置。
 *
 * 为什么独立成 hook：
 * - `PerspectiveRoom` 已经在管背景缓存、Live2D 状态、rAF；再把指针/落盘塞进去会逼近体量红线；
 * - **不轮询的红线**（`room-no-polling`）：组件里只允许 `requestAnimationFrame` 管渲染，
 *   这里唯一的 `setTimeout` 是**用户动作后的防抖落盘**（滚轮停 450ms 才写一次），
 *   不是后台轮询——它只在有人操作时存在，空闲时立即清掉。
 *
 * 坐标口径：
 * - **默认拖动**：横向改世界 x，纵向改 `lift`（纯屏幕上下，不改变纵深与大小）；
 * - **Shift + 拖动**：纵向改纵深（原来的「脚点跟手」反解，越往下越近）；
 * - 滚轮：以脚点为锚缩放。
 * 直接按像素加减 x/y 会让人物在纵深方向乱跑，所以 x/纵深都走 `placementFromFootScreen`。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import {
  ROOM_CHARACTER_LIMITS,
  type RoomAppearance,
  type RoomCharacterPlacement
} from '@shared/room/appearance'
import { defaultProjection, placementFromFootScreen, projectPoint } from '@shared/room/room-scene'
import { saveAppearance } from './use-appearance'

/** 拖拽时的最小位移（CSS px）：小于它视为点击，不挪人物 */
const DRAG_THRESHOLD = 3
/** 滚轮缩放停止多久后落盘 */
const SAVE_DEBOUNCE_MS = 450
/** 滚轮灵敏度：每 1px deltaY 的指数系数 */
const WHEEL_SENSITIVITY = 0.0015

function clampPlacement(c: RoomCharacterPlacement): RoomCharacterPlacement {
  const { x, y, lift, scale } = ROOM_CHARACTER_LIMITS
  const at = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
  return {
    x: at(c.x, x.min, x.max),
    y: at(c.y, y.min, y.max),
    lift: at(c.lift, lift.min, lift.max),
    scale: at(c.scale, scale.min, scale.max)
  }
}

export interface CharacterDrag {
  /** 当前生效位置（拖拽中为本地值，否则为已保存配置） */
  placement: RoomCharacterPlacement
  /** 供 rAF 绘制读取的最新位置（避免 10fps 闭包拿到旧值） */
  placementRef: RefObject<RoomCharacterPlacement>
  dragging: boolean
  handlers: {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => void
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => void
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => void
  }
}

export function useCharacterDrag(args: {
  aiId?: number
  appearance: RoomAppearance
  /** 画布 CSS 缩放（CSS px / 逻辑 px） */
  scale: number
  containerRef: RefObject<HTMLDivElement | null>
}): CharacterDrag {
  const { aiId, appearance, scale, containerRef } = args
  const [livePlacement, setLivePlacement] = useState<RoomCharacterPlacement | null>(null)
  const [dragging, setDragging] = useState(false)
  const placement = livePlacement ?? appearance.character
  const placementRef = useRef<RoomCharacterPlacement>(placement)
  placementRef.current = placement
  const appearanceRef = useRef(appearance)
  appearanceRef.current = appearance
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const dragRef = useRef<{
    id: number
    startX: number
    startY: number
    base: RoomCharacterPlacement
    moved: boolean
  } | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 写回该 AI 的外观（用户路径）；失败静默，下次操作会再试 */
  const persist = useCallback(
    (next: RoomCharacterPlacement) => {
      if (!aiId) return
      void saveAppearance(aiId, { ...appearanceRef.current, character: next })
    },
    [aiId]
  )

  // 面板改了数值 / 保存回来 → 丢掉本地覆盖，跟随配置。
  // `lift` 必须在内：只改高度时 x/y/scale 不变，漏掉它会继续用拖拽时的本地值。
  useEffect(() => {
    setLivePlacement(null)
  }, [appearance.character.x, appearance.character.y, appearance.character.lift, appearance.character.scale])

  // 滚轮缩放：必须非 passive 才能 preventDefault（React 的 onWheel 是 passive）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const base = placementRef.current
      const factor = Math.exp(-e.deltaY * WHEEL_SENSITIVITY)
      const next = clampPlacement({ ...base, scale: base.scale * factor })
      setLivePlacement(next)
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null
        persist(next)
      }, SAVE_DEBOUNCE_MS)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
        const last = placementRef.current
        // 卸载前把最后一次滚轮缩放落盘（否则调完立刻切走就丢了）
        persist(last)
      }
    }
  }, [containerRef, persist])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    dragRef.current = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      base: placementRef.current,
      moved: false
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || d.id !== e.pointerId) return
    const px = (e.clientX - d.startX) / Math.max(0.1, scaleRef.current)
    const py = (e.clientY - d.startY) / Math.max(0.1, scaleRef.current)
    if (!d.moved && Math.hypot(px, py) < DRAG_THRESHOLD) return // 只是点击，不挪人物
    d.moved = true
    setDragging(true)
    const p = defaultProjection()
    const foot = projectPoint(d.base.x, d.base.y, 0, p)
    // Shift + 拖动 = 调整纵深（脚点跟手）；默认 = 横向 x + 垂直 lift（不改大小）
    const world = e.shiftKey
      ? placementFromFootScreen(foot.x + px, foot.y + py, p)
      : placementFromFootScreen(foot.x + px, foot.y, p)
    setLivePlacement(
      clampPlacement({
        ...d.base,
        x: world.x,
        ...(e.shiftKey ? { y: world.y } : { lift: d.base.lift - py })
      })
    )
  }

  const endDrag = (e: PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 指针已释放 */
    }
    if (d?.moved) persist(placementRef.current)
  }

  return {
    placement,
    placementRef,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag
    }
  }
}
