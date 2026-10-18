/**
 * 像素画布：把 `RoomAvatarSpec` 画到 `<canvas>`（nearest-neighbor，整数倍放大）。
 *
 * 为什么用 canvas 而不是 SVG/DOM：房间是 40×24 = 960 格、形象 12×12 = 144 格；用 DOM 每格一个元素
 * 会造上千节点。canvas 一次 `fillRect` 画完，且 `image-rendering: pixelated` 保证放大不糊。
 * **零外部资产**（无贴图/字体/base64），利好分发可移植性。
 *
 * 为什么画布尺寸 = 规格尺寸（再由 CSS 放大）：规格是逻辑像素，scale 只影响显示；
 * 换规格（P3 AI 重画）时无需改渲染逻辑。
 *
 * 安全：只按字符查调色板画 1×1 方块；不 eval、不加载资源、不解析颜色表达式。
 */
import { useEffect, useRef } from 'react'
import { pickFrame, type PixelSprite, type RoomAvatarSpec } from '@shared/room/avatar-spec'

/** 把一个精灵的某一帧画到 (ox, oy)。 */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  sprite: PixelSprite,
  frame: string,
  ox: number,
  oy: number
): void {
  const rows = pickFrame(sprite, frame)
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]
      if (ch === '.') continue
      const color = sprite.palette[parseInt(ch, 16)]
      if (!color) continue
      ctx.fillStyle = color
      ctx.fillRect(ox + x, oy + y, 1, 1)
    }
  }
}

export function PixelCanvas({
  spec,
  phase,
  scale = 4,
  className
}: {
  spec: RoomAvatarSpec
  /** 相位名（`stopped`/`standby`/`idle`/`running`）→ 形象帧名 */
  phase: string
  /** 放大倍数（整数，避免像素糊） */
  scale?: number
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    cv.width = spec.room.w
    cv.height = spec.room.h
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, spec.room.w, spec.room.h)
    drawSprite(ctx, spec.room, 'base', 0, 0)
    drawSprite(ctx, spec.avatar, phase, spec.avatarPos.x, spec.avatarPos.y)
  }, [spec, phase])

  return (
    <canvas
      ref={ref}
      width={spec.room.w}
      height={spec.room.h}
      className={className}
      style={{ width: spec.room.w * scale, height: spec.room.h * scale, imageRendering: 'pixelated' }}
      aria-hidden="true"
    />
  )
}
