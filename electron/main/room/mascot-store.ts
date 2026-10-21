/**
 * @category ROOM
 * @summary 图片看板娘的读取：`<data>/room/mascot/<帧名>.png` → 帧名 → data URL
 *
 * 为什么存在：AI/用户把立绘丢进目录就该生效——但**目录里可能有任何东西**（半张图、改名错了的
 * 扩展名、几 MB 的未压缩大图、`.psd`），所以读取必须**逐张校验 + 逐张报原因**：
 * 一个坏文件不该让整张表失效，但也**不能静默**（静默 = 「我放了图它不生效」且毫无线索）。
 *
 * 为什么返回 data URL 而不是路径：渲染进程开着 `webSecurity`，`file://` 读不了；
 * 自定义协议要多一条协议注册与生命周期管理，而这里总共就十几张、一次读一次送，
 * base64 的代价可以接受（`MASCOT_LIMITS` 有总量上限兜底）。
 *
 * 不删理由：删掉即「AI 生成的立绘」只能靠手改代码贴进去，用户与 AI 都没有入口。
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import {
  MASCOT_LIMITS,
  isPng,
  mascotFrameKey,
  readPngSize,
  type MascotSheet,
  type MascotSkip
} from '@shared/room/mascot'

export interface MascotLoadResult {
  sheet: MascotSheet
  skipped: MascotSkip[]
}

export class MascotStore {
  /**
   * `dir` = 当前 AI 的立绘目录（`<data>/room/AI{aiId}/mascot`）；
   * `fallbackDir` = 全局 `<data>/room/mascot`（兼容 0.53.4 之前已放好的图）。
   *
   * **整套切换，不混帧**：当前 AI 目录里只要有 `.png`（哪怕全是不合格的），就以它为准并报原因；
   * 只有该目录不存在 / 没有 `.png` 时才用全局。为什么不逐帧补齐——两个角色的 idle.0 / idle.1
   * 混在一起会得到「半张脸是 A、半张脸是 B」的鬼图，而且肉眼很难发现。
   */
  constructor(
    private readonly dir: string,
    private readonly fallbackDir?: string
  ) {}

  /**
   * 读取并逐张校验。**目录不存在 = 空表**（合法状态：用内置像素画），不是错误。
   * 任何单张的失败都进 `skipped`（含原因），不影响其余。
   */
  load(): MascotLoadResult {
    const primary = this.collect(this.dir)
    if (primary.pngSeen) {
      return { sheet: { version: 1, frames: primary.frames }, skipped: primary.skipped }
    }
    if (this.fallbackDir) {
      const fb = this.collect(this.fallbackDir)
      return { sheet: { version: 1, frames: fb.frames }, skipped: fb.skipped }
    }
    return { sheet: { version: 1, frames: {} }, skipped: [] }
  }

  private collect(dir: string): {
    frames: Record<string, string>
    skipped: MascotSkip[]
    pngSeen: boolean
  } {
    const frames: Record<string, string> = {}
    const skipped: MascotSkip[] = []
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return { frames, skipped, pngSeen: false } // 目录不存在 / 不可读 → 跳过这一层
    }
    const pngSeen = entries.some((f) => f.toLowerCase().endsWith('.png'))
    let total = 0
    let count = 0
    for (const file of entries.sort()) {
      const key = mascotFrameKey(file)
      if (!key) {
        // 目录里允许有别的东西（README、源文件、非 png），**不报**——只有「像图但不是图」才报
        if (file.toLowerCase().endsWith('.png')) {
          skipped.push({ file, reason: '文件名不能作为帧名（只允许字母数字与 . _ -，且不以点开头）' })
        }
        continue
      }
      if (count >= MASCOT_LIMITS.maxFrames) {
        skipped.push({ file, reason: `超过 ${MASCOT_LIMITS.maxFrames} 张，本张及之后的都被忽略` })
        continue
      }
      const path = join(dir, file)
      let buf: Buffer
      try {
        const st = statSync(path)
        if (!st.isFile()) continue
        if (st.size > MASCOT_LIMITS.maxFileBytes) {
          skipped.push({ file, reason: `单张超过 ${Math.round(MASCOT_LIMITS.maxFileBytes / 1024 / 1024)}MB` })
          continue
        }
        if (total + st.size > MASCOT_LIMITS.maxTotalBytes) {
          skipped.push({ file, reason: '全部图片合计超过上限' })
          continue
        }
        buf = readFileSync(path)
      } catch (err) {
        skipped.push({ file, reason: `读取失败：${(err as Error).message}` })
        continue
      }
      if (!isPng(buf)) {
        skipped.push({ file, reason: '不是 PNG（改扩展名不行，要真 PNG）' })
        continue
      }
      const size = readPngSize(buf)
      if (!size) {
        skipped.push({ file, reason: 'PNG 头部损坏，读不出宽高' })
        continue
      }
      if (size.w > MASCOT_LIMITS.maxDim || size.h > MASCOT_LIMITS.maxDim) {
        skipped.push({ file, reason: `尺寸 ${size.w}×${size.h} 超过单边 ${MASCOT_LIMITS.maxDim}` })
        continue
      }
      frames[key] = `data:image/png;base64,${buf.toString('base64')}`
      total += buf.length
      count += 1
    }
    return { frames, skipped, pngSeen }
  }
}
