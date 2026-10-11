/**
 * 文件查找工具：为什么存在——AI 需要按 glob 参数在工作区找文件（如匹配全部 ts 文件的那种模式），
 * 但匹配过多时排序会卡住主进程，必须设上限。
 * 作用：Glob 工具基于 globMatch 收集文件并按修改时间倒序返回（上限 2000，超限截断）。
 */
import { statSync } from 'fs'
import { resolve, isAbsolute } from 'path'
import { globMatch } from './glob-walk'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

/** Glob 返回文件数硬上限：匹配过多时排序（逐文件 statSync）会卡主进程，截断返回 */
const GLOB_MAX_RESULTS = 2000

export interface GlobParams {
  pattern: string
  path?: string
}

export class GlobTool implements Tool<GlobParams> {
  name = 'Glob'
  description = '按 glob 模式匹配文件路径。参数：pattern（必填，如 "**/*.ts" 匹配所有 ts 文件）/ path（选填，搜索目录，默认当前目录）。返回 { base, pattern, count, truncated, files }，files 按修改时间倒序（最近改的排前面）。⚠️ 仅跳过 node_modules/dist/build/缓存等巨型依赖目录（性能保护）；月蚀自身数据（abyssac_data、userdata、技能/记忆/会话）与用户参考目录均完整可访问。匹配超过 2000 个文件时截断（truncated=true）。按文件名模式找文件用本工具；看目录结构用 LS；搜文件内容用 Grep。'
  parameters = [
    { name: 'pattern', type: 'string' as const, description: 'glob 模式，如 "**/*.ts"', required: true },
    { name: 'path', type: 'string' as const, description: '搜索目录（默认当前目录）', required: false }
  ]

  execute(params: GlobParams, ctx?: ToolContext): Promise<ToolResult> {
    const base = params.path
      ? resolveToolPath(params.path, ctx)
      : process.cwd()
    try {
      const fullPattern = isAbsolute(params.pattern)
        ? params.pattern
        : resolve(base, params.pattern).replace(/\\/g, '/')

      const matches = globMatch(fullPattern)
      // 性能修复：匹配过多时按 mtime 排序（每个文件 statSync）会卡主进程——硬上限截断
      const capped = matches.length > GLOB_MAX_RESULTS ? matches.slice(0, GLOB_MAX_RESULTS) : matches
      const sorted = sortByMtimeDesc(capped)

      return Promise.resolve({
        ok: true,
        data: {
          base,
          pattern: params.pattern,
          count: matches.length,
          truncated: matches.length > GLOB_MAX_RESULTS,
          files: sorted
        }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}

function sortByMtimeDesc(files: string[]): string[] {
  return files
    .map(f => ({ f, t: safeMtime(f) }))
    .sort((a, b) => b.t - a.t)
    .map(x => x.f)
}

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs } catch { return 0 }
}
