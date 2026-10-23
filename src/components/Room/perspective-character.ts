/**
 * 房间里的**角色**画笔：像素立牌 / 图片立绘 + 极轻的呼吸/浮动。
 *
 * 为什么回到这条链（0.53.4 第三轮，用户「太蠢了换回立绘吧…MONIKA AFTER STORY 那样的构图也不错…
 * 背景不要杂乱，也别乱走动了」）：
 * - 上一版为了补半身图的腿，做了内置全身角色；用户明确不要，**换回立绘本身**；
 * - 构图改为视觉小说式：立绘固定在画面中右侧、**不再走动**，下半身的下缘由底部对话盒遮住；
 * - 只保留极轻的呼吸 / 浮动，不做走路、不做换身体。
 *
 * 边界：
 * - 只做表现，不改变世界坐标 / 近大远小 / 阴影锚点（`characterHeight` 仍是唯一身高来源）；
 * - 图片帧仍由 `resolveAvatarFrameName` 决定（与像素角色共用同一份取帧判定）；
 * - 无帧 / 无调色板时的兜底立牌保持原样（测试锁死图元数量）。
 */
import { characterHeight, projectPoint, type RoomProjection } from '@shared/room/room-scene'
import type { SceneState } from './scene-layers'
import type { Ctx } from './perspective-primitives'

/** 次级运动上下文。**全部由渲染侧 rAF 计算**，不引入新定时器。 */
export interface CharacterMotion {
  now: number
  /** 固定构图中恒为 false；保留字段是为了不破坏既有调用方与测试 */
  walking: boolean
  phase: number
  state: SceneState
  /** 仅用于呼吸节奏（work/read/think 略有不同） */
  action?: string
}

interface MotionAmount {
  /** 上下起伏（占角色高度的比例） */
  bob: number
  /** 左右轻摆（占角色高度的比例） */
  sway: number
  /** 纵向呼吸缩放（1±少量；围绕脚底，只让上半身轻微起伏） */
  breath: number
  /** 绕脚底的微倾（弧度；让静止的立绘不显得像贴图） */
  tilt: number
}

const STILL: MotionAmount = { bob: 0, sway: 0, breath: 1, tilt: 0 }

function motionOf(m?: CharacterMotion): MotionAmount {
  if (!m) return STILL
  if (m.state === 'stopped' || m.state === 'standby' || m.state === 'error') {
    return STILL
  }
  const speed = m.action === 'work' ? 620 : m.action === 'read' ? 1500 : m.action === 'think' ? 2400 : 1700
  const amp = m.action === 'work' ? 0.006 : m.action === 'read' ? 0.003 : 0.004
  return {
    bob: Math.sin(m.now / speed) * amp,
    sway: Math.sin(m.now / (speed * 1.25) + 0.7) * 0.006,
    // 呼吸与摇摆不同周期（≈10.7s vs 16s / 19s），避免三者合成一条可预测的机械曲线
    breath: 1 + Math.sin(m.now / 2600) * 0.0045,
    tilt: Math.sin(m.now / 3100 + 1.2) * 0.0035
  }
}

/** 地面接触阴影：**不跟着呼吸上下动**，否则会「离地」。2D 立绘与 Live2D 共用。 */
export function drawFootShadow(
  ctx: Ctx,
  p: RoomProjection,
  pos: { x: number; y: number },
  scale = 1
): void {
  const foot = projectPoint(pos.x, pos.y, 0, p)
  const h = characterHeight(pos.y, p) * Math.max(0.2, scale)
  ctx.fillStyle = 'rgba(0,0,0,0.42)'
  ctx.beginPath()
  ctx.ellipse(foot.x, foot.y - 1, Math.max(4, h * 0.2), Math.max(2, h * 0.026), 0, 0, Math.PI * 2)
  ctx.fill()
}

/** 画角色立牌（像素角色；近大远小）。 */
export function drawCharacter(
  ctx: Ctx,
  p: RoomProjection,
  pos: { x: number; y: number },
  rows: readonly string[],
  palette: readonly string[],
  spriteW: number,
  spriteH: number,
  mirror: boolean,
  facing: 'left' | 'right' | 'down',
  motion?: CharacterMotion,
  /** 用户侧「大小」配置（在透视身高之上再乘；缺省 1） */
  scale = 1,
  /** 垂直偏移（画布逻辑像素，正数向上）：只抬人物，不改变地面阴影 */
  lift = 0
): void {
  const foot = projectPoint(pos.x, pos.y, 0, p)
  const h = characterHeight(pos.y, p) * Math.max(0.2, scale)
  const w = h * (spriteW / Math.max(1, spriteH))
  const top = foot.y - h - lift
  const left = foot.x - w / 2

  // 地面阴影：不跟着呼吸上下动，否则会「离地」
  ctx.fillStyle = 'rgba(0,0,0,0.42)'
  ctx.beginPath()
  ctx.ellipse(foot.x, foot.y - 1, Math.max(4, w * 0.38), Math.max(2, h * 0.045), 0, 0, Math.PI * 2)
  ctx.fill()

  if (rows.length === 0 || palette.length === 0) {
    // 兜底：一个简单的立牌，不让房间空着（图元数量被测试锁死）
    ctx.fillStyle = '#d7c7a8'
    ctx.beginPath()
    ctx.ellipse(foot.x, top + h * 0.16, w * 0.22, h * 0.11, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#3a4a6a'
    ctx.fillRect(foot.x - w * 0.22, top + h * 0.28, w * 0.44, h * 0.5)
    return
  }

  const m = motionOf(motion)
  const pxW = w / spriteW
  const pxH = h / spriteH
  ctx.save()
  ctx.translate(m.sway * h, m.bob * h)
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]
      if (ch === '.' || ch === ' ') continue
      const color = palette[parseInt(ch, 16)]
      if (!color) continue
      const dx = mirror || facing === 'left' ? spriteW - 1 - x : x
      ctx.fillStyle = color
      ctx.fillRect(left + dx * pxW, top + y * pxH, Math.ceil(pxW), Math.ceil(pxH))
    }
  }
  ctx.restore()
}

/**
 * 画**图片立绘**：等比缩放、底边落在脚点、近大远小与像素角色同源。
 *
 * 半身图不再补下半身——底部对话盒会盖住立绘下缘，构图按用户指定的
 * MONIKA AFTER STORY 式视觉小说来做。
 */
export function drawCharacterImage(
  ctx: Ctx,
  p: RoomProjection,
  pos: { x: number; y: number },
  img: CanvasImageSource,
  naturalW: number,
  naturalH: number,
  mirror: boolean,
  motion?: CharacterMotion,
  /** 用户侧「大小」配置（在透视身高之上再乘；缺省 1） */
  scale = 1,
  /** 垂直偏移（画布逻辑像素，正数向上）：只抬人物，不改变地面阴影 */
  lift = 0
): void {
  const foot = projectPoint(pos.x, pos.y, 0, p)
  const h = characterHeight(pos.y, p) * Math.max(0.2, scale)
  // 退化图（naturalH=0）会算出极大的宽高比：夹到 [0.05, 4]，避免巨幅 drawImage
  const ratio = Math.min(4, Math.max(0.05, naturalW / Math.max(1, naturalH)))
  const w = h * ratio
  const m = motionOf(motion)

  ctx.fillStyle = 'rgba(0,0,0,0.42)'
  ctx.beginPath()
  ctx.ellipse(foot.x, foot.y - 1, Math.max(4, Math.min(w, h) * 0.34), Math.max(2, h * 0.04), 0, 0, Math.PI * 2)
  ctx.fill()

  const bottom = foot.y - lift
  ctx.save()
  if (mirror) {
    ctx.translate(foot.x, 0)
    ctx.scale(-1, 1)
    ctx.translate(-foot.x, 0)
  }
  ctx.translate(m.sway * h, m.bob * h)
  // 呼吸 / 微倾围绕**脚底**：头肩有变化，落脚点不动（不会看起来离地或整体漂移）
  ctx.translate(foot.x, bottom)
  ctx.rotate(m.tilt)
  ctx.scale(1, m.breath)
  ctx.translate(-foot.x, -bottom)
  ctx.drawImage(img, foot.x - w / 2, bottom - h, w, h)
  ctx.restore()
}

/** 角色在屏幕上的落脚点（给 DOM 叠加层定位用） */
export function characterScreenPoint(
  p: RoomProjection,
  pos: { x: number; y: number }
): { x: number; y: number; height: number } {
  const foot = projectPoint(pos.x, pos.y, 0, p)
  return { x: foot.x, y: foot.y, height: characterHeight(pos.y, p) }
}
