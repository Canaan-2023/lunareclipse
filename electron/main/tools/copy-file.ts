/**
 * 复制文件工具：为什么存在——AI 需要复制文件/目录（备份、归档、重组素材）；
 * 月蚀是本地 AI 助手，主流程不限制目标路径（用户授权全盘操作），
 * relative 路径按 cwd 解析、绝对路径直通（见 base-tool.ts resolveToolPath 设计说明）。
 * 作用：copy_file 复制单个文件或整个目录（递归），自动创建目标父目录，
 * 逐路径 try/catch 隔离失败，dirCount/fileCount 供 AI 核对复制结果。
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from 'fs'
import { dirname } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

export interface CopyFileParams {
  source_path: string
  target_path: string
  recursive?: boolean
}

export class CopyFileTool implements Tool<CopyFileParams> {
  name = 'CopyFile'
  description = '复制文件或目录。参数：source_path（必填，源路径）/ target_path（必填，完整目标路径含文件名）/ recursive（选填，目录递归复制，默认 true）。返回 { source, target, copied, isDirectory }。自动创建目标父目录。'
  parameters = [
    { name: 'source_path', type: 'string' as const, description: '源路径（绝对）', required: true },
    { name: 'target_path', type: 'string' as const, description: '目标路径（绝对，含文件名）', required: true },
    { name: 'recursive', type: 'boolean' as const, description: '目录递归复制', required: false, default: true }
  ]

  execute(params: CopyFileParams, ctx?: ToolContext): Promise<ToolResult> {
    const resolvePath = (p: string) => resolveToolPath(p, ctx)
    const src = resolvePath(params.source_path)
    const dst = resolvePath(params.target_path)
    try {
      if (!existsSync(src)) {
        return Promise.resolve({ ok: false, error: `源路径不存在: ${src}` })
      }
      mkdirSync(dirname(dst), { recursive: true })
      const stat = statSync(src)
      if (stat.isDirectory()) {
        cpSync(src, dst, { recursive: params.recursive ?? true })
      } else {
        copyFileSync(src, dst)
      }
      ctx?.handleAccessed?.(dst)
      return Promise.resolve({
        ok: true,
        data: { source: src, target: dst, copied: true, isDirectory: stat.isDirectory() }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}
