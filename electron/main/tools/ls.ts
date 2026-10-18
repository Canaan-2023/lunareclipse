/**
 * 列目录工具：为什么存在——AI 需要快速查看目录结构、文件属性（大小/修改时间）以定位素材，
 * 是文件管理的最基础动作。
 * 作用：ls 列出目录条目并附带类型/大小/时间信息，支持 ignore 过滤。
 */
import { readdirSync, statSync } from 'fs'
import { resolve } from 'path'
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { resolveToolPath } from './base-tool'

export interface LSParams {
  path: string
  ignore?: string[]
}

export class LSTool implements Tool<LSParams> {
  name = 'LS'
  description = '列出目录下的文件和子目录。参数：path（必填，绝对路径）/ ignore（选填，glob 忽略模式数组，如 ["*.log", "node_modules"]）。返回 { path, count, items: [{name, type: "file"|"directory", path}] }，目录排前面再按字母序。需要看目录结构时用本工具；需要按文件名模式搜索用 Glob；需要搜文件内容用 Grep。'
  parameters = [
    { name: 'path', type: 'string' as const, description: '绝对路径', required: true },
    { name: 'ignore', type: 'array' as const, description: 'glob 忽略模式', required: false }
  ]

  // 行为声明：列目录纯读取无副作用
  behavior = {
    readOnly: true
  }

  execute(params: LSParams, ctx?: ToolContext): Promise<ToolResult> {
    // 搜索纪律内建（原内置 PreToolUse 守卫的 block 语义收敛到工具自身）：
    // path 必填，禁止无参列举当前目录（找文件用 Glob 精确匹配）。
    const pth = String(params.path ?? '').trim()
    if (!pth) {
      return Promise.resolve({
        ok: false,
        error: '搜索纪律守护：LS 必须带 path 参数限定目录（禁止无参列举当前目录）。找文件用 Glob 精确匹配，例：Glob(pattern="**/TodoPanel*", path="app/src")。'
      })
    }

    const dir = resolveToolPath(params.path, ctx)
    try {
      const stat = statSync(dir)
      if (!stat.isDirectory()) {
        return Promise.resolve({ ok: false, error: `不是目录: ${dir}` })
      }

      const entries = readdirSync(dir, { withFileTypes: true })
      const ignorePatterns = params.ignore ?? []
      const items = entries
        .filter(e => !isIgnored(e.name, ignorePatterns))
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: resolve(dir, e.name)
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      return Promise.resolve({
        ok: true,
        data: { path: dir, count: items.length, items }
      })
    } catch (err) {
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }
}

function isIgnored(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  for (const p of patterns) {
    if (p === name) return true
    if (p.startsWith('*') && name.endsWith(p.slice(1))) return true
    if (p.endsWith('*') && name.startsWith(p.slice(0, -1))) return true
  }
  return false
}
