/**
 * 健康检查文件层扫描（从 health-check.ts 拆出）。
 * scanWorkspace（扫描异常残留）。
 * 纯函数，不依赖 HealthCheck 实例状态。
 */
import { readdirSync } from 'fs'
import type { Dirent } from 'fs'
import { join } from 'path'

/** 扫描时排除的目录（大目录/产物目录/数据目录，避免扫描爆炸） */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.userdata',
  'userdata',
  'data',
  'tmp',
  'temp'
])

/**
 * 扫描工作区文件层异常：异常残留（.orig/.rej）。
 * 排除大目录，深度 ≤6，最多扫 maxFiles 个文件——性能可控，不阻塞主进程太久。
 */
export function scanWorkspace(
  root: string,
  opts: { maxFiles?: number } = {}
): { residues: string[] } {
  const maxFiles = opts.maxFiles ?? 3000
  const residues: string[] = []
  let scanned = 0

  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || scanned >= maxFiles) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (scanned >= maxFiles) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.has(e.name)) continue
        walk(full, depth + 1)
      } else if (e.isFile()) {
        scanned++
        if (/\.(orig|rej)$/i.test(e.name)) {
          residues.push(full)
        }
      }
    }
  }
  walk(root, 0)
  return { residues }
}