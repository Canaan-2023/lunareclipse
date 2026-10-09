/**
 * 内容搜索工具：为什么存在——AI 需要不开文件就能按关键词/正则定位代码与文本，
 * 是"读文件"的高效前置，也是大规模检索的入口。
 * 作用：grep 工具在文件（可选 glob 过滤）中搜索并返回带行号/上下文的匹配片段，
 * 单文件 10MB、2000 文件上限防内存溢出。
 */
import { readFileSync, statSync } from 'fs'
import { resolve } from 'path'
import { globMatch } from './glob-walk'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

/** 单文件搜索大小上限（10MB），超过则跳过防止内存溢出 */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/**
 * 扫描文件数硬上限（性能修复）：
 * Grep 是同步 readFileSync 逐文件扫，文件数过多会阻塞 Electron 主进程事件循环 → 窗口卡死。
 * 超过上限直接报错让 AI 缩小范围（globMatch 已跳过 node_modules 等巨型目录，此上限是双保险）。
 */
const MAX_SCAN_FILES = 2000

export interface GrepParams {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'content' | 'files_with_matches' | 'count'
  '-n'?: boolean
  '-i'?: boolean
  '-C'?: number
  '-A'?: number
  '-B'?: number
  multiline?: boolean
  head_limit?: number
}

export class GrepTool implements Tool<GrepParams> {
  name = 'Grep'
  description = '正则搜索文件内容（ripgrep 风格）。参数：pattern（必填，正则表达式）/ path（选填，搜索目录或文件，默认当前目录）/ glob（选填，文件名过滤如 "*.ts"）/ output_mode（选填，content/files_with_matches/count，默认 files_with_matches）/ -n（显示行号）/ -i（忽略大小写）/ -C/-A/-B（上下文行数）/ multiline（多行模式）/ head_limit（限制条数）。content 模式返回 {matches: [{file, line?, text, context?}]}；files_with_matches 返回 {files: [路径]}；count 返回 {counts: [{file, count}]}。⚠️ 仅跳过 node_modules/dist/build/缓存等巨型依赖目录（性能保护）；月蚀自身数据（abyssac_data、userdata、技能/记忆/会话）与用户参考目录均完整可访问；扫描文件数上限 2000，超限报错请缩小范围。0 匹配时返回 hint 提示（大小写/正则转义）。搜文件内容用本工具；按文件名找文件用 Glob。'
  parameters = [
    { name: 'pattern', type: 'string' as const, description: '正则表达式', required: true },
    { name: 'path', type: 'string' as const, description: '搜索目录或文件', required: false },
    { name: 'glob', type: 'string' as const, description: '文件名过滤，如 "*.ts"', required: false },
    { name: 'output_mode', type: 'string' as const, description: 'content/files_with_matches/count', required: false, default: 'files_with_matches' },
    { name: '-n', type: 'boolean' as const, description: '显示行号', required: false },
    { name: '-i', type: 'boolean' as const, description: '忽略大小写', required: false },
    { name: '-C', type: 'number' as const, description: '上下文行数', required: false },
    { name: '-A', type: 'number' as const, description: '后置行数', required: false },
    { name: '-B', type: 'number' as const, description: '前置行数', required: false },
    { name: 'multiline', type: 'boolean' as const, description: '多行模式', required: false },
    { name: 'head_limit', type: 'number' as const, description: '限制输出条数', required: false }
  ]

  execute(params: GrepParams, ctx?: ToolContext): Promise<ToolResult> {
    const base = params.path
      ? resolveToolPath(params.path, ctx)
      : process.cwd()

    try {
      const flags = params['-i'] ? 'gi' : 'g'
      const regex = params.multiline
        ? new RegExp(params.pattern, `${flags}s`)
        : new RegExp(params.pattern, flags)

      const files = collectFiles(base, params.glob)
      // 扫描文件数硬上限：超限报错引导缩小范围（防同步逐文件读卡死主进程）
      if (files.length > MAX_SCAN_FILES) {
        return Promise.resolve({
          ok: false,
          error: `扫描文件数 ${files.length} 超过上限 ${MAX_SCAN_FILES}——搜索范围太大，请用 path 限定目录、glob 限定文件类型（如 *.ts）后重试（已自动跳过 node_modules/构建产物等目录）`
        })
      }
      const mode = params.output_mode ?? 'files_with_matches'
      const results: Array<Record<string, unknown>> = []
      const counts: Array<{ file: string; count: number }> = []
      const matchedFiles: string[] = []

      for (const file of files) {
        let content: string
        try {
          // 跳过超大文件（>10MB），防止内存溢出
          const stat = statSync(file)
          if (stat.size > MAX_FILE_BYTES) continue
          content = readFileSync(file, 'utf-8')
        } catch { continue }
        const lines = content.split('\n')
        const fileMatches: Array<{ line: number; text: string; ctx: string[] }> = []

        // content 模式已收集满 head_limit → 停止扫描后续文件（防白烧 CPU/IO）
        if (mode === 'content' && params.head_limit && results.length >= params.head_limit) break

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0
          if (regex.test(lines[i])) {
            fileMatches.push({
              line: i + 1,
              text: lines[i],
              ctx: extractContext(lines, i, params)
            })
          }
        }

        if (fileMatches.length === 0) continue
        matchedFiles.push(file)

        if (mode === 'count') {
          counts.push({ file, count: fileMatches.length })
        } else if (mode === 'content') {
          // 提前截断：head_limit 限定的是总匹配条数——达到上限后停止收集（原实现全量收集后再 slice，白烧内存/CPU）
          const remaining = params.head_limit ? params.head_limit - results.length : Infinity
          if (remaining <= 0) break
          for (const m of fileMatches) {
            if (results.length >= (params.head_limit ?? Infinity)) break
            results.push({
              file,
              line: params['-n'] ? m.line : undefined,
              text: m.text,
              context: params['-C'] || params['-A'] || params['-B'] ? m.ctx : undefined
            })
          }
        }
      }

      let data: unknown
      if (mode === 'count') {
        data = { base, pattern: params.pattern, counts }
      } else if (mode === 'content') {
        let r = results
        if (params.head_limit) r = r.slice(0, params.head_limit)
        data = { base, pattern: params.pattern, count: r.length, matches: r }
      } else {
        let f = matchedFiles
        if (params.head_limit) f = f.slice(0, params.head_limit)
        data = { base, pattern: params.pattern, count: f.length, files: f }
      }

      // 零匹配诊断：0 结果时给 AI 可操作的提示，避免干瞪眼
      const matchCount = mode === 'count' ? counts.length : mode === 'content' ? results.length : matchedFiles.length
      if (matchCount === 0) {
        const hint = diagnoseZeroMatch(params.pattern, files)
        if (hint) {
          ;(data as Record<string, unknown>).hint = hint
        }
      }

      return Promise.resolve({ ok: true, data })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}

function collectFiles(base: string, globPattern?: string): string[] {
  let isDir = false
  try { isDir = statSync(base).isDirectory() } catch { return [] }

  if (!isDir) {
    return [base]
  }

  const fullGlob = globPattern
    ? resolve(base, '**', globPattern).replace(/\\/g, '/')
    : resolve(base, '**', '*').replace(/\\/g, '/')
  return globMatch(fullGlob).filter(f => {
    try { return !statSync(f).isDirectory() } catch { return false }
  })
}

function extractContext(lines: string[], idx: number, params: GrepParams): string[] {
  const before = params['-B'] ?? (params['-C'] ? params['-C'] : 0)
  const after = params['-A'] ?? (params['-C'] ? params['-C'] : 0)
  const start = Math.max(0, idx - before)
  const end = Math.min(lines.length, idx + after + 1)
  return lines.slice(start, end)
}

/**
 * 零匹配诊断：
 * 0 匹配时探测常见原因，给 AI 可操作的提示：
 * 1. 大小写不匹配（case-insensitive 探测有命中）
 * 2. 正则元字符需要转义（固定字符串探测有命中）
 * 只跑 2 次轻量探测（最多扫前 200 个文件各 1 遍），有命中才返回提示。
 */
function diagnoseZeroMatch(pattern: string, files: string[]): string | null {
  if (files.length === 0) return null
  // 只探测前 200 个文件（防诊断本身烧性能）
  const sample = files.slice(0, 200)

  // 1) 大小写探测：原模式 + i 标志
  try {
    const ciRegex = new RegExp(pattern, 'gi')
    for (const file of sample) {
      try {
        const stat = statSync(file)
        if (stat.size > MAX_FILE_BYTES) continue
        const content = readFileSync(file, 'utf-8')
        ciRegex.lastIndex = 0
        if (ciRegex.test(content)) {
          return '0 匹配——但忽略大小写后能找到，可能是大小写不匹配。检查 pattern 的大小写，或加 -i 参数。'
        }
      } catch { continue }
    }
  } catch {
    // 正则不合法，跳过大小写探测
  }

  // 2) 正则元字符探测：模式含元字符时，试固定字符串匹配
  if (/[.*+?^${}()|[\]\\]/.test(pattern)) {
    try {
      const fixedRegex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      for (const file of sample) {
        try {
          const stat = statSync(file)
          if (stat.size > MAX_FILE_BYTES) continue
          const content = readFileSync(file, 'utf-8')
          fixedRegex.lastIndex = 0
          if (fixedRegex.test(content)) {
            return '0 匹配——但作为固定字符串能找到，pattern 里的正则元字符可能干扰了匹配。若想搜字面量，请转义元字符（如 . 写成 \\.）。'
          }
        } catch { continue }
      }
    } catch { /* 忽略 */ }
  }

  return null
}
