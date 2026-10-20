/**
 * @category ROOM
 * @summary 立绘后处理（纯函数）：**去背 → 裁切 → 缩放到统一画布 + 底部居中**
 *
 * 为什么存在：用户裁决「我自己在外面出图，丢进目录，**应用负责去背/裁切/命名**」。
 * AI 生图端点大多出的是**不透明背景**，直接贴进房间会是一块矩形；而「每个姿态各裁各的」
 * 会让角色在不同帧之间**大小跳变**（抬手的姿势比站立高，按内容缩放就会忽大忽小）。
 *
 * 三个步骤各自解决一件事：
 * 1. **去背**：已经带 alpha 的图原样保留；不透明的图从**四边泛洪**抠掉背景，再给边缘做一像素羽化
 *    （否则边缘是一圈硬锯齿，贴在房间的柔光里很扎眼）；
 * 2. **裁切**：裁到内容包围盒——去掉大片空白，后面缩放才有意义；
 * 3. **统一画布**：所有帧缩放到**同一个画布**（宽高比 = 像素形象框的宽高比）、**底边居中**对齐。
 *    这样「脚踩在地板上」与像素版完全一致；代价是抬手那几帧整体略小（~5-10%），
 *    这是「统一取景」必然的取舍，比忽大忽小好得多。
 *
 * 不删理由：删掉即「自己出图」这条路只能在用户那边手工 PS，应用帮不上忙。
 */
import type { RgbaImage } from './png'

/** 一张图里的背景色（RGB） */
export type Rgb = readonly [number, number, number]

export interface RemoveBgResult {
  image: RgbaImage
  /** 原本就带 alpha（原样返回，不做抠色） */
  alreadyTransparent: boolean
  /** 被置为透明的像素数（UI 可据此提示「这张可能不是纯色背景」） */
  removed: number
  /** 判定的背景色 */
  bg: Rgb
}

/** 已经带透明通道的判定：≥2% 的像素明显不透明以下 → 认为「作者已经去过背」 */
export function hasTransparency(img: RgbaImage, alphaBelow = 250): boolean {
  const need = Math.max(64, Math.floor(img.w * img.h * 0.02))
  let n = 0
  for (let i = 3; i < img.data.length; i += 4) {
    if (img.data[i] < alphaBelow) {
      n++
      if (n >= need) return true
    }
  }
  return false
}

/**
 * 估背景色：取**图像最外一圈**像素里出现最多的颜色（按 8 级量化分桶，桶内取均值）。
 * 为什么要量化：AI 出的「纯色背景」在编码后往往有轻微噪声，逐像素比对会得到几千个「不同色」。
 */
export function estimateBackground(img: RgbaImage): Rgb {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  const push = (x: number, y: number): void => {
    const o = (y * img.w + x) * 4
    const r = img.data[o]
    const g = img.data[o + 1]
    const b = img.data[o + 2]
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
    const cur = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    cur.n++
    cur.r += r
    cur.g += g
    cur.b += b
    buckets.set(key, cur)
  }
  for (let x = 0; x < img.w; x++) {
    push(x, 0)
    push(x, img.h - 1)
  }
  for (let y = 0; y < img.h; y++) {
    push(0, y)
    push(img.w - 1, y)
  }
  let best = { n: -1, r: 0, g: 0, b: 0 }
  for (const v of buckets.values()) if (v.n > best.n) best = v
  if (best.n <= 0) return [255, 255, 255]
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]
}

/** 单通道差的最大值（对纯色背景比欧氏距离更可预测） */
function channelDiff(data: Uint8Array, o: number, bg: Rgb): number {
  return Math.max(Math.abs(data[o] - bg[0]), Math.abs(data[o + 1] - bg[1]), Math.abs(data[o + 2] - bg[2]))
}

/**
 * 去背：从四边泛洪，把「与背景色接近且与边界连通」的像素置为透明。
 *
 * **只移除与边界连通的**（泛洪而不是按颜色全图删）——这条很重要：
 * 角色身上如果恰好有和背景同色的高光/衣服，全图删会在人身上开洞；泛洪只吃外圈。
 */
export function removeBackground(img: RgbaImage, opts: { tolerance?: number } = {}): RemoveBgResult {
  const tol = opts.tolerance ?? 36
  if (hasTransparency(img)) {
    return { image: img, alreadyTransparent: true, removed: 0, bg: estimateBackground(img) }
  }
  const bg = estimateBackground(img)
  const { w, h, data } = img
  const out = new Uint8Array(data) // 复制：不改调用方的数据
  const visited = new Uint8Array(w * h)
  const stack: number[] = []

  const tryPush = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const p = y * w + x
    if (visited[p]) return
    if (channelDiff(data, p * 4, bg) > tol) return
    visited[p] = 1
    stack.push(p)
  }

  for (let x = 0; x < w; x++) {
    tryPush(x, 0)
    tryPush(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    tryPush(0, y)
    tryPush(w - 1, y)
  }
  while (stack.length > 0) {
    const p = stack.pop()!
    const x = p % w
    const y = (p - x) / w
    tryPush(x - 1, y)
    tryPush(x + 1, y)
    tryPush(x, y - 1)
    tryPush(x, y + 1)
  }

  let removed = 0
  for (let p = 0; p < visited.length; p++) {
    if (visited[p]) {
      out[p * 4 + 3] = 0
      removed++
    }
  }

  // 边缘羽化：紧邻透明区的**不透明**像素给半透明，去掉硬锯齿。
  // 只做一像素宽，且只调 alpha——不改颜色（改颜色会在轮廓上留一圈背景色的脏边）。
  const feathered: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (out[p * 4 + 3] === 0) continue
      const nearTransparent =
        (x > 0 && out[(p - 1) * 4 + 3] === 0) ||
        (x < w - 1 && out[(p + 1) * 4 + 3] === 0) ||
        (y > 0 && out[(p - w) * 4 + 3] === 0) ||
        (y < h - 1 && out[(p + w) * 4 + 3] === 0)
      if (nearTransparent) feathered.push(p)
    }
  }
  for (const p of feathered) out[p * 4 + 3] = 120

  return { image: { w, h, data: out }, alreadyTransparent: false, removed, bg }
}

/**
 * 丢掉零散的孤立块：**只保留面积 ≥ 最大块 50% 的连通块**。
 *
 * 为什么需要：SD 系模型在 `simple background` 下仍然很爱加**装饰**（墨迹圈、心形、三角、星）。
 * 这些块与角色**不连通**，泛洪去背留得住它们——贴进房间就是几块漂浮的色块。
 * 用提示词反复压是「和模型赌」，成本高且不稳；**按连通性丢弃**是确定性的。
 *
 * 阈值取 50%（实测值）：装饰圈能到角色面积的 10~20%，10% 的阈值会把它留下；
 * 而角色本身几乎总是一整块（头发—身体—腿—鞋相连），50% 足够安全。
 * 代价：真正**断开**的碎块（比如飘出去的一缕头发）会被一并丢掉——比留一圈墨迹好。
 */
export function dropStrayComponents(
  img: RgbaImage,
  opts: { keepRatio?: number; alphaAbove?: number } = {}
): { image: RgbaImage; dropped: number } {
  const keepRatio = opts.keepRatio ?? 0.5
  const alphaAbove = opts.alphaAbove ?? 8
  const { w, h, data } = img
  const label = new Int32Array(w * h).fill(-1)
  const areas: number[] = []
  const stack: number[] = []
  for (let p0 = 0; p0 < w * h; p0++) {
    if (label[p0] !== -1 || data[p0 * 4 + 3] <= alphaAbove) continue
    const id = areas.length
    let area = 0
    label[p0] = id
    stack.push(p0)
    while (stack.length > 0) {
      const p = stack.pop()!
      area++
      const x = p % w
      const y = (p - x) / w
      const visit = (q: number): void => {
        if (label[q] !== -1 || data[q * 4 + 3] <= alphaAbove) return
        label[q] = id
        stack.push(q)
      }
      if (x > 0) visit(p - 1)
      if (x < w - 1) visit(p + 1)
      if (y > 0) visit(p - w)
      if (y < h - 1) visit(p + w)
    }
    areas.push(area)
  }
  if (areas.length <= 1) return { image: img, dropped: 0 }
  const max = Math.max(...areas)
  const keep = new Set<number>()
  areas.forEach((a, i) => {
    if (a >= max * keepRatio) keep.add(i)
  })
  if (keep.size === areas.length) return { image: img, dropped: 0 }
  const out = new Uint8Array(data)
  let dropped = 0
  for (let p = 0; p < w * h; p++) {
    const id = label[p]
    if (id >= 0 && !keep.has(id)) {
      out[p * 4 + 3] = 0
      dropped++
    }
  }
  return { image: { w, h, data: out }, dropped }
}

/** 内容包围盒（alpha 高于阈值的像素范围）。整张全透明返回 null。 */
export function contentBounds(img: RgbaImage, alphaAbove = 8): { x0: number; y0: number; x1: number; y1: number } | null {
  const { w, h, data } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] <= alphaAbove) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/**
 * 双线性采样（**预乘 alpha** 后再插值，否则边缘会出现一圈黑边——这是 alpha 图像的经典坑）。
 */
function sampleBilinear(img: RgbaImage, fx: number, fy: number): [number, number, number, number] {
  const { w, h, data } = img
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx)))
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy)))
  const x1 = Math.min(w - 1, x0 + 1)
  const y1 = Math.min(h - 1, y0 + 1)
  const tx = Math.max(0, Math.min(1, fx - x0))
  const ty = Math.max(0, Math.min(1, fy - y0))
  const px = (x: number, y: number): [number, number, number, number] => {
    const o = (y * w + x) * 4
    const a = data[o + 3] / 255
    return [data[o] * a, data[o + 1] * a, data[o + 2] * a, a]
  }
  const c00 = px(x0, y0)
  const c10 = px(x1, y0)
  const c01 = px(x0, y1)
  const c11 = px(x1, y1)
  const mix = (i: number): number =>
    c00[i] * (1 - tx) * (1 - ty) + c10[i] * tx * (1 - ty) + c01[i] * (1 - tx) * ty + c11[i] * tx * ty
  const a = mix(3)
  if (a <= 0.001) return [0, 0, 0, 0]
  return [mix(0) / a, mix(1) / a, mix(2) / a, a]
}

/**
 * 把内容按「等比缩放到目标框内 + **底部居中**」合成到固定尺寸的透明画布上。
 * `paddingRatio` 是四周留白比例（默认 2%），防止内容贴边被裁。
 */
export function composeToBox(
  img: RgbaImage,
  box: { w: number; h: number },
  paddingRatio = 0.02
): { image: RgbaImage; empty: boolean } {
  const empty = { image: { w: box.w, h: box.h, data: new Uint8Array(box.w * box.h * 4) }, empty: true }
  const b = contentBounds(img)
  if (!b) return empty
  const cw = b.x1 - b.x0 + 1
  const ch = b.y1 - b.y0 + 1
  const padX = Math.round(box.w * paddingRatio)
  const padY = Math.round(box.h * paddingRatio)
  const availW = Math.max(1, box.w - padX * 2)
  const availH = Math.max(1, box.h - padY * 2)
  const scale = Math.min(availW / cw, availH / ch)
  const dw = Math.max(1, Math.round(cw * scale))
  const dh = Math.max(1, Math.round(ch * scale))
  const dx = Math.round((box.w - dw) / 2)
  const dy = box.h - padY - dh // 底边居中对齐
  const out = new Uint8Array(box.w * box.h * 4)
  for (let y = 0; y < dh; y++) {
    const sy = b.y0 + (y + 0.5) / scale - 0.5
    for (let x = 0; x < dw; x++) {
      const sx = b.x0 + (x + 0.5) / scale - 0.5
      const [r, g, bl, a] = sampleBilinear(img, sx, sy)
      const o = ((dy + y) * box.w + (dx + x)) * 4
      out[o] = Math.round(r)
      out[o + 1] = Math.round(g)
      out[o + 2] = Math.round(bl)
      out[o + 3] = Math.round(a * 255)
    }
  }
  return { image: { w: box.w, h: box.h, data: out }, empty: false }
}

/** 一步到位：去背 → **丢零散块** → 裁切 → 统一画布（后处理管线；测试与批处理共用） */
export function processImage(
  img: RgbaImage,
  box: { w: number; h: number }
): { image: RgbaImage; alreadyTransparent: boolean; removed: number; dropped: number; empty: boolean } {
  const bg = removeBackground(img)
  const cleaned = dropStrayComponents(bg.image)
  const composed = composeToBox(cleaned.image, box)
  return {
    image: composed.image,
    alreadyTransparent: bg.alreadyTransparent,
    removed: bg.removed,
    dropped: cleaned.dropped,
    empty: composed.empty
  }
}
