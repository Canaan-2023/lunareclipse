/**
 * 文档提取模块（docx/xlsx/ipynb → 文本，MIT 许可参考实现）

 * 为什么存在：对话中常见附件是办公文档，LLM 无法直接读二进制格式，
 * 需要先提取为纯文本再注入上下文——自包含桌面应用不绑 Python，
 * 故用纯 JS 零原生依赖实现。

 * 纯 JS 实现 ipynb / docx / xlsx 三种格式的文本提取，零原生依赖：
 * - ipynb：JSON 解析，输出按 cell 分节，output 渲染为紧凑文本
 * - docx：zip + XML（word/document.xml 的 w:p/w:t/w:tab/w:br）
 * - xlsx：zip + XML（workbook → rels → sheet + sharedStrings），5000 行/256 列上限

 * 与原 Python 版差异：
 * - 移除 anydoc（Rust 核心）可选扩展——月蚀是自包含桌面应用，不绑 Python
 * - ANSI 清理用正则替代原 ansi_strip 模块（等价覆盖常见 CSI/OSC 序列）
 * - 输入为 Buffer（附件链路已是字节），不做路径读取
 */
import { inflateSync } from 'zlib'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import type { Document as XmlDocument, Element as XmlElement } from '@xmldom/xmldom'

export class ExtractionError extends Error {}

export const EXTRACTABLE_EXTENSIONS = new Set(['.ipynb', '.docx', '.xlsx', '.pdf'])

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024 // 50MB，与原版一致
const MAX_XLSX_ROWS_PER_SHEET = 5000
const MAX_XLSX_COLS = 256
const MAX_OUTPUT_CHARS = 20000 // 单 output 块截断，防训练日志刷屏

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** NodeList → 数组（xmldom 的 NodeList 是类数组，方便遍历） */
function toArray<T>(list: { length: number; item(i: number): T | null }): T[] {
  const out: T[] = []
  for (let i = 0; i < list.length; i++) {
    const v = list.item(i)
    if (v !== null) out.push(v)
  }
  return out
}

function parseXml(xml: string): XmlDocument {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  // xmldom 解析失败时仍返回文档，但带 parsererror 节点
  const errors = doc.getElementsByTagName('parsererror')
  if (errors.length > 0) {
    throw new ExtractionError(`Malformed XML: ${errors.item(0)?.textContent?.slice(0, 200) || 'unknown error'}`)
  }
  return doc
}

// ── ANSI 清理（等价原 ansi_strip 的常见覆盖） ──────────────────────────

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

/** 清 ANSI + 折叠 \r 进度条重绘（tqdm 类只留每行最后一帧，还原 Jupyter 显示） */
function cleanStreamText(text: string): string {
  const cleaned = stripAnsi(text).replace(/\r\n/g, '\n')
  const lines: string[] = []
  for (const line of cleaned.split('\n')) {
    const frames = line.split('\r').filter((f) => f)
    lines.push(frames.length > 0 ? frames[frames.length - 1] : '')
  }
  return lines.join('\n')
}

function sourceText(source: unknown): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source)) return source.filter((i) => typeof i === 'string').join('')
  return ''
}

function humanSize(nBytes: number): string {
  return nBytes >= 1024 ? `${Math.round(nBytes / 1024)} KB` : `${nBytes} B`
}

/** base64 负载的近似解码大小（忽略空白） */
function base64Bytes(payload: string): number {
  const clean = payload.replace(/[^0-9+/=A-Za-z]/g, '')
  const padding = Math.min(2, clean.length - clean.replace(/=+$/, '').length)
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

// ── ipynb ─────────────────────────────────────────────────────────────

/** 渲染一个 notebook output 为紧凑文本（v4 + 旧 v3 形状都兼容） */
function notebookOutputText(output: unknown): string {
  if (typeof output !== 'object' || output === null) return ''
  const o = output as Record<string, unknown>
  const otype = o.output_type

  if (otype === 'stream') {
    const body = cleanStreamText(sourceText(o.text))
    return body.trim() ? body : ''
  }

  if (otype === 'error' || otype === 'pyerr') {
    const tb = o.traceback
    let tbText = ''
    if (Array.isArray(tb)) {
      tbText = cleanStreamText(tb.filter((l) => typeof l === 'string').join('\n'))
    }
    const header = `Error: ${String(o.ename ?? '')}: ${String(o.evalue ?? '')}`.replace(/:\s*$/, '')
    return `${header}\n${tbText}`.trim()
  }

  if (otype === 'execute_result' || otype === 'display_data' || otype === 'pyout') {
    let data = o.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      // nbformat v3：mime 数据平铺在 output dict 上
      data = {}
      if (typeof o.text === 'string' || Array.isArray(o.text)) {
        ;(data as Record<string, unknown>)['text/plain'] = o.text
      }
      const v3Map: Array<[string, string]> = [
        ['png', 'image/png'],
        ['jpeg', 'image/jpeg'],
        ['svg', 'image/svg+xml'],
        ['html', 'text/html']
      ]
      for (const [key, mime] of v3Map) {
        if (key in o) (data as Record<string, unknown>)[mime] = o[key]
      }
    }
    const dataMap = data as Record<string, unknown>

    if ('application/vnd.jupyter.widget-view+json' in dataMap) {
      return '[interactive widget — omitted]'
    }

    // 优先 readable 文本：模型吃 text/plain（如 pandas 的纯文本版）远好于 markup
    for (const mime of ['text/plain', 'text/markdown']) {
      if (mime in dataMap) {
        const body = cleanStreamText(sourceText(dataMap[mime]))
        if (body.trim()) return body
      }
    }

    for (const [mime, value] of Object.entries(dataMap)) {
      if (mime.startsWith('image/')) {
        const size = base64Bytes(sourceText(value))
        return `[${mime} output — ${humanSize(size)}, omitted]`
      }
    }

    if ('text/html' in dataMap) {
      const html = sourceText(dataMap['text/html'])
      return `[text/html output — ${html.length.toLocaleString()} chars, omitted]`
    }

    const mimes = Object.keys(dataMap).join(', ') || 'unknown'
    return `[${mimes} output — omitted]`
  }

  return ''
}

function notebookOutputs(cell: Record<string, unknown>): string {
  const outputs = cell.outputs
  if (!Array.isArray(outputs)) return ''
  const blocks = outputs.map(notebookOutputText).filter((t) => t)
  if (blocks.length === 0) return ''
  const joined = blocks.join('\n')
  if (joined.length > MAX_OUTPUT_CHARS) {
    const omitted = joined.length - MAX_OUTPUT_CHARS
    joined.slice(0, MAX_OUTPUT_CHARS)
    return joined.slice(0, MAX_OUTPUT_CHARS) + `\n… [${omitted.toLocaleString()} output chars truncated]`
  }
  return joined
}

function extractNotebook(data: Buffer): string {
  let nb: unknown
  try {
    nb = JSON.parse(data.toString('utf-8'))
  } catch (err) {
    throw new ExtractionError(`Not a valid notebook: ${(err as Error).message}`)
  }
  if (typeof nb !== 'object' || nb === null || Array.isArray(nb)) {
    throw new ExtractionError('Notebook root is not an object')
  }
  const nbObj = nb as Record<string, unknown>

  let cells: Array<Record<string, unknown>> = []
  if (Array.isArray(nbObj.cells)) {
    cells = nbObj.cells.filter((c) => typeof c === 'object' && c !== null) as Array<Record<string, unknown>>
  } else if (Array.isArray(nbObj.worksheets)) {
    // nbformat v3：worksheets[].cells
    for (const ws of nbObj.worksheets) {
      if (typeof ws !== 'object' || ws === null) continue
      const wsCells = (ws as Record<string, unknown>).cells
      if (Array.isArray(wsCells)) {
        cells.push(...(wsCells.filter((c) => typeof c === 'object' && c !== null) as Array<Record<string, unknown>>))
      }
    }
  }
  if (cells.length === 0) throw new ExtractionError('Notebook contains no cells')

  const counts: Record<string, number> = { markdown: 0, code: 0, raw: 0 }
  const labels: Record<string, string> = { markdown: 'Markdown', code: 'Code', raw: 'Raw' }
  const out: string[] = []
  for (const cell of cells) {
    const typ = String(cell.cell_type ?? '')
    if (!(typ in labels)) continue
    counts[typ] = (counts[typ] ?? 0) + 1
    const suffix = typ !== 'raw' ? ` ${counts[typ]}` : ''
    out.push(`# ── ${labels[typ]} cell${suffix} ──`)
    out.push(sourceText(cell.source).replace(/\n$/, ''))
    out.push('')
    if (typ === 'code') {
      const rendered = notebookOutputs(cell)
      if (rendered) {
        out.push(`# ── Output (cell ${counts[typ]}) ──`)
        out.push(rendered.replace(/\n$/, ''))
        out.push('')
      }
    }
  }
  if (out.length === 0) throw new ExtractionError('Notebook contains no readable cells')
  return out.join('\n').replace(/\n$/, '') + '\n'
}

// ── docx ──────────────────────────────────────────────────────────────

async function extractDocx(data: Buffer): Promise<string> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (err) {
    throw new ExtractionError(`Not a valid DOCX: ${(err as Error).message}`)
  }
  const entry = zip.file('word/document.xml')
  if (!entry) throw new ExtractionError('Missing word/document.xml')
  const doc = parseXml(await entry.async('string'))

  const lines: string[] = []
  for (const para of toArray(doc.getElementsByTagNameNS(NS_W, 'p'))) {
    const buf: string[] = []
    for (const node of toArray(para.getElementsByTagName('*'))) {
      if (node.namespaceURI === NS_W && node.localName === 't') {
        buf.push(node.textContent || '')
      } else if (node.namespaceURI === NS_W && node.localName === 'tab') {
        buf.push('\t')
      } else if (node.namespaceURI === NS_W && (node.localName === 'br' || node.localName === 'cr')) {
        buf.push('\n')
      }
    }
    lines.push(...buf.join('').split('\n'))
  }
  if (!lines.some((l) => l.trim())) throw new ExtractionError('DOCX contains no extractable text')
  return lines.join('\n').replace(/\n$/, '') + '\n'
}

// ── xlsx ──────────────────────────────────────────────────────────────

async function zipEntryString(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name)
  if (!entry) throw new ExtractionError(`Missing ${name}`)
  return entry.async('string')
}

async function sharedStrings(zip: JSZip, names: Set<string>): Promise<string[]> {
  if (!names.has('xl/sharedStrings.xml')) return []
  let doc: XmlDocument
  try {
    doc = parseXml(await zipEntryString(zip, 'xl/sharedStrings.xml'))
  } catch {
    return []
  }
  const out: string[] = []
  for (const item of toArray(doc.getElementsByTagNameNS(NS_S, 'si'))) {
    out.push(
      toArray(item.getElementsByTagNameNS(NS_S, 't'))
        .map((t) => t.textContent || '')
        .join('')
    )
  }
  return out
}

async function workbookSheets(zip: JSZip): Promise<Array<{ name: string; state: string; rid: string }>> {
  const doc = parseXml(await zipEntryString(zip, 'xl/workbook.xml'))
  return toArray(doc.getElementsByTagNameNS(NS_S, 'sheet')).map((sheet) => ({
    name: sheet.getAttribute('name') || 'Sheet',
    state: sheet.getAttribute('state') || 'visible',
    rid: sheet.getAttributeNS(NS_REL, 'id') || ''
  }))
}

async function workbookRels(zip: JSZip, names: Set<string>): Promise<Map<string, string>> {
  const relsPath = 'xl/_rels/workbook.xml.rels'
  if (!names.has(relsPath)) return new Map()
  let doc: XmlDocument
  try {
    doc = parseXml(await zipEntryString(zip, relsPath))
  } catch {
    return new Map()
  }
  const rels = new Map<string, string>()
  for (const rel of toArray(doc.getElementsByTagNameNS(NS_PKG_REL, 'Relationship'))) {
    const id = rel.getAttribute('Id')
    if (id) rels.set(id, rel.getAttribute('Target') || '')
  }
  return rels
}

function sheetPart(target: string): string {
  let t = target.replace(/^\/+/, '')
  if (!t.startsWith('xl/')) t = `xl/${t}`
  return t
    .split('/')
    .filter((seg) => seg && seg !== '.')
    .join('/')
}

function colIndex(ref: string): number {
  let idx = 0
  for (const ch of ref) {
    if (!/[a-zA-Z]/.test(ch)) break
    idx = idx * 26 + ch.toUpperCase().charCodeAt(0) - 64
  }
  return Math.max(idx - 1, 0)
}

function cellValue(cell: XmlElement, shared: string[]): string {
  const vEls = cell.getElementsByTagNameNS(NS_S, 'v')
  const value = vEls.length > 0 ? vEls.item(0)?.textContent || '' : ''
  const typ = cell.getAttribute('t') || ''
  if (typ === 's') {
    const idx = parseInt(value, 10)
    return Number.isNaN(idx) ? '' : shared[idx] || ''
  }
  if (typ === 'inlineStr') {
    const isEls = cell.getElementsByTagNameNS(NS_S, 'is')
    if (isEls.length > 0) {
      return toArray(isEls.item(0)!.getElementsByTagNameNS(NS_S, 't'))
        .map((t) => t.textContent || '')
        .join('')
    }
    return ''
  }
  if (typ === 'b') {
    const v = value.trim().toLowerCase()
    return v === '1' || v === 'true' ? 'TRUE' : 'FALSE'
  }
  if (typ === 'e') return value || '#ERROR'
  return value
}

async function sheetRows(zip: JSZip, part: string, shared: string[]): Promise<string[][]> {
  const doc = parseXml(await zipEntryString(zip, part))
  const rows: string[][] = []
  for (const rowEl of toArray(doc.getElementsByTagNameNS(NS_S, 'row'))) {
    if (rows.length >= MAX_XLSX_ROWS_PER_SHEET) break
    const cells = new Map<number, string>()
    let maxCol = -1
    for (const cell of toArray(rowEl.getElementsByTagNameNS(NS_S, 'c'))) {
      const ref = cell.getAttribute('r') || ''
      const col = ref ? colIndex(ref) : maxCol + 1
      if (col >= MAX_XLSX_COLS) continue
      cells.set(col, cellValue(cell, shared))
      maxCol = Math.max(maxCol, col)
    }
    rows.push(maxCol >= 0 ? Array.from({ length: maxCol + 1 }, (_, i) => cells.get(i) || '') : [])
  }
  while (rows.length > 0 && !rows[rows.length - 1].some((v) => v.trim())) rows.pop()
  return rows
}

async function extractXlsx(data: Buffer): Promise<string> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(data)
  } catch (err) {
    throw new ExtractionError(`Not a valid XLSX: ${(err as Error).message}`)
  }
  const names = new Set(Object.keys(zip.files))
  const shared = await sharedStrings(zip, names)
  const sheets = await workbookSheets(zip)
  const rels = await workbookRels(zip, names)

  const out: string[] = []
  for (const { name, state, rid } of sheets) {
    if (state === 'hidden' || state === 'veryHidden') continue
    const part = sheetPart(rels.get(rid) || '')
    if (!names.has(part)) continue
    let rows: string[][]
    try {
      rows = await sheetRows(zip, part, shared)
    } catch (err) {
      if (err instanceof ExtractionError) throw err
      continue // 单个 sheet 解析失败跳过，不拖垮整个文件
    }
    out.push(`# ── Sheet: ${name} ──`)
    out.push(...rows.map((r) => r.join('\t')))
    if (rows.length === 0) out.push('(empty)')
    out.push('')
  }
  if (out.length === 0) throw new ExtractionError('XLSX has no visible sheets with content')
  return out.join('\n').replace(/\n$/, '') + '\n'
}


// ── PDF ──────────────────────────────────────────────────────────────
//
// 纯 TypeScript PDF 文本提取器，零外部依赖。
// 流程：扫描 PDF stream 块 → FlateDecode 解压（Node.js zlib inflateSync）→
// 解析 Tj/TJ/'/" 文本操作符中的字符串 → 拼接纯文本
//
// 局限：不处理 CID 字体自定义编码（部分中日韩 PDF 可能乱码）、
// 扫描件（无文本层）、LZW/ASCII85 等非 FlateDecode 压缩。
// 复杂 PDF 如需精确提取建议使用专用 OCR 工具。

/** 解码 PDF literal string: (text) → string，处理转义序列和 UTF-16BE BOM */
function decodePdfLiteral(content: string, start: number): { text: string; next: number } {
  const bytes: number[] = []
  let i = start + 1 // skip '('
  let depth = 1
  while (i < content.length && depth > 0) {
    const ch = content[i]
    if (ch === '\\') {
      const octMatch = content.slice(i + 1).match(/^([0-7]{1,3})/)
      if (octMatch) {
        bytes.push(parseInt(octMatch[1], 8))
        i += 1 + octMatch[1].length
        continue
      }
      const escMap: Record<string, number> = {
        n: 10, r: 13, t: 9, b: 8, f: 12,
        '(': 40, ')': 41, '\\': 92, '\n': 10
      }
      const next = content[i + 1]
      if (escMap[next] !== undefined) {
        bytes.push(escMap[next])
        i += 2
      } else {
        i++ // unknown escape, skip backslash
      }
      continue
    }
    if (ch === '(') { depth++; bytes.push(ch.charCodeAt(0)); i++; continue }
    if (ch === ')') {
      depth--
      if (depth === 0) { i++; break }
      bytes.push(ch.charCodeAt(0)); i++; continue
    }
    bytes.push(ch.charCodeAt(0))
    i++
  }
  return { text: decodePdfBytes(bytes), next: i }
}

/** 解码 PDF hex string: <hex> → string */
function decodePdfHex(content: string, start: number): { text: string; next: number } {
  let i = start + 1 // skip '<'
  let hex = ''
  while (i < content.length && content[i] !== '>') {
    const ch = content[i]
    if (/[0-9A-Fa-f]/.test(ch)) hex += ch
    i++
  }
  i++ // skip '>'
  if (hex.length % 2) hex += '0'
  if (!hex) return { text: '', next: i }
  return { text: decodePdfBytes(Array.from(Buffer.from(hex, 'hex'))), next: i }
}

/** 从字节数组解码 PDF 字符串（UTF-16BE BOM 检测 + WinAnsi/Latin1 兜底） */
function decodePdfBytes(bytes: number[]): string {
  if (bytes.length === 0) return ''
  // UTF-16BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    let result = ''
    for (let j = 2; j < bytes.length - 1; j += 2) {
      const code = (bytes[j] << 8) | bytes[j + 1]
      if (code >= 32 || code === 10 || code === 13) result += String.fromCharCode(code)
    }
    return result
  }
  // WinAnsi/Latin1
  return Buffer.from(bytes).toString('latin1')
}

/** 从 TJ 数组中提取文本（跳过数字定位元素，收集字符串） */
function readPdfTJArray(content: string, start: number): { text: string; next: number } {
  let i = start + 1 // skip '['
  let text = ''
  while (i < content.length && content[i] !== ']') {
    const ch = content[i]
    if (ch === '(') {
      const { text: t, next } = decodePdfLiteral(content, i)
      text += t
      i = next
    } else if (ch === '<' && content[i + 1] !== '<') {
      const { text: t, next } = decodePdfHex(content, i)
      text += t
      i = next
    } else {
      i++
    }
  }
  i++ // skip ']'
  return { text, next: i }
}

/** 从 PDF content stream 中提取文本 */
function extractPdfTextFromContent(content: string): string {
  const lines: string[] = []
  let currentLine = ''
  let pendingText = ''
  let i = 0

  const flush = () => {
    if (currentLine.trim()) lines.push(currentLine.trim())
    currentLine = ''
  }

  while (i < content.length) {
    const ch = content[i]

    if (/\s/.test(ch)) { i++; continue }

    // literal string
    if (ch === '(') {
      const { text, next } = decodePdfLiteral(content, i)
      pendingText = text
      i = next
      continue
    }

    // hex string or dict
    if (ch === '<') {
      if (content[i + 1] === '<') {
        // dict << ... >> -- skip
        let depth = 1
        i += 2
        while (i < content.length && depth > 0) {
          if (content[i] === '<' && content[i + 1] === '<') { depth++; i += 2 }
          else if (content[i] === '>' && content[i + 1] === '>') { depth--; i += 2 }
          else i++
        }
        continue
      }
      const { text, next } = decodePdfHex(content, i)
      pendingText = text
      i = next
      continue
    }

    // TJ array
    if (ch === '[') {
      const { text, next } = readPdfTJArray(content, i)
      pendingText = text
      i = next
      continue
    }

    // operators
    if (ch === 'T' && content[i + 1] === 'j') {
      if (pendingText) { currentLine += (currentLine ? ' ' : '') + pendingText; pendingText = '' }
      i += 2; continue
    }
    if (ch === 'T' && content[i + 1] === 'J') {
      if (pendingText) { currentLine += (currentLine ? ' ' : '') + pendingText; pendingText = '' }
      i += 2; continue
    }
    if (ch === 'T' && content[i + 1] === '*') {
      flush(); pendingText = ''
      i += 2; continue
    }
    if (ch === 'T' && (content[i + 1] === 'd' || content[i + 1] === 'D')) {
      flush(); pendingText = ''
      i += 2; continue
    }

    if (ch === "'") {
      flush(); currentLine = pendingText; pendingText = ''
      i++; continue
    }
    if (ch === '"') {
      flush(); currentLine = pendingText; pendingText = ''
      i++; continue
    }

    i++
  }
  flush()
  return lines.join('\n')
}

export async function extractPdf(data: Buffer): Promise<string> {
  const pdf = data.toString('latin1')

  // 加密检测
  if (/\/Encrypt\s+\d+\s+\d+\s+R/.test(pdf)) {
    throw new ExtractionError('PDF 已加密，请先解密后再提取文本')
  }

  // 收集所有 stream 块
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g
  const streams: Buffer[] = []
  let m: RegExpExecArray | null
  while ((m = streamRe.exec(pdf)) !== null) {
    streams.push(Buffer.from(m[1], 'latin1'))
  }

  const pages: string[] = []
  for (const streamBuf of streams) {
    let content: string
    // 尝试 FlateDecode 解压
    try {
      content = inflateSync(streamBuf).toString('latin1')
    } catch {
      content = streamBuf.toString('latin1')
    }
    // 只处理含文本操作符的流（跳过字体/图片流）
    if (!/Tj|TJ|BT|ET/.test(content)) continue

    const text = extractPdfTextFromContent(content)
    if (text.trim()) pages.push(text)
  }

  if (pages.length === 0) {
    throw new ExtractionError(
      'PDF 无内嵌文本层（可能是扫描件），需要 OCR。有文本层的 PDF 已自动提取；扫描图页请用 screen_capture 或上传图片 OCR'
    )
  }
  return pages.join('\n\n') + '\n'
}


export function isExtractableDocument(filename: string): boolean {
  const lower = filename.toLowerCase()
  return EXTRACTABLE_EXTENSIONS.has(lower.slice(lower.lastIndexOf('.'))) || false
}

export async function extractDocumentBytes(data: Buffer, filename: string): Promise<string> {
  if (data.length > MAX_DOCUMENT_BYTES) {
    throw new ExtractionError(
      `Document too large to convert (${data.length.toLocaleString()} bytes, limit is ${MAX_DOCUMENT_BYTES.toLocaleString()})`
    )
  }
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  if (ext === '.ipynb') return extractNotebook(data)
  if (ext === '.docx') return extractDocx(data)
  if (ext === '.xlsx') return extractXlsx(data)
  if (ext === '.pdf') return extractPdf(data)
  throw new ExtractionError(`Unsupported document type: ${filename}`)
}
