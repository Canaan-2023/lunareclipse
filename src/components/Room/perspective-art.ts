/**
 * 房间直播镜头的画笔：一点透视的房间 / 家具 / 角色立牌 / 灯光 / 镜头氛围。
 *
 * 口径（用户 2026-10-19）：「不要做那个小人和地图了，做房间效果，**近大远小**的透视效果，
 * 人物也这么呈现」「就像是一场直播，我们看到的是**摄像头的视角**」。
 *
 * 因此这里没有俯视格子：所有东西都在世界坐标 `(x,y,z)` 里，用
 * `projectPoint` 投到屏幕；家具与角色共用同一个 `s = f/(y-camY)`，越远越小。
 * 静态房间（墙/地板/家具/窗）预渲染一次，每帧只画角色、灯光、尘埃、色偏与镜头效果。
 */
import {
  ROOM_DEPTH,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  characterHeight,
  defaultProjection,
  projectPoint,
  scaleAt,
  type RoomProjection
} from '@shared/room/room-scene'
import type { SceneState } from './scene-layers'
import { drawBox, line, poly, pr, type Ctx } from './perspective-primitives'

export {
  characterScreenPoint,
  drawCharacter,
  drawCharacterImage,
  type CharacterMotion
} from './perspective-character'

// 几何原语（投影 / 多边形 / 线 / 长方体）已拆到 `perspective-primitives.ts`：
// 角色、前景、陈设三条链共用同一份，避免同一个柜子画出三种透视。

function drawWindow(ctx: Ctx, p: RoomProjection): void {
  const y = ROOM_DEPTH - 0.02
  const x0 = -1.75
  const x1 = 0.25
  const z0 = 1.45
  const z1 = 3.45
  const a = pr(p, x0, y, z0)
  const b = pr(p, x1, y, z0)
  const c = pr(p, x1, y, z1)
  const d = pr(p, x0, y, z1)

  // 夜空（平滑，不是像素）
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.lineTo(c.x, c.y)
  ctx.lineTo(d.x, d.y)
  ctx.closePath()
  ctx.clip()
  const sky = ctx.createLinearGradient(0, d.y, 0, a.y)
  sky.addColorStop(0, '#0a1530')
  sky.addColorStop(0.55, '#16264d')
  sky.addColorStop(1, '#31436f')
  ctx.fillStyle = sky
  ctx.fillRect(Math.min(a.x, d.x), Math.min(d.y, c.y), Math.abs(b.x - a.x), Math.abs(a.y - d.y))
  // 月亮
  const moon = pr(p, -0.95, y, 2.85)
  const moonR = Math.max(5, scaleAt(y, p) * 0.2)
  const mg = ctx.createRadialGradient(moon.x, moon.y, 1, moon.x, moon.y, moonR * 3)
  mg.addColorStop(0, 'rgba(255,248,220,0.85)')
  mg.addColorStop(0.35, 'rgba(220,232,255,0.28)')
  mg.addColorStop(1, 'rgba(200,220,255,0)')
  ctx.fillStyle = mg
  ctx.fillRect(moon.x - moonR * 3, moon.y - moonR * 3, moonR * 6, moonR * 6)
  ctx.fillStyle = '#fff6d8'
  ctx.beginPath()
  ctx.arc(moon.x, moon.y, moonR, 0, Math.PI * 2)
  ctx.fill()
  // 星点（确定性；0.53.5 减量：26 → 16——窗外是背景，不该比人物更抢眼）
  for (let i = 0; i < 16; i++) {
    const sx = x0 + ((i * 37) % 100) / 100 * (x1 - x0)
    const sz = z0 + ((i * 61) % 100) / 100 * (z1 - z0)
    const s = pr(p, sx, y, sz)
    const alpha = 0.25 + ((i * 17) % 70) / 100
    ctx.fillStyle = `rgba(225,235,255,${alpha})`
    ctx.fillRect(s.x, s.y, 1.5, 1.5)
  }
  // 远处树影
  ctx.fillStyle = 'rgba(8,16,14,0.75)'
  ctx.beginPath()
  const base = pr(p, x0, y, z0)
  ctx.moveTo(base.x, base.y)
  for (let i = 0; i <= 12; i++) {
    const tx = x0 + ((x1 - x0) * i) / 12
    const tz = z0 + 0.18 + Math.abs(Math.sin(i * 1.7)) * 0.42
    const tp = pr(p, tx, y, tz)
    ctx.lineTo(tp.x, tp.y)
  }
  ctx.lineTo(pr(p, x1, y, z0).x, pr(p, x1, y, z0).y)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  // 窗框
  const frame = '#3a2b1e'
  const frameLight = '#6b5338'
  poly(ctx, [a, b, c, d], 'rgba(0,0,0,0)', frame, 7)
  line(ctx, pr(p, (x0 + x1) / 2, y, z0), pr(p, (x0 + x1) / 2, y, z1), frame, 4)
  line(ctx, pr(p, x0, y, (z0 + z1) / 2), pr(p, x1, y, (z0 + z1) / 2), frame, 4)
  line(ctx, pr(p, x0, y, z1), pr(p, x1, y, z1), frameLight, 2)
  // 窗台
  drawBox(ctx, p, { x: -0.75, y: y - 0.12, z: z0 - 0.12, w: 2.3, d: 0.22, h: 0.14 }, {
    front: '#4a3826',
    top: '#6b5338',
    side: '#33261b'
  })
  // 窗帘（0.53.3）：后墙两侧的深色布幔，让窗是一个「开口」而不是贴纸。
  // 0.53.5：每侧只留一道褶——布幔是背景，褶皱多了会变成花纹。
  for (const [cx0, cx1, fold] of [
    [x0 - 0.42, x0 + 0.12, -1],
    [x1 - 0.12, x1 + 0.42, 1]
  ] as const) {
    const drape = [
      pr(p, cx0, y, z0 - 0.18),
      pr(p, cx1, y, z0 - 0.18),
      pr(p, cx1 + fold * 0.08, y, z1 + 0.22),
      pr(p, cx0 - fold * 0.08, y, z1 + 0.22)
    ]
    poly(ctx, drape, '#241d24', '#33272f', 1)
    const fx = (cx0 + cx1) / 2
    line(ctx, pr(p, fx, y, z0 - 0.12), pr(p, fx + fold * 0.02, y, z1 + 0.2), 'rgba(90,60,74,0.38)', 1)
  }
  // 月光光晕
  const glow = ctx.createRadialGradient((a.x + b.x) / 2, (a.y + d.y) / 2, 4, (a.x + b.x) / 2, (a.y + d.y) / 2, 210)
  glow.addColorStop(0, 'rgba(130,170,255,0.16)')
  glow.addColorStop(1, 'rgba(130,170,255,0)')
  ctx.fillStyle = glow
  ctx.fillRect((a.x + b.x) / 2 - 210, (a.y + d.y) / 2 - 210, 420, 420)
}

function drawDoor(ctx: Ctx, p: RoomProjection): void {
  const x = -ROOM_WIDTH / 2 + 0.01
  const y0 = 1.25
  const y1 = 2.85
  const z1 = 2.7
  const a = pr(p, x, y0, 0)
  const b = pr(p, x, y1, 0)
  const c = pr(p, x, y1, z1)
  const d = pr(p, x, y0, z1)
  poly(ctx, [a, b, c, d], '#2a1e16', '#4a3826', 3)
  // 门板
  poly(
    ctx,
    [pr(p, x, y0 + 0.12, 0.15), pr(p, x, y1 - 0.12, 0.15), pr(p, x, y1 - 0.12, 1.25), pr(p, x, y0 + 0.12, 1.25)],
    '#33251b'
  )
  poly(
    ctx,
    [pr(p, x, y0 + 0.12, 1.4), pr(p, x, y1 - 0.12, 1.4), pr(p, x, y1 - 0.12, 2.5), pr(p, x, y0 + 0.12, 2.5)],
    '#33251b'
  )
  // 门把手
  const knob = pr(p, x, y1 - 0.18, 1.15)
  ctx.fillStyle = '#d8b060'
  ctx.beginPath()
  ctx.arc(knob.x, knob.y, 3, 0, Math.PI * 2)
  ctx.fill()
}

function drawRug(ctx: Ctx, p: RoomProjection): void {
  const y0 = 2.4
  const y1 = 5.8
  const x0 = -1.9
  const x1 = 1.9
  const pts = [pr(p, x0, y0, 0.01), pr(p, x1, y0, 0.01), pr(p, x1, y1, 0.01), pr(p, x0, y1, 0.01)]
  // 0.53.5：只留一圈细边。原来的内框 + 中线把地毯画成了「棋盘」，是背景杂乱的主要来源之一。
  poly(ctx, pts, '#2c2528', '#3c3336', 1.5)
}

function drawDesk(ctx: Ctx, p: RoomProjection): void {
  const wood = { front: '#3a2a1c', top: '#4a3726', side: '#2a1e14', edge: '#1d140e' }
  drawBox(ctx, p, { x: 1.55, y: 7.4, z: 0.78, w: 1.9, d: 0.8, h: 0.12 }, wood)
  for (const dx of [-0.8, 0.8]) {
    for (const dy of [-0.32, 0.32]) {
      drawBox(ctx, p, { x: 1.55 + dx, y: 7.4 + dy, z: 0, w: 0.1, d: 0.1, h: 0.78 }, wood)
    }
  }
  // 显示器
  drawBox(ctx, p, { x: 1.55, y: 7.32, z: 0.9, w: 0.86, d: 0.08, h: 0.5 }, {
    front: '#14161c',
    top: '#1d2028',
    side: '#0d0f14',
    edge: '#2a2f38'
  })
  const sc = pr(p, 1.55, 7.27, 1.14)
  const scW = scaleAt(7.27, p) * 0.74
  const scH = scaleAt(7.27, p) * 0.38
  const sg = ctx.createLinearGradient(0, sc.y - scH / 2, 0, sc.y + scH / 2)
  sg.addColorStop(0, '#6fa9cf')
  sg.addColorStop(1, '#2b577a')
  ctx.fillStyle = sg
  ctx.fillRect(sc.x - scW / 2, sc.y - scH / 2, scW, scH)
  // 0.53.5：删掉屏幕上的四条「代码线」——远景里的细节只会变成噪点，一块柔和的冷光更像真实屏幕。
  // 键盘
  drawBox(ctx, p, { x: 1.55, y: 7.02, z: 0.9, w: 0.7, d: 0.22, h: 0.03 }, {
    front: '#22262e',
    top: '#343a44',
    side: '#181b20'
  })
  // 台灯
  const lampBase = pr(p, 2.22, 7.15, 0.92)
  ctx.fillStyle = '#3a2b1e'
  ctx.fillRect(lampBase.x - 8, lampBase.y - 3, 16, 4)
  line(ctx, lampBase, { x: lampBase.x, y: lampBase.y - 30 }, '#4a3826', 3)
  const shade = pr(p, 2.22, 7.15, 1.3)
  poly(
    ctx,
    [
      { x: shade.x - 14, y: shade.y },
      { x: shade.x + 14, y: shade.y },
      { x: shade.x + 9, y: shade.y - 12 },
      { x: shade.x - 9, y: shade.y - 12 }
    ],
    '#6b5338',
    '#3a2b1e',
    1
  )
  // 凳子
  drawBox(ctx, p, { x: 1.55, y: 6.35, z: 0, w: 0.5, d: 0.5, h: 0.45 }, {
    front: '#3a2a1c',
    top: '#5a4530',
    side: '#2a1e14'
  })
}

function drawBookshelf(ctx: Ctx, p: RoomProjection): void {
  drawBox(ctx, p, { x: 3.14, y: 8.9, z: 0, w: 0.5, d: 2.2, h: 3.2 }, {
    front: '#2a2018',
    top: '#3a2c1e',
    side: '#1d150f',
    edge: '#15100b'
  })
  // 可见的左侧面（朝镜头）上的隔板与书
  for (const z of [0.75, 1.55, 2.35]) {
    const a = pr(p, 2.89, 7.85, z)
    const b = pr(p, 2.89, 9.95, z)
    line(ctx, a, b, '#4a3826', 2)
  }
  // 0.53.5：每层 6 本 → 4 本，颜色降饱和。书架在画面深处，书的颜色一多就成了噪点。
  const colors = ['#4a3a3a', '#3a4a42', '#3d4050', '#4d4533', '#443a44', '#34434a']
  for (let row = 0; row < 3; row++) {
    const z = 0.12 + row * 0.8
    for (let i = 0; i < 4; i++) {
      const yy = 7.95 + i * 0.5
      const h = 0.42 + ((i * 13) % 20) / 100
      drawBox(ctx, p, { x: 2.86, y: yy, z, w: 0.06, d: 0.12, h }, {
        front: colors[(i + row) % colors.length],
        top: colors[(i + row) % colors.length],
        side: colors[(i + row) % colors.length]
      })
    }
  }
}

function drawSofa(ctx: Ctx, p: RoomProjection): void {
  // 0.53.5：布料降饱和（原来的紫调在暖光下会发脏），并去掉搭毯——沙发只需要读成「一块柔软的坐具」。
  const fabric = { front: '#34313a', top: '#494550', side: '#26242b', edge: '#1b191f' }
  drawBox(ctx, p, { x: -2.05, y: 4.9, z: 0, w: 1.75, d: 1.25, h: 0.55 }, fabric)
  drawBox(ctx, p, { x: -2.05, y: 5.45, z: 0.55, w: 1.75, d: 0.25, h: 0.8 }, fabric)
  // 靠垫
  drawBox(ctx, p, { x: -2.55, y: 5.05, z: 0.55, w: 0.55, d: 0.35, h: 0.4 }, {
    front: '#4f444c',
    top: '#5d5159',
    side: '#3b333a'
  })
  drawBox(ctx, p, { x: -1.8, y: 5.05, z: 0.55, w: 0.55, d: 0.35, h: 0.4 }, {
    front: '#3e464d',
    top: '#4b545c',
    side: '#2e353a'
  })
}

function drawPlant(ctx: Ctx, p: RoomProjection): void {
  drawBox(ctx, p, { x: 2.2, y: 6.0, z: 0, w: 0.5, d: 0.5, h: 0.5 }, {
    front: '#5a3a2a',
    top: '#6b4a34',
    side: '#3a251a'
  })
  const base = pr(p, 2.2, 6.0, 0.5)
  // 0.53.5：9 片叶 → 5 片。植物是「房间里有一点生命」的提示，不是一簇烟花。
  for (let i = 0; i < 5; i++) {
    const angle = -Math.PI / 2 + (i - 2) * 0.3
    const len = 42 + (i % 3) * 10
    const ex = base.x + Math.cos(angle) * len
    const ey = base.y + Math.sin(angle) * len * 0.7
    ctx.beginPath()
    ctx.moveTo(base.x, base.y)
    ctx.quadraticCurveTo(base.x + (ex - base.x) * 0.5, base.y - 18, ex, ey)
    ctx.strokeStyle = i % 2 === 0 ? '#2b4a34' : '#36573f'
    ctx.lineWidth = 2.5
    ctx.stroke()
  }
}

function drawWallArt(ctx: Ctx, p: RoomProjection): void {
  const y = ROOM_DEPTH - 0.015
  // 一幅画：后墙已经有一扇窗、一盏纸灯和一组串灯，再挂两幅会显得满
  const frames: Array<{ x0: number; x1: number; z0: number; z1: number; fill: string }> = [
    { x0: 1.15, x1: 2.05, z0: 2.05, z1: 2.95, fill: '#3a2a3a' }
  ]
  for (const f of frames) {
    const pts = [
      pr(p, f.x0, y, f.z0),
      pr(p, f.x1, y, f.z0),
      pr(p, f.x1, y, f.z1),
      pr(p, f.x0, y, f.z1)
    ]
    poly(ctx, pts, f.fill, '#6b5338', 3)
    // 画里的一抹月光
    const c = pr(p, (f.x0 + f.x1) / 2, y, (f.z0 + f.z1) / 2)
    ctx.fillStyle = 'rgba(180,205,255,0.14)'
    ctx.beginPath()
    ctx.ellipse(c.x, c.y, Math.max(2, Math.abs(pts[1].x - pts[0].x) * 0.18), Math.max(2, Math.abs(pts[0].y - pts[3].y) * 0.2), 0, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * 角色**背光**：在人物后面铺一层柔和的径向光。
 *
 * 为什么需要（0.53.5「更写实、更简约」）：立绘是矩形 PNG，直接贴在深色房间里会读成
 * 「一张贴纸」；人物背后有一层与相位同色的环境光，边缘才会从背景里「浮」出来，
 * 同时把背景里剩下的细节压到视觉第二层。它画在人物之前，不改变任何几何。
 */
export function drawCharacterBacklight(
  ctx: Ctx,
  p: RoomProjection,
  pos: { x: number; y: number },
  state: SceneState,
  t: number,
  /** 用户侧「大小」配置（与人物绘制同源；缺省 1） */
  scale = 1
): void {
  if (state === 'stopped') return
  const foot = projectPoint(pos.x, pos.y, 0, p)
  const h = characterHeight(pos.y, p) * Math.max(0.2, scale)
  const cx = foot.x
  const cy = foot.y - h * 0.52
  const r = Math.max(70, h * 0.74)
  const rgb =
    state === 'error'
      ? [255, 70, 88]
      : state === 'standby'
        ? [112, 142, 216]
        : state === 'running'
          ? [255, 232, 186]
          : [222, 202, 168]
  // 运行时的呼吸只做 ±0.03，和 CSS 呼吸同向但不抢戏
  const pulse = state === 'running' ? Math.sin(t / 420) * 0.03 : 0
  const alpha =
    (state === 'standby' ? 0.10 : state === 'idle' ? 0.13 : state === 'running' ? 0.17 : 0.14) + pulse
  const g = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r)
  g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`)
  g.addColorStop(0.58, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha * 0.32})`)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = g
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2)
  ctx.restore()
}

/** 静态房间（墙 / 地板 / 家具 / 窗 / 灯）预渲染一次。 */
export function renderStaticRoom(p: RoomProjection = defaultProjection()): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = 960
  cv.height = 600
  const ctx = cv.getContext('2d')
  if (!ctx) return cv
  ctx.imageSmoothingEnabled = true

  ctx.fillStyle = '#07090e'
  ctx.fillRect(0, 0, 960, 600)

  // 地板
  const floor = [pr(p, -ROOM_WIDTH / 2, 0, 0), pr(p, ROOM_WIDTH / 2, 0, 0), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, 0), pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, 0)]
  const fg = ctx.createLinearGradient(0, floor[0].y, 0, floor[3].y)
  fg.addColorStop(0, '#2a2119')
  fg.addColorStop(1, '#141210')
  poly(ctx, floor, '#18140f')
  ctx.fillStyle = fg
  ctx.fillRect(0, floor[3].y, 960, floor[0].y - floor[3].y)
  // 地板缝（0.53.5：减半 + 降透明度。远景不需要数得清每块地板）
  for (let x = -ROOM_WIDTH / 2; x <= ROOM_WIDTH / 2 + 0.01; x += 1) {
    line(ctx, pr(p, x, 0, 0), pr(p, x, ROOM_DEPTH, 0), 'rgba(90,70,50,0.09)', 1)
  }
  for (let y = 2; y <= ROOM_DEPTH; y += 2) {
    line(ctx, pr(p, -ROOM_WIDTH / 2, y, 0), pr(p, ROOM_WIDTH / 2, y, 0), 'rgba(0,0,0,0.10)', 1)
  }

  // 后墙：一块干净的深色墙（0.53.5 删掉每 0.35 一道的竖纹——那是「装饰」不是「结构」）
  const back = [pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, 0), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, 0), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, ROOM_HEIGHT), pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, ROOM_HEIGHT)]
  poly(ctx, back, '#20232a')
  line(ctx, pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, 0.9), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, 0.9), '#32353c', 2)
  line(ctx, pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, 1.0), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, 1.0), '#17191e', 2)

  // 左墙 / 右墙
  const leftWall = [pr(p, -ROOM_WIDTH / 2, 0, 0), pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, 0), pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, ROOM_HEIGHT), pr(p, -ROOM_WIDTH / 2, 0, ROOM_HEIGHT)]
  const rightWall = [pr(p, ROOM_WIDTH / 2, 0, 0), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, 0), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, ROOM_HEIGHT), pr(p, ROOM_WIDTH / 2, 0, ROOM_HEIGHT)]
  poly(ctx, leftWall, '#191b21')
  poly(ctx, rightWall, '#1d1f26')
  for (let y = 2; y <= ROOM_DEPTH; y += 2) {
    line(ctx, pr(p, -ROOM_WIDTH / 2, y, 0), pr(p, -ROOM_WIDTH / 2, y, ROOM_HEIGHT), 'rgba(255,255,255,0.015)', 1)
    line(ctx, pr(p, ROOM_WIDTH / 2, y, 0), pr(p, ROOM_WIDTH / 2, y, ROOM_HEIGHT), 'rgba(255,255,255,0.015)', 1)
  }
  line(ctx, pr(p, -ROOM_WIDTH / 2, 0, 0.9), pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, 0.9), '#32353c', 2)
  line(ctx, pr(p, ROOM_WIDTH / 2, 0, 0.9), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, 0.9), '#32353c', 2)

  // 天花板（0.53.5：去掉横向线条——顶面在画面里几乎不可见，线条只会让暗部发灰）
  const ceil = [pr(p, -ROOM_WIDTH / 2, 0, ROOM_HEIGHT), pr(p, ROOM_WIDTH / 2, 0, ROOM_HEIGHT), pr(p, ROOM_WIDTH / 2, ROOM_DEPTH, ROOM_HEIGHT), pr(p, -ROOM_WIDTH / 2, ROOM_DEPTH, ROOM_HEIGHT)]
  poly(ctx, ceil, '#101218')

  drawWindow(ctx, p)
  drawDoor(ctx, p)
  drawRug(ctx, p)
  drawSofa(ctx, p)
  drawDesk(ctx, p)
  drawBookshelf(ctx, p)
  drawPlant(ctx, p)
  drawWallArt(ctx, p)
  return cv
}

/**
 * 状态色偏（**背景层**；图片背景时不再压角色——人物是主体，直播里不会跟着房间一起熄灯）。
 * 0.53.6：整体调轻。旧的 `stopped=0.52` 叠在 4K 背景上会把画面压成一块黑，
 * 「房间关着灯」不该等于「看不见房间」。
 */
export function stateTint(state: SceneState): string {
  switch (state) {
    case 'stopped':
      return 'rgba(2, 4, 9, 0.34)'
    case 'standby':
      return 'rgba(6, 12, 34, 0.26)'
    case 'idle':
      return 'rgba(8, 16, 44, 0.14)'
    case 'running':
      return 'rgba(64, 42, 12, 0.03)'
    case 'error':
      return 'rgba(92, 8, 18, 0.24)'
  }
}

/** 后墙挂钟：显示**真实时间**（「那边另一间屋子」的时间感）。 */
function drawWallClock(ctx: Ctx, p: RoomProjection): void {
  const y = ROOM_DEPTH - 0.012
  const c = pr(p, -2.75, y, 3.0)
  const r = Math.max(6, scaleAt(y, p) * 0.14)
  const d = new Date()
  ctx.save()
  ctx.fillStyle = 'rgba(12,14,20,0.9)'
  ctx.beginPath()
  ctx.arc(c.x, c.y, r + 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#d8cdb8'
  ctx.beginPath()
  ctx.arc(c.x, c.y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#6b5338'
  ctx.lineWidth = 1.2
  ctx.stroke()
  // 12 个刻度
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2
    ctx.fillStyle = i % 3 === 0 ? '#3a2a1c' : 'rgba(58,42,28,0.55)'
    ctx.fillRect(c.x + Math.sin(a) * r * 0.78 - 0.5, c.y - Math.cos(a) * r * 0.78 - 0.5, 1.2, 1.2)
  }
  const hand = (angle: number, len: number, width: number, color: string): void => {
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(c.x + Math.sin(angle) * len, c.y - Math.cos(angle) * len)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.lineCap = 'round'
    ctx.stroke()
  }
  const minute = (d.getMinutes() + d.getSeconds() / 60) / 60
  const hour = ((d.getHours() % 12) + minute) / 12
  hand((hour / 1) * Math.PI * 2, r * 0.52, 2, '#2a2018')
  hand(minute * Math.PI * 2, r * 0.76, 1.2, '#2a2018')
  ctx.fillStyle = '#8a2f3a'
  ctx.beginPath()
  ctx.arc(c.x, c.y, 1.4, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** 每帧的灯光（画在角色之后）：只有吊灯暖光 + 显示器冷光，保持画面干净。 */
export function drawRoomAtmosphere(
  ctx: Ctx,
  p: RoomProjection,
  t: number,
  state: SceneState
): void {
  // 吊灯暖光
  const bulb = pr(p, 0, 4.6, 3.1)
  const flicker = 0.82 + Math.sin(t / 310) * 0.06 + Math.sin(t / 91) * 0.03
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  const g = ctx.createRadialGradient(bulb.x, bulb.y, 4, bulb.x, bulb.y, 330)
  g.addColorStop(0, `rgba(255, 220, 150, ${0.20 * flicker})`)
  g.addColorStop(0.35, 'rgba(255, 190, 100, 0.06)')
  g.addColorStop(1, 'rgba(255, 170, 80, 0)')
  ctx.fillStyle = g
  ctx.fillRect(bulb.x - 340, bulb.y - 340, 680, 680)
  // 显示器冷光
  const sc = pr(p, 1.55, 7.25, 1.14)
  const sg = ctx.createRadialGradient(sc.x, sc.y, 2, sc.x, sc.y, 120)
  sg.addColorStop(0, 'rgba(120, 200, 255, 0.12)')
  sg.addColorStop(1, 'rgba(80, 160, 255, 0)')
  ctx.fillStyle = sg
  ctx.fillRect(sc.x - 120, sc.y - 120, 240, 240)
  ctx.restore()

  drawRoomGrade(ctx, state, { projection: p })
}

/**
 * 房间的**统一调色 / 暗角 / 挂钟**。
 * 为什么拆出来：前景层已删除，但把「镜头分级」与灯光分开仍便于在角色之后统一压色；
 * 挂钟只需画一次（`opts.clock=false`）。
 */
export function drawRoomGrade(
  ctx: Ctx,
  state: SceneState,
  opts: { clock?: boolean; projection?: RoomProjection } = {}
): void {
  // 色偏
  ctx.fillStyle = stateTint(state)
  ctx.fillRect(0, 0, 960, 600)

  // 暗角（0.53.5：0.5 → 0.34。暗角是「镜头」不是「黑框」，压得太重会把背景细节全吃掉）
  const vg = ctx.createRadialGradient(480, 300, 210, 480, 300, 700)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.34)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, 960, 600)

  // 挂钟画在暗角之后：它是房间里少数「始终可读」的真实信息
  if (opts.clock !== false) drawWallClock(ctx, opts.projection ?? defaultProjection())
}

// 角色绘制（像素 / 图片立绘 / 呼吸微动）已拆到 `perspective-character.ts`：
// 它在每帧调用，静态房间只在启动时渲染一次，拆开后两条链的职责与性能边界都清楚。
// 为兼容既有 import（测试直接从这里取 `drawCharacter` / `drawCharacterImage`），文件顶部做了再导出。

