/**
 * 移动/重命名文件工具：为什么存在——AI 整理文件时需要在工作区内移动或改名，
 * 与复制/删除一起构成完整的文件管理能力。
 * 作用：move_file 在同一文件系统内 rename（兼容跨目录移动），路径经 resolveToolPath 校验。
 */
import { renameSync, existsSync, mkdirSync, statSync } from 'fs'
import { dirname, sep } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

export interface MoveFileParams {
  source_path: string
  target_path: string
}

export class MoveFileTool implements Tool<MoveFileParams> {
  name = 'MoveFile'
  description = '移动或重命名文件/目录。参数：source_path（必填，源路径）/ target_path（必填，完整目标路径含文件名）。返回 { source, target, moved, isDirectory }。自动创建目标父目录。源路径不存在会报错。'
  parameters = [
    { name: 'source_path', type: 'string' as const, description: '源路径（绝对）', required: true },
    { name: 'target_path', type: 'string' as const, description: '目标路径（绝对，含文件名）', required: true }
  ]

  execute(params: MoveFileParams, ctx?: ToolContext): Promise<ToolResult> {
    const resolvePath = (p: string) => resolveToolPath(p, ctx)
    const src = resolvePath(params.source_path)
    const dst = resolvePath(params.target_path)
    try {
      if (!existsSync(src)) {
        return Promise.resolve({ ok: false, error: `源路径不存在: ${src}` })
      }
      if (src === dst) {
        return Promise.resolve({ ok: true, data: { source: src, target: dst, moved: false, reason: 'same path' } })
      }
      // 防自嵌套：目标位于源路径内部（如把 A 目录移到 A/B）时，Windows 上 renameSync 必然 EPERM，
      // 且先 mkdir 会在源内部留下残留目录。与 loader 迁移同源的坑，通用工具必须拦在入口。
      if (dst.startsWith(src + sep)) {
        return Promise.resolve({ ok: false, error: `目标路径位于源路径内部（自嵌套），拒绝移动: ${src} -> ${dst}` })
      }
      mkdirSync(dirname(dst), { recursive: true })
      renameSync(src, dst)
      ctx?.handleAccessed?.(src)
      ctx?.handleAccessed?.(dst)
      return Promise.resolve({
        ok: true,
        data: { source: src, target: dst, moved: true, isDirectory: statSync(dst).isDirectory() }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}
