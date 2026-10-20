/**
 * @category ROOM
 * @summary ROOM 默认像素画（房间 + **月蚀的看板娘**）：开箱即用的「它的房间」与「它长什么样」
 *
 * 为什么存在：`Presence` 需要一份默认规格才能有画面；且它是 AI 自决像素（P3）的**模板**——
 * AI 只需在这份结构上改写行字符串即可重画自己与房间。
 *
 * **看板娘（2026-10-19 用户裁决）**：「角色要**二次元风格**，**二次元美少女**，也算是担任
 * 月蚀的**看板娘**、月蚀的形象」。因此形象从「16×16 的抽象小人」重做为 **28×40 的二次元少女**：
 * 大头小身的 Q 版比例、大眼睛（上睫毛 + 虹膜 + 高光 + 瞳孔）、长直发 + 刘海 + 侧发、
 * 白领水手服 + 月金胸针（月蚀的记号）、白色过膝袜 + 深色鞋。**全部程序生成、零随机源**。
 *
 * **行为（同批）**：「AI 可以自己绘制，**保存挂在某个动作上**，到时候 AI 做什么那个行为就会
 * 展示出来」→ `DEFAULT_BEHAVIORS` 把帧绑到**房间自己的动作**（相位 + 本轮阶段）上；
 * 结构与校验在 `@shared/room/avatar-spec` 的 `AvatarBehavior`。
 * 画面上：`think` = 手托腮（分诊/召回/规划）、`work` = 双手前伸（运行/执行）、
 * `watch` = 手搭凉棚看向窗外（采集 = 它的眼睛）、`sleep` = 闭眼、`off` = 整身剪影。
 *
 * 房间（同批从 96×64 提到 **112×72**，给角色留出余地）：后墙板缝 / 挂镜线 / 窗（窗棂 + 窗台）/
 * **地板上的月光池**（窗棂的影子落在光里）/ 书架与书 / 吊灯 / 工作台（显示器 + 键盘 + 杯子）/
 * 椅子 / 地毯 / 踢脚线 / 竖向贯通的地板缝。
 * **窗外不画**：窗内留透明，系统的平滑天空（`scene-layers.skyGradient`）从这里透出来——
 * 「里面是它的画，外面是真实的光」。
 *
 * 画法约定（与 `@shared/room/avatar-spec` 一致）：`'.'` 透明，`'0'`-`'9'`/`'a'`-`'f'` = 调色板下标。
 * 墙面与地板用 **Bayer 4×4 有序抖动**做多色阶过渡（`ramp`），不是 alpha 渐变——渐变会把像素糊掉。
 *
 * 语义隐喻（与「细节」面板的六页对应，改图时保留）：
 * - **窗**（左上）= 感知：它的眼睛看向外面，月光落进房间；
 * - **工作台**（右下，带显示器）= 动作：它动手的地方；
 * - **书架与地毯** = 记忆：它读过与留过的；
 * - 形象帧绑定相位/阶段：见 `DEFAULT_BEHAVIORS`。
 *
 * 不删理由：删掉即 `Presence` 无默认画面，AI 未作画时房间是空白。
 */
import type { AvatarBehavior, PixelSprite, RoomAvatarSpec } from '@shared/room/avatar-spec'

const ROOM_W = 112
const ROOM_H = 72
const AVATAR_W = 28
const AVATAR_H = 40

/** 后墙占 y 0..WALL_BOTTOM-1；踢脚线 y WALL_BOTTOM..FLOOR_TOP-1；地板 y FLOOR_TOP.. */
const WALL_BOTTOM = 44
const FLOOR_TOP = 46

/** 窗（外框闭区间）。窗内留透明，系统天空从这儿透出来。 */
const WIN = { x0: 12, y0: 8, x1: 52, y1: 36 }
/** 窗台 */
const SILL = { x0: 9, y0: 37, x1: 55, y1: 40 }
/**
 * 月光池：梯形，越近越宽（模拟光从窗口投到地板上的形状）。
 * 中心刻意偏右（x≈34）——看板娘站在池的左侧，**池的最亮核心才看得见**；
 * 若把池摆在角色正下方，最亮的那几列会被角色整个盖住，等于白画。
 */
const POOL = { cxTop: 36, cxBottom: 32, halfTop: 12, halfBottom: 26 }
/** 书架 */
const SHELF = { x0: 60, y0: 12, x1: 88, y1: 30 }
/** 吊灯（灯罩中心 x / 灯罩起始 y） */
const LAMP = { x: 96, yShade: 8, shadeRows: [2, 4, 5, 6] as const }
/** 工作台（桌面闭区间） */
const DESK = { x0: 68, y0: 52, x1: 108, y1: 56 }
/** 显示器（屏幕外框闭区间）。高度刻意压到 13 行——再高它比工作台还高，像块广告牌。 */
const MONITOR = { x0: 82, y0: 36, x1: 98, y1: 48 }
/** 椅子 */
const CHAIR = { x0: 52, y0: 56, x1: 66, y1: 68 }
/**
 * 地毯：椭圆 + 深色镶边。**刻意摆在工作台一侧而不是角色脚下**——角色脚下是月光池的最亮区，
 * 地毯一铺上去就把那块光盖掉了（同一块地板上，两个「主角」只能留一个）。
 */
const RUG = { x0: 46, y0: 62, x1: 86, y1: 70 }

/**
 * 房间调色板（16 色）。
 * 分四组：墙（0-3）/ 地板与月光（4-7）/ 木（8-a）/ 金属与光（b-f）。
 * 下标 4 是「地板远 + 桌下阴影」共用的最暗地板色；f 是月光白，**只用在月光池核心**。
 */
const ROOM_PALETTE = [
  '#0a0d16', // 0 最暗：缝隙 / 描边 / 窗框
  '#141b2e', // 1 后墙（暗）
  '#1d2740', // 2 后墙（中）
  '#28334f', // 3 后墙（亮）
  '#232c47', // 4 地板（远 / 阴影）
  '#2c3654', // 5 地板（中）
  '#3a4568', // 6 地板（近）
  '#4a5a86', // 7 地板（月光）
  '#4a3a24', // 8 木（暗：桌腿 / 书架立柱 / 地毯边）
  '#6b5334', // 9 木（桌面 / 书脊）
  '#8a6c46', // a 木（亮边 / 地毯）
  '#3a4460', // b 金属（暗：灯罩 / 屏幕底）
  '#5b6a92', // c 金属（亮：键盘 / 杯子）
  '#d6b276', // d 月金（点缀 / 靴 / 书）
  '#ffe9b0', // e 暖光（灯泡 / 屏幕首行）
  '#e8eeff' // f 月光白（只用于月光池核心）
]

/**
 * 看板娘调色板（16 色）。
 * 分六组：描边 / 头发三阶 / 皮肤三阶 / 眼 / 衣四阶 / 白与月金。
 */
const AVATAR_PALETTE = [
  '#0b0d16', // 0 描边（最暗）
  '#1b2238', // 1 头发（暗）
  '#2b3a5c', // 2 头发
  '#4a5f8c', // 3 头发高光（月光打在发上）
  '#ffe6d5', // 4 皮肤
  '#e8b9a0', // 5 皮肤阴影
  '#b3806a', // 6 皮肤深阴影 / 嘴
  '#20263a', // 7 瞳孔
  '#4f86c4', // 8 虹膜
  '#a9d8ff', // 9 虹膜高光
  '#f2f6ff', // a 眼白 / 最亮
  '#2a3552', // b 衣（暗）
  '#3f5080', // c 衣（主体）
  '#5a6ea8', // d 衣（亮）
  '#e8eeff', // e 白（领口 / 过膝袜）
  '#d6b276' // f 月金（胸针 / 发饰）
]

// ===== 画法基础（纯函数；越界静默忽略——画法代码不该因为边缘差一像素而抛）=====

type Grid = string[][]

function blank(w: number, h: number, ch = '.'): Grid {
  return Array.from({ length: h }, () => Array.from({ length: w }, () => ch))
}

function px(g: Grid, x: number, y: number, ch: string): void {
  const row = g[y]
  if (!row) return
  if (x < 0 || x >= row.length) return
  row[x] = ch
}

function rect(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(g, x, y, ch)
}

/** 矩形边框（厚度 1） */
function frame(g: Grid, x0: number, y0: number, x1: number, y1: number, ch: string): void {
  for (let x = x0; x <= x1; x++) {
    px(g, x, y0, ch)
    px(g, x, y1, ch)
  }
  for (let y = y0; y <= y1; y++) {
    px(g, x0, y, ch)
    px(g, x1, y, ch)
  }
}

/** Bayer 4×4 有序抖动矩阵（0..15）——像素画做「多色阶渐变」的标准做法 */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
]

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * 0..1 的连续亮度 → `tones` 里的一个色号，**相邻色阶之间用 Bayer 抖动过渡**。
 * 为什么不用 alpha 渐变：渐变会把像素糊掉，1px 方块的边界一糊就不再是像素画。
 *
 * **NaN 兜底**：亮度算成 NaN 时（例如 `Math.pow(负数, 1.6)`）取最暗色而不是写进 `undefined`
 * ——`undefined` 会被 `join('')` 吃掉一个字符，表现为「某几行比别的行短」，肉眼看不出来，
 * 只有行宽断言抓得到。宁可暗一格，不可少一格。
 */
function ramp(v: number, tones: readonly string[], x: number, y: number): string {
  if (!Number.isFinite(v)) return tones[0]
  const t = clamp01(v) * (tones.length - 1)
  const lo = Math.floor(t)
  if (lo >= tones.length - 1) return tones[tones.length - 1]
  return t - lo > (BAYER4[y & 3][x & 3] + 0.5) / 16 ? tones[lo + 1] : tones[lo]
}

/**
 * 确定性伪随机，值域 **[0, 1)**（**不用 `Math.random`**：画面必须可复现）。
 * 除以 2^32（而不是 `0xffffffff`）是刻意的——后者会在极少数取值上返回**恰好 1.0**，
 * 而调用方普遍用它做数组下标（`Math.floor(hash * n)` 会变成 n，取到 `undefined`）。
 */
function hash(i: number, salt: number): number {
  let h = (i * 374761393 + salt * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// ===== 房间 =====

const WALL_TONES = ['0', '1', '2', '3'] as const
const FLOOR_TONES = ['4', '5', '6'] as const
const POOL_TONES = ['6', '7', 'f'] as const
const RUG_TONES = ['8', '9', 'a'] as const
const BOOK_TONES = ['d', 'a', 'c', '9', 'e'] as const

/** 后墙：顶亮底暗 + 四角压暗 + **窗口光晕**（月光从窗口洒在墙上）+ 板缝 + 挂镜线。 */
function drawWall(g: Grid): void {
  for (let y = 0; y < WALL_BOTTOM; y++) {
    for (let x = 0; x < ROOM_W; x++) {
      const top = 1 - y / WALL_BOTTOM
      const edge = Math.min(x, ROOM_W - 1 - x) / (ROOM_W / 2)
      let v = 0.26 + 0.34 * top + 0.16 * clamp01(edge * 1.4)
      // 到窗框的欧氏距离：越近越亮（指数衰减，边界由抖动过渡）
      const dx = Math.max(WIN.x0 - x, 0, x - WIN.x1)
      const dy = Math.max(WIN.y0 - y, 0, y - WIN.y1)
      v += 0.62 * Math.exp(-Math.sqrt(dx * dx + dy * dy) / 9)
      px(g, x, y, ramp(v, WALL_TONES, x, y))
    }
  }
  // 板缝：每 16px 一条（给墙面尺度感，不然是一整片渐变）
  for (let y = 0; y < WALL_BOTTOM; y++) for (let x = 16; x < ROOM_W; x += 16) px(g, x, y, '0')
  // 挂镜线：一条横向暗线，把墙分成上下两段
  for (let x = 0; x < ROOM_W; x++) px(g, x, 12, '0')
}

/** 踢脚线：地板与墙的分界（一条硬边 + 受光上沿，给纵深） */
function drawBaseboard(g: Grid): void {
  for (let x = 0; x < ROOM_W; x++) {
    px(g, x, WALL_BOTTOM, '0')
    px(g, x, WALL_BOTTOM + 1, '2')
  }
}

/**
 * 地板底色：近处更亮（近大远小的纵深暗示）+ 左右两端略暗，用抖动过渡。
 * **板缝单独一层、画在月光池之前**（见 `drawFloorSeams`）——光斑是一整块光，
 * 不该被地板缝切成梯子；窗棂投在光斑里的影子由 `drawMullionShadow` 单独画。
 */
function drawFloorBase(g: Grid): void {
  for (let y = FLOOR_TOP; y < ROOM_H; y++) {
    const depth = (y - FLOOR_TOP) / (ROOM_H - 1 - FLOOR_TOP)
    for (let x = 0; x < ROOM_W; x++) {
      const edge = Math.min(x, ROOM_W - 1 - x) / (ROOM_W / 2)
      px(g, x, y, ramp(0.1 + 0.62 * depth + 0.12 * clamp01(edge * 1.6), FLOOR_TONES, x, y))
    }
  }
}

/**
 * 地板板缝：**竖向贯通** + 横向板端（间距递增 = 透视）。
 *
 * 为什么竖向要贯通、不能按带错开：错开会读成**砖墙**（每一格都是独立砖块），
 * 贯通才读成**长木板**——这是同一组像素、两种完全不同的材质。
 * 缝一律用 tone 4（比地板底色暗一档），不用 tone 0：满屏黑线会把地板压成一张网格纸。
 */
function drawFloorSeams(g: Grid): void {
  for (let y = FLOOR_TOP; y < ROOM_H; y++) {
    for (let x = 0; x < ROOM_W; x += 8) px(g, x, y, '4')
  }
  let y = FLOOR_TOP + 3
  let band = 0
  while (y < ROOM_H) {
    for (let x = 0; x < ROOM_W; x++) px(g, x, y, '4')
    band++
    y += 3 + (band >> 1)
  }
}

/** 窗：外框 / 受光内框 / 窗棂 / 窗台。**窗内留透明**，系统天空从这儿透出来。 */
function drawWindow(g: Grid): void {
  // 先把墙擦掉：墙的底色铺满整面（含窗的位置），窗内必须是**透明**的，
  // 否则系统天空透不进来——「窗 = 它看向外面的眼睛」这条语义就没了。
  rect(g, WIN.x0 + 2, WIN.y0 + 2, WIN.x1 - 2, WIN.y1 - 2, '.')
  for (let t = 0; t < 2; t++) frame(g, WIN.x0 + t, WIN.y0 + t, WIN.x1 - t, WIN.y1 - t, t === 0 ? '0' : '3')
  const mx = Math.round((WIN.x0 + WIN.x1) / 2)
  const my = Math.round((WIN.y0 + WIN.y1) / 2)
  for (let y = WIN.y0 + 2; y <= WIN.y1 - 2; y++) {
    px(g, mx, y, '0')
    px(g, mx + 1, y, '3')
  }
  for (let x = WIN.x0 + 2; x <= WIN.x1 - 2; x++) {
    px(g, x, my, '0')
    px(g, x, my + 1, '3')
  }
  // 窗台：上沿受光（月光落在窗台上）
  for (let x = SILL.x0; x <= SILL.x1; x++) px(g, x, SILL.y0, '3')
  rect(g, SILL.x0, SILL.y0 + 1, SILL.x1, SILL.y1 - 1, '2')
  for (let x = SILL.x0; x <= SILL.x1; x++) px(g, x, SILL.y1, '0')
}

/**
 * 月光池：光从窗口投到地板上形成的梯形亮区（房间画面里最亮的一块）。
 * 边界由抖动过渡（不是硬边白斑），中心用月光白 `f`——整幅画只有这里会出现 `f`。
 * 指数 2.2 让亮核收得住：指数小（1.4）时整片都是高亮抖动，远看像雪花屏。
 */
function drawMoonPool(g: Grid): void {
  for (let y = FLOOR_TOP; y < ROOM_H; y++) {
    const t = (y - FLOOR_TOP) / (ROOM_H - 1 - FLOOR_TOP)
    const cx = POOL.cxTop + (POOL.cxBottom - POOL.cxTop) * t
    const hw = POOL.halfTop + (POOL.halfBottom - POOL.halfTop) * t
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) {
      const row = g[y]
      if (!row || x < 0 || x >= row.length) continue
      const dist = Math.abs(x - cx) / hw
      // `Math.max(0, ...)` 不是防御性冗余：`Math.round(cx + hw)` 会落到 cx+hw+0.5，
      // 那时 `1 - dist` 略小于 0，而 `Math.pow(负数, 1.6)` 是 NaN（见 `ramp` 的 NaN 兜底）。
      px(g, x, y, ramp(0.3 + 0.7 * Math.pow(Math.max(0, 1 - dist), 2.2), POOL_TONES, x, y))
    }
  }
}

/**
 * 窗棂的影子：窗棂是实体，光穿过它时会在光斑里留下暗纹。
 * 只画竖棂（横棂的影子在光斑里会读成「梯子横档」，与地板缝混淆）；
 * 位置直接取窗棂的 x——**不另设一个数字**，否则改窗就要记得同时改影子。
 */
function drawMullionShadow(g: Grid): void {
  const mx = Math.round((WIN.x0 + WIN.x1) / 2)
  const lit = new Set<string>(POOL_TONES)
  for (let y = FLOOR_TOP; y < ROOM_H; y++) {
    for (const x of [mx, mx + 1]) {
      const row = g[y]
      // 只落在光斑里（亮于地板底色才算在光斑里），地板缝上不加影
      if (!row || !lit.has(row[x] ?? '')) continue
      px(g, x, y, '6')
    }
  }
}

/** 地毯：椭圆 + 深色镶边（给工作台一侧一块暖色落点）。 */
function drawRug(g: Grid): void {
  const cx = (RUG.x0 + RUG.x1) / 2
  const rx = (RUG.x1 - RUG.x0) / 2
  for (let y = RUG.y0; y <= RUG.y1; y++) {
    const ty = (y - RUG.y0) / (RUG.y1 - RUG.y0)
    const hw = Math.sqrt(Math.max(0, 1 - Math.pow(2 * ty - 1, 2))) * rx
    for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) {
      const dx = Math.abs(x - cx) / Math.max(1, hw)
      const v = dx > 0.86 ? 0 : dx > 0.7 ? 0.4 : 0.78 + 0.22 * (1 - dx)
      px(g, x, y, ramp(v, RUG_TONES, x, y))
    }
  }
}

/** 书架：立柱 + 三层板 + 两层书（书的高度/颜色由确定性哈希决定）。 */
function drawShelf(g: Grid): void {
  for (let y = SHELF.y0; y <= SHELF.y1; y++) {
    px(g, SHELF.x0, y, '8')
    px(g, SHELF.x1, y, '8')
  }
  const boards = [SHELF.y0, SHELF.y0 + 9, SHELF.y1]
  for (const by of boards) {
    for (let x = SHELF.x0; x <= SHELF.x1; x++) px(g, x, by, '9')
    for (let x = SHELF.x0; x <= SHELF.x1; x++) px(g, x, by + 1, '0')
  }
  for (let layer = 0; layer < 2; layer++) {
    const baseY = boards[layer] + 1
    const inner = boards[layer + 1] - 2 - baseY // 该层可用高度（不含板）
    let x = SHELF.x0 + 2
    let i = 0
    while (x < SHELF.x1 - 1) {
      const w = 1 + Math.floor(hash(i, layer + 1) * 2)
      const hh = 4 + Math.floor(hash(i, layer + 7) * Math.max(1, inner - 3))
      const tone = BOOK_TONES[Math.floor(hash(i, layer + 13) * BOOK_TONES.length)]
      for (let yy = baseY + inner - hh; yy <= baseY + inner - 1; yy++) {
        for (let xx = x; xx < Math.min(x + w, SHELF.x1); xx++) px(g, xx, yy, tone)
      }
      x += w + 1
      i++
    }
  }
}

/** 吊灯：吊绳 + 梯形灯罩 + 灯泡（暖光）。灯是房间里的第二个光源。 */
function drawPendant(g: Grid): void {
  for (let y = 0; y < LAMP.yShade; y++) px(g, LAMP.x, y, '0')
  LAMP.shadeRows.forEach((half, i) => {
    const y = LAMP.yShade + i
    for (let x = LAMP.x - half; x <= LAMP.x + half; x++) px(g, x, y, 'b')
    px(g, LAMP.x - half, y, '0')
    px(g, LAMP.x + half, y, '0')
  })
  const bulbY = LAMP.yShade + LAMP.shadeRows.length
  for (let x = LAMP.x - 1; x <= LAMP.x + 1; x++) px(g, x, bulbY, 'd')
  for (let x = LAMP.x - 1; x <= LAMP.x + 1; x++) px(g, x, bulbY + 1, 'e')
}

/** 工作台：桌下阴影 → 桌面（受光上沿 + 前缘暗线）→ 桌腿 → 显示器（屏上几条内容条）→ 键盘 / 杯子。 */
function drawDesk(g: Grid): void {
  for (let y = DESK.y1 + 1; y < DESK.y1 + 12; y++) {
    for (let x = DESK.x0 + 1; x <= DESK.x1 - 1; x++) {
      const row = g[y]
      if (row && row[x] !== '0') row[x] = '4'
    }
  }
  for (let x = DESK.x0; x <= DESK.x1; x++) px(g, x, DESK.y0, 'a')
  rect(g, DESK.x0, DESK.y0 + 1, DESK.x1, DESK.y1 - 1, '9')
  for (let x = DESK.x0; x <= DESK.x1; x++) px(g, x, DESK.y1, '0')
  rect(g, DESK.x0 + 2, DESK.y1 + 1, DESK.x0 + 3, DESK.y1 + 10, '8')
  rect(g, DESK.x1 - 3, DESK.y1 + 1, DESK.x1 - 2, DESK.y1 + 10, '8')

  // 显示器：底座 → 支架 → 屏幕外框 → 屏幕 → 内容条（让它像在显示东西，而不是一块黑板）
  rect(g, MONITOR.x0 + 2, DESK.y0 - 1, MONITOR.x1 - 2, DESK.y0 - 1, '0')
  rect(g, 89, DESK.y0 - 3, 90, DESK.y0 - 2, '0')
  frame(g, MONITOR.x0, MONITOR.y0, MONITOR.x1, MONITOR.y1, '0')
  rect(g, MONITOR.x0 + 2, MONITOR.y0 + 2, MONITOR.x1 - 2, MONITOR.y1 - 2, 'b')
  const bars = [8, 12, 6] as const
  bars.forEach((w, i) => {
    const y = MONITOR.y0 + 2 + i * 2
    for (let x = MONITOR.x0 + 3; x < MONITOR.x0 + 3 + w; x++) px(g, x, y, i === 0 ? 'e' : 'c')
  })

  // 键盘（键帽交错两色）+ 杯子（带把手）
  for (let x = 78; x <= 96; x++) px(g, x, DESK.y0 + 1, x % 2 === 0 ? 'c' : 'e')
  rect(g, 101, DESK.y0 - 4, 104, DESK.y0 - 1, 'c')
  px(g, 105, DESK.y0 - 3, 'c')
  px(g, 105, DESK.y0 - 2, 'c')
}

/** 椅子：椅背（描边，与坐面**留一格缝**才读得出是「靠背」而不是一个箱子）+ 坐面 + 前缘 + 两条腿。 */
function drawChair(g: Grid): void {
  rect(g, CHAIR.x0 + 3, CHAIR.y0, CHAIR.x1 - 3, CHAIR.y0 + 6, '8')
  frame(g, CHAIR.x0 + 3, CHAIR.y0, CHAIR.x1 - 3, CHAIR.y0 + 6, '0')
  rect(g, CHAIR.x0, CHAIR.y0 + 8, CHAIR.x1, CHAIR.y0 + 9, '9')
  for (let x = CHAIR.x0; x <= CHAIR.x1; x++) px(g, x, CHAIR.y0 + 10, '0')
  rect(g, CHAIR.x0 + 1, CHAIR.y0 + 11, CHAIR.x0 + 2, CHAIR.y0 + 12, '8')
  rect(g, CHAIR.x1 - 2, CHAIR.y0 + 11, CHAIR.x1 - 1, CHAIR.y0 + 12, '8')
}

function makeRoomRows(): string[] {
  const g = blank(ROOM_W, ROOM_H)
  drawWall(g)
  drawBaseboard(g)
  drawFloorBase(g)
  drawWindow(g)
  drawFloorSeams(g)
  drawMoonPool(g)
  drawMullionShadow(g)
  drawRug(g)
  drawShelf(g)
  drawPendant(g)
  drawDesk(g)
  drawChair(g)
  return g.map((row) => row.join(''))
}

// ===== 看板娘（28×40 的二次元少女）=====

/**
 * 手臂姿态（六种：垂下 / 托腮 / 身前做事 / 搭凉棚 / 双手交叠 / 双手举起）。
 * **姿态就是行为**——不做自由骨骼：像素画在 28×40 这个尺寸上，两三个折点已经能表达清楚，
 * 而自由骨骼需要一整套绑定与求解，收益远不抵复杂度。
 */
type ArmPose = 'down' | 'chin' | 'forward' | 'brow' | 'fold' | 'raise'

/** 眼睛（四种：睁 / 半闭 / 闭 / 熄灯）；`half` 用来做「眨眼」与「困倦」 */
type EyePose = 'open' | 'half' | 'closed' | 'dark'

/** 嘴（四种：小 / 笑 / 张开 / 抿平） */
type MouthPose = 'small' | 'smile' | 'open' | 'flat'

interface Pose {
  /** 上半身整体下沉像素（呼吸/起伏）：0 或 1。**腿脚不动**——脚是踩在地上的 */
  bob: number
  /** 左臂姿态（右臂默认垂下；托腮/搭凉棚只用左手，读起来更像「一个人的小动作」） */
  armL: ArmPose
  /** 右臂姿态（干活时双臂前伸） */
  armR: ArmPose
  eyes: EyePose
  mouth: MouthPose
  /** 头发飘动偏移（-1 / 0 / 1）——静止的角色只要头发动一点点就活了 */
  sway: number
  /** 头部横向偏移（-1 / 0 / 1）——侧目、歪头；**整个头组一起移**，否则五官会脱位 */
  tilt: number
  /** 熄灯：整身换成剪影色（只剩轮廓，与「已停止」语义相符） */
  dark?: boolean
}

/** 大眼睛（4×5）：上睫毛 / 虹膜 + 高光 / 瞳孔 / 下眼睑——二次元的辨识度几乎全在这里 */
const EYE_OPEN = ['0000', 'a998', '8878', '8778', '0000'] as const
/** 半闭：只留虹膜下半 —— 「眨眼」与「困倦」共用这一张 */
const EYE_HALF = ['0000', '0000', 'a998', '8778', '0000'] as const
const EYE_CLOSED = ['0000', '0000', '1771', '0000', '0000'] as const
const EYE_DARK = ['0000', '0770', '0000', '0000', '0000'] as const

/** 把一段小图（行字符串）贴到 (ox, oy)，`'.'` 不覆盖 */
function stamp(g: Grid, rows: readonly string[], ox: number, oy: number): void {
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x]
      if (ch !== '.') px(g, ox + x, oy + y, ch)
    }
  }
}

/**
 * 画一条 2px 粗的手臂：沿折线走。
 * 为什么用折线而不是矩形块：手臂的角度是「姿态」的主要信息（垂下/抬起/前伸），
 * 折线让它能被两个点描述，改姿态 = 改两个数。
 */
function limb(g: Grid, pts: ReadonlyArray<readonly [number, number]>, ch: string, bob: number): void {
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[i + 1]
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + ((x1 - x0) * s) / steps)
      const y = Math.round(y0 + ((y1 - y0) * s) / steps) + bob
      px(g, x, y, ch)
      px(g, x + 1, y, ch)
    }
  }
}

/**
 * 手臂折线（左手；右手把 x 镜像到 27-x）。
 * `forward` 刻意做成**向内下方**而不是水平——正面视角里水平的双臂会读成「T 字站立」，
 * 往内下走才读成「手在身前做事」。
 * `brow` 的手落在**脸的外侧**（x4）而不是眼睛上——落在眼睛高度会读成「捂眼」，
 * 而且贴着头发时蓝袖子会被深蓝头发吃掉（**袖子用 tone d 而不是 c 也是为这个**）。
 * `fold` 双手交叠在身前（安静/抱着东西）、`raise` 双手举到头两侧上方（惊讶/伸懒腰）——
 * 这两个是**语义上离得最远的两个极端**，一眼可辨。
 */
const ARM_PATHS: Record<ArmPose, ReadonlyArray<readonly [number, number]>> = {
  down: [[8, 24], [7, 27], [8, 30]],
  chin: [[8, 24], [10, 22], [12, 20]],
  forward: [[8, 25], [6, 27], [9, 29]],
  brow: [[8, 24], [6, 20], [4, 17]],
  fold: [[8, 24], [7, 26], [11, 26]],
  raise: [[8, 24], [6, 18], [5, 12]]
}

/**
 * 袖子色（比裙子亮一档）。
 * 为什么不用裙子同色：手臂经常压在深蓝头发上（托腮 / 搭凉棚），同色袖子会**整个消失**，
 * 表现力归零——而这两个姿态正是「行为」的核心信息。
 */
const SLEEVE = 'd'

/** 给所有非透明像素加一圈 1px 暗边（让角色在任何背景上都读得出来）。 */
function addOutline(g: Grid): void {
  const h = g.length
  const w = g[0]?.length ?? 0
  const marks: Array<[number, number]> = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (g[y][x] !== '.') continue
      const near =
        (y > 0 && g[y - 1][x] !== '.') ||
        (y < h - 1 && g[y + 1][x] !== '.') ||
        (x > 0 && g[y][x - 1] !== '.') ||
        (x < w - 1 && g[y][x + 1] !== '.')
      if (near) marks.push([x, y])
    }
  }
  for (const [x, y] of marks) g[y][x] = '0'
}

function avatarRows(p: Pose): string[] {
  const g = blank(AVATAR_W, AVATAR_H)
  const d = p.bob

  // ---- 鞋与腿（不随呼吸动：脚踩在地上）----
  rect(g, 10, 35, 12, 37, 'e')
  rect(g, 15, 35, 17, 37, 'e')
  for (const x of [10, 11, 12, 15, 16, 17]) px(g, x, 35, 'b') // 袜口
  rect(g, 9, 38, 13, 39, 'b')
  rect(g, 14, 38, 18, 39, 'b')
  for (let x = 9; x <= 18; x++) px(g, x, 39, '0')

  // ---- 裙（A 字，越往下越宽）----
  for (let i = 0; i <= 4; i++) {
    const y = 30 + i + d
    const half = 5 + i
    for (let x = Math.round(13.5 - half); x <= Math.round(13.5 + half); x++) px(g, x, y, 'c')
  }
  for (let i = 0; i <= 4; i++) {
    const y = 30 + i + d
    const half = 5 + i
    px(g, Math.round(13.5 - half), y, 'b')
    px(g, Math.round(13.5 + half), y, 'b')
  }
  for (let x = 6; x <= 21; x++) px(g, x, 34 + d, 'e') // 裙摆

  // ---- 躯干：水手服（白领 + 蓝衣 + 月金胸针）----
  rect(g, 9, 22 + d, 18, 29 + d, 'c')
  rect(g, 9, 22 + d, 9, 29 + d, 'd') // 左缘受光
  rect(g, 18, 22 + d, 18, 29 + d, 'b') // 右缘阴影
  rect(g, 10, 22 + d, 17, 23 + d, 'e') // 水手领
  rect(g, 12, 24 + d, 15, 24 + d, 'b')
  px(g, 13, 26 + d, 'f') // 月金胸针（月蚀的记号）
  px(g, 14, 26 + d, 'f')
  px(g, 13, 27 + d, 'f')

  // ---- 头发：先画（在身体之后、手臂之前）——长发从肩后垂下来 ----
  // `tx` 是**整个头组**（头发 + 脸 + 五官 + 呆毛）的横向偏移：侧目/歪头靠它。
  // 只移五官不移头发 = 五官脱位；只移头发不移五官 = 头发脱位。所以头组一起移。
  const tx = p.tilt
  const sway = p.sway
  rect(g, 6 + tx, 2 + d, 21 + tx, 9 + d, '2') // 头顶
  rect(g, 7 + tx, 3 + d, 20 + tx, 5 + d, '3') // 月光高光带
  rect(g, 6 + tx, 9 + d, 7 + tx, 28 + d, '2') // 左侧发
  rect(g, 20 + tx, 9 + d, 21 + tx, 28 + d, '2')
  rect(g, 5 + sway, 10 + d, 6 + sway, 30 + d, '1') // 左侧发（外缘，随呼吸飘 1px）
  rect(g, 21 + sway, 10 + d, 22 + sway, 30 + d, '1')
  // 呆毛
  px(g, 15 + tx, 0 + d, '2')
  px(g, 15 + tx, 1 + d, '2')
  px(g, 16 + tx, 1 + d, '1')
  // 刘海：额前四行（发丝用 tone 1 勾出来，不是一块实心）
  stamp(
    g,
    ['2222222222222222', '2332222222223322', '2212222222221222', '2112222222222112'],
    6 + tx,
    6 + d
  )

  // ---- 脸（在头发之后画，只露出刘海以下的部分）----
  rect(g, 8 + tx, 10 + d, 19 + tx, 20 + d, '4')
  rect(g, 8 + tx, 19 + d, 19 + tx, 20 + d, '5') // 下颌阴影
  rect(g, 10, 21 + d, 17, 21 + d, '5') // 脖子（不跟着头歪，否则脖子会飘出去）

  // ---- 眼与嘴 ----
  const eyeRows =
    p.eyes === 'open' ? EYE_OPEN : p.eyes === 'half' ? EYE_HALF : p.eyes === 'closed' ? EYE_CLOSED : EYE_DARK
  stamp(g, eyeRows, 9 + tx, 13 + d)
  stamp(g, eyeRows, 15 + tx, 13 + d)
  if (p.mouth === 'smile') {
    px(g, 13 + tx, 19 + d, '6')
    px(g, 14 + tx, 19 + d, '6')
    px(g, 12 + tx, 18 + d, '5') // 腮红
    px(g, 15 + tx, 18 + d, '5')
  } else if (p.mouth === 'open') {
    rect(g, 13 + tx, 19 + d, 14 + tx, 20 + d, '6') // 张口（惊讶）
  } else if (p.mouth === 'flat') {
    rect(g, 12 + tx, 19 + d, 14 + tx, 19 + d, '6') // 抿平（认真/无语）
  } else {
    px(g, 13 + tx, 19 + d, '6')
    px(g, 14 + tx, 19 + d, '6')
  }

  // ---- 手臂（画在最上层：它要「伸出去」，被头发挡住就看不出来了）----
  limb(g, ARM_PATHS[p.armL], SLEEVE, d)
  const mirrored = ARM_PATHS[p.armR].map(([x, y]) => [27 - x, y] as const)
  limb(g, mirrored, SLEEVE, d)
  // 手：手臂末端一个 2×2 的皮肤块
  const handL = ARM_PATHS[p.armL][ARM_PATHS[p.armL].length - 1]
  const handR = mirrored[mirrored.length - 1]
  rect(g, handL[0] - 1, handL[1] + d, handL[0], handL[1] + 1 + d, '4')
  rect(g, handR[0], handR[1] + d, handR[0] + 1, handR[1] + 1 + d, '4')

  addOutline(g)
  if (p.dark) {
    for (let y = 0; y < AVATAR_H; y++) {
      for (let x = 0; x < AVATAR_W; x++) if (g[y][x] !== '.') g[y][x] = '0'
    }
  }
  return g.map((row) => row.join(''))
}

/**
 * 看板娘的**姿态预设库**（17 帧 / 11 组姿态）。
 *
 * 命名即预设：`<姿态>.<序号>`。AI 重画时可以整套换掉，也可以只加一组——
 * **`behaviors` 里引用的帧名必须在这里存在**（否则校验层拒，见 `validateAvatarSpec`）。
 *
 * 为什么给这么多帧：用户 2026-10-19「**多给点姿态，预设多一点**」。
 * 姿态多了之后，同一个触发源可以**多帧循环**，动画从「两帧来回」变成「有节奏的小动作」——
 * 例如 `idle` 四帧 = 呼吸 → 呼吸 → 侧目张望 → 眨眼，看上去像「她真的在那儿」。
 *
 * 这份清单同时是**生图清单**：要换成 AI 生成立绘时，按这里的姿态名逐个出图即可
 * （见 `POSE_PRESETS` 的 label/intent）。
 */
const AVATAR_FRAMES: Record<string, string[]> = {
  // 站立呼吸（两帧 = 呼吸起伏 + 发梢飘）
  'idle.0': avatarRows({ bob: 0, armL: 'down', armR: 'down', eyes: 'open', mouth: 'small', sway: 0, tilt: 0 }),
  'idle.1': avatarRows({ bob: 1, armL: 'down', armR: 'down', eyes: 'open', mouth: 'small', sway: 1, tilt: 0 }),
  // 侧目张望（歪头）
  'look.0': avatarRows({ bob: 0, armL: 'down', armR: 'down', eyes: 'open', mouth: 'small', sway: 0, tilt: 1 }),
  // 眨眼 / 困倦（半闭眼）
  'tired.0': avatarRows({ bob: 1, armL: 'down', armR: 'down', eyes: 'half', mouth: 'flat', sway: 0, tilt: 0 }),
  // 托腮思考
  'think.0': avatarRows({ bob: 0, armL: 'chin', armR: 'down', eyes: 'open', mouth: 'small', sway: 0, tilt: 0 }),
  'think.1': avatarRows({ bob: 1, armL: 'chin', armR: 'down', eyes: 'open', mouth: 'smile', sway: 1, tilt: 0 }),
  // 闭眼回忆（手仍在下巴，眼闭）
  'recall.0': avatarRows({ bob: 0, armL: 'chin', armR: 'down', eyes: 'closed', mouth: 'small', sway: 0, tilt: 0 }),
  'recall.1': avatarRows({ bob: 1, armL: 'chin', armR: 'down', eyes: 'closed', mouth: 'flat', sway: 1, tilt: 0 }),
  // 手扶下巴、头偏向一侧看向上方（与「搭凉棚」共用一条手臂时两帧会撞成一样——所以这里用托腮那条）
  'plan.0': avatarRows({ bob: 0, armL: 'chin', armR: 'down', eyes: 'open', mouth: 'small', sway: 0, tilt: -1 }),
  'plan.1': avatarRows({ bob: 1, armL: 'chin', armR: 'down', eyes: 'open', mouth: 'small', sway: 1, tilt: -1 }),
  // 双手在身前做事
  'work.0': avatarRows({ bob: 0, armL: 'forward', armR: 'forward', eyes: 'open', mouth: 'small', sway: 0, tilt: 0 }),
  'work.1': avatarRows({ bob: 1, armL: 'forward', armR: 'forward', eyes: 'open', mouth: 'smile', sway: 1, tilt: 0 }),
  // 双手交叠在身前（安静地等 / 抱着东西）
  'hold.0': avatarRows({ bob: 0, armL: 'fold', armR: 'fold', eyes: 'open', mouth: 'small', sway: 0, tilt: 0 }),
  // 搭凉棚看向窗外（采集 = 它的眼睛）
  'watch.0': avatarRows({ bob: 0, armL: 'brow', armR: 'down', eyes: 'open', mouth: 'small', sway: 0, tilt: 0 }),
  'watch.1': avatarRows({ bob: 1, armL: 'brow', armR: 'down', eyes: 'open', mouth: 'small', sway: 1, tilt: 0 }),
  // 惊讶 / 出错（双手举起、张口）
  'trouble.0': avatarRows({ bob: 0, armL: 'raise', armR: 'raise', eyes: 'open', mouth: 'open', sway: 0, tilt: 0 }),
  // 闭眼待机
  'sleep.0': avatarRows({ bob: 1, armL: 'down', armR: 'down', eyes: 'closed', mouth: 'small', sway: 0, tilt: 0 }),
  // 熄灯（整身剪影）
  'off.0': avatarRows({ bob: 0, armL: 'down', armR: 'down', eyes: 'dark', mouth: 'small', sway: 0, tilt: 0, dark: true })
}

/**
 * 姿态预设目录（帧名 → 人话）。两个用途：
 * 1. **生图清单**——要换成 AI 生成立绘时，按这里的 label 逐个出图；
 * 2. **测试的真源**——`test/avatar-spec.test.ts` 断言「目录里每一帧都真的存在」，
 *    防止加姿态时漏写进 `AVATAR_FRAMES`。
 */
export const POSE_PRESETS: ReadonlyArray<{ frame: string; label: string; intent: string }> = [
  { frame: 'idle.0', label: '站立', intent: '空闲：呼吸的起点' },
  { frame: 'idle.1', label: '站立（呼吸）', intent: '空闲：呼吸的终点 + 发梢飘' },
  { frame: 'look.0', label: '侧目张望', intent: '空闲：偶发的小动作，让她像活着' },
  { frame: 'tired.0', label: '眨眼 / 困倦', intent: '空闲：半闭眼，兼作眨眼' },
  { frame: 'think.0', label: '托腮', intent: '分诊：在想' },
  { frame: 'think.1', label: '托腮（笑）', intent: '分诊：想通了' },
  { frame: 'recall.0', label: '闭眼回忆', intent: '召回：在翻记忆' },
  { frame: 'recall.1', label: '闭眼回忆（抿嘴）', intent: '召回：翻到了' },
  { frame: 'plan.0', label: '手扶下巴望向侧上方', intent: '规划：在盘算' },
  { frame: 'plan.1', label: '手扶下巴望向侧上方（呼吸）', intent: '规划：盘算中' },
  { frame: 'work.0', label: '双手身前做事', intent: '运行 / 执行：在动手' },
  { frame: 'work.1', label: '双手身前做事（笑）', intent: '运行 / 执行：顺手了' },
  { frame: 'hold.0', label: '双手交叠在身前', intent: '安静地等（预留姿态）' },
  { frame: 'watch.0', label: '搭凉棚看窗外', intent: '采集：它的眼睛看向外面' },
  { frame: 'watch.1', label: '搭凉棚看窗外（呼吸）', intent: '采集：还在看' },
  { frame: 'trouble.0', label: '惊讶（双手举起）', intent: '出错：它知道自己出问题了' },
  { frame: 'sleep.0', label: '闭眼待机', intent: '待机：它睡了' },
  { frame: 'off.0', label: '整身剪影', intent: '已停止：熄灯' }
]

/**
 * 默认行为绑定：**把帧挂到房间自己的动作上**（用户：「保存挂在某个动作上，到时候 AI 做什么
 * 那个行为就会展示出来」）。
 *
 * **`stopped` 绑 `idle.0` 而不是 `off.0`**（用户 2026-10-19：「没开启自主前，AI 形象全黑色…
 * 最好不要有全黑色的占位」）：熄灯剪影贴在深色房间里等于**看不见**，用户第一眼看到的就是一团黑。
 * 「已停止」这件事交给**画面环境**表达（夜空全黑、不发光、不呼吸），不需要把她本人涂黑。
 * `off.0` 仍留在预设库里，供 AI 自己绑。
 *
 * 节拍在 0.52.87 整体放慢约 1.5×（用户：「**图变的太快了**」）：像素版相邻帧差异很小，
 * 放慢才像呼吸/动作而不是闪烁；**有立绘时完全不循环**（立绘之间跳变像闪屏，见 `Presence`）。
 */
export const DEFAULT_BEHAVIORS: AvatarBehavior[] = [
  { trigger: 'idle', frames: ['idle.0', 'idle.1', 'look.0', 'tired.0'], frameMs: 900 },
  { trigger: 'running', frames: ['work.0', 'work.1'], frameMs: 420 },
  { trigger: 'standby', frames: ['sleep.0'] },
  { trigger: 'stopped', frames: ['idle.0'] },
  { trigger: 'error', frames: ['trouble.0'] },
  { trigger: 'collect', frames: ['watch.0', 'watch.1'], frameMs: 1100 },
  { trigger: 'triage', frames: ['think.0', 'think.1'], frameMs: 900 },
  { trigger: 'recall', frames: ['recall.0', 'recall.1'], frameMs: 1100 },
  { trigger: 'plan', frames: ['plan.0', 'plan.1'], frameMs: 850 },
  { trigger: 'execute', frames: ['work.0', 'work.1'], frameMs: 360 }
]

/** 默认房间精灵（单帧 `base`）。 */
export function makeDefaultRoomSprite(): PixelSprite {
  return { w: ROOM_W, h: ROOM_H, palette: ROOM_PALETTE, frames: { base: makeRoomRows() } }
}

/** 默认看板娘精灵（十帧：呼吸 / 托腮 / 干活 / 看窗外 / 闭眼 / 熄灯）。 */
export function makeDefaultAvatarSprite(): PixelSprite {
  return { w: AVATAR_W, h: AVATAR_H, palette: AVATAR_PALETTE, frames: AVATAR_FRAMES }
}

/**
 * 默认规格：看板娘站在月光池的**左侧**、面朝工作台，脚下踩在地板上。
 * `avatarPos` 让形象**完整落在房间内**（y 32 + 40 = 72 = 房间高）；
 * x 取 12 而不是居中：池的最亮核心在 x≈34，角色一居中就把核心盖住了。
 */
export const DEFAULT_AVATAR_SPEC: RoomAvatarSpec = {
  version: 1,
  room: makeDefaultRoomSprite(),
  avatar: makeDefaultAvatarSprite(),
  avatarPos: { x: 12, y: 32 },
  behaviors: DEFAULT_BEHAVIORS
}
