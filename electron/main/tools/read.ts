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

/** 图片扩展名（图片自动重定向，不吐乱码） */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif'])

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
  return control > len * 0.05 // >5% 控制字符 = 二进制
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
        score = 100
        reason = '完全同名'
      } else if (e.name.replace(/\.[^.]+$/, '').toLowerCase() === nameNoExt) {
        score = 90
        reason = '同名不同扩展'
      } else if (lf.startsWith(lowerName) || lowerName.startsWith(lf)) {
        score = 70
        reason = '名称前后缀匹配'
      } else if (lowerName.includes(lf) && lf.length > 2) {
        score = 60
        reason = '包含关系'
      } else if (ext && extname(e.name).toLowerCase() === ext) {
        // 同扩展 + 字符重叠 ≥40%
        const common = new Set([...lowerName].filter((c) => lf.includes(c)))
        if (common.size >= Math.max(lowerName.length, lf.length) * 0.4) {
          score = 30
          reason = '同扩展且有字符重叠'
        }
      }
      if (score > 0) scored.push({ score, path: join(dir, e.name), reason })
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 5).map((s) => ({ path: s.path, reason: s.reason }))
  } catch {
    return []
  }
}

export class ReadTool implements Tool<ReadParams> {
  name = 'Read'
  description = '读取文件内容，返回带行号的文本。参数：file_path（必填，绝对路径）/ offset（选填，起始行从 1 开始）/ limit（选填，读取行数）。返回 { path, totalLines, startLine, endLine, content }，content 格式为 "  行号→内容"。大文件用 offset+limit 分页。路径是目录会报错；文件不存在时返回相似文件建议（同名不同扩展/近似名）；二进制/图片文件返回明确提示不吐乱码；超长单行自动截断标注。'
  parameters = [
    { name: 'file_path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'offset', type: 'number' as const, description: '起始行号（从 1 开始）', required: false },
    { name: 'limit', type: 'number' as const, description: '读取行数', required: false }
  ]

  execute(params: ReadParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.file_path || typeof params.file_path !== 'string' || params.file_path.trim().length === 0) {
      return Promise.resolve({ ok: false, error: 'file_path 必填且不能为空' })
    }
    const filePath = resolveToolPath(params.file_path, ctx)
    let stat
    try {
      stat = statSync(filePath)
    } catch {
      // 文件不存在（ENOENT）：建议相似文件
      const suggestions = suggestSimilarFiles(filePath)
      return Promise.resolve({
        ok: false,
        error: suggestions.length > 0
          ? `文件不存在: ${filePath}。相似文件（按相似度排序）：\n${suggestions.map((s) => `  ${s.path}（${s.reason}）`).join('\n')}`
          : `文件不存在: ${filePath}`
      })
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

      // 二进制检测：读字节采样判定，二进制不吐乱码
      const buf = readFileSync(filePath)
      if (isLikelyBinary(buf)) {
        const ext = extname(filePath).toLowerCase()
        if (IMAGE_EXTENSIONS.has(ext)) {
          return Promise.resolve({
            ok: false,
            // 图片无法用文本 Read 读（会乱码）。明示出路，防 AI 反复试 Read。
            error: `图片文件（${ext}）：文本 Read 无法读取图片内容（二进制）。月蚀当前无视觉，"用工具看图"不可行——若任务需要图片里的文字/信息，向用户说明让用户查看，或由用户配置支持图片的视觉模型后才有自动理解。不要反复尝试用 Read 读它。`
          })
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
