/**
 * ROOM「存在」画面的分层与五态（纯函数，可单测）。
 *
 * **设计口径（用户 2026-10-19 裁决「不必执着于像素，总之你来弄」后的定稿）**：
 * - **里面是它的画，外面是系统给的真实光**——房间与形象仍是**像素**（那是 AI 自己画的世界，
 *   它有权决定每一个像素点怎么摆）；**窗外天空与光照是平滑的**（系统层，不用像素模拟）。
 *   这个对比本身就是语义：窗子是一个真的开口。
 * - 三层：① 平滑天空（渐变 + 星点 + 地平线辉光）→ ② 像素房间 + 形象（AI 绘制）→ ③ 环境光晕。
 * - **呼吸**：相位由「节奏 + 色温 + 光晕」表达（`breathPeriodMs`），CSS 动画负责，**不用 JS 定时器**；
 *   静止态（停 / 待机 / 出错）不呼吸——**安静就是安静**。
 *
 * 为什么独立成模块：`Presence` 只能画，画面的「该长什么样」必须与 canvas 解耦，否则五态差异
 * 与呼吸节奏全部内联在绘制回调里，既不可测也无法在 node 环境下验证。
 *
 * 不删理由：删掉即五态退回「同一张图换个颜色」，且呼吸/光照的差异无法被单测锁住。
 */
import type { PixelSprite } from '@shared/room/avatar-spec'

/** 画面状态（**五态**）：四相位 + 出错（`llmFailed`） */
export type SceneState = 'stopped' | 'standby' | 'idle' | 'running' | 'error'

/** 相位 + 出错标记 → 画面状态。出错优先于一切（与月相红月同口径）。 */
export function sceneStateOf(phase: string, opts: { llmFailed?: boolean } = {}): SceneState {
  if (opts.llmFailed) return 'error'
  return phase === 'standby' || phase === 'idle' || phase === 'running' ? phase : 'stopped'
}

/** 天空动画节拍（毫秒/帧）：约 5fps——云与星不需要 60fps，且降低重绘开销。 */
export const SCENE_FRAME_MS = 200

/** 缩放上下限（整数倍；`1` 是下限，避免房间小到不可辨） */
export const SCENE_SCALE_MIN = 1
/**
 * 上限 6 → **14**（用户 2026-10-19：「月蚀窗口那么大，为啥自主模式那个图像不能自适应窗口大小」）：
 * 6 倍时 112×72 的房间最大只有 672×432，在大窗口里显得很小。上限只是**防爆**——
 * 真正决定大小的是 `fitScale` 量到的容器尺寸：窗口多大，它就能多大。
 */
export const SCENE_SCALE_MAX = 14

/**
 * 整数缩放：容器宽 → 房间像素宽的**整数倍**。
 * 为什么必须取整：非整数倍会让 canvas 的 1px 方块变成 1.5px，`image-rendering: pixelated`
 * 也救不回来（会出现粗细不一的方格）——像素风的第一条硬约束。
 */
export function integerScale(containerPx: number, roomW: number, opts: { min?: number; max?: number } = {}): number {
  const min = opts.min ?? SCENE_SCALE_MIN
  const max = opts.max ?? SCENE_SCALE_MAX
  if (!Number.isFinite(containerPx) || roomW <= 0) return min
  return Math.max(min, Math.min(max, Math.floor(containerPx / roomW)))
}

/**
 * **适配缩放**：同时受容器**宽与高**约束的整数倍（渲染侧真正用的那个）。
 *
 * 为什么不能只看宽度（2026-10-19 用户报「看板娘并没有显示出来」的根因之一）：
 * 房间区域只占聊天区的一部分（下面是输出流），因此它常常**窄而矮**。只按宽度放大时画布
 * 纵向超出容器，而容器是 `overflow-hidden` + `items-center` → 上下各裁掉一大块；
 * 角色站在画面下半部，于是**被裁得看不见**（房间还在，人没了）。
 *
 * 上下限沿用 `SCENE_SCALE_MIN/MAX`；容器还没量到（0×0）时返回下限，量到后自动修正。
 */
export function fitScale(
  containerW: number,
  containerH: number,
  roomW: number,
  roomH: number,
  opts: { min?: number; max?: number } = {}
): number {
  const min = opts.min ?? SCENE_SCALE_MIN
  const max = opts.max ?? SCENE_SCALE_MAX
  if (!Number.isFinite(containerW) || !Number.isFinite(containerH) || roomW <= 0 || roomH <= 0) return min
  const byWidth = Math.floor(containerW / roomW)
  const byHeight = Math.floor(containerH / roomH)
  const fit = Math.min(byWidth, byHeight)
  if (!Number.isFinite(fit) || fit < min) return min
  return Math.min(max, fit)
}

/**
 * 是否跑**天空**动画（云/星的漂移）。**静止时零开销**：
 * - `stopped` / `standby` / `error` → 不跑（熄灯 / 它睡了 / 出事了，画面定住更醒目）；
 * - 页面不可见（`document.hidden`）→ 不跑；
 * - `prefers-reduced-motion` → 不跑。
 *
 * 注意：**呼吸**不走这里（它是 CSS 动画，同样被 reduced-motion 与相位闸住），
 * 所以「不跑天空动画」不等于「画面完全静止」。
 */
export function shouldAnimate(state: SceneState, env: { hidden: boolean; reducedMotion: boolean }): boolean {
  if (env.hidden || env.reducedMotion) return false
  return state === 'idle' || state === 'running'
}

// ===== 呼吸（CSS 动画的节奏参数；`null` = 不呼吸）=====

/** 呼吸周期（毫秒）：**越快 = 越活**。`null` = 静止不呼吸。 */
export function breathPeriodMs(state: SceneState): number | null {
  switch (state) {
    case 'running':
      return 1400
    case 'idle':
      return 3000
    case 'standby':
      return 6000
    case 'stopped':
    case 'error':
      return null
  }
}

/** 呼吸的振幅（缩放增量；越小越克制）。`null` = 不呼吸。 */
export function breathAmplitude(state: SceneState): number | null {
  switch (state) {
    case 'running':
      return 0.012
    case 'idle':
      return 0.008
    case 'standby':
      return 0.005
    case 'stopped':
    case 'error':
      return null
  }
}

/**
 * **形象动画帧**的节拍（毫秒/帧）。与呼吸同向：**越快 = 越活**。
 *
 * 为什么单独一档而不是复用 `SCENE_FRAME_MS`：天空漂移要快（云在动），形象的动作要慢
 * （`running` 抬手 260ms 一帧已经很快，`idle` 呼吸 520ms 一帧才像在呼吸）。两者共用一个节拍
 * 必然一头不合适。
 *
 * `standby` / `stopped` / `error` 返回 `null` = **形象不动**（它睡了 / 熄灯了 / 出事了）。
 * 与 `shouldAnimate` 一致：静止态连 rAF 都不跑，因此这里返回非 null 也没用——
 * 但返回 `null` 让「静止」这件事在纯函数层就成立，可被单测锁住。
 */
export function avatarFrameMs(state: SceneState): number | null {
  switch (state) {
    case 'running':
      return 260
    case 'idle':
      return 520
    case 'standby':
    case 'stopped':
    case 'error':
      return null
  }
}

// ===== 平滑天空（系统层）=====

/** 天空的三段色（自上而下）：顶 / 中 / 地平线辉光 */
export interface SkyGradient {
  top: string
  mid: string
  horizon: string
}

const SKY: Record<SceneState, SkyGradient> = {
  // 熄灯：外面什么都看不见
  stopped: { top: '#04050a', mid: '#06070d', horizon: '#0a0b12' },
  // 待机：深夜蓝，地平线几乎不亮
  standby: { top: '#070c1a', mid: '#0d1630', horizon: '#16224a' },
  // 空闲：夜色 + 明显的地平线辉光（它醒着）
  idle: { top: '#0a1128', mid: '#14204a', horizon: '#2b3f7a' },
  // 运行：更亮，地平线有一道暖金（它在动）
  running: { top: '#101d3f', mid: '#1d3163', horizon: '#6a7fb8' },
  // 出错：暗红，地平线是烧红的
  error: { top: '#1c0509', mid: '#330e14', horizon: '#7a1d24' }
}

export function skyGradient(state: SceneState): SkyGradient {
  return SKY[state]
}

/** 确定性伪随机（0~1）：**不用 `Math.random`**——画面必须可复现、可断言。 */
function noise(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

/** 一颗星（画布坐标 + 亮度 0~1） */
export interface Star {
  x: number
  y: number
  brightness: number
}

/**
 * 星点：位置**固定**（不随时间变），密度与亮度按状态。
 * 熄灯态没有星（外面什么都看不见）；出错态星是烧红的余烬（调色板见 `STAR_PALETTE`）。
 */
export function stars(state: SceneState, w: number, h: number): Star[] {
  if (state === 'stopped') return []
  const density = state === 'error' ? 0.012 : state === 'running' ? 0.02 : 0.016
  const out: Star[] = []
  for (let y = 0; y < Math.floor(h * 0.62); y++) {
    for (let x = 0; x < w; x++) {
      const n = noise(x, y, 1)
      if (n > 1 - density) out.push({ x, y, brightness: 0.35 + (n - (1 - density)) / density * 0.65 })
    }
  }
  return out
}

/** 星点的调色板（三档亮度；出错态是烧红的余烬） */
const STAR_PALETTE: Record<'normal' | 'error', string[]> = {
  normal: ['#4a5878', '#9fb0d8', '#ffffff'],
  error: ['#5a2a24', '#c05a4a', '#ffb0a0']
}

/**
 * 天空的**星点层**（像素 1×1，叠在平滑渐变之上）。
 * 保留这一层像素是有意的：星是「真实的点」，渐变是「大气」——两者叠在一起才有纵深。
 * 熄灯态没有星（外面什么都看不见）→ 返回 `null`。
 */
export function starSprite(state: SceneState, w: number, h: number): PixelSprite | null {
  const list = stars(state, w, h)
  if (list.length === 0) return null
  const grid: string[][] = Array.from({ length: h }, () => Array.from({ length: w }, () => '.'))
  for (const s of list) {
    // 亮度分三档 → 三个调色板下标（0 暗 / 1 中 / 2 亮）
    grid[s.y][s.x] = s.brightness > 0.8 ? '2' : s.brightness > 0.55 ? '1' : '0'
  }
  return {
    w,
    h,
    palette: STAR_PALETTE[state === 'error' ? 'error' : 'normal'],
    frames: { stars: grid.map((r) => r.join('')) }
  }
}

/**
 * 云：一条**平滑**的横向柔光带（不是像素块），只在空闲/运行出现，随时间左移。
 * 返回 `null` = 这个状态没有云（停 / 待机 / 出错）。
 */
export function cloudBand(state: SceneState, w: number, h: number, t: number): { y: number; h: number; x: number; alpha: number } | null {
  if (state !== 'idle' && state !== 'running') return null
  const speed = state === 'running' ? 2 : 1
  const span = w * 1.6
  const x = ((w + 8 - ((t * speed * 2) % span)) % span) - w * 0.3
  return { y: Math.floor(h * 0.2), h: Math.max(3, Math.floor(h * 0.18)), x, alpha: state === 'running' ? 0.16 : 0.1 }
}

// ===== 环境光晕（系统层）=====

/** 光晕规格：中心色 + 半径（相对房间宽的比例）+ 强度 */
export interface GlowSpec {
  color: string
  radiusRatio: number
  alpha: number
}

/**
 * 环境光晕：五态各有不同的色温与强度，**罩在 AI 站位上**。
 * 这是「它在不在发光」的直觉信号——即使 AI 把房间画得密不透风也看得见。
 * `null` = 不发光（熄灯）。
 */
export function glowFor(state: SceneState): GlowSpec | null {
  switch (state) {
    case 'stopped':
      return null
    case 'standby':
      return { color: '#5b7fd6', radiusRatio: 0.55, alpha: 0.16 }
    case 'idle':
      return { color: '#d6b276', radiusRatio: 0.7, alpha: 0.22 }
    case 'running':
      return { color: '#ffe9b0', radiusRatio: 0.9, alpha: 0.3 }
    case 'error':
      return { color: '#ff2d3d', radiusRatio: 0.8, alpha: 0.28 }
  }
}

