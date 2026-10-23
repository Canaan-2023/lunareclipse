/**
 * 房间画笔的**共用几何原语**：投影点 / 多边形 / 线 / 长方体。
 *
 * 为什么从 `perspective-art.ts` 拆出来（0.53.4）：房间细节、前景陈设、角色三条绘制链
 * 都要用同一套「世界坐标 → 屏幕」的画法；各抄一份必然在边线宽度、可见面判定上漂移
 * （例如同一个柜子在三条链里画出三种透视）。本文件是**唯一一份**。
 *
 * 口径不变：所有图形都在世界坐标 `(x,y,z)` 里，经 `projectPoint` 投到屏幕；
 * 越界/退化输入静默忽略——画法代码不该因为边缘差一像素而抛。
 */
import { projectPoint, type RoomProjection } from '@shared/room/room-scene'

export type Ctx = CanvasRenderingContext2D

export interface Pt {
  x: number
  y: number
}

export function pr(p: RoomProjection, x: number, y: number, z: number): Pt {
  return projectPoint(x, y, z, p)
}

export function poly(ctx: Ctx, pts: Pt[], fill: string, stroke?: string, lw = 1): void {
  if (pts.length < 3) return
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) {
    ctx.strokeStyle = stroke
    ctx.lineWidth = lw
    ctx.stroke()
  }
}

export function line(ctx: Ctx, a: Pt, b: Pt, color: string, lw = 1): void {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.stroke()
}

export interface BoxSpec {
  x: number
  y: number
  z: number
  w: number
  d: number
  h: number
}

export interface BoxColors {
  front: string
  top: string
  side: string
  edge?: string
}

/** 画一个世界坐标里的长方体（只画朝向镜头的三个面）。 */
export function drawBox(ctx: Ctx, p: RoomProjection, b: BoxSpec, c: BoxColors): void {
  const x0 = b.x - b.w / 2
  const x1 = b.x + b.w / 2
  const y0 = b.y - b.d / 2
  const y1 = b.y + b.d / 2
  const z0 = b.z
  const z1 = b.z + b.h
  const nbl = pr(p, x0, y0, z0)
  const nbr = pr(p, x1, y0, z0)
  const ntr = pr(p, x1, y0, z1)
  const ntl = pr(p, x0, y0, z1)
  const fbl = pr(p, x0, y1, z0)
  const fbr = pr(p, x1, y1, z0)
  const ftr = pr(p, x1, y1, z1)
  const ftl = pr(p, x0, y1, z1)

  // 顶面：镜头在物体上方才可见
  if (z1 <= p.camZ) poly(ctx, [ntl, ntr, ftr, ftl], c.top, c.edge, 0.8)
  // 侧面：物体在镜头右侧 → 看到左面；反之看到右面
  if (b.x > p.camX) poly(ctx, [nbl, ntl, ftl, fbl], c.side, c.edge, 0.8)
  else if (b.x < p.camX) poly(ctx, [nbr, ntr, ftr, fbr], c.side, c.edge, 0.8)
  // 前面（最近）
  poly(ctx, [nbl, nbr, ntr, ntl], c.front, c.edge, 0.8)
}

/** 世界坐标里的一个薄片（用于海报 / 纸 / 屏幕）：贴在某个平面上。 */
export function drawPanel(
  ctx: Ctx,
  p: RoomProjection,
  x0: number,
  x1: number,
  y: number,
  z0: number,
  z1: number,
  fill: string,
  stroke?: string,
  lw = 1
): void {
  poly(ctx, [pr(p, x0, y, z0), pr(p, x1, y, z0), pr(p, x1, y, z1), pr(p, x0, y, z1)], fill, stroke, lw)
}
