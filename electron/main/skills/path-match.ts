/**
 * skill 路径激活匹配：skill 可声明 paths（glob 模式），
 * 用户在编辑器打开匹配路径的文件时自动激活对应技能。
 * 独立成文件以集中 glob 匹配实现（含通配符上限防 ReDoS），
 * 并供加载器与预览联动复用。
 */
import type { SkillMetadata } from './types'
import type { SkillLoader } from './loader'

/** glob 模式中允许的最大通配符数量（防止 ReDoS） */
const GLOB_MAX_WILDCARDS = 20

/**
 * glob 匹配（简单实现：单星匹配任意非分隔符字符，双星匹配任意含分隔符，问号单字符）。
 * paths 字段声明用（如 "*.tsx" 或 "src/任意深度的 ts 文件"），不引第三方依赖。
 */
export function globMatch(pattern: string, input: string): boolean {
  const normalized = input.replace(/\\/g, '/')
  const safePattern = pattern.replace(/\*{3,}/g, '**')
  const wildcardCount = (safePattern.match(/\*/g) || []).length
  if (wildcardCount > GLOB_MAX_WILDCARDS) return false
  let re = ''
  let i = 0
  while (i < safePattern.length) {
    const c = safePattern[i]
    if (c === '*') {
      if (safePattern[i + 1] === '*') {
        re += '(?:.*/)?'
        i += 2
        if (safePattern[i] === '/') i++
        continue
      }
      re += '[^/]*'
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+()^${}[]|\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
    i++
  }
  const hasSlash = safePattern.includes('/')
  if (hasSlash) {
    return new RegExp('^' + re + '$').test(normalized)
  }
  const base = normalized.split('/').pop() ?? ''
  return new RegExp('^' + re + '$').test(base)
}

/** 判断某路径是否匹配 skill 声明的 paths（glob 自动激活） */
export function matchSkillPath(meta: SkillMetadata, filePath: string): boolean {
  if (!meta.paths || meta.paths.length === 0) return false
  return meta.paths.some((p) => globMatch(p, filePath))
}

/** 列出被某路径激活的 skill（工作区文件预览时用） */
export function skillsActivatedByPath(loader: SkillLoader, filePath: string): SkillMetadata[] {
  return loader.listMetadata().filter((s) => matchSkillPath(s, filePath))
}