/**
 * 编辑文件工具：为什么存在——AI 改文件最怕整文件重写丢上下文；基于精确替换 + 模糊匹配
 * 的小改动既省 token 又容错。
 * 作用：edit 调用 fuzzy-match 九层匹配定位 old_string，经原子写回文件并返回行变更统计。
 */
import { readFileSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'
import { applyEditToFile, writeFileSafe, countLineDiff } from './edit-engine/file-operations'
import { fuzzyMatch, normalizeLineEndings } from './edit-engine/fuzzy-match'

export interface EditParams {
  file_path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

export class EditTool implements Tool<EditParams> {
  name = 'Edit'
  description = '字符串替换编辑（安全修改文件首选，内置模糊匹配引擎）。参数：file_path（必填，绝对路径）/ old_string（必填，要替换的字符串，需在文件中唯一除非 replace_all）/ new_string（必填，替换为）/ replace_all（选填，替换全部匹配，默认 false）。返回 { path, replacements, addedLines, removedLines }。old_string 在文件中不唯一且未设 replace_all 时会报错，需提供更长上下文。支持 CRLF/BOM 文件（自动保持行尾与 BOM），匹配失败时给出相近行提示。'
  parameters = [
    { name: 'file_path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'old_string', type: 'string' as const, description: '要替换的字符串', required: true },
    { name: 'new_string', type: 'string' as const, description: '替换为的字符串', required: true },
    { name: 'replace_all', type: 'boolean' as const, description: '是否全部替换', required: false, default: false }
  ]

  async execute(params: EditParams, ctx?: ToolContext): Promise<ToolResult> {
    const filePath = resolveToolPath(params.file_path, ctx)
    try {
      const { old_string, new_string, replace_all } = params

      if (old_string === new_string) {
        return { ok: false, error: 'old_string 与 new_string 相同' }
      }

      if (replace_all) {
        return this.replaceAll(filePath, old_string, new_string, ctx)
      }

      // 改前读旧内容（供行 diff）
      const oldContent = readFileSync(filePath, 'utf-8')

      const res = applyEditToFile(filePath, old_string, new_string)

      if (res.alreadyApplied) {
        return {
          ok: true,
          data: {
            path: filePath,
            replacements: 0,
            note: '编辑已应用（old 已被替换或 old==new），无需修改'
          }
        }
      }
      if (!res.ok) {
        return { ok: false, error: res.error ?? '编辑失败' }
      }

      const newContent = readFileSync(filePath, 'utf-8')
      const diff = countLineDiff(oldContent, newContent)

      ctx?.handleAccessed?.(filePath)

      return {
        ok: true,
        data: {
          path: filePath,
          replacements: 1,
          strategy: res.strategy,
          verified: res.verified,
          addedLines: diff.added,
          removedLines: diff.removed
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  /** replace_all：fuzzyMatch 拿归一化 old/new → 全文替换 → 保持行尾/BOM 原子写 */
  private replaceAll(filePath: string, old_string: string, new_string: string, ctx?: ToolContext): ToolResult {
    try {
      const oldContent = readFileSync(filePath, 'utf-8')
      const result = fuzzyMatch(oldContent, old_string, new_string)

      if (result.alreadyApplied) {
        return {
          ok: true,
          data: {
            path: filePath,
            replacements: 0,
            note: '编辑已应用（old 已被替换或 old==new），无需修改'
          }
        }
      }
      if (!result.matched) {
        return { ok: false, error: `未找到匹配: ${old_string.slice(0, 50)}...` }
      }

      // 归一化空间全文替换，再保持原行尾
      const normContent = normalizeLineEndings(oldContent, '\n')
      const newContentNorm = normContent.split(result.normalizedOld).join(result.normalizedNew)

      const wres = writeFileSafe(filePath, newContentNorm)
      if (!wres.verified) {
        return { ok: false, error: '写入后验证失败' }
      }

      const newContent = readFileSync(filePath, 'utf-8')
      const diff = countLineDiff(oldContent, newContent)
      const count = normContent.split(result.normalizedOld).length - 1

      ctx?.handleAccessed?.(filePath)

      return {
        ok: true,
        data: {
          path: filePath,
          replacements: count,
          strategy: result.strategy,
          verified: true,
          addedLines: diff.added,
          removedLines: diff.removed
        }
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}