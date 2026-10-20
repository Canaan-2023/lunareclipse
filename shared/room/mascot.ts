/**
 * @category ROOM
 * @summary 图片看板娘（mascot）的契约与校验：**一帧一张 PNG**，放在 `<data>/room/mascot/`
 *
 * 为什么存在：用户 2026-10-19 裁决「我觉得你像素来画其实也挺麻烦的，**不如 AI 生成**或者
 * 网络上找找资源，符合月蚀风格的」→ 内置像素画（`@shared/room/avatar-spec`）是**零资产兜底**，
 * 但「好看」这条路径要能接**真图**。本文件是那条路径的**数据格式与校验**（纯函数，双端共用）。
 *
 * 形态选择（重要，勿改成「让用户写路径」或「任意代码」）：
 * - **一帧一张 PNG，文件名即帧名**（`idle.0.png` → 帧 `idle.0`）——最省事、容错最好：
 *   少一张就少一个姿态，不会因为「图集格子算错」而整块错位；
 * - **不打包任何图片**：目录由用户/AI 自己放（AI 生图 → 去背 → 丢进去），
 *   于是**不引入第三方美术的授权问题**，也不改打包边界（仓内不需要记 Third-Party Notices）；
 * - **可机械校验**：文件名 / 扩展名 / 大小 / PNG 魔数 / 尺寸全部可判定，越界即跳过并**报出原因**。
 *
 * 与像素规格的关系：**按帧覆盖**。渲染侧先解析出「这一 tick 该画哪一帧」（`resolveAvatarFrameName`），
 * 该帧有图就贴图、没有就画像素版——**两种来源可以在同一套行为绑定下混用**（部分出图也能跑，
 * 只是那几帧仍是像素风）。
 *
 * 不删理由：删掉即「换成 AI 生成的立绘」这条路径没有数据格式，只能回去手画像素。
 */

/** 图片看板娘的边界（防 DoS，也是给用户的硬边界）。 */
export const MASCOT_LIMITS = {
  /** 最多多少张（帧名是闭集衍生的，正常十几个；留余量给 AI 重画时的自定义帧名） */
  maxFrames: 32,
  /** 单张上限（AI 生成立绘通常 1~3MB；超过多半是没压缩的大图） */
  maxFileBytes: 4 * 1024 * 1024,
  /** 全部合计上限（一次读进内存并转 base64 送渲染进程，必须有界） */
  maxTotalBytes: 32 * 1024 * 1024,
  /** 单边像素上限（再大对「贴进一个小窗格」没有意义，只是白占内存） */
  maxDim: 2048
} as const

/** 一帧一张图：帧名 → `data:image/png;base64,…`。 */
export interface MascotSheet {
  version: 1
  frames: Record<string, string>
}

/** 空表（没有放任何图 = 用内置像素画）。 */
export const EMPTY_MASCOT_SHEET: MascotSheet = { version: 1, frames: {} }

/** 被跳过的文件及原因（**必须报出来**：静默跳过等于「我放了图但它不生效」而没有任何线索） */
export interface MascotSkip {
  file: string
  reason: string
}

/**
 * 文件名 → 帧名。`idle.0.png` → `idle.0`；不合格返回 `null`（调用方跳过并报原因）。
 *
 * 为什么只认 `.png`：去背后的立绘几乎都是 PNG（需要 alpha）；GIF/WebP/JPEG 各自带来
 * 「动画怎么算」「alpha 怎么办」的新语义，而现在**动画由行为系统负责**，一张图就是一帧。
 */
export function mascotFrameKey(fileName: string): string | null {
  // 先挡路径分隔符：本函数是导出的纯函数，不假设调用方一定只传 `readdirSync` 的名字
  // （`../evil.png` 若只取末段会被当成合法帧名——那是「看起来能用」的路径穿越）。
  if (/[\\/]/.test(fileName)) return null
  if (!fileName.toLowerCase().endsWith('.png')) return null
  const key = fileName.slice(0, -4)
  // 帧名限定为「字母数字 + . _ -」，且不得以点开头：**同时挡掉路径穿越与隐藏文件**
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) return null
  return key
}

/** PNG 魔数：`89 50 4E 47 0D 0A 1A 0A`（认魔数而不是只看扩展名——扩展名是用户随手改的） */
export function isPng(buf: Uint8Array): boolean {
  if (buf.length < 8) return false
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return sig.every((b, i) => buf[i] === b)
}

/**
 * 从 PNG 头部读出宽高（不依赖任何图片库）。
 * PNG 布局：8 字节魔数 + 4 字节块长 + 4 字节 `IHDR` + 4 字节宽 + 4 字节高（均大端）。
 * 读不出来返回 `null`（调用方跳过）。
 */
export function readPngSize(buf: Uint8Array): { w: number; h: number } | null {
  if (!isPng(buf) || buf.length < 24) return null
  const type = String.fromCharCode(buf[12], buf[13], buf[14], buf[15])
  if (type !== 'IHDR') return null
  const be32 = (o: number): number => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0
  const w = be32(16)
  const h = be32(20)
  if (w <= 0 || h <= 0) return null
  return { w, h }
}

/** data URL 前缀（渲染侧据此判定「这张是不是我们认的图」） */
const DATA_URL_PREFIX = 'data:image/png;base64,'

/**
 * 校验一份图片表（纯函数，**渲染侧对 IPC 回来的东西也要过一遍**）。
 * 只接受 `data:image/png;base64,` 开头的字符串——渲染侧永远不 eval、不加载外部 URL。
 */
export function validateMascotSheet(raw: unknown): { ok: true; sheet: MascotSheet } | { ok: false; error: string } {
  const r = (raw ?? {}) as { version?: unknown; frames?: unknown }
  if (r.version !== 1) return { ok: false, error: '版本必须是 1' }
  if (!r.frames || typeof r.frames !== 'object' || Array.isArray(r.frames)) {
    return { ok: false, error: 'frames 必须是对象' }
  }
  const entries = Object.entries(r.frames as Record<string, unknown>)
  if (entries.length > MASCOT_LIMITS.maxFrames) {
    return { ok: false, error: `最多 ${MASCOT_LIMITS.maxFrames} 帧` }
  }
  const frames: Record<string, string> = {}
  for (const [name, url] of entries) {
    if (typeof url !== 'string' || !url.startsWith(DATA_URL_PREFIX)) {
      return { ok: false, error: `帧「${name}」不是 PNG data URL` }
    }
    frames[name] = url
  }
  return { ok: true, sheet: { version: 1, frames } }
}

/** 该帧名是否有图（渲染侧的分支点：有图贴图、没图画像素版） */
export function mascotImageFor(sheet: MascotSheet | null | undefined, frameName: string | null): string | null {
  if (!sheet || !frameName) return null
  return sheet.frames[frameName] ?? null
}
