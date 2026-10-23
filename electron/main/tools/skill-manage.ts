/**
 * Skill 管理工具：为什么存在——AI 需要自主创建/更新/删除技能（SKILL.md）来沉淀方法论，
 * 是技能生态的自我驱动能力。
 * 作用：skill_manage 按 action=create/update/delete 校验并写/删 SKILL.md（含 frontmatter 构建）。
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { AnyTool, ToolResult, ToolContext } from './base-tool'
import { getUserSkillsDir, getDomainSkillsDir, parseSkillFile } from '../skills/loader'

/**
 * skill_manage：Skill CRUD 合并工具（action=create/update/delete）。
 *
 * - skill 是程序性记忆：任务完成后把可复用流程固化成 SKILL.md，下次直接加载执行。
 * - 三个 action 合并为一个工具，减少工具数量。
 * - 写入后 SkillLoader 的 watcher 自动热重载。
 */

const SKILL_MD = 'SKILL.md'
const FM_KEYS = [
  'name', 'description', 'disable-model-invocation', 'user-invocable', 'context',
  'allowed-tools', 'paths', 'hooks',
  'version', 'author', 'license', 'homepage', 'platforms', 'dependencies',
  'related-skills', 'tags', 'category', 'requires-tools', 'fallback-for-tools', 'config'
]

function validateSkillName(name: string): string | null {
  const n = name.trim()
  if (!n) return '技能名不能为空'
  if (n.length > 64) return `技能名超过 64 字符（当前 ${n.length}）`
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(n)) return '技能名必须是 kebab-case（小写字母/数字/连字符，如 task-orchestration）'
  if (/<[^>]+>/.test(n)) return '技能名不能包含 XML 标签'
  return null
}

function buildFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ['---']
  for (const key of FM_KEYS) {
    const v = fm[key]
    if (v === undefined || v === null) continue
    if (typeof v === 'boolean') {
      lines.push(`${key}: ${v}`)
    } else if (Array.isArray(v)) {
      if (v.length === 0) continue
      if (typeof v[0] === 'object' && v[0] !== null) {
        lines.push(`${key}:`)
        for (const item of v as Array<Record<string, unknown>>) {
          const keyStr = String(item.key ?? '')
          lines.push(`  - key: ${keyStr.replace(/\n/g, ' ')}`)
          if (item.description !== undefined && item.description !== null) {
            lines.push(`    description: ${String(item.description).replace(/\n/g, ' ')}`)
          }
          if (item.default !== undefined && item.default !== null) {
            lines.push(`    default: ${String(item.default).replace(/\n/g, ' ')}`)
          }
          if (item.prompt !== undefined && item.prompt !== null) {
            lines.push(`    prompt: ${String(item.prompt).replace(/\n/g, ' ')}`)
          }
        }
      } else {
        lines.push(`${key}:`)
        for (const item of v) lines.push(`  - ${item}`)
      }
    } else if (typeof v === 'object') {
      const obj = v as Record<string, unknown>
      lines.push(`${key}:`)
      for (const [k2, v2] of Object.entries(obj)) {
        if (v2 !== undefined && v2 !== null) lines.push(`  ${k2}: ${v2}`)
      }
    } else {
      lines.push(`${key}: ${String(v).replace(/\n/g, ' ')}`)
    }
  }
  lines.push('---')
  return lines.join('\n')
}

function buildSkillMd(params: Record<string, unknown>, body: string): string {
  const fm: Record<string, unknown> = {
    name: params.name,
    description: params.description
  }
  if (typeof params.disable_model_invocation === 'boolean') {
    fm['disable-model-invocation'] = params.disable_model_invocation
  }
  if (typeof params.user_invocable === 'boolean') {
    fm['user-invocable'] = params.user_invocable
  }
  if (params.context === 'inline' || params.context === 'fork') {
    fm.context = params.context
  }
  if (Array.isArray(params.allowed_tools) && params.allowed_tools.length > 0) {
    fm['allowed-tools'] = params.allowed_tools as string[]
  }
  if (Array.isArray(params.paths) && params.paths.length > 0) {
    fm.paths = params.paths as string[]
  }
  if (params.hooks && typeof params.hooks === 'object') {
    fm.hooks = params.hooks as Record<string, unknown>
  }
  for (const [paramKey, fmKey] of [
    ['version', 'version'], ['author', 'author'], ['license', 'license'],
    ['homepage', 'homepage'], ['category', 'category']
  ] as const) {
    if (typeof params[paramKey] === 'string' && String(params[paramKey]).trim()) {
      fm[fmKey] = String(params[paramKey]).trim()
    }
  }
  for (const [paramKey, fmKey] of [
    ['platforms', 'platforms'], ['dependencies', 'dependencies'],
    ['related_skills', 'related-skills'], ['tags', 'tags'],
    ['requires_tools', 'requires-tools'], ['fallback_for_tools', 'fallback-for-tools']
  ] as const) {
    if (Array.isArray(params[paramKey]) && (params[paramKey] as unknown[]).length > 0) {
      fm[fmKey] = params[paramKey] as string[]
    }
  }
  if (Array.isArray(params.config) && params.config.length > 0) {
    fm.config = params.config as Record<string, unknown>[]
  }
  const frontmatter = buildFrontmatter(fm)
  const bodyText = typeof body === 'string' ? body.trim() : ''
  return bodyText ? `${frontmatter}\n\n${bodyText}\n` : `${frontmatter}\n`
}

function skillDir(name: string, source?: string, domain?: string): string {
  if (source === 'domain') {
    // getDomainSkillsDir 未登录时回退 {root}/skills_domains（不再返回 null），故无需可用性守卫
    const domainRoot = getDomainSkillsDir()
    const dir = domain ? join(domainRoot, domain, name) : join(domainRoot, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  return join(getUserSkillsDir(), name)
}

function parseExisting(filePath: string): Record<string, unknown> | null {
  try {
    const meta = parseSkillFile(filePath, 'user')
    return {
      name: meta.name,
      description: meta.description,
      disableModelInvocation: meta.disableModelInvocation,
      userInvocable: meta.userInvocable,
      context: meta.context,
      allowedTools: meta.allowedTools,
      paths: meta.paths,
      hooks: meta.hooks,
      version: meta.version,
      author: meta.author,
      license: meta.license,
      homepage: meta.homepage,
      category: meta.category,
      platforms: meta.platforms,
      dependencies: meta.dependencies,
      relatedSkills: meta.relatedSkills,
      tags: meta.tags,
      requiresTools: meta.requiresTools,
      fallbackForTools: meta.fallbackForTools,
      config: meta.config
    }
  } catch {
    return null
  }
}

function extractBody(raw: string): string {
  const lines = raw.split('\n')
  if (lines.length === 0 || lines[0].trim() !== '---') return raw.trim()
  let endLine = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endLine = i
      break
    }
  }
  if (endLine === -1) return raw.trim()
  return lines.slice(endLine + 1).join('\n').trim()
}

export class SkillManageTool {
  name = 'skill_manage'
  description = `管理 Skill（程序性记忆）。action：create=创建新技能 / update=增量合并更新 / delete=删除技能。name=技能名（kebab-case）。source 选 user（默认，用户级）或 domain（领域级）。领域 = 技能存放的文件夹路径，数量与层级不限（如 design、design/web）：source=domain 时用 domain 参数指定该路径，领域由安装位置承载，不写入技能文件。description=技能描述（做什么+何时用，AI 触发依据）；body=技能正文 Markdown SOP（create 必填）。其余可选字段见参数表。

何时用：复杂多步流程以后会再遇→create；按 skill 执行后步骤过时/有坑→update；技能废弃→delete。

约束：create 遇已存在技能名拒绝（用 update）；update 只改传入字段；delete 可删用户级与领域级；写入后立即生效。`
  parameters = [
    { name: 'action', type: 'string' as const, description: 'create / update / delete', required: true },
    { name: 'name', type: 'string' as const, description: '技能名（kebab-case）', required: true },
    { name: 'source', type: 'string' as const, description: 'user=用户级（默认）/ domain=领域级', required: false },
    { name: 'domain', type: 'string' as const, description: '领域路径（文件夹层级，如 design、design/web，数量与层级不限），仅 source=domain 时生效', required: false },
    { name: 'description', type: 'string' as const, description: '技能描述（做什么+何时用）', required: false },
    { name: 'body', type: 'string' as const, description: '技能正文（Markdown SOP）', required: false },
    { name: 'disable_model_invocation', type: 'boolean' as const, description: '禁用 AI 自动触发', required: false },
    { name: 'user_invocable', type: 'boolean' as const, description: '用户菜单可见', required: false },
    { name: 'context', type: 'string' as const, description: 'inline / fork', required: false },
    { name: 'allowed_tools', type: 'array' as const, description: '允许使用的工具名列表（不填则继承全部已启用工具）', required: false },
    { name: 'paths', type: 'array' as const, description: '文件 glob 自动激活', required: false },
    { name: 'hooks', type: 'object' as const, description: '{pre_execute?, post_execute?} 生命周期钩子', required: false },
    { name: 'version', type: 'string' as const, description: '版本号', required: false },
    { name: 'author', type: 'string' as const, description: '作者', required: false },
    { name: 'license', type: 'string' as const, description: '许可证', required: false },
    { name: 'homepage', type: 'string' as const, description: '来源链接', required: false },
    { name: 'category', type: 'string' as const, description: '分类', required: false },
    { name: 'platforms', type: 'array' as const, description: '平台门控（linux/macos/windows）', required: false },
    { name: 'dependencies', type: 'array' as const, description: '依赖声明', required: false },
    { name: 'related_skills', type: 'array' as const, description: '互链技能名', required: false },
    { name: 'tags', type: 'array' as const, description: '分类标签', required: false },
    { name: 'requires_tools', type: 'array' as const, description: '条件激活：缺这些工具时隐藏', required: false },
    { name: 'fallback_for_tools', type: 'array' as const, description: '条件激活：有这些工具时隐藏', required: false },
    { name: 'config', type: 'array' as const, description: '配置声明 [{key, description, default?, prompt?}]', required: false }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const action = String(params.action ?? '').trim()
    if (!['create', 'update', 'delete'].includes(action)) {
      return { ok: false, error: 'action 必填（create / update / delete）' }
    }
    if (action === 'create') return this.create(params, ctx)
    if (action === 'update') return this.update(params, ctx)
    return this.delete(params, ctx)
  }

  private async create(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const nameErr = validateSkillName(name)
    if (nameErr) return { ok: false, error: nameErr }
    const description = typeof params.description === 'string' ? params.description.trim() : ''
    if (!description) return { ok: false, error: 'description 必填' }
    if (description.length > 1024) return { ok: false, error: `description 超过 1024 字符（当前 ${description.length}）` }
    const body = typeof params.body === 'string' ? params.body : ''
    if (!body.trim()) return { ok: false, error: 'body 必填' }

    const source = typeof params.source === 'string' ? params.source : 'user'
    const domain = typeof params.domain === 'string' ? params.domain.trim() : undefined
    if (source !== 'user' && source !== 'domain') {
      return { ok: false, error: 'source 只能是 user 或 domain' }
    }
    if (source === 'domain' && !domain) {
      return { ok: false, error: 'source=domain 时必须指定 domain（领域分类目录名）' }
    }

    const dir = skillDir(name, source, domain)
    const filePath = join(dir, SKILL_MD)
    if (existsSync(filePath)) return { ok: false, error: `技能 "${name}" 已存在。用 action=update 修改。` }

    if (!ctx?.requestPermission) return { ok: false, error: '创建技能需要用户授权' }
    const perm = await ctx.requestPermission({
      type: 'command',
      description: `AI 请求创建 Skill「${name}」（${description.slice(0, 100)}）${source === 'domain' ? `[领域级/${domain}]` : '[用户级]'}`,
      content: filePath,
      risk: 'low'
    })
    if (!perm.allowed) return { ok: false, error: `用户拒绝：${perm.reason ?? '无原因'}` }

    try {
      mkdirSync(dir, { recursive: true })
      const content = buildSkillMd(params, body)
      writeFileSync(filePath, content, 'utf-8')
      try {
        parseSkillFile(filePath, source as 'user' | 'domain')
      } catch (err) {
        rmSync(dir, { recursive: true, force: true })
        return { ok: false, error: `frontmatter 校验失败，已回滚：${(err as Error).message}` }
      }
      ctx?.skillLoader?.load()
      return { ok: true, data: { name, path: filePath.replace(/\\/g, '/'), source, domain, created: true, message: `Skill "${name}" 已创建并生效` } }
    } catch (err) {
      return { ok: false, error: `创建 Skill 失败: ${(err as Error).message}` }
    }
  }

  private async update(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const nameErr = validateSkillName(name)
    if (nameErr) return { ok: false, error: nameErr }

    // 从已加载的元数据查找 skill 的实际路径
    const meta = ctx?.skillLoader?.findMetadata(name)
    if (!meta) return { ok: false, error: `技能 "${name}" 不存在。用 action=create 创建。` }
    const filePath = join(meta.dirPath, SKILL_MD)
    if (!existsSync(filePath)) return { ok: false, error: `技能 "${name}" 文件不存在。` }

    if (!ctx?.requestPermission) return { ok: false, error: '更新技能需要用户授权' }
    const perm = await ctx.requestPermission({
      type: 'command',
      description: `AI 请求更新 Skill「${name}」`,
      content: filePath,
      risk: 'low'
    })
    if (!perm.allowed) return { ok: false, error: `用户拒绝：${perm.reason ?? '无原因'}` }

    try {
      const existingRaw = readFileSync(filePath, 'utf-8')
      const existingFm = parseExisting(filePath) ?? {}
      const existingBody = extractBody(existingRaw)
      const merged: Record<string, unknown> = { ...existingFm }
      const desc = typeof params.description === 'string' ? params.description.trim() : null
      if (desc) {
        if (desc.length > 1024) return { ok: false, error: `description 超过 1024 字符` }
        merged.description = desc
      }
      for (const key of ['disable_model_invocation', 'user_invocable'] as const) {
        if (typeof params[key] === 'boolean') merged[key] = params[key]
      }
      if (params.context === 'inline' || params.context === 'fork') merged.context = params.context
      if (Array.isArray(params.allowed_tools)) merged.allowedTools = params.allowed_tools
      if (Array.isArray(params.paths)) merged.paths = params.paths
      if (params.hooks && typeof params.hooks === 'object') merged.hooks = params.hooks
      const newBody = typeof params.body === 'string' ? params.body.trim() : existingBody
      const content = buildSkillMd({ ...merged, name, description: merged.description }, newBody)
      writeFileSync(filePath, content, 'utf-8')
      try {
        parseSkillFile(filePath, meta.source)
      } catch (err) {
        return { ok: false, error: `frontmatter 校验失败：${(err as Error).message}` }
      }
      ctx?.skillLoader?.load()
      return { ok: true, data: { name, path: filePath.replace(/\\/g, '/'), updated: true, message: `Skill "${name}" 已更新` } }
    } catch (err) {
      return { ok: false, error: `更新 Skill 失败: ${(err as Error).message}` }
    }
  }

  private async delete(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const name = typeof params.name === 'string' ? params.name.trim() : ''
    const nameErr = validateSkillName(name)
    if (nameErr) return { ok: false, error: nameErr }

    // 从已加载的元数据查找 skill 的实际路径
    const meta = ctx?.skillLoader?.findMetadata(name)
    if (!meta) return { ok: false, error: `技能 "${name}" 不存在` }
    const dir = meta.dirPath
    const filePath = join(dir, SKILL_MD)
    if (!existsSync(filePath)) return { ok: false, error: `技能 "${name}" 文件不存在` }

    if (!ctx?.requestPermission) return { ok: false, error: '删除技能需要用户授权' }
    const perm = await ctx.requestPermission({
      type: 'command',
      description: `AI 请求删除 Skill「${name}」（不可恢复）[${meta.source}${meta.domain ? '/' + meta.domain : ''}]`,
      content: filePath,
      risk: 'high'
    })
    if (!perm.allowed) return { ok: false, error: `用户拒绝：${perm.reason ?? '无原因'}` }
    try {
      rmSync(dir, { recursive: true, force: true })
      ctx?.skillLoader?.load()
      return { ok: true, data: { name, deleted: true, message: `Skill "${name}" 已删除` } }
    } catch (err) {
      return { ok: false, error: `删除 Skill 失败: ${(err as Error).message}` }
    }
  }
}

export type { AnyTool, ToolResult, ToolContext }
