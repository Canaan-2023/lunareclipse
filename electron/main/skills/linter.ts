/**
 * skill_linter（技能 lint 本土化）：
 * 不规范或存在安全隐患的外部技能若直接进入系统会带来风险（裸 shell 命令、
 * 危险模式、营销词），因此在技能创建/更新、市场安装等入口统一做检查。
 * 触发点：skill_manage action=create/update（警告不阻断）、市场安装、loader errors 并入。
 */

export interface LintIssue {
  /** 严重度：error=必须修复 / warning=建议 / info=提示 */
  severity: 'error' | 'warning' | 'info'
  /** 问题类别：frontmatter / body / platform */
  category: 'frontmatter' | 'body' | 'platform'
  message: string
}

/** 禁裸 shell 命令名（规则：无路径上下文出现的常见命令视为裸用） */
const BARE_COMMAND_PATTERN = /(^|[^`\w-])(grep|cat|rm|cp|mv|mkdir|touch|curl|wget|sed|awk|ls|cd|chmod|chown|ps|kill|df|du|tar|unzip|zip|pip|npm|yarn|pnpm)\s/m

/** 营销词（禁词） */
const MARKETING_WORDS = ['unleash', 'revolutionary', 'cutting-edge', 'game-changer', 'ultra', 'amazing', 'incredible', 'effortless', 'seamless']

/** 危险模式（正文里裸用 eval/exec 等） */
const DANGEROUS_PATTERNS = [
  { re: /\beval\s*\(/i, msg: '裸 eval( 使用' },
  { re: /\bexec\s*\(/i, msg: '裸 exec( 使用' },
  { re: /child_process/i, msg: 'child_process 引用（需说明用途）' },
  { re: /rm\s+-rf/i, msg: 'rm -rf 出现（危险命令，需谨慎）' },
  { re: /rm\s+-rf\s+\//i, msg: 'rm -rf / 根目录删除（极危险）' },
  { re: /:\s*\(\)\s*\{.*\|.*&.*\}/, msg: 'fork bomb 模式（拒绝服务攻击）' },
  { re: /(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/i, msg: 'curl/wget 管道到 shell（远程代码执行）' },
  { re: /\bFunction\s*\(/i, msg: 'Function( 构造器（动态代码执行）' },
  { re: /__proto__/i, msg: '__proto__ 原型链污染（需说明用途）' },
  { re: /process\.env\b/i, msg: 'process.env 访问（可能泄露环境变量凭据）' }
]

/** 对单个 skill 运行 lint */
export function lintSkill(skill: { name: string; description: string; platforms?: string[]; body?: string }): LintIssue[] {
  const issues: LintIssue[] = []

  // ===== frontmatter 规范 =====
  if (!skill.name || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skill.name)) {
    issues.push({ severity: 'error', category: 'frontmatter', message: 'name 必须是 kebab-case（小写字母/数字/连字符）' })
  }
  if (!skill.description || !skill.description.trim()) {
    issues.push({ severity: 'error', category: 'frontmatter', message: 'description 不能为空' })
  }
  if (skill.description && skill.description.length > 300) {
    issues.push({ severity: 'warning', category: 'frontmatter', message: `description 较长（${skill.description.length} 字符），L1 索引会截断到 60 字符，建议精简核心触发词` })
  }
  if (skill.platforms && skill.platforms.length > 0) {
    const valid = new Set(['linux', 'macos', 'windows'])
    for (const p of skill.platforms) {
      if (!valid.has(p)) {
        issues.push({ severity: 'error', category: 'frontmatter', message: `platforms 含非法值: ${p}` })
      }
    }
  }

  // ===== 正文安全 =====
  const body = skill.body ?? ''
  if (body) {
    // 禁裸 shell 命令
    const bareMatch = body.match(BARE_COMMAND_PATTERN)
    if (bareMatch) {
      issues.push({
        severity: 'warning',
        category: 'body',
        message: `正文出现裸命令 "${bareMatch[2]}"（建议用反引号包裹或在步骤中说明用 run_command 执行）`
      })
    }
    // 营销词
    const lower = body.toLowerCase()
    for (const w of MARKETING_WORDS) {
      if (lower.includes(w)) {
        issues.push({ severity: 'info', category: 'body', message: `正文含营销词 "${w}"（建议用中性表述）` })
      }
    }
    // 危险模式
    for (const { re, msg } of DANGEROUS_PATTERNS) {
      if (re.test(body)) {
        issues.push({ severity: 'warning', category: 'body', message: msg })
      }
    }
  }

  return issues
}

/** lint 摘要（error 数 / warning 数） */
export function summarizeLint(issues: LintIssue[]): { errors: number; warnings: number; infos: number } {
  return {
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
    infos: issues.filter((i) => i.severity === 'info').length
  }
}
