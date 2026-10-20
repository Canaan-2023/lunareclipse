/**
 * @category ROOM
 * @summary 房间直播镜头：一点透视的房间坐标、区域、AI 可直接声明的「我在哪 / 做什么」
 *
 * 为什么重做（用户 2026-10-19 补充）：「不要做那个小人和地图了，做房间效果，**近大远小**的
 * 透视效果，人物也这么呈现」「就像是一场直播，我们看到的是**摄像头的视角**」。
 * 此前的 48×30 俯视 RPG 地图读起来是「棋盘」，不是「房间」；角色在图上平移但大小不变，
 * 没有纵深。本模块把「世界」换成**固定机位的一点透视**：
 *
 * - 世界坐标 `(x, y, z)`：x 横向（-3.5~3.5）、y 纵深（0 近 ~ 11 远）、z 高度（0 地板 ~ 4.4 天花板）；
 * - 投影 `s = f / (y - camY)`：越远 s 越小 → **近大远小**；角色与家具都用同一个 s；
 * - 角色是**立牌**：脚在 (x,y,0)，按 s 取高度，因此走近镜头会变大、走到窗边会变小；
 * - 区域是**房间里的位置**（窗边/书桌/书架/门边/地毯/中央），阶段只是兜底；
 *   AI 可以在计划里用 `scene` 直接指定「去窗边观察」「在书桌前工作」。
 *
 * 纯函数、零外部资源；渲染侧只负责把这里算出的点连成面。
 */

/** 房间世界尺寸 */
export const ROOM_WIDTH = 7
export const ROOM_DEPTH = 11
export const ROOM_HEIGHT = 4.4

/**
 * 固定机位（直播镜头）：位于房间近端外侧偏左，朝 +y 看；`f` 是焦距（像素）。
 *
 * 为什么是低位偏左（0.53.3，用户「就像我在屏幕这边看到那边另一间屋子」）：
 * - 机位贴近地面（z=1.15）→ 近景角色**填满左侧原立绘区域**，同时保留一点仰视的空间感；
 * - 机位偏左（x=-1）→ 近景角色落在画面左侧，房间深处（书桌 / 书架 / 窗）向右展开，
 *   形成「同一间屋子」的纵深，而不是把人贴在空白立绘槽里；
 * - 参数本身不是魔法：它们由「近景角色高度 ≈ 画面 90%」与「窗 / 桌 / 书架仍在画面内」
 *   两条构图约束反推而来（见 `ROOM_ZONES` 与测试）。
 */
export const ROOM_CAMERA = { x: -1, y: -0.8, z: 1.15, f: 900 } as const

/** 逻辑画布（渲染侧按容器等比缩放；透视必须允许非整数缩放，这是与俯视像素地图的关键区别） */
export const ROOM_VIEW_W = 960
export const ROOM_VIEW_H = 600

export interface RoomProjection {
  cx: number
  cy: number
  f: number
  camX: number
  camY: number
  camZ: number
}

/** 默认投影（画布中心 + 地平线略高于中线） */
export function defaultProjection(): RoomProjection {
  return {
    cx: ROOM_VIEW_W / 2,
    cy: ROOM_VIEW_H * 0.35,
    f: ROOM_CAMERA.f,
    camX: ROOM_CAMERA.x,
    camY: ROOM_CAMERA.y,
    camZ: ROOM_CAMERA.z
  }
}

/** 纵深 → 缩放（近大远小）。`depth` 是世界 y；低于相机前方时夹到 0.25，防爆。 */
export function scaleAt(depth: number, p: RoomProjection = defaultProjection()): number {
  const d = depth - p.camY
  if (!Number.isFinite(d)) return 0
  return p.f / Math.max(0.25, d)
}

/** 世界点 → 屏幕点（含该点的缩放） */
export function projectPoint(
  x: number,
  y: number,
  z: number,
  p: RoomProjection = defaultProjection()
): { x: number; y: number; scale: number } {
  const s = scaleAt(y, p)
  return { x: p.cx + (x - p.camX) * s, y: p.cy + (p.camZ - z) * s, scale: s }
}

/**
 * 屏幕落脚点 → 世界坐标（`projectPoint` 的逆运算，供舞台拖拽使用）。
 *
 * 为什么需要：拖拽是在**屏幕**上发生的，而外观配置存的是世界坐标 `(x, y)`；
 * 直接按像素改 x/y 会让「往下拖」变成「往远处走」（y 同时改变透视大小）。
 * 这里先由脚点反解纵深 s，再解 x/y，保证人物跟手。
 */
export function placementFromFootScreen(
  screenX: number,
  screenY: number,
  p: RoomProjection = defaultProjection()
): { x: number; y: number } {
  // 脚点 y = cy + camZ * s；s 与 scaleAt 同口径夹到 0.25，防反解出负数纵深
  const s = Math.max(0.25, (screenY - p.cy) / p.camZ)
  return {
    y: p.f / s + p.camY,
    x: (screenX - p.cx) / s + p.camX
  }
}

/**
 * 房间区域 = **它此刻在哪一类空间里做事**（不是家具，也不是房间里的坐标）。
 *
 * 0.53.6 语义化：舞台背景跟着 AI 的**活动**走，而不是跟着「房间里的角落」走。
 * 六个区各自是一处独立空间（用户「不局限于一个房间内」）：
 * - `home`   休息 / 空闲 / 待机；
 * - `plan`   分诊、规划（看资料、排步骤）；
 * - `work`   执行（工作间：工具、终端、工作台）；
 * - `memory` 回忆、检索（档案库）；
 * - `device` 设备（设备间：机柜、仪器）；
 * - `lan`    局域网（通信室：链路、屏幕、天线）。
 *
 * 人物位置仍由用户的外观配置决定；分区只决定**背景**与语义。
 */
export type RoomZoneId = 'home' | 'plan' | 'work' | 'memory' | 'device' | 'lan'

export interface RoomZone {
  x: number
  y: number
  facing: 'left' | 'right' | 'down'
  label: string
}

/**
 * 六个区域的世界坐标（保留给 `actorIntent` 与构图测试；**不再驱动人物位置**）。
 * 这些坐标只是「同一个房间里的落点」，当背景图缺失、回落到代码房间时仍有语义。
 */
export const ROOM_ZONES: Record<RoomZoneId, RoomZone> = {
  home: { x: 0, y: 4.6, facing: 'down', label: '房间' },
  plan: { x: 1.5, y: 6.4, facing: 'right', label: '规划室' },
  work: { x: 2.0, y: 3.0, facing: 'right', label: '工作间' },
  memory: { x: 2.55, y: 8.8, facing: 'right', label: '记忆库' },
  device: { x: -1.5, y: 7.5, facing: 'left', label: '设备间' },
  lan: { x: -2, y: 2.3, facing: 'left', label: '通信室' }
}

/**
 * 旧分区名 → 新分区。AI 的旧计划 / 用户旧场景文件里可能还留着这些名字，
 * 解析时**映射而不是丢弃**（否则一次改名会让正在跑的房间突然没有背景）。
 */
export const ROOM_ZONE_ALIASES: Record<string, RoomZoneId> = {
  center: 'home',
  door: 'home',
  rug: 'home',
  foyer: 'home',
  window: 'plan',
  desk: 'work',
  bookshelf: 'memory'
}

/**
 * 直播式**固定构图**（0.53.4 第三轮确立方向，0.53.6 按直播镜头重排）：
 *
 * 参考 VTuber / 直播画面的取景习惯，而不是「立绘槽」：
 * - **人物在右三分**（屏幕 x ≈ 67%）——左边 2/3 留给场景，等于「主持人在右、空间在左」；
 * - **头顶留白**：人物约占画面高度 82%，头顶距顶边 ≈ 11%（`y=2.16`），
 *   4K 背景的天花/吊灯不会被头发压住，人物也不会像被裁掉；
 * - **脚下落在前景地板**（屏幕 y ≈ 93%），底部输出带正好压住脚踝以下，
 *   和直播「下半身被下三分之一挡掉」的观感一致；
 * - 底部对话盒/输出带会盖住立绘下缘，半身图不会被看出「没有腿」；
 * - `ROOM_ZONES` 仍保留给 AI 的 `scene.zone` 字段与既有测试，但**不再驱动位置**；
 *   0.53.5 起它用于**分区场景切换**（用户放了 `scenes/<zone>.png` 时，舞台切到那个地方）。
 */
export const ROOM_COMPOSITION = { x: -0.45, y: 2.16 } as const

/** AI 可直接声明的地图动作（闭集；未知回落 `walk`） */
export const ROOM_SCENE_ACTIONS = ['walk', 'observe', 'work', 'read', 'think', 'rest'] as const
export type RoomSceneAction = (typeof ROOM_SCENE_ACTIONS)[number]

/**
 * 动作 → 人话（直播 HUD 显示用）。
 * 为什么放这里：HUD 以前直接把枚举值印出来（「窗边 · observe」），用户看到的是一半中文一半代码；
 * 动作集合是共享契约，标签与它同处一处才不会在渲染侧另建一份而漂移。
 */
export const ROOM_SCENE_ACTION_LABEL: Record<RoomSceneAction, string> = {
  walk: '走过去',
  observe: '观察',
  work: '做事',
  read: '看书',
  think: '思考',
  rest: '休息'
}

/** AI 声明的「这一轮我在哪里、做什么、说什么」 */
export interface RoomSceneDirective {
  zone: RoomZoneId
  action: RoomSceneAction
  /** 对镜头/用户说的一句话（可选，≤200 字符） */
  say?: string
}

export function isRoomZone(value: string): value is RoomZoneId {
  return Object.prototype.hasOwnProperty.call(ROOM_ZONES, value)
}

/** 宽容归一：新名字直接用；旧名字按别名映射；其它返回 null */
export function normalizeRoomZone(value: string): RoomZoneId | null {
  if (isRoomZone(value)) return value
  return ROOM_ZONE_ALIASES[value] ?? null
}

/** 解析 AI 的 `scene` 字段（形状非法 → null；action 缺省 walk；旧 zone 名自动映射） */
export function parseRoomScene(raw: unknown): RoomSceneDirective | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { zone?: unknown; action?: unknown; say?: unknown }
  if (typeof o.zone !== 'string') return null
  const zone = normalizeRoomZone(o.zone)
  if (!zone) return null
  const action =
    typeof o.action === 'string' && (ROOM_SCENE_ACTIONS as readonly string[]).includes(o.action)
      ? (o.action as RoomSceneAction)
      : 'walk'
  const say = typeof o.say === 'string' && o.say.trim() ? o.say.trim().slice(0, 200) : undefined
  return { zone, action, ...(say ? { say } : {}) }
}

/** 场景动作 → 行为绑定触发源（avatar 的帧仍由 behaviors 决定） */
export function sceneStage(action: RoomSceneAction): string | undefined {
  switch (action) {
    case 'observe':
      return 'collect'
    case 'read':
      return 'recall'
    case 'think':
      return 'plan'
    case 'work':
      return 'execute'
    case 'rest':
      return 'standby'
    case 'walk':
    default:
      return undefined
  }
}

/**
 * 阶段 → 区域（AI 未声明 scene 时的兜底）。**按「它此刻在哪类空间做事」映射**：
 * - 采集（传感器）→ 设备间；
 * - 分诊 / 规划 → 规划室；
 * - 回忆 → 记忆库；
 * - 执行 → 工作间（若本轮调用了局域网/设备工具，渲染侧会改判，见 `zoneForTools`）。
 */
export function zoneForStage(stage: string | undefined): RoomZoneId {
  switch (stage) {
    case 'collect':
      return 'device'
    case 'triage':
    case 'plan':
      return 'plan'
    case 'recall':
      return 'memory'
    case 'execute':
      return 'work'
    default:
      return 'home'
  }
}

/** 工具类别 → 区域（只有局域网/设备会改变落点；普通工具留在工作间） */
export function zoneForToolCategory(category: string | undefined): RoomZoneId | null {
  if (category === 'lan') return 'lan'
  if (category === 'device') return 'device'
  return null
}

/**
 * 相位 + 阶段 + AI 声明 → 目标区域 / 移动语义。
 * - `stopped` / `error`：原地停下（人还在，不是黑块）；
 * - `standby`：回房间中央（房间的灯会暗下来，人不出门）；
 * - **AI 声明的 `scene.zone` 优先**（直接控制）；
 * - 其余按阶段兜底；idle 在中央。
 */
export function actorIntent(
  phase: string,
  stage?: string,
  scene?: RoomSceneDirective
): { zone: RoomZoneId; mode: 'goto' | 'scene' | 'stay' } {
  if (phase === 'stopped' || phase === 'error') return { zone: 'home', mode: 'stay' }
  if (phase === 'standby') return { zone: 'home', mode: 'goto' }
  if (scene) return { zone: scene.zone, mode: 'scene' }
  if (phase === 'running') return { zone: zoneForStage(stage), mode: 'goto' }
  return { zone: 'home', mode: 'goto' }
}

/** 线性靠近目标（世界单位/秒）；返回新坐标与是否到达。 */
export function moveToward(
  current: { x: number; y: number },
  target: { x: number; y: number },
  speed: number,
  dt: number
): { x: number; y: number; arrived: boolean } {
  const dx = target.x - current.x
  const dy = target.y - current.y
  const len = Math.hypot(dx, dy)
  const budget = Math.max(0, speed) * Math.max(0, dt)
  if (len <= Math.max(0.02, budget)) return { x: target.x, y: target.y, arrived: true }
  if (len <= 1e-9) return { x: current.x, y: current.y, arrived: true }
  return { x: current.x + (dx / len) * budget, y: current.y + (dy / len) * budget, arrived: false }
}

/** 角色立牌在屏幕上的高度（世界身高 1.62，按纵深缩放） */
export function characterHeight(depth: number, p: RoomProjection = defaultProjection()): number {
  return 1.62 * scaleAt(depth, p)
}
