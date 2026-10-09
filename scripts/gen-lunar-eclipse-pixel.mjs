/**
 * 生成「月蚀」专属像素艺术 PNG。
 *
 * 主题：暗夜星空中一轮「月蚀」（Lunar Eclipse）——月亮被暗影蚀过一角，
 * 配上 ABYSSAC 记忆主题的星点与底层星野。像素风，硬边缘，无抗锯齿。
 *
 * 输出：app/src/assets/lunar-eclipse.png（96x96，供 UI 缩放显示保持像素感）
 */
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const W = 96
const H = 96

// ----- 调色板 -----
const PALETTE = {
  bgTop: [10, 8, 24],      // 夜空最深处
  bgMid: [16, 14, 40],
  bgBottom: [26, 20, 56],
  starDim: [90, 90, 130],
  starBright: [220, 226, 255],
  moon: [244, 240, 232],   // 月面
  moonShade: [198, 192, 188], // 月面暗影(半个弧)
  moonShadow: [52, 46, 84],   // 月蚀暗影(蚀进月亮)
  halo: [120, 110, 200],   // 月光晕
  horizonFar: [48, 38, 88], // 远山
  horizonNear: [28, 22, 56], // 近山
  accent: [120, 220, 255], // 青色点缀(记忆光点)
  accentGlow: [60, 120, 180],
  copper: [180, 90, 70]    // 月食红铜色
}

function px(img, x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return
  img[y][x] = [c[0], c[1], c[2], 255]
}

// 初始化画布
const img = []
for (let y = 0; y < H; y++) {
  img.push([])
  for (let x = 0; x < W; x++) {
    const t = y / (H - 1)
    let c
    if (t < 0.55) c = lerp(PALETTE.bgTop, PALETTE.bgMid, t / 0.55)
    else c = lerp(PALETTE.bgMid, PALETTE.bgBottom, (t - 0.55) / 0.45)
    img[y].push([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255])
  }
}

function lerp(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// ----- 星点 (确定性伪随机，稳定输出) -----
let seed = 42
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const stars = []
for (let i = 0; i < 90; i++) {
  stars.push({
    x: Math.floor(rnd() * W),
    y: Math.floor(rnd() * (H * 0.62)),
    s: rnd() > 0.85 ? 2 : 1,
    bright: rnd()
  })
}
for (const st of stars) {
  const c = st.bright > 0.7 ? PALETTE.starBright : PALETTE.starDim
  px(img, st.x, st.y, c)
  if (st.s === 2) {
    px(img, st.x + 1, st.y, c)
    px(img, st.x, st.y + 1, c)
    px(img, st.x + 1, st.y + 1, c)
  }
}

// ----- 月亮 (中心偏右上，月蚀) -----
const mcx = 56
const mcy = 34
const mr = 18
// 月光晕（比月亮略大，扩散到夜空中）
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - mcx
    const dy = y - mcy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d >= mr && d < mr + 5) {
      const a = Math.max(0, (5 - (d - mr)) / 5)
      const base = img[y][x]
      img[y][x] = [
        Math.round(base[0] + (PALETTE.halo[0] - base[0]) * a * 0.55),
        Math.round(base[1] + (PALETTE.halo[1] - base[1]) * a * 0.55),
        Math.round(base[2] + (PALETTE.halo[2] - base[2]) * a * 0.55),
        255
      ]
    }
  }
}
// 蚀影（月食缺角）几何：模块级常量，供月面绘制与铜红描边共用
const ECX = mcx + 12
const ECY = mcy + 13
const ER = 10.5
// 月面 + 蚀：一轮亮月，右下角被一颗「蚀影」暗影咬掉一个缺角（月偏食意象）
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - mcx
    const dy = y - mcy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d <= mr) {
      // 月面渐变：左上亮、右下略暗（经典月亮光照）
      const shade = lerp(PALETTE.moon, PALETTE.moonShade, Math.max(0, (dx + dy) / (2 * mr)))
      const ex = x - ECX
      const ey = y - ECY
      const ed = Math.sqrt(ex * ex + ey * ey)
      if (ed < ER) {
        // 蚀影：深邃暗紫，与月面形成强对比 —— 一眼可辨的「月蚀」
        img[y][x] = [PALETTE.moonShadow[0], PALETTE.moonShadow[1], PALETTE.moonShadow[2], 255]
      } else {
        img[y][x] = [Math.round(shade[0]), Math.round(shade[1]), Math.round(shade[2]), 255]
      }
    }
  }
}
// 蚀影边缘在缺口处描一圈淡红晕（月食红铜色过渡）
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = x - mcx
    const dy = y - mcy
    const d = Math.sqrt(dx * dx + dy * dy)
    if (d <= mr + 1.5) {
      const ex = x - ECX
      const ey = y - ECY
      const ed = Math.sqrt(ex * ex + ey * ey)
      if (ed > ER - 1.2 && ed < ER + 1.2) {
        // 铜红色细边
        const c = lerp(PALETTE.copper, img[y][x], 0.5)
        img[y][x] = [Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255]
      }
    }
  }
}

// ----- 底层星野 / 记忆光点 (分散在月下) -----
const glows = [
  { x: 20, y: 62 }, { x: 76, y: 58 }, { x: 40, y: 74 }, { x: 62, y: 78 }, { x: 28, y: 84 }
]
for (const g of glows) {
  px(img, g.x, g.y, PALETTE.accentGlow)
  px(img, g.x + 1, g.y, PALETTE.accentGlow)
  px(img, g.x, g.y + 1, PALETTE.accentGlow)
  px(img, g.x + 1, g.y + 1, PALETTE.accent)
  px(img, g.x + 2, g.y + 1, PALETTE.accent)
  px(img, g.x + 1, g.y + 2, PALETTE.accent)
  px(img, g.x + 2, g.y + 2, PALETTE.accent)
}

// ----- 地平线 (两层山影) -----
// 远山
for (let x = 0; x < W; x++) {
  const h = Math.floor(72 + Math.sin(x * 0.35) * 4 + Math.sin(x * 0.13) * 3)
  for (let y = h; y < H; y++) {
    px(img, x, y, PALETTE.horizonFar)
  }
}
// 近山
for (let x = 0; x < W; x++) {
  const h = Math.floor(80 + Math.sin(x * 0.5 + 2) * 3)
  for (let y = h; y < H; y++) {
    px(img, x, y, PALETTE.horizonNear)
  }
}

// ----- 月蚀标记：月亮下方一点小双星(ABYSSAC 记忆双链意象) -----
px(img, mcx - 4, mcy + 26, PALETTE.accent)
px(img, mcx - 3, mcy + 26, PALETTE.accent)
px(img, mcx + 4, mcy + 26, PALETTE.starBright)
px(img, mcx + 5, mcy + 26, PALETTE.starBright)

// ----- 编码成 PNG -----
function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

// raw scanlines: 每行前置 filter byte 0
const raw = Buffer.alloc(H * (1 + W * 4))
for (let y = 0; y < H; y++) {
  const rowStart = y * (1 + W * 4)
  raw[rowStart] = 0
  for (let x = 0; x < W; x++) {
    const p = img[y][x]
    const o = rowStart + 1 + x * 4
    raw[o] = p[0]
    raw[o + 1] = p[1]
    raw[o + 2] = p[2]
    raw[o + 3] = p[3]
  }
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // color type RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0
const idat = deflateSync(raw)
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets', 'lunar-eclipse.png')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, png)
console.log('written', outPath, png.length, 'bytes')
