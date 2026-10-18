/**
 * @category ROOM
 * @summary ROOM 默认像素画（房间 + AI 拟人化形象）：开箱即用的「AI 的房间」
 *
 * 为什么存在：`RoomScene` 需要一份默认规格才能有画面；且它是 AI 自决像素（P3）的**模板**——
 * AI 只需在这份结构上改写行字符串即可重画自己与房间。
 *
 * 画法约定（与 `@shared/room/avatar-spec` 一致）：`'.'` 透明，`'0'`-`'9'`/`'a'`-`'f'` = 调色板下标。
 * 房间是**程序生成**的（墙/地板棋盘 + 窗 + 工作台），形象是**手写行字符串**（表达力在形象上）。
 *
 * 语义隐喻（与驾驶舱三主区对应，改图时保留）：
 * - **窗**（墙上的蓝色矩形）= 采集器：AI 的「眼睛」看向外面；
 * - **工作台**（木色矩形）= 执行器：AI 动手的地方；
 * - 形象四帧绑定房间相位：`idle` 站立 / `running` 伸手干活 / `standby` 闭眼 / `stopped` 熄灯（仅描边色）。
 *
 * 不删理由：删掉即 `RoomScene` 无默认画面，AI 未作画时房间是空白。
 */
import type { PixelSprite, RoomAvatarSpec } from '@shared/room/avatar-spec'

const ROOM_W = 40
const ROOM_H = 24
const AVATAR_W = 12
const AVATAR_H = 12

const ROOM_PALETTE = [
  '#1b2033', // 0 墙（暗）
  '#232c47', // 1 墙（亮）
  '#2c3654', // 2 地板（暗）
  '#35406a', // 3 地板（亮）
  '#7fd1e8', // 4 窗（蓝）
  '#0e1220', // 5 描边 / 阴影 / 桌腿
  '#6b5334', // 6 工作台（木）
  '#d6b276' // 7 月金点缀（台面高光）
]

const AVATAR_PALETTE = [
  '#d6b276', // 0 身体（月金）
  '#20263a', // 1 描边 / 眼
  '#f5f7ff' // 2 高光
]

/** 在网格上填一个闭区间矩形。 */
function fill(g: string[][], x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) g[y][x] = ch
  }
}

/** 生成房间背景：墙（上 7 行）+ 地板棋盘（下 17 行）+ 窗 + 工作台。 */
function makeRoomRows(): string[] {
  const g: string[][] = Array.from({ length: ROOM_H }, () => Array.from({ length: ROOM_W }, () => '.'))
  for (let y = 0; y < ROOM_H; y++) {
    for (let x = 0; x < ROOM_W; x++) {
      const alt = (x + y) % 2 === 0
      g[y][x] = y < 7 ? (alt ? '0' : '1') : alt ? '2' : '3'
    }
  }
  // 窗（采集器隐喻）
  fill(g, 4, 2, 12, 5, '4')
  for (let x = 4; x <= 12; x++) {
    g[2][x] = '5'
    g[5][x] = '5'
  }
  for (let y = 2; y <= 5; y++) {
    g[y][4] = '5'
    g[y][12] = '5'
  }
  // 工作台（执行器隐喻）
  fill(g, 24, 12, 35, 14, '6')
  for (let x = 24; x <= 35; x++) g[12][x] = '7'
  fill(g, 25, 15, 25, 17, '5')
  fill(g, 34, 15, 34, 17, '5')
  return g.map((row) => row.join(''))
}

/** 形象四帧（12×12 行字符串）。 */
const AVATAR_FRAMES: Record<string, string[]> = {
  // 站立：睁眼，双臂垂下
  idle: [
    '....0000....',
    '...000000...',
    '..00100100..',
    '..00000000..',
    '...010010...',
    '....0000....',
    '...000000...',
    '..00000000..',
    '..0.0000.0..',
    '..0.0000.0..',
    '....0..0....',
    '....0..0....'
  ],
  // 干活：双臂前伸（在工作台前）
  running: [
    '....0000....',
    '...000000...',
    '..00100100..',
    '..00000000..',
    '...000000...',
    '....0000....',
    '...000000...',
    '.0000000000.',
    '.0.000000.0.',
    '...000000...',
    '....0..0....',
    '....0..0....'
  ],
  // 待机：闭眼
  standby: [
    '....0000....',
    '...000000...',
    '..00000000..',
    '..00000000..',
    '...000000...',
    '....0000....',
    '...000000...',
    '..00000000..',
    '..0.0000.0..',
    '..0.0000.0..',
    '....0..0....',
    '....0..0....'
  ],
  // 熄灯：只剩描边色
  stopped: [
    '....1111....',
    '...111111...',
    '..11111111..',
    '..11111111..',
    '...111111...',
    '....1111....',
    '...111111...',
    '..11111111..',
    '..1.1111.1..',
    '..1.1111.1..',
    '....1..1....',
    '....1..1....'
  ]
}

/** 默认房间精灵（单帧 `base`）。 */
export function makeDefaultRoomSprite(): PixelSprite {
  return { w: ROOM_W, h: ROOM_H, palette: ROOM_PALETTE, frames: { base: makeRoomRows() } }
}

/** 默认 AI 形象精灵（四相位帧）。 */
export function makeDefaultAvatarSprite(): PixelSprite {
  return { w: AVATAR_W, h: AVATAR_H, palette: AVATAR_PALETTE, frames: AVATAR_FRAMES }
}

/** 默认规格：AI 站在房间中前方、面朝工作台。 */
export const DEFAULT_AVATAR_SPEC: RoomAvatarSpec = {
  version: 1,
  room: makeDefaultRoomSprite(),
  avatar: makeDefaultAvatarSprite(),
  avatarPos: { x: 14, y: 12 }
}
