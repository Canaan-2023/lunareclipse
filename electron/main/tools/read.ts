/**
 * 读取文件工具：为什么存在——AI 读写闭环的入口：按路径读取文本/二进制/图片文件，
 * 并处理行尾、BOM、超大文件截断等边界。
 * 作用：read 返回文本/二进制采样/图片引用，支持 offset + limit 分段读取与格式嗅探。
 */
import { readFileSync, statSync, readdirSync } from 'fs'
import { resolve, extname, basename, dirname, join } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { normalizeLineEndings, stripBom } from './edit-engine/fuzzy-match'
import { extractDocumentBytes, isExtractableDocument, ExtractionError } from '../api/document-extract'

export interface ReadParams {
  file_path: string
  offset?: number
  limit?: number
}

/** 单文件读取大小上限（10MB），防止读取超大文件导致内存溢出 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** 单行长度上限（超长单行如 400MB minified 文件截断，防打爆上下文） */
const MAX_LINE_CHARS = 5000

/** 二进制探测采样字节数 */
const BINARY_SAMPLE_BYTES = 2048

/** 二进制判定阈值：采样区控制字符占比超过 5% 即视为二进制 */
const BINARY_CONTROL_RATIO = 0.05

/** 图片头部探测边界：JPEG 标记扫描上限 / SVG 探测长度与头部采样字节数 */
const JPEG_SCAN_BYTES = 4096
const SVG_MAX_PROBE_BYTES = 8192
const SVG_PROBE_PREFIX_CHARS = 200
const SVG_HEAD_BYTES = 2048

/**
 * 相似文件建议：各维度匹配分数（取前 MAX_SIMILAR_SUGGESTIONS 条），
 * 同扩展分支额外要求字符重叠 ≥ SIMILAR_OVERLAP_RATIO
 */
const SIMILAR_SCORES = { exact: 100, sameBase: 90, prefixSuffix: 70, contains: 60, overlap: 30 } as const
const SIMILAR_OVERLAP_RATIO = 0.4
const MAX_SIMILAR_SUGGESTIONS = 5

/** 图片扩展名（图片自动重定向，不吐乱码） */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'])

/**
 * 从文件头解析图片尺寸（零依赖）。
 * 为什么存在：Read 读取图片时纯文本通道无法注入像素字节，但头部尺寸信息是
 * 文本可承载的（宽/高/格式），让 AI 在无法看图时仍能回答"这是什么图、多大"。
 * 支持 png/jpeg/gif/webp/bmp/ico/svg 的常见头部解析；解析失败返回 null，
 * 让调用方降级为"格式+大小"而不断言失败。
 */
function readImageMeta(buf: Buffer, filePath: string): { width: number | null; height: number | null; format: string | null } {
  const ext = extname(filePath).toLowerCase()
  try {
    // PNG：签名 8 字节 + IHDR 块，宽高分别位于偏移 16/20（大端）
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' }
    }
    // GIF：签名 6 字节，宽高分别位于偏移 6/8（小端）
    if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' }
    }
    // BMP：'BM' + 文件大小，宽高分别位于偏移 18/22（小端，高可能为负表示自顶向下）
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), format: 'bmp' }
    }
    // ICO：2 字节保留 + 类型 + 数量，第 1 个图像的宽高位于偏移 6/7（0 表示 256）
    if (buf.length >= 8 && buf.readUInt16LE(0) === 0) {
      const w = buf[6] === 0 ? 256 : buf[6]
      const h = buf[7] === 0 ? 256 : buf[7]
      if (buf[2] === 1 || buf[2] === 2) return { width: w, height: h, format: 'ico' }
    }
    // WebP：'RIFF' + 大小 + 'WEBP'，VP8/VP8L/VP8X 三种块
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' }
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const b = buf[21]
        const w = 1 + (((b & 0x3f) << 8) | buf[22])
        const h = 1 + ((((b >> 6) & 0x3) << 8) | buf[23])
        return { width: w, height: h, format: 'webp' }
      }
      if (chunk === 'VP8X' && buf.length >= 30) {
        const w = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16)
        const h = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16)
        return { width: w, height: h, format: 'webp' }
      }
    }
    // JPEG：FFD8 起始，扫描 SOF0-SOF15 标记（FFC0-FFCF 但排除 C4/C8/CC），高宽位于标记后 5/7
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length && i < JPEG_SCAN_BYTES) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        // SOF0/1/2/3（C0-C3）、SOF5-7（C5-C7）、SOF9-11（C9-CB）、SOF13-15（CD-CF）
        const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
        if (isSof && i + 9 <= buf.length) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' }
        }
        // 跳过段长度（长度字段位于标记后 2 字节，含长度字段本身）
        if (buf[i + 3] !== undefined) {
          const segLen = buf.readUInt16BE(i + 2)
          if (segLen < 2) break
          i += 2 + segLen
        } else {
          break
        }
      }
    }
    // SVG：文本解析 width/height 属性或 viewBox
    if (buf.length < SVG_MAX_PROBE_BYTES && buf.toString('utf-8', 0, SVG_PROBE_PREFIX_CHARS).includes('<svg')) {
      const head = buf.toString('utf-8').slice(0, SVG_HEAD_BYTES)
      const viewBox = head.match(/viewBox=["']([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)\s+([-+]?\d*\.?\d+)["']/)
      const widthAttr = head.match(/width=["']([-+]?\d*\.?\d+)(?:px)?["']/)
      const heightAttr = head.match(/height=["']([-+]?\d*\.?\d+)(?:px)?["']/)
      const w = widthAttr ? Math.round(parseFloat(widthAttr[1])) : viewBox ? Math.round(parseFloat(viewBox[3])) : null
      const h = heightAttr ? Math.round(parseFloat(heightAttr[1])) : viewBox ? Math.round(parseFloat(viewBox[4])) : null
      return { width: w, height: h, format: 'svg' }
    }
  } catch {
    // 头部解析失败：降级为格式+大小（由调用方补充文件大小）
  }
  return { width: null, height: null, format: ext.slice(1) || null }
}

/** 二进制探测：采样区含 NUL 或高比例控制字符即判定二进制*/
function isLikelyBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, BINARY_SAMPLE_BYTES)
  if (sample.includes(0)) return true // NUL 字节 = 二进制
  let control = 0
  const len = Math.min(sample.length, BINARY_SAMPLE_BYTES)
  for (let i = 0; i < len; i++) {
    const b = sample[i]
    // 允许 \t \n \r（文本合法控制符），其余 <0x20 或 0x7f 视为二进制特征
    if ((b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f) control++
  }
  return control > len * BINARY_CONTROL_RATIO // >5% 控制字符 = 二进制
}

/**
 * 相似文件建议：
 * 目标文件不存在时，列同级目录找相似候选（同名不同扩展/前后缀/子串/同扩展），
 * 按相似度打分排序取前 5，给 AI 可操作的纠错方向。
 */
function suggestSimilarFiles(filePath: string): Array<{ path: string; reason: string }> {
  try {
    const dir = resolve(dirname(filePath))
    const filename = basename(filePath)
    const lowerName = filename.toLowerCase()
    const nameNoExt = filename.replace(/\.[^.]+$/, '').toLowerCase()
    const ext = extname(filename).toLowerCase()

    const entries = readdirSync(dir, { withFileTypes: true })
    const scored: Array<{ score: number; path: string; reason: string }> = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const lf = e.name.toLowerCase()
      let score = 0
      let reason = ''
      if (lf === lowerName) {
        score = SIMILAR_SCORES.exact
        reason = '完全同名'
      } else if (e.name.replace(/\.[^.]+$/, '').toLowerCase() === nameNoExt) {
        score = SIMILAR_SCORES.sameBase
        reason = '同名不同扩展'
      } else if (lf.startsWith(lowerName) || lowerName.startsWith(lf)) {
        score = SIMILAR_SCORES.prefixSuffix
        reason = '名称前后缀匹配'
      } else if (lowerName.includes(lf) && lf.length > 2) {
        score = SIMILAR_SCORES.contains
        reason = '包含关系'
      } else if (ext && extname(e.name).toLowerCase() === ext) {
        // 同扩展 + 字符重叠 ≥ SIMILAR_OVERLAP_RATIO
        const common = new Set([...lowerName].filter((c) => lf.includes(c)))
        if (common.size >= Math.max(lowerName.length, lf.length) * SIMILAR_OVERLAP_RATIO) {
          score = SIMILAR_SCORES.overlap
          reason = '同扩展且有字符重叠'
        }
      }
      if (score > 0) scored.push({ score, path: join(dir, e.name), reason })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, MAX_SIMILAR_SUGGESTIONS).map((s) => ({ path: s.path, reason: s.reason }))
  } catch {
    return []
  }
}

export class ReadTool implements Tool<ReadParams> {
  name = 'Read'
  description = '读取文件内容。参数：file_path（必填，绝对路径）/ offset（选填，起始行从 1 开始）/ limit（选填，读取行数）。文本文件返回带行号内容（{ path, totalLines, startLine, endLine, content }）；办公文档（pdf/docx/xlsx/ipynb）自动提取为文本（{ path, type: "document", format, content }）；图片返回元信息（{ path, type: "image", format, sizeBytes, width, height }），不提供像素内容。大文件用 offset+limit 分页。路径是目录会报错；文件不存在时返回相似文件建议；其他二进制文件报错不吐乱码；超长单行自动截断标注。'
  parameters = [
    { name: 'file_path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'offset', type: 'number' as const, description: '起始行号（从 1 开始）', required: false },
    { name: 'limit', type: 'number' as const, description: '读取行数', required: false }
  ]

  // 行为声明：纯读取无副作用（readOnly=true，等价去重/只读免审判定的准入条件）；
  // 结果上限 8000 字符——无 limit 读取大文件时内容远超上下文承载，执行器先落盘再返回摘要路径。
  behavior = {
    readOnly: true,
    resultLimitChars: 8000
  }

  async execute(params: ReadParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.file_path || typeof params.file_path !== 'string' || params.file_path.trim().length === 0) {
      return { ok: false, error: 'file_path 必填且不能为空' }
    }
    const filePath = resolveToolPath(params.file_path, ctx)
    let stat
    try {
      stat = statSync(filePath)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      // 不存在（ENOENT/ENOTDIR）：给相似文件建议；权限错误（EACCES/EPERM）与其他错误
      // 不是"文件不存在"，套用相似文件名会误导 AI 换路径，必须区分报错
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        const suggestions = suggestSimilarFiles(filePath)
        return Promise.resolve({
          ok: false,
          error: suggestions.length > 0
            ? `文件不存在: ${filePath}。相似文件（按相似度排序）：\n${suggestions.map((s) => `  ${s.path}（${s.reason}）`).join('\n')}`
            : `文件不存在: ${filePath}`
        })
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return Promise.resolve({ ok: false, error: `没有权限访问: ${filePath}` })
      }
      return Promise.resolve({ ok: false, error: `读取文件状态失败: ${filePath}（${(err as Error).message}）` })
    }
    try {
      if (stat.isDirectory()) {
        return Promise.resolve({ ok: false, error: `路径是目录不是文件: ${filePath}` })
      }
      if (!stat.isFile()) {
        return Promise.resolve({ ok: false, error: `不是普通文件: ${filePath}` })
      }
      // 文件大小限制：超过 10MB 拒绝读取，防止内存溢出
      if (stat.size > MAX_FILE_BYTES) {
        return Promise.resolve({
          ok: false,
          error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限。请用 Grep 搜索内容或用 offset+limit 分页读取。`
        })
      }

      // 文档类（pdf/docx/xlsx/ipynb）：优先提取文本（复用 document-extract 纯 JS 实现）
      const buf = readFileSync(filePath)
      if (isExtractableDocument(filePath)) {
        try {
          const text = await extractDocumentBytes(buf, filePath)
          ctx?.handleAccessed?.(filePath)
          return {
            ok: true,
            data: {
              path: filePath,
              type: 'document',
              format: extname(filePath).toLowerCase().slice(1),
              sizeBytes: stat.size,
              totalChars: text.length,
              content: text
            }
          }
        } catch (err) {
          const reason = err instanceof ExtractionError ? err.message : (err as Error).message
          return { ok: false, error: `文档解析失败（${extname(filePath).toLowerCase()}）：${reason}。若文件损坏或为扫描件，请考虑直接导入该文件或人工查看。` }
        }
      }
      // 二进制检测：读字节采样判定，二进制不吐乱码
      if (isLikelyBinary(buf)) {
        const ext = extname(filePath).toLowerCase()
        if (IMAGE_EXTENSIONS.has(ext)) {
          const meta = readImageMeta(buf, filePath)
          const sizeKb = (stat.size / 1024).toFixed(1)
          const dim = meta.width && meta.height ? `${meta.width}x${meta.height}` : '尺寸未知'
          ctx?.handleAccessed?.(filePath)
          return {
            ok: true,
            data: {
              path: filePath,
              type: 'image',
              format: meta.format ?? ext.slice(1),
              sizeBytes: stat.size,
              width: meta.width,
              height: meta.height,
              note: `图片文件（${dim}，${sizeKb}KB）。文本通道无法读取像素内容——若任务需要图中文字/信息，向用户说明让用户查看，或由用户配置支持图片的视觉模型后才有自动理解；不要反复尝试用 Read 读它。`
            }
          }
        }
        return Promise.resolve({
          ok: false,
          error: `二进制文件（${ext || '未知扩展名'}），无法作为文本读取。请用对应工具处理（如查大小/哈希，或确认是否该读其他文件）。`
        })
      }
      // BOM 剥离 + 行尾归一化（CRLF/CR 统一为 \n）：避免 BOM 粘在第一行开头、CRLF 行尾带 \r 的幽灵字符
      const raw = normalizeLineEndings(stripBom(buf.toString('utf-8')), '\n')
      const lines = raw.split('\n')
      // offset 校验：NaN / 非正数 / 非整数都回退到 1
      let offset = 1
      if (typeof params.offset === 'number' && Number.isFinite(params.offset) && params.offset >= 1) {
        offset = Math.floor(params.offset)
      }
      // limit 校验：NaN / 非正数 回退到全文
      let limit = lines.length
      if (typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0) {
        limit = Math.floor(params.limit)
      }
      const start = offset - 1
      // offset 越界（超出文件总行数）时显式报错，而不是返回空切片、产生 startLine/endLine 倒挂
      if (start >= lines.length) {
        return Promise.resolve({
          ok: false,
          error: `offset ${offset} 超出文件总行数 ${lines.length}：文件共 ${lines.length} 行，请用 1..${lines.length} 范围内的 offset 分页读取。`
        })
      }
      const end = Math.min(start + limit, lines.length)
      const sliced = lines.slice(start, end)

      const maxLen = String(end).length
      // 超长行截断：单行超过 MAX_LINE_CHARS 截断并标注，防打爆上下文
      const numbered = sliced.map((line, i) => {
        const num = String(start + i + 1).padStart(maxLen, ' ')
        const truncated = line.length > MAX_LINE_CHARS
        const shown = truncated ? line.slice(0, MAX_LINE_CHARS) + `... [行过长已截断，原 ${line.length} 字符]` : line
        return `${num}→${shown}`
      }).join('\n')

      ctx?.handleAccessed?.(filePath)

      return Promise.resolve({
        ok: true,
        data: {
          path: filePath,
          totalLines: lines.length,
          startLine: offset,
          endLine: end,
          content: numbered
        }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}
