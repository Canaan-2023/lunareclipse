/**
 * path-security.ts — 路径穿越安全校验

 * 为什么存在：所有文件类工具（读/写/删/复制…）都必须把路径约束在允许的工作区内，
 * 否则 AI 可借 ../ 或 symlink 逃逸到任意目录；本模块是统一的路径边界校验层。
 * 路径校验共享助手：统一 resolve + 穿越检查。
 * - Node path.resolve 做词法归一化；路径存在时用 fs.realpathSync 解析 symlink（防逃逸）。
 * - 判越界用「等于 root 或以 root + sep 开头」，对不存在的路径也安全。
 */

import { resolve, sep } from 'node:path'
import { existsSync, realpathSync } from 'node:fs'

/**
 * 确保 *path* 解析后落在 *root* 内。

 * 返回错误信息字符串（校验失败时），安全时返回 null。
 * resolve 跟随 symlink 并归一化 `..` 组件。

 * 用法：const err = validateWithinDir(userPath, allowedRoot); if (err) return toolError(err)
 */
export function validateWithinDir(path: string, root: string): string | null {
  try {
    let resolved = resolve(path)
    let rootResolved = resolve(root)

    // 路径存在则解析 symlink（对齐 Python resolve 的符号链接跟随）；
    // 不存在（如写操作目标尚未创建）保留词法归一化结果。
    if (existsSync(resolved)) {
      resolved = realpathSync(resolved)
    }
    if (existsSync(rootResolved)) {
      rootResolved = realpathSync(rootResolved)
    }

    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
      return `Path escapes allowed directory: ${resolved}`
    }
    return null
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc)
    return `Path escapes allowed directory: ${msg}`
  }
}

/**
 * 路径字符串是否含 `..` 穿越组件。
 * 快速预检（不做完整解析），配合 validateWithinDir 使用。
 */
export function hasTraversalComponent(pathStr: string): boolean {
  return pathStr.split(/[\\/]+/).includes('..')
}
