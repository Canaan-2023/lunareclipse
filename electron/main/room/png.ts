/**
 * @category ROOM
 * @summary 极简 PNG 编解码（8 位、非隔行，color type 0/2/3/4/6）——**零依赖**
 *
 * 为什么存在：图片看板娘的后处理（去背 / 裁切 / 对齐 / 缩放）要在主进程里**读像素**，
 * 而本仓没有任何图像库（`sharp` / `pngjs` / `jimp` 都不在依赖里，也不打算为这件事加一个）。
 * PNG 的关键部分只有「zlib 解压 + 5 种行过滤 + 几个块」——用 Node 自带的 `zlib` 就能实现，
 * 300 行以内，而且**完全可测**（编码 → 解码往返逐字节相等）。
 *
 * 支持范围（**超出即明确拒绝，不猜**）：
 * - 位深 **8 位**（16 位 PNG 常见于 AI 出图的高色深导出，拒绝并给出原因）；
 * - **非隔行**（Adam7 不实现）；
 * - color type 0（灰度）/ 2（RGB）/ 3（调色板 + tRNS）/ 4（灰度+alpha）/ 6（RGBA）。
 *
 * 不做的事：Gamma / ICC / 交错。这些对「把立绘贴进房间」没有意义，
 * 而实现它们的成本远高于收益——**明确不支持比半吊子支持更诚实**。
 *
 * 不删理由：删掉即后处理要么引第三方图像库（违反零依赖/零资产的既有口径），
 * 要么只能处理「本来就已经透明」的图。
 */
import { deflateSync, inflateSync } from 'zlib'

/** 解码后的位图：RGBA，每通道 0~255，行优先、无 padding。 */
export interface RgbaImage {
  w: number
  h: number
  data: Uint8Array
}

export type DecodeResult = { ok: true; image: RgbaImage } | { ok: false; error: string }

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

/** 从 PNG 头部快速读宽高（不校验块结构；用于「尺寸超限就先跳过」这种廉价判断） */
export function pngSize(buf: Uint8Array): { w: number; h: number } | null {
  if (buf.length < 24) return null
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return null
  return { w: be32(buf, 16), h: be32(buf, 20) }
}

/** 遍历 PNG 块。回调返回 false 可提前停止。 */
function eachChunk(buf: Uint8Array, fn: (type: string, data: Uint8Array) => void): void {
  let o = 8
  while (o + 12 <= buf.length) {
    const len = be32(buf, o)
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7])
    const start = o + 8
    const end = start + len
    if (end + 4 > buf.length) return
    fn(type, buf.subarray(start, end))
    if (type === 'IEND') return
    o = end + 4
  }
}

/** Paeth 预测（PNG 规范里的同名过滤器） */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * 解码 PNG → RGBA。
 * 失败一律返回 `{ok:false, error}`（**带人话原因**），绝不返回半张图。
 */
export function decodePng(buf: Uint8Array): DecodeResult {
  if (buf.length < 8) return { ok: false, error: '不是 PNG（太短）' }
  for (let i = 0; i < 8; i++) if (buf[i] !== PNG_SIG[i]) return { ok: false, error: '不是 PNG（魔数不符）' }

  let w = 0
  let h = 0
  let bitDepth = 0
  let colorType = -1
  let interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []

  eachChunk(buf, (type, data) => {
    if (type === 'IHDR') {
      w = be32(data, 0)
      h = be32(data, 4)
      bitDepth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
  })

  if (w <= 0 || h <= 0) return { ok: false, error: 'PNG 头部损坏（宽高为 0）' }
  if (bitDepth !== 8) return { ok: false, error: `只支持 8 位 PNG（这张是 ${bitDepth} 位）` }
  if (interlace !== 0) return { ok: false, error: '不支持隔行（Adam7）PNG，请重新导出为普通 PNG' }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0
  if (channels === 0) return { ok: false, error: `不支持的 PNG 颜色类型 ${colorType}` }
  if (colorType === 3 && !palette) return { ok: false, error: '调色板 PNG 缺少 PLTE 块' }
  if (idat.length === 0) return { ok: false, error: 'PNG 没有任何图像数据（IDAT 缺失）' }

  let raw: Uint8Array
  try {
    const merged = Buffer.concat(idat.map((d) => Buffer.from(d)))
    raw = new Uint8Array(inflateSync(merged))
  } catch (err) {
    return { ok: false, error: `PNG 数据解压失败：${(err as Error).message}` }
  }

  const bpp = channels
  const stride = w * bpp
  if (raw.length < (stride + 1) * h) return { ok: false, error: 'PNG 数据不完整（行数不足）' }

  // TS 的控制流看不见「在 eachChunk 回调里被赋值」，会把 palette/trns 窄化成 null；
  // 这里的断言只是把声明类型拿回来，不是「不信校验」——上面已经确认过调色板存在。
  const paletteTable = palette as Uint8Array | null
  const alphaTable = trns as Uint8Array | null

  const out = new Uint8Array(w * h * 4)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const rowStart = y * (stride + 1) + 1
    const cur = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + i]
      const a = i >= bpp ? cur[i - bpp] : 0
      const b = prev[i]
      const c = i >= bpp ? prev[i - bpp] : 0
      let v: number
      switch (filter) {
        case 0:
          v = x
          break
        case 1:
          v = x + a
          break
        case 2:
          v = x + b
          break
        case 3:
          v = x + ((a + b) >> 1)
          break
        case 4:
          v = x + paeth(a, b, c)
          break
        default:
          return { ok: false, error: `PNG 行过滤类型非法（${filter}）` }
      }
      cur[i] = v & 0xff
    }
    // 展开到 RGBA
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (colorType === 0) {
        const g = cur[x]
        out[o] = out[o + 1] = out[o + 2] = g
        out[o + 3] = 255
      } else if (colorType === 4) {
        const g = cur[x * 2]
        out[o] = out[o + 1] = out[o + 2] = g
        out[o + 3] = cur[x * 2 + 1]
      } else if (colorType === 2) {
        out[o] = cur[x * 3]
        out[o + 1] = cur[x * 3 + 1]
        out[o + 2] = cur[x * 3 + 2]
        out[o + 3] = 255
      } else if (colorType === 6) {
        out[o] = cur[x * 4]
        out[o + 1] = cur[x * 4 + 1]
        out[o + 2] = cur[x * 4 + 2]
        out[o + 3] = cur[x * 4 + 3]
      } else {
        const idx = cur[x]
        out[o] = paletteTable?.[idx * 3] ?? 0
        out[o + 1] = paletteTable?.[idx * 3 + 1] ?? 0
        out[o + 2] = paletteTable?.[idx * 3 + 2] ?? 0
        out[o + 3] = alphaTable && idx < alphaTable.length ? alphaTable[idx] : 255
      }
    }
    prev = cur
  }
  return { ok: true, image: { w, h, data: out } }
}

// ===== 编码（color type 6 / 8 位 / 行过滤 0）=====

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  Buffer.from(data).copy(out, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  out.writeUInt32BE(crc32(crcInput), 8 + data.length)
  return out
}

/** 编码 RGBA → PNG（固定 8 位 RGBA、行过滤 0；对「立绘落盘」足够，且体积可接受） */
export function encodePng(img: RgbaImage): Buffer {
  const { w, h, data } = img
  const stride = w * 4
  const raw = Buffer.alloc((stride + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0 // filter: None
    Buffer.from(data.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0))
  ])
}
