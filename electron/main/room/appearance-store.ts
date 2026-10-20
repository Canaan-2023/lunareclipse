/**
 * @category ROOM
 * @summary 外观配置的落盘与背景图片读取（`<data>/room/appearance.json` + `room/background/background.png`）
 *
 * 为什么不用 `config.json`：外观是**房间自己的产物**（与 avatar.json / sensor-policy / room-events 同域），
 * 且写入频率低、体积小；放进主配置会让「配置迁移 / 补丁保护键」多背一份无关数据。
 *
 * 背景图片只认固定文件名 + PNG 魔数 + 尺寸/体积上限：用户放图即可，但**不让路径进入配置**。
 *
 * 0.53.6：背景 / 分区场景不再返回 base64 data URL，而是 `room-asset://room/...` 只读 URL。
 * 主进程只做「存在性 + 头部校验」，图片由 Chromium 直接经协议读取并缓存——`appearance-get`
 * 因此是常数级耗时，房间不会为了等几张 4K 图而先画错人物。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  DEFAULT_ROOM_APPEARANCE,
  ROOM_BACKGROUND_FILES,
  ROOM_BACKGROUND_LIMITS,
  ROOM_SCENE_ZONES,
  parseRoomAppearance,
  type RoomAppearance
} from '@shared/room/appearance'
import type { RoomZoneId } from '@shared/room/room-scene'
import { isPng, readPngSize } from '@shared/room/mascot'

/** 只读协议的两个根：当前 AI 的目录与全局回落目录（与 `room/asset-protocol.ts` 对齐） */
export interface RoomAssetUrls {
  ai: string
  global: string
}

/** 头部校验只需要前 256KB：4K PNG 的 IHDR 在开头，JPEG 的 SOF 通常也在这一段 */
const HEAD_BYTES = 256 * 1024

function readHead(path: string, size: number): Uint8Array {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    return n === buf.length ? buf : buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** JPEG 魔数：FF D8 FF */
function isJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

/**
 * 从 JPEG 的 SOF 段读宽高（不依赖图片库）。读不出来返回 null。
 * 支持 baseline / progressive 等常见 SOF；跳过 APP/EXIF 等段。
 */
function readJpegSize(buf: Uint8Array): { w: number; h: number } | null {
  if (!isJpeg(buf)) return null
  let i = 2
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buf[i + 1]
    // 无长度字段的标记
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      i += 2
      continue
    }
    if (i + 4 > buf.length) return null
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if (len < 2 || i + 2 + len > buf.length) return null
    // SOF0/1/2/3/5/6/7/9/10/11/13/14/15（排除 DHT/DAC 等）
    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof) {
      if (i + 9 > buf.length) return null
      const h = (buf[i + 5] << 8) | buf[i + 6]
      const w = (buf[i + 7] << 8) | buf[i + 8]
      return w > 0 && h > 0 ? { w, h } : null
    }
    i += 2 + len
  }
  return null
}

export class AppearanceStore {
  /**
   * `dir` = 当前 AI 的房间目录（`<data>/room/AI{aiId}`）；
   * `fallbackDir` = 全局 `<data>/room`（兼容 0.53.4 之前的单份配置/背景）。
   * 读取：当前 AI 优先，缺失回落全局；写入：只写当前 AI。
   */
  constructor(
    private readonly dir: string,
    private readonly fallbackDir?: string,
    private readonly urls?: RoomAssetUrls
  ) {}

  get file(): string {
    return join(this.dir, 'appearance.json')
  }

  get backgroundDir(): string {
    return join(this.dir, 'background')
  }

  get scenesDir(): string {
    return join(this.dir, 'scenes')
  }

  load(): { appearance: RoomAppearance; error?: string } {
    const own = this.file
    const fallback = this.fallbackDir ? join(this.fallbackDir, 'appearance.json') : null
    const p = existsSync(own) ? own : fallback && existsSync(fallback) ? fallback : null
    if (!p) return { appearance: DEFAULT_ROOM_APPEARANCE }
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as unknown
      const parsed = parseRoomAppearance(raw)
      return parsed.ok
        ? { appearance: parsed.appearance }
        : { appearance: DEFAULT_ROOM_APPEARANCE, error: `外观配置无效：${parsed.error}` }
    } catch (err) {
      return { appearance: DEFAULT_ROOM_APPEARANCE, error: `外观配置读取失败：${(err as Error).message}` }
    }
  }

  save(raw: unknown): { ok: true; appearance: RoomAppearance } | { ok: false; error: string } {
    const parsed = parseRoomAppearance(raw)
    if (!parsed.ok) return parsed
    try {
      mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(parsed.appearance, null, 2)}\n`, 'utf-8')
      try {
        renameSync(tmp, this.file)
      } catch {
        // Windows 上目标被占用时 rename 可能失败：退回直接写（低频、小文件）
        writeFileSync(this.file, `${JSON.stringify(parsed.appearance, null, 2)}\n`, 'utf-8')
      }
      return { ok: true, appearance: parsed.appearance }
    } catch (err) {
      return { ok: false, error: `外观配置保存失败：${(err as Error).message}` }
    }
  }

  /**
   * 读主背景图：当前 AI 优先，没有则回落全局。
   * **目录不存在 = 没有背景**（合法状态：用代码房间），不是错误。
   * 放了但不是 PNG/JPEG / 太大 / 尺寸超限 → 返回原因（不静默），渲染侧回落代码房间。
   */
  loadBackground(): { url: string | null; dir: string; error?: string } {
    const dir = this.backgroundDir
    const own = this.readImage(dir, ROOM_BACKGROUND_FILES, 'ai', 'background')
    if (own.url || own.error) return { ...own, dir }
    if (this.fallbackDir) {
      const fb = this.readImage(join(this.fallbackDir, 'background'), ROOM_BACKGROUND_FILES, 'global', 'background')
      return { ...fb, dir }
    }
    return { url: null, dir }
  }

  /**
   * 读分区场景（`scenes/{zone}.png|jpg|jpeg`）：当前 AI 优先，缺失回落全局。
   * 只返回**通过校验**的图；坏图的原因集中返回（不静默跳过）。
   */
  loadScenes(): {
    scenes: Partial<Record<RoomZoneId, string>>
    dir: string
    errors: string[]
  } {
    const dir = this.scenesDir
    const scenes: Partial<Record<RoomZoneId, string>> = {}
    const errors: string[] = []
    for (const zone of ROOM_SCENE_ZONES) {
      const files = [`${zone}.png`, `${zone}.jpg`, `${zone}.jpeg`] as const
      let r = this.readImage(dir, files, 'ai', 'scenes')
      if (!r.url && !r.error && this.fallbackDir) {
        r = this.readImage(join(this.fallbackDir, 'scenes'), files, 'global', 'scenes')
      }
      if (r.url) scenes[zone] = r.url
      else if (r.error) errors.push(`${zone}：${r.error}`)
    }
    return { scenes, dir, errors }
  }

  /**
   * 读一张背景：按文件名顺序找第一个存在的（PNG → JPG）。
   * 找到但非法 → 返回原因（不继续试下一个，避免掩盖坏文件）。
   * 合法 → 返回带 `?v=<mtime>` 的只读 URL（文件被替换时 URL 变化，浏览器缓存自然失效）。
   */
  private readImage(
    dir: string,
    files: readonly string[],
    scope: 'ai' | 'global',
    kind: 'background' | 'scenes'
  ): { url: string | null; error?: string } {
    let file: string | null = null
    for (const candidate of files) {
      if (existsSync(join(dir, candidate))) {
        file = candidate
        break
      }
    }
    if (!file) return { url: null }
    const path = join(dir, file)
    try {
      const st = statSync(path)
      if (!st.isFile()) return { url: null, error: `${file} 不是文件` }
      if (st.size > ROOM_BACKGROUND_LIMITS.maxBytes) {
        return {
          url: null,
          error: `${file} 超过 ${Math.round(ROOM_BACKGROUND_LIMITS.maxBytes / 1024 / 1024)}MB`
        }
      }
      const head = readHead(path, st.size)
      const mime = isPng(head) ? 'image/png' : isJpeg(head) ? 'image/jpeg' : null
      if (!mime) return { url: null, error: `${file} 不是 PNG/JPEG（改扩展名不行）` }
      const size = mime === 'image/png' ? readPngSize(head) : readJpegSize(head)
      if (!size) return { url: null, error: '图片头部损坏，读不出宽高' }
      if (size.w > ROOM_BACKGROUND_LIMITS.maxDim || size.h > ROOM_BACKGROUND_LIMITS.maxDim) {
        return {
          url: null,
          error: `尺寸 ${size.w}×${size.h} 超过单边 ${ROOM_BACKGROUND_LIMITS.maxDim}`
        }
      }
      const base = scope === 'global' ? this.urls?.global : this.urls?.ai
      if (!base) return { url: null, error: '本地资源地址未配置' }
      return { url: `${base}/${kind}/${file}?v=${Math.floor(st.mtimeMs)}` }
    } catch (err) {
      return { url: null, error: `读取失败：${(err as Error).message}` }
    }
  }
}
