/**
 * @category ROOM
 * @summary 立绘批量后处理：`<data>/room/mascot/raw/*.png` → 去背/裁切/统一画布 → `<data>/room/mascot/<帧名>.png`
 *
 * 为什么存在：用户裁决「**我自己在外面出图**，丢进目录，**应用负责去背/裁切/命名**」。
 * AI 生图端点出的多半是不透明背景 + 各姿态取景不一致；直接丢进 `mascot/` 会是一块矩形、
 * 且不同帧之间大小跳变。本模块把「原始图 → 可用立绘」这一步收进应用里。
 *
 * 两个目录，职责清楚：
 * - `mascot/raw/`：**你放原始图的地方**（文件名仍是帧名：`idle.0.png`）；
 * - `mascot/`：**应用写成品的地方**（已经是透明背景 + 统一画布），渲染侧只读这一层。
 * 两层分开的好处：原始图不会被渲染侧当成成品误用，重跑处理也不会覆盖你的原图。
 *
 * 逐张处理、逐张报原因：一张坏图不该让整批停住，也不该**静默**（静默 = 「我处理了但它没生效」）。
 *
 * 不删理由：删掉即「自己出图」这条路只能在用户那边手工 PS。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { MASCOT_LIMITS, mascotFrameKey, type MascotSkip } from '@shared/room/mascot'
import { renameFileWithRetry } from '../utils/atomic-write'
import { decodePng, encodePng } from './png'
import { processImage } from './mascot-image'

/**
 * 成品的统一画布高度（像素）。
 * 宽按「像素形象框的宽高比」算（默认 28:40 → 560×800），于是**所有帧同一个画布**——
 * 这是「不同姿态之间角色大小不跳变」的前提。
 */
export const MASCOT_CANVAS_HEIGHT = 800

export interface MascotProcessed {
  file: string
  frame: string
  w: number
  h: number
  /** 原图本来就带 alpha（没做抠色） */
  alreadyTransparent: boolean
  /** 抠掉的像素数（0 = 原图已透明） */
  removed: number
  /** 丢掉的零散块像素数（模型爱加装饰色块，按连通性丢弃） */
  dropped: number
}

export interface MascotProcessResult {
  processed: MascotProcessed[]
  skipped: MascotSkip[]
}

export class MascotProcessor {
  constructor(private readonly dir: string) {}

  /** 原始图目录：`<mascot>/raw` */
  rawDir(): string {
    return join(this.dir, 'raw')
  }

  /** 按像素形象框的宽高比算出成品画布 */
  static boxFor(avatarW: number, avatarH: number): { w: number; h: number } {
    const ratio = avatarH > 0 ? avatarW / avatarH : 0.7
    const w = Math.max(64, Math.min(2048, Math.round(MASCOT_CANVAS_HEIGHT * ratio)))
    return { w, h: MASCOT_CANVAS_HEIGHT }
  }

  /** 处理 `raw/` 下的全部 PNG。目录不存在 = 什么都没做（合法状态，不报错）。 */
  process(box: { w: number; h: number }): MascotProcessResult {
    const processed: MascotProcessed[] = []
    const skipped: MascotSkip[] = []
    let files: string[]
    try {
      files = readdirSync(this.rawDir())
    } catch {
      return { processed, skipped }
    }
    mkdirSync(this.dir, { recursive: true })
    for (const file of files.sort()) {
      const frame = mascotFrameKey(file)
      if (!frame) {
        if (file.toLowerCase().endsWith('.png')) skipped.push({ file, reason: '文件名不能作为帧名（只允许字母数字与 . _ -）' })
        continue
      }
      const src = join(this.rawDir(), file)
      try {
        if (!statSync(src).isFile()) continue
        const buf = readFileSync(src)
        if (buf.length > MASCOT_LIMITS.maxFileBytes) {
          skipped.push({ file, reason: `单张超过 ${Math.round(MASCOT_LIMITS.maxFileBytes / 1024 / 1024)}MB` })
          continue
        }
        const decoded = decodePng(buf)
        if (!decoded.ok) {
          skipped.push({ file, reason: decoded.error })
          continue
        }
        const r = processImage(decoded.image, box)
        if (r.empty) {
          skipped.push({ file, reason: '去背后没有任何内容（背景色是不是和角色同色？）' })
          continue
        }
        // 原子写：与其余记录型文件同口径（先写临时文件再 rename）
        const dst = join(this.dir, `${frame}.png`)
        const tmp = `${dst}.tmp`
        writeFileSync(tmp, encodePng(r.image))
        renameFileWithRetry(tmp, dst)
        processed.push({
          file,
          frame,
          w: r.image.w,
          h: r.image.h,
          alreadyTransparent: r.alreadyTransparent,
          removed: r.removed,
          dropped: r.dropped
        })
      } catch (err) {
        skipped.push({ file, reason: `处理失败：${(err as Error).message}` })
      }
    }
    return { processed, skipped }
  }

  /** 是否已有原始图（UI 用来决定按钮要不要可点） */
  hasRaw(): boolean {
    try {
      return existsSync(this.rawDir()) && readdirSync(this.rawDir()).some((f) => f.toLowerCase().endsWith('.png'))
    } catch {
      return false
    }
  }
}
