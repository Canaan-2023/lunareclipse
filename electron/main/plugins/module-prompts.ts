/**
 * 插件 prompts.md 模块加载器

 * 插件需要把自身的使用须知注入系统提示词，但不能直接改核心模板，
 * 故以 prompts.md 分段声明、经内核注册表按命名片段注入、卸载即移除——

 * 协议：prompts.md 以 "# 标题" 分段，每段注入系统提示词的一个命名片段。
 * 段名 = 标题 slug；排序权重统一 100（装配时按注册顺序）。

 * 示例：
 * ```md
 * # 我的插件须知
 * 当你使用 my_* 工具时，注意……
 * ```
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { kernelRegistry } from '../kernel'
import type { ExtensionHandle, PromptSection } from '../kernel'

/** 解析 prompts.md 为 PromptSection 列表（"# 标题" 分段） */
export function parsePromptSections(md: string): PromptSection[] {
  const sections: PromptSection[] = []
  let currentTitle: string | null = null
  let currentBody: string[] = []

  const flush = (): void => {
    if (currentTitle) {
      const content = currentBody.join('\n').trim()
      if (content.length > 0) {
        sections.push({
          name: slugify(currentTitle),
          content,
          order: 100
        })
      }
    }
    currentBody = []
  }

  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+)$/)
    if (m) {
      flush()
      currentTitle = m[1].trim()
    } else if (currentTitle) {
      currentBody.push(line)
    }
  }
  flush()
  return sections
}

/** 标题 → 段名（保留中文，其余转连字符） */
function slugify(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'section'
}

/** 加载 prompts.md（不存在则跳过；失败收集进 errors） */
export function loadPromptsModule(
  dirPath: string,
  pluginName: string,
  errors: string[]
): ExtensionHandle[] {
  const promptsFile = join(dirPath, 'prompts.md')
  if (!existsSync(promptsFile)) return []
  // registered 提升到 try 外：注册中途抛错时 catch 需要遍历回滚已注册段
  const registered: ExtensionHandle[] = []
  try {
    const content = readFileSync(promptsFile, 'utf-8')
    const sections = parsePromptSections(content)
    if (sections.length === 0) {
      errors.push('prompts.md 无有效分段（需以 "# 标题" 开头且含内容）')
      return []
    }
    // 逐段注册并收集句柄：中途抛错时已注册段可回滚（与 module-hooks E3 同规则）
    for (const s of sections) {
      registered.push(kernelRegistry.register('prompt', { kind: 'plugin', pluginName }, s))
    }
    return registered
  } catch (err) {
    // 同步注册中途异常：回滚已注册分段句柄，避免随插件卸载时残留
    for (const h of registered) {
      if (!h.disposed) h.dispose()
    }
    errors.push(`prompts.md 加载失败: ${(err as Error).message}`)
    return []
  }
}
