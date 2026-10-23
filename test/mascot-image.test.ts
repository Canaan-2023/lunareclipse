/**
 * 立绘后处理回归（ADR-35）：PNG 编解码 → 去背 → 裁切 → 统一画布 → 批量落盘。
 *
 * 为什么测：这条链路**全程静默**——抠色抠坏了、裁切裁歪了、画布尺寸错了、文件没写进去，
 * 界面上都只是「图不太对」，没有任何报错。而其中三件事最容易错、也最难看：
 * 1. **PNG 编解码**（自己写的，没有库兜底）→ 必须往返逐字节相等；
 * 2. **去背不能吃人**（角色身上恰好有和背景同色的部分）→ 泛洪「只吃与边界连通的」这条必须被锁住；
 * 3. **统一画布要底边居中**（不同姿态之间角色大小不跳变、脚踩在同一水平线上）。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decodePng, encodePng, pngSize, type RgbaImage } from '../electron/main/room/png'
import {
  composeToBox,
  contentBounds,
  dropStrayComponents,
  estimateBackground,
  hasTransparency,
  processImage,
  removeBackground
} from '../electron/main/room/mascot-image'
import { MASCOT_CANVAS_HEIGHT, MascotProcessor } from '../electron/main/room/mascot-process'

/** 造一张纯色 + 中央方块的不透明图（模拟「AI 出的立绘」） */
function solidWithSquare(w: number, h: number, bg: [number, number, number], fg: [number, number, number], pad = 10): RgbaImage {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const inSquare = x >= pad && x < w - pad && y >= pad && y < h - pad
      const c = inSquare ? fg : bg
      data[o] = c[0]
      data[o + 1] = c[1]
      data[o + 2] = c[2]
      data[o + 3] = 255
    }
  }
  return { w, h, data }
}

const at = (img: RgbaImage, x: number, y: number): number => img.data[(y * img.w + x) * 4 + 3]

describe('PNG 编解码（自己写的，没有库兜底 → 往返必须逐字节相等）', () => {
  it('encode → decode 往返：尺寸与每个像素都一致', () => {
    const img = solidWithSquare(37, 23, [10, 20, 30], [200, 100, 50], 4)
    img.data[(5 * 37 + 6) * 4 + 3] = 77 // 一个半透明像素
    const png = encodePng(img)
    expect(pngSize(png)).toEqual({ w: 37, h: 23 })
    const back = decodePng(png)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.image.w).toBe(37)
    expect(back.image.h).toBe(23)
    expect([...back.image.data]).toEqual([...img.data])
  })

  it('不是 PNG / 太短 → 明确拒绝（带人话原因）', () => {
    expect(decodePng(new Uint8Array(0)).ok).toBe(false)
    const notPng = Buffer.from('hello world hello world', 'utf8')
    const r = decodePng(notPng)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('PNG')
  })

  it('16 位 / 隔行 → 明确拒绝（不猜、不半吊子支持）', () => {
    const png = encodePng(solidWithSquare(4, 4, [0, 0, 0], [255, 255, 255], 1))
    const deep = Buffer.from(png)
    deep[24] = 16 // IHDR.bitDepth
    const r1 = decodePng(deep)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error).toContain('8 位')

    const interlaced = Buffer.from(png)
    interlaced[28] = 1 // IHDR.interlace
    const r2 = decodePng(interlaced)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error).toContain('隔行')
  })
})

describe('去背：只吃「与边界连通」的背景色（否则会在人身上开洞）', () => {
  it('已经带 alpha 的图原样保留，不做二次抠色', () => {
    const img = solidWithSquare(20, 20, [0, 0, 0], [255, 255, 255], 2)
    // 把中间一块挖成透明（≥2%）
    for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) img.data[(y * 20 + x) * 4 + 3] = 0
    expect(hasTransparency(img)).toBe(true)
    const r = removeBackground(img)
    expect(r.alreadyTransparent).toBe(true)
    expect(r.removed).toBe(0)
  })

  it('外圈背景被吃掉，中央内容保留；紧邻透明区的边缘被羽化', () => {
    const img = solidWithSquare(100, 100, [250, 250, 250], [40, 60, 200], 20)
    expect(hasTransparency(img)).toBe(false)
    const bg = estimateBackground(img)
    expect(bg[0]).toBeGreaterThan(240) // 估到的是白色背景
    const r = removeBackground(img)
    expect(r.alreadyTransparent).toBe(false)
    expect(at(r.image, 0, 0)).toBe(0) // 角上（背景）透明
    expect(at(r.image, 50, 50)).toBe(255) // 中央（内容）保留
    expect(r.removed).toBeGreaterThan(0)
    // 羽化：内容边界上有一圈半透明
    const edge = at(r.image, 20, 50)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(255)
  })

  it('**与内容同色但被围住的背景不被删**（泛洪只吃连通的部分）', () => {
    // 白色背景 + 蓝色方环：方环内部的白色与外界不连通，必须保留
    const w = 60
    const h = 60
    const data = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4
        const ring = x >= 10 && x < 50 && y >= 10 && y < 50 && !(x >= 20 && x < 40 && y >= 20 && y < 40)
        const c: [number, number, number] = ring ? [40, 60, 200] : [250, 250, 250]
        data[o] = c[0]
        data[o + 1] = c[1]
        data[o + 2] = c[2]
        data[o + 3] = 255
      }
    }
    const r = removeBackground({ w, h, data })
    expect(at(r.image, 0, 0)).toBe(0) // 外圈白 → 透明
    expect(at(r.image, 30, 30)).toBe(255) // 方环内部的白 → **保留**
    expect(at(r.image, 15, 30)).toBe(255) // 方环本身 → 保留
  })
})

describe('丢零散块：只保留主体（模型爱加装饰色块）', () => {
  /** 造一张只有两块不透明区域的图 */
  function twoBlocks(w: number, h: number, blocks: Array<{ x0: number; y0: number; s: number }>): RgbaImage {
    const data = new Uint8Array(w * h * 4)
    for (const b of blocks) {
      for (let y = b.y0; y < b.y0 + b.s; y++) {
        for (let x = b.x0; x < b.x0 + b.s; x++) {
          const o = (y * w + x) * 4
          data[o] = 200
          data[o + 1] = 100
          data[o + 2] = 50
          data[o + 3] = 255
        }
      }
    }
    return { w, h, data }
  }

  it('孤立的小块被丢弃，主体完整保留', () => {
    // 主体 60×60（3600px）+ 装饰 15×15（225px ≈ 6%）
    const img = twoBlocks(100, 100, [
      { x0: 20, y0: 20, s: 60 },
      { x0: 2, y0: 2, s: 15 }
    ])
    const r = dropStrayComponents(img)
    expect(r.dropped).toBe(225)
    expect(at(r.image, 50, 50)).toBe(255) // 主体
    expect(at(r.image, 8, 8)).toBe(0) // 装饰
  })

  it('两块都够大（≥ 主体的 50%）→ 都保留（真正断开的肢体不该被误删）', () => {
    const img = twoBlocks(100, 100, [
      { x0: 2, y0: 20, s: 55 },
      { x0: 60, y0: 20, s: 40 } // 1600 / 3025 ≈ 53% ≥ 50%
    ])
    const r = dropStrayComponents(img)
    expect(r.dropped).toBe(0)
    expect(at(r.image, 30, 50)).toBe(255)
    expect(at(r.image, 78, 50)).toBe(255)
  })

  it('只有一个连通块 → 原样返回（dropped=0）', () => {
    const img = twoBlocks(40, 40, [{ x0: 5, y0: 5, s: 30 }])
    expect(dropStrayComponents(img).dropped).toBe(0)
  })
})

describe('裁切与统一画布', () => {
  it('contentBounds 给出内容包围盒；全透明 → null', () => {
    const img = solidWithSquare(40, 40, [0, 0, 0], [255, 255, 255], 5)
    const r = removeBackground(img)
    expect(contentBounds(r.image)).toEqual({ x0: 5, y0: 5, x1: 34, y1: 34 })
    const empty: RgbaImage = { w: 4, h: 4, data: new Uint8Array(64) }
    expect(contentBounds(empty)).toBeNull()
  })

  it('缩放到统一画布：**底边居中**（不同姿态之间角色不跳、脚在同一水平线）', () => {
    const img = solidWithSquare(100, 100, [250, 250, 250], [40, 60, 200], 20)
    const box = { w: 560, h: 800 }
    const r = processImage(img, box)
    expect(r.empty).toBe(false)
    expect([r.image.w, r.image.h]).toEqual([560, 800])
    const b = contentBounds(r.image)!
    // 内容在水平方向居中（左右余量相差不超过 1px）
    expect(Math.abs(b.x0 - (box.w - 1 - b.x1))).toBeLessThanOrEqual(1)
    // 底边留白 = paddingRatio（2% of 800 = 16）
    expect(box.h - 1 - b.y1).toBe(16)
    // 空白区透明
    expect(at(r.image, 0, 0)).toBe(0)
  })

  it('空图（全透明）→ empty=true，画布仍是目标尺寸（不返回半张图）', () => {
    const empty: RgbaImage = { w: 8, h: 8, data: new Uint8Array(8 * 8 * 4) }
    const r = composeToBox(empty, { w: 50, h: 60 })
    expect(r.empty).toBe(true)
    expect([r.image.w, r.image.h]).toEqual([50, 60])
  })

  it('画布比例来自像素形象框（28:40 → 560×800）', () => {
    expect(MascotProcessor.boxFor(28, 40)).toEqual({ w: 560, h: MASCOT_CANVAS_HEIGHT })
  })
})

describe('MascotProcessor：raw/ → 成品，逐张报原因', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  /** 在临时目录里建 `<mascot>/raw/` 并写入原始图；返回处理器与成品目录 */
  const setup = (raw: Record<string, Buffer | string>): { proc: MascotProcessor; mascot: string } => {
    const base = mkdtempSync(join(tmpdir(), 'le-mproc-'))
    dir = base
    const mascot = join(base, 'mascot')
    mkdirSync(join(mascot, 'raw'), { recursive: true })
    for (const [name, buf] of Object.entries(raw)) writeFileSync(join(mascot, 'raw', name), buf)
    return { proc: new MascotProcessor(mascot), mascot }
  }

  it('好图写出成品（透明背景 + 统一画布），坏图进 skipped 带原因，非 png 不报', () => {
    const img = solidWithSquare(120, 160, [250, 250, 250], [40, 60, 200], 20)
    const { proc, mascot } = setup({
      'idle.0.png': encodePng(img),
      'work.0.png': Buffer.from('这不是 PNG', 'utf8'),
      'note.txt': 'readme'
    })
    const r = proc.process({ w: 560, h: 800 })
    expect(r.processed.map((p) => p.frame)).toEqual(['idle.0'])
    expect(r.processed[0].w).toBe(560)
    expect(r.processed[0].h).toBe(800)
    expect(r.processed[0].alreadyTransparent).toBe(false)
    expect(r.processed[0].removed).toBeGreaterThan(0)

    // 成品真的落盘且可解码
    const out = decodePng(readFileSync(join(mascot, 'idle.0.png')))
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(at(out.image, 0, 0)).toBe(0)
      expect(at(out.image, 280, 700)).toBe(255)
    }

    const reasons = Object.fromEntries(r.skipped.map((s) => [s.file, s.reason]))
    expect(reasons['work.0.png']).toContain('PNG')
    expect(reasons['note.txt']).toBeUndefined()
  })

  it('raw 目录不存在 → 什么都没做，不抛', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'le-mproc-empty-'))
    dir = tmp
    const r = new MascotProcessor(join(tmp, 'mascot')).process({ w: 100, h: 100 })
    expect(r).toEqual({ processed: [], skipped: [] })
  })

  it('文件名不能作帧名时报原因（改了名没生效必须有线索）', () => {
    const img = solidWithSquare(20, 20, [255, 255, 255], [0, 0, 0], 4)
    const { proc } = setup({ 'idle 0.png': encodePng(img) })
    const r = proc.process({ w: 100, h: 100 })
    expect(r.skipped.map((s) => s.file)).toContain('idle 0.png')
    expect(r.skipped[0].reason).toContain('帧名')
  })
})
