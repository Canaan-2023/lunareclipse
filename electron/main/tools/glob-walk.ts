/**
 * 简易 glob 匹配实现：为什么存在——Electron 33 / Node 20 没有 fs.globSync，而工具链
 * 需要 ** / * / ? 通配符收集文件；本模块自研实现以兼容当前运行时。
 * 作用：globMatch 按通配符返回完整路径列表，内置常用跳过目录规则（DEFAULT_SKIP_DIRS）。
 */
import { readdirSync } from 'fs'
import type { Dirent } from 'fs'
import { sep } from 'path'

/**
 * 简易 glob 文件匹配（替代 Node.js 22+ 的 fs.globSync，兼容 Electron 33 / Node 20）
 * 支持 **、*、? 通配符，返回完整路径列表

 * 性能修复：walk 跳过巨型/无关目录（node_modules/构建产物/备份/桌面运行时），
 * 否则 Grep/Glob 全项目扫描会递归进数万文件的目录 + 同步 readFileSync 阻塞主进程 → 窗口卡死
 * （用户实测：无 Hook 拦截时 Grep 全项目扫卡死窗口；根因是 walk 无排除，Hook 只是治标）
 */
export function globMatch(fullPattern: string, ignore?: Set<string>): string[] {
  const normalized = fullPattern.replace(/\\/g, '/')
  const root = extractRoot(normalized)
  if (!root) return []
  const regex = globToRegExp(normalized)
  const results: string[] = []
  walk(root, (filePath) => {
    const normalizedPath = filePath.replace(/\\/g, '/')
    if (regex.test(normalizedPath)) {
      results.push(filePath)
    }
  }, ignore)
  return results
}

/**
 * 遍历时默认跳过的目录名（任意层级，命中即不进入）。
 * 只保留「巨型外部依赖/构建产物/版本控制/缓存」类目——它们是 Glob/Grep
 * 全项目扫描卡死主进程的根因（用户实测：无排除时 Grep 全项目扫卡死窗口），
 * 属性能保护而非路径限制。
 *
 * 2026-10-09 按用户要求放开路径限制：移除月蚀自身数据目录
 * （abyssac_data=技能/记忆/会话/RAW、userdata、.userdata）与用户参考目录
 * （tmp/code/游戏 MOD 参考等）的跳过——AI 的通用工具应能访问这些路径
 * （技能检索、记忆搜索、参考素材定位都依赖它们），只保留真实的性能红线。
 * 调用方可用 ignore 参数追加自定义排除（见 walk 签名）。
 */
export const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.svn',
  '.hg',
  'dist',
  'out',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.npm-cache',
  '.playwright-browsers'
])

/** 从 glob 模式中提取不含通配符的根目录 */
function extractRoot(normalizedPattern: string): string {
  const segments = normalizedPattern.split('/')
  let rootEnd = -1
  for (let i = 0; i < segments.length; i++) {
    if (/[*?]/.test(segments[i])) break
    rootEnd = i
  }
  if (rootEnd < 0) return ''
  let root = segments.slice(0, rootEnd + 1).join('/')
  // Windows 盘符根目录，如 D: → D:/
  if (/^[A-Za-z]:$/.test(root)) root += '/'
  return root
}

/** glob 模式转 RegExp（支持 **、*、?） */
function globToRegExp(pattern: string): RegExp {
  let re = '^'
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // **/ → 可选任意目录前缀（含 0 层）
        re += '(?:.*/)?'
        i += 3
      } else {
        // ** 末尾或后跟非 / 字符
        re += '.*'
        i += 2
      }
    } else if (c === '*') {
      // * 匹配单层内非分隔符
      re += '[^/]*'
      i++
    } else if (c === '?') {
      re += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
      i++
    } else {
      re += c
      i++
    }
  }
  re += '$'
  return new RegExp(re)
}

/**
 * 递归遍历目录（跳过 DEFAULT_SKIP_DIRS 中的目录名，任意层级）。
 * @param ignore 调用方追加排除的目录名集合（与默认排除合并）
 */
function walk(dir: string, cb: (p: string) => void, ignore?: Set<string>): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  const skip = ignore ? new Set([...DEFAULT_SKIP_DIRS, ...ignore]) : DEFAULT_SKIP_DIRS
  for (const entry of entries) {
    const full = dir.endsWith('/') ? dir + entry.name : dir + sep + entry.name
    if (entry.isDirectory()) {
      // 跳过巨型/无关目录（node_modules/构建产物/备份等）——防全项目扫描卡死主进程
      if (skip.has(entry.name)) continue
      walk(full, cb, ignore)
    } else if (entry.isFile()) {
      cb(full)
    }
  }
}
