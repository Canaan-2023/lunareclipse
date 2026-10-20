/**
 * SKILL.md frontmatter 解析与校验：skill 的元数据（名称/描述/钩子/路径等）
 * 以 YAML frontmatter 承载，解析结果决定技能如何被索引与触发。
 * 统一用 js-yaml 解析 + kebab-case→camelCase 映射 + 字段校验，
 * 避免各加载环节对 frontmatter 的处理不一致。
 */
import { readFileSync } from 'fs'
import { dirname } from 'path'
import * as yaml from 'js-yaml'
import type {
  SkillMetadata,
  SkillFrontmatter,
  SkillSource,
  SkillContext,
  SkillExtraFields
} from './types'
import { SkillValidationError } from './types'

/** frontmatter 字段限制常量 */
const MAX_NAME_LENGTH = 64
const MAX_DESCRIPTION_LENGTH = 1024
const RESERVED_WORDS = ['lunareclipse', 'moon']
const FRONTMATTER_DELIMITER = '---'

/** YAML frontmatter kebab-case key → SkillFrontmatter camelCase 属性映射 */
const FRONTMATTER_KEY_MAP: Record<string, keyof SkillFrontmatter> = {
  'name': 'name',
  'description': 'description',
  'disable-model-invocation': 'disableModelInvocation',
  'user-invocable': 'userInvocable',
  'context': 'context',
  'allowed-tools': 'allowedTools',
  'paths': 'paths',
  'platforms': 'platforms',
  'dependencies': 'dependencies',
  'related-skills': 'relatedSkills',
  'tags': 'tags',
  'requires-tools': 'requiresTools',
  'fallback-for-tools': 'fallbackForTools',
  'hooks': 'hooks',
  'config': 'config',
  'version': 'version',
  'author': 'author',
  'license': 'license',
  'homepage': 'homepage',
  'category': 'category',
  'domain': 'domain'
}

/**
 * 解析 SKILL.md 文件：提取 frontmatter + 校验字段
 */
export function parseSkillFile(filePath: string, source: SkillSource): SkillMetadata {
  const raw = readFileSync(filePath, 'utf-8')
  const frontmatter = parseFrontmatter(raw)
  validateFrontmatter(frontmatter, filePath)
  const { extraFields, ...rest } = frontmatter as SkillFrontmatter & { extraFields?: SkillExtraFields }
  return {
    ...rest,
    extraFields,
    source,
    filePath,
    // dirPath = 去掉文件名后的目录路径。用 path.dirname 处理跨平台分隔符
    // （原实现用 lastIndexOf 嵌套三元表达式，逻辑错误且类型不匹配）
    dirPath: dirname(filePath),
    runtime: { enabled: true } // 默认启用，load() 时会被配置覆盖
  }
}

/**
 * 解析 frontmatter（--- 之间的 YAML）
 * 使用 js-yaml 替代手写解析器，正确处理多行值、转义、嵌套等边界情况
 */
export function parseFrontmatter(raw: string): SkillFrontmatter {
  const lines = raw.split('\n')
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_DELIMITER) {
    throw new SkillValidationError('', 'SKILL.md 必须以 --- 开头的 frontmatter 开始')
  }
  let endLine = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_DELIMITER) {
      endLine = i
      break
    }
  }
  if (endLine === -1) {
    throw new SkillValidationError('', 'frontmatter 未闭合（缺少结束 ---）')
  }

  const yamlContent = lines.slice(1, endLine).join('\n')
  let parsed: Record<string, unknown>
  try {
    parsed = yaml.load(yamlContent) as Record<string, unknown>
  } catch (err) {
    throw new SkillValidationError('', `frontmatter YAML 解析失败: ${(err as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillValidationError('', 'frontmatter 内容为空或非对象')
  }

  const result: Partial<SkillFrontmatter> = {}
  const extraFields: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(parsed)) {
    const mappedKey = FRONTMATTER_KEY_MAP[key]
    if (mappedKey) {
      applyFrontmatterField(result, mappedKey, value)
    } else {
      extraFields[key] = value
    }
  }

  if (!result.name) throw new SkillValidationError('', '缺少必填字段：name')
  if (!result.description) throw new SkillValidationError('', '缺少必填字段：description')
  const fm = result as SkillFrontmatter & { extraFields?: SkillExtraFields }
  if (Object.keys(extraFields).length > 0) {
    fm.extraFields = extraFields
  }
  return fm
}

/** 将 js-yaml 解析出的值赋到 SkillFrontmatter 对应属性，处理类型转换 */
export function applyFrontmatterField(
  target: Partial<SkillFrontmatter>,
  key: keyof SkillFrontmatter,
  value: unknown
): void {
  switch (key) {
    case 'name':
    case 'description':
    case 'version':
    case 'author':
    case 'license':
    case 'homepage':
    case 'category':
      if (typeof value === 'string') {
        (target as Record<string, unknown>)[key] = value
      } else if (value !== null && value !== undefined) {
        (target as Record<string, unknown>)[key] = String(value)
      }
      break
    case 'domain':
      // 空字符串/纯空白视为未声明（领域判定以文件夹路径为准，frontmatter 声明仅保留展示），不写入 target
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed) (target as Record<string, unknown>)[key] = trimmed
      } else if (value !== null && value !== undefined) {
        const coerced = String(value).trim()
        if (coerced) (target as Record<string, unknown>)[key] = coerced
      }
      break
    case 'disableModelInvocation':
      target.disableModelInvocation = value === true || value === 'true'
      break
    case 'userInvocable':
      target.userInvocable = value !== false && value !== 'false'
      break
    case 'context':
      if (value === 'inline' || value === 'fork') {
        target.context = value as SkillContext
      }
      break
    case 'allowedTools':
    case 'paths':
    case 'platforms':
    case 'dependencies':
    case 'relatedSkills':
    case 'tags':
    case 'requiresTools':
    case 'fallbackForTools':
      (target as Record<string, unknown>)[key] = normalizeStringArray(value)
      break
    default:
      // hooks / config / 其他已知对象字段：直接赋值（js-yaml 已解析为正确结构）
      if (value !== null && value !== undefined) {
        (target as Record<string, unknown>)[key] = value
      }
      break
  }
}

/** 将标量值包装为数组，保证数组字段类型一致 */
export function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : String(v)))
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? [trimmed] : undefined
  }
  return [String(value)]
}

/** 提取 frontmatter 之后的正文（L2 指令） */
export function extractBody(raw: string): string {
  const lines = raw.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return raw
  let endLine = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { endLine = i; break }
  }
  if (endLine === -1) return raw
  return lines.slice(endLine + 1).join('\n').trim()
}

/** 校验 frontmatter 字段 */
export function validateFrontmatter(fm: SkillFrontmatter, filePath: string): void {
  const err = (msg: string) => new SkillValidationError(filePath, msg)

  // name 校验
  if (fm.name.length > MAX_NAME_LENGTH) {
    throw err(`name 超过 ${MAX_NAME_LENGTH} 字符（当前 ${fm.name.length}）`)
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name)) {
    throw err(`name 必须是 kebab-case（小写字母/数字/连字符）：${fm.name}`)
  }
  if (RESERVED_WORDS.some((w) => fm.name.toLowerCase().includes(w))) {
    throw err(`name 不能包含保留词：${RESERVED_WORDS.join(', ')}`)
  }
  if (/<[^>]+>/.test(fm.name)) {
    throw err('name 不能包含 XML 标签')
  }

  // description 校验
  if (!fm.description.trim()) {
    throw err('description 不能为空')
  }
  if (fm.description.length > MAX_DESCRIPTION_LENGTH) {
    throw err(`description 超过 ${MAX_DESCRIPTION_LENGTH} 字符（当前 ${fm.description.length}）`)
  }
  if (/<[^>]+>/.test(fm.description)) {
    throw err('description 不能包含 XML 标签')
  }

  // ===== 扩展字段校验 =====
  // platforms 合法值
  const VALID_PLATFORMS = ['linux', 'macos', 'windows']
  if (fm.platforms) {
    for (const p of fm.platforms) {
      if (!VALID_PLATFORMS.includes(p)) {
        throw err(`platforms 含非法值: ${p}（合法: ${VALID_PLATFORMS.join('/')}）`)
      }
    }
  }
  // config 格式（key/description 必填）
  if (fm.config) {
    for (const c of fm.config) {
      if (!c.key?.trim()) throw err('config 项缺少 key')
      if (!c.description?.trim()) throw err(`config 项 ${c.key} 缺少 description`)
    }
  }
  // version 宽松校验（x.y.z 或纯数字）
  if (fm.version && !/^[\w.+-]+$/.test(fm.version)) {
    throw err(`version 格式非法: ${fm.version}`)
  }
  // domain 声明值校验：kebab-case 且 ≤32 字符（用户级技能保留的展示字段；
  // 领域级技能领域由目录路径判定、此声明不参与，故仅为用户级旧格式提供温和约束）
  if (fm.domain) {
    if (fm.domain.length > 32) {
      throw err(`domain 超过 32 字符（当前 ${fm.domain.length}）`)
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.domain)) {
      throw err(`domain 必须是 kebab-case（小写字母/数字/连字符）：${fm.domain}`)
    }
  }
}