/**
 * 附件读取：把用户附加的文件按类型（文本 / 图片 / 文档 / 不支持）统一
 * 读成可供 LLM 消费的内容（文本或 base64 多模态），并做大小限制与
 * 拒绝原因文案化，是对话上下文装配前的附件预处理入口。
 */
import { readFileSync, statSync } from 'fs'
import { extname, basename } from 'path'
import { extractDocumentBytes, isExtractableDocument, ExtractionError } from './document-extract'

export interface AttachmentContent {
  name: string
  size: number
  type: string
  // 文本内容（文本类附件）
  text?: string
  // 图片 base64（图片类附件，走多模态 LLM）
  imageBase64?: string
  imageMimeType?: string
  // 拒绝原因（二进制等不支持的类型）
  rejected?: string
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.yaml', '.yml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.html', '.htm', '.css', '.scss', '.less',
  '.xml', '.svg', '.ini', '.cfg', '.conf', '.toml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql',
  '.env', '.dockerignore',
  '.log', '.csv'
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

const MAX_TEXT_SIZE = 256 * 1024 // 256KB
const MAX_IMAGE_SIZE = 8 * 1024 * 1024 // 8MB
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024 // 50MB（文档提取参考实现）

export function isTextAttachment(filename: string, mimeType: string): boolean {
  const ext = extname(filename).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return true
  if (mimeType.startsWith('text/')) return true
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true
  return false
}

export function isImageAttachment(filename: string, mimeType: string): boolean {
  const ext = extname(filename).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return true
  if (mimeType.startsWith('image/')) return true
  return false
}

export async function readAttachment(filePath: string): Promise<AttachmentContent> {
  const name = basename(filePath)
  let stat
  try {
    stat = statSync(filePath)
  } catch (err) {
    return {
      name,
      size: 0,
      type: '',
      rejected: `无法访问文件: ${(err as Error).message}`
    }
  }

  const size = stat.size
  // 通过扩展名和 MIME 猜测类型
  const ext = extname(filePath).toLowerCase()
  const dummyMime = guessMime(ext)

  // 文档类（docx/xlsx/ipynb）：提取为文本
  if (isExtractableDocument(name)) {
    if (size > MAX_DOCUMENT_SIZE) {
      return {
        name,
        size,
        type: dummyMime,
        rejected: `文档过大（${(size / 1024 / 1024).toFixed(1)}MB > 50MB）`
      }
    }
    try {
      const buf = readFileSync(filePath)
      const text = await extractDocumentBytes(buf, name)
      if (text.length > MAX_TEXT_SIZE) {
        return {
          name,
          size,
          type: dummyMime,
          rejected: `文档提取文本过大（${(text.length / 1024).toFixed(1)}KB > 256KB），请缩减后重试`
        }
      }
      return { name, size, type: dummyMime, text }
    } catch (err) {
      const reason = err instanceof ExtractionError ? err.message : (err as Error).message
      return {
        name,
        size,
        type: dummyMime,
        rejected: `文档解析失败: ${reason}`
      }
    }
  }

  if (isTextAttachment(name, dummyMime)) {
    if (size > MAX_TEXT_SIZE) {
      return {
        name,
        size,
        type: dummyMime,
        rejected: `文本文件过大（${(size / 1024).toFixed(1)}KB > 256KB），请缩减后重试`
      }
    }
    try {
      const buf = readFileSync(filePath)
      const text = buf.toString('utf-8')
      return { name, size, type: dummyMime, text }
    } catch (err) {
      return {
        name,
        size,
        type: dummyMime,
        rejected: `读取文本失败: ${(err as Error).message}`
      }
    }
  }

  if (isImageAttachment(name, dummyMime)) {
    if (size > MAX_IMAGE_SIZE) {
      return {
        name,
        size,
        type: dummyMime,
        rejected: `图片过大（${(size / 1024 / 1024).toFixed(1)}MB > 8MB）`
      }
    }
    try {
      const buf = readFileSync(filePath)
      const base64 = buf.toString('base64')
      return {
        name,
        size,
        type: dummyMime,
        imageBase64: base64,
        imageMimeType: dummyMime
      }
    } catch (err) {
      return {
        name,
        size,
        type: dummyMime,
        rejected: `读取图片失败: ${(err as Error).message}`
      }
    }
  }

  return {
    name,
    size,
    type: dummyMime,
    rejected: '不支持的文件类型（支持文本、图片、docx/xlsx/ipynb 文档）'
  }
}

export function formatAttachmentsForContext(attachments: AttachmentContent[]): string {
  if (attachments.length === 0) return ''
  const lines: string[] = ['用户拖拽了以下文件，内容已融入上下文：', '']

  for (const a of attachments) {
    lines.push(`--- 文件: ${a.name} (${a.size} bytes, ${a.type || '未知类型'}) ---`)
    if (a.rejected) {
      lines.push(`[拒绝] ${a.rejected}`)
    } else if (a.text) {
      lines.push('```')
      lines.push(a.text)
      lines.push('```')
    } else if (a.imageBase64) {
      lines.push(`[图片已加载，base64 长度 ${a.imageBase64.length}]`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.js': 'text/javascript',
    '.jsx': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.py': 'text/x-python',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.css': 'text/css',
    '.xml': 'application/xml',
    '.svg': 'image/svg+xml',
    '.bat': 'text/x-bat',
    '.cmd': 'text/x-cmd',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  }
  return map[ext] || 'application/octet-stream'
}
