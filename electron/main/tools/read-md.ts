/**
 * Markdown 阅读工具：为什么存在——提示词段等 md 文件需要以可读格式注入上下文，
 * 部分 JSON 数据源也可转为 md 视图统一呈现。
 * 作用：read_md 读取 md/文本文件（10MB 上限）并返回内容，json 文件可经 json-md-view 转视图。
 */
import { readFileSync, statSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { jsonFileToMdView } from '../services/json-md-view'

export interface ReadMdParams {
  file_path: string
}

/** 单文件读取大小上限（10MB），与 Read 工具一致 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/**
 * MD 视图读取工具
 *
 * 作用：读取 JSON 文件（记忆 / NNG / 缓存等）并转为 MD 视图——
 * 字段全保留、数组每项一行、嵌套缩进、路径/网址原样（结构级转换，不拆字符串）。
 * AI 想直观读 JSON 用本工具；想读原始 JSON 用 Read。
 */
export class ReadMdTool implements Tool<ReadMdParams> {
  name = 'read_md'
  description =
    '读取 JSON 文件并转为 MD 视图（记忆/NNG/缓存等 JSON 文件专用）。' +
    '数组自动每项一行、嵌套字段缩进、路径/网址原样不变（结构级转换，不拆分字符串内部）。' +
    '所有字段完整保留，适合直观理解结构化数据；想读原始 JSON 原文用 Read。' +
    '参数：file_path（必填，JSON 文件绝对路径）。非 JSON 文件返回原文。'
  parameters = [
    { name: 'file_path', type: 'string' as const, description: 'JSON 文件绝对路径', required: true }
  ]

  execute(params: ReadMdParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.file_path || typeof params.file_path !== 'string' || params.file_path.trim().length === 0) {
      return Promise.resolve({ ok: false, error: 'file_path 必填且不能为空' })
    }
    const filePath = resolveToolPath(params.file_path, ctx)
    try {
      const stat = statSync(filePath)
      if (stat.isDirectory()) {
        return Promise.resolve({ ok: false, error: `路径是目录不是文件: ${filePath}` })
      }
      if (!stat.isFile()) {
        return Promise.resolve({ ok: false, error: `文件不存在: ${filePath}` })
      }
      if (stat.size > MAX_FILE_BYTES) {
        return Promise.resolve({
          ok: false,
          error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`
        })
      }

      const raw = readFileSync(filePath, 'utf-8')
      ctx?.handleAccessed?.(filePath)

      // JSON → MD 视图（非 JSON 返回原文）
      const md = jsonFileToMdView(raw)
      return Promise.resolve({
        ok: true,
        data: {
          path: filePath.replace(/\\/g, '/'),
          view: md !== null ? 'md' : 'raw',
          content: md ?? raw
        }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: `读取失败: ${(err as Error).message}` })
    }
  }
}
