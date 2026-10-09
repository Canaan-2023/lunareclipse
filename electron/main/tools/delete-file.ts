/**
 * 删除文件工具：为什么存在——AI 整理文件时需要删除，但删除不可逆，行为必须明确可控；
 * 月蚀是本地 AI 助手，主流程允许全盘删除（用户授权），因此依赖工具描述中的
 * "不可逆操作，谨慎使用"提示 + recursive 显式语义来约束 AI，而不是路径白名单。
 * 作用：delete_file 按 file_paths 删除文件/目录（recursive 控制目录递归删除），
 * 逐路径 try/catch 保证单条失败不中断其余删除，结果数组供 AI 判断哪些失败。
 */
import { rmSync, existsSync } from 'fs'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

export interface DeleteFileParams {
  file_paths: string[]
  recursive?: boolean
}

export class DeleteFileTool implements Tool<DeleteFileParams> {
  name = 'DeleteFile'
  description = '批量删除文件或目录（不可逆操作，谨慎使用）。参数：file_paths（必填，绝对路径数组）/ recursive（目录递归删除，默认 true）。返回 { results: [{path, deleted, error?}], deletedCount }。删除前请确认路径正确，删除后无法恢复。'
  parameters = [
    { name: 'file_paths', type: 'array' as const, description: '绝对路径数组', required: true },
    { name: 'recursive', type: 'boolean' as const, description: '目录递归删除', required: false, default: true }
  ]

  execute(params: DeleteFileParams, ctx?: ToolContext): Promise<ToolResult> {
    const resolvePath = (p: string) => resolveToolPath(p, ctx)
    const recursive = params.recursive ?? true
    const results: Array<{ path: string; deleted: boolean; error?: string }> = []

    for (const p of params.file_paths) {
      const abs = resolvePath(p)
      try {
        if (!existsSync(abs)) {
          results.push({ path: abs, deleted: false, error: '不存在' })
          continue
        }
        rmSync(abs, { recursive, force: false })
        ctx?.handleAccessed?.(abs)
        results.push({ path: abs, deleted: true })
      } catch (err) {
        results.push({ path: abs, deleted: false, error: (err as Error).message })
      }
    }

    const ok = results.every(r => r.deleted)
    return Promise.resolve({ ok, data: { results, deletedCount: results.filter(r => r.deleted).length } })
  }
}
