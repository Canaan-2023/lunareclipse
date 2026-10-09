/**
 * 技能加载工具：为什么存在——技能正文常驻注入会浪费上下文，改为 AI 按需显式加载
 * （L2 指令进入上下文后再执行），是技能调用的统一入口。
 * 作用：use_skill 读取指定技能 SKILL.md 正文作为工具结果返回给 AI。
 * 返回体含 dir_path（技能目录绝对路径，如 .../skills/U1/AI1/skill-creator）：
 * 子文档（methods/ 等）与 SKILL.md 同目录，AI 用 Read(file_path=<dir_path>/methods/xxx.md) 按需读取。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
// skill fork 子 agent 任务指令统一集中管理（prompts/sub-agent.ts）
import { buildSkillForkTaskPrompt } from '../prompts/sub-agent'

/**
 * use_skill 工具：AI 调用加载指定 skill 的正文指令（L2）到上下文。
 *
 * 触发时读取 SKILL.md 正文。
 * 月蚀的实现：AI 通过 use_skill 工具显式加载 skill 正文，返回内容作为工具结果。
 * AI 收到后按指令行事（正文不会自动注入 system prompt，而是作为工具结果在 assistant 上下文中）。
 *
 * 执行模式（frontmatter context 字段）：
 * - inline（默认）：返回正文，AI 在主上下文按指令行事
 * - fork：启动子 agent 隔离执行（正文作为子 agent 系统提示），allowed-tools 作工具白名单
 *
 * 生命周期钩子（frontmatter hooks 字段）：
 * - pre_execute：执行前注入（附在返回内容里提示 AI 先处理）
 * - post_execute：执行后调用（附在返回内容里提示 AI 收尾）
 *
 * 参数：
 * - skill_name：要加载的 skill 名称（kebab-case）
 *
 * 行为：
 * - 返回内容含 skill 名称、来源、技能目录绝对路径（dir_path）、正文
 */
export class UseSkillTool implements Tool {
  name = 'use_skill'
  description = `加载指定 Skill 的详细操作指令（SOP），或盘点技能池。

用法：
- skill_name（可选）：要加载的 skill 名（kebab-case，如 "code-review"）；不传=盘点模式；传了但不存在=返回可用清单帮你选择
- domain（可选）：按领域盘点领域级技能（领域 = 目录路径，数量与层级不限，如 design、design/web），仅不传 skill_name 时生效；不传 domain 也不传 skill_name=返回全部技能清单

领域级技能定位：不会自动出现在你的工具清单里，数据目录结构为 skills_domains/{领域路径}/{技能名}/SKILL.md——先用 Grep/Glob 检索 skills_domains/{领域路径}/ 目录看有哪些 SKILL.md（文件头部的 name/description 判断是否匹配），再 use_skill(skill_name=...) 加载正文；domain 盘点仅作辅助确认。

何时用：已确定技能名（加载正文）/ 需确认技能池里有什么（盘点）。

返回体：加载成功时含 name、source、mode、dir_path（技能目录绝对路径，读取子文档如 methods/ 需用它拼绝对路径：Read(file_path=<dir_path>/methods/xxx.md)）、body（SKILL.md 正文）。

约束：skill_name 必须是已注册 skill；context=fork 启动子 agent 隔离执行（allowed-tools 限制工具），context=inline（默认）返回正文按指令行事；同一 skill 可多次调用，正文每次重读（正文不缓存，元数据缓存）；正文为 Markdown（含步骤/约束/输出格式）。`
  parameters = [
    {
      name: 'skill_name',
      type: 'string' as const,
      description: '要加载的 skill 名称（kebab-case）；不传 = 进入查询模式（配合 domain 参数）',
      required: false
    },
    {
      name: 'domain',
      type: 'string' as const,
      description: '按领域盘点领域级技能（领域 = 目录路径，数量与层级不限，如 "design"、"design/web"）；仅在不传 skill_name 时生效。领域级技能定位优先用 Grep/Glob 检索 skills_domains/{领域路径}/ 目录，此参数仅作辅助确认',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const skillName = params.skill_name as string | undefined
    if (!skillName || typeof skillName !== 'string' || skillName.trim().length === 0) {
      const loader = ctx?.skillLoader
      if (!loader) {
        return { ok: false, error: 'Skills 加载器未初始化' }
      }

      const domain = params.domain as string | undefined
      if (domain && typeof domain === 'string' && domain.trim().length > 0) {
        // 按领域盘点领域级技能（辅助 QA；领域级定位主路径是 grep skills_domains/{领域}/ 目录）
        const domainSkills = loader.listMetadata().filter((s) =>
          s.source === 'domain' && (s.domain ?? '(未分类)') === domain
        )
        if (domainSkills.length === 0) {
          const domains = loader.getDomainGroups()
          return {
            ok: true,
            data: {
              domain,
              list: [],
              available_domains: domains,
              message: `领域 "${domain}" 下无技能。可用领域: ${domains.map((d) => d.domain).join(', ')}`
            }
          }
        }
        const lines = domainSkills.map((s) => `- ${s.name}: ${s.description}`)
        return {
          ok: true,
          data: {
            domain,
            list: domainSkills.map((s) => ({ name: s.name, description: s.description, domain: s.domain })),
            detail: `【领域 ${domain} · ${domainSkills.length} 个】\n${lines.join('\n')}`,
            message: `找到 ${domainSkills.length} 个 ${domain} 领域技能。用 use_skill(skill_name=...) 加载具体技能。`
          }
        }
      }

      // 全量盘点：按来源+领域分组
      const all = loader.listMetadata()
      if (all.length === 0) {
        return { ok: true, data: { list: [], message: '技能池为空（无可用技能）' } }
      }

      const SOURCE_LABEL: Record<string, string> = {
        user: '用户级',
        domain: '领域级（按领域分类）'
      }
      const sections: string[] = []

      // 用户级
      const userSkills = all.filter((s) => s.source === 'user')
      if (userSkills.length > 0) {
        sections.push(`【${SOURCE_LABEL.user} · ${userSkills.length} 个】`)
        for (const m of userSkills) {
          sections.push(`- ${m.name}: ${m.description}`)
        }
      }

      // 领域级按领域分组
      const domainSkills = all.filter((s) => s.source === 'domain')
      if (domainSkills.length > 0) {
        const byDomain = new Map<string, typeof domainSkills>()
        for (const s of domainSkills) {
          const d = s.domain ?? '(未分类)'
          const arr = byDomain.get(d) ?? []
          arr.push(s)
          byDomain.set(d, arr)
        }
        sections.push(`【${SOURCE_LABEL.domain} · ${domainSkills.length} 个，${byDomain.size} 个领域】`)
        for (const [d, metas] of byDomain) {
          sections.push(`  领域 ${d}（${metas.length} 个）：`)
          for (const m of metas) {
            sections.push(`  - ${m.name}: ${m.description}`)
          }
        }
      }

      return {
        ok: true,
        data: {
          list: all.map((m) => ({ name: m.name, source: m.source, domain: m.domain, description: m.description })),
          summary: `技能池共 ${all.length} 个技能（用户级 ${userSkills.length} + 领域级 ${domainSkills.length}）`,
          detail: sections.join('\n'),
          domain_groups: loader.getDomainGroups(),
          message: '技能盘点：用户级技能常驻可用；领域级按目录路径分类存放于 skills_domains/{领域路径}/，用 Grep/Glob 检索该目录定位 SKILL.md 后，use_skill(skill_name=...) 加载具体技能。'
        }
      }
    }

    const loader = ctx?.skillLoader
    if (!loader) {
      return { ok: false, error: 'Skills 加载器未初始化' }
    }

    const meta = loader.findMetadata(skillName)
    if (!meta) {
      // 列出可用 skill 帮助 AI 选择
      const available = loader.listMetadata().map((s) => `- ${s.name}: ${s.description}`)
      return {
        ok: false,
        error: `skill "${skillName}" 不存在。可用 skills:\n${available.join('\n')}`
      }
    }

    const skill = loader.loadBody(skillName)
    if (!skill) {
      return { ok: false, error: `加载 skill "${skillName}" 正文失败` }
    }

    // 声明态字段执行：
    // 1. context=fork → 子 agent 隔离执行（正文为系统提示，allowed-tools 白名单）
    // 2. hooks → pre_execute 附在返回提示里（AI 先处理），post_execute 附在收尾提示里
    const isFork = skill.context === 'fork'

    if (isFork) {
      if (!ctx?.launchSubAgent) {
        return { ok: false, error: `skill "${skillName}" 声明 context=fork，但当前上下文不支持子 agent（launchSubAgent 未注入）` }
      }
      // 组装子 agent 任务：正文作为指令，allowed-tools 作工具白名单
      const taskPrompt = buildSkillForkTaskPrompt(skillName, skill.body)
      const tools = skill.allowedTools && skill.allowedTools.length > 0 ? skill.allowedTools : undefined
      try {
        const results = await ctx.launchSubAgent(
          // maxTurns 不传（2026-10-02 取消上限）：skill fork 子 agent 不再因轮次限制中断，
          // 由 SubAgentManager 默认不限制 + 超时兜底
          [{ prompt: taskPrompt, tools }],
          'serial'
        )
        const output = results[0] ?? '(子 agent 无输出)'
        return {
          ok: true,
          data: {
            name: skill.name,
            description: skill.description,
            source: skill.source,
            domain: skill.domain ?? null,
            mode: 'fork',
            dir_path: skill.dirPath,
            file_path: skill.filePath,
            body: skill.body,
            result: output,
            message: `skill "${skillName}" 已由子 agent 隔离执行完成（fork 模式），结果如上。`
          }
        }
      } catch (err) {
        return { ok: false, error: `skill "${skillName}" fork 执行失败: ${(err as Error).message}` }
      }
    }

    // inline 模式：返回正文，附带 hooks 提示
    const extra: string[] = []
    if (skill.hooks?.pre_execute) {
      extra.push(`【pre_execute】执行前：${skill.hooks.pre_execute}`)
    }
    if (skill.hooks?.post_execute) {
      extra.push(`【post_execute】执行完成后：${skill.hooks.post_execute}`)
    }

    return {
      ok: true,
      data: {
        name: skill.name,
        description: skill.description,
        source: skill.source,
        domain: skill.domain ?? null,
        mode: 'inline',
        dir_path: skill.dirPath,
        file_path: skill.filePath,
        body: skill.body,
        ...(extra.length > 0 ? { hooks: extra.join('\n') } : {}),
        message: `已加载 skill "${skillName}"，目录 ${skill.dirPath}。子文档（如 methods/）与 SKILL.md 同目录，用 Read(file_path=${skill.dirPath}/methods/...) 按需读取。`
      }
    }
  }
}
