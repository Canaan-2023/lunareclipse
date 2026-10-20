/**
 * skill 子系统的类型定义：统一 SkillMetadata / Skill / frontmatter /
 * 运行时状态等跨模块数据类型，是加载器、配置层、市场与运用层
 * 之间共享的结构契约，避免各处各定义一份导致字段不一致。
 */
/** Skill 来源（用户级 / 领域级） */
export type SkillSource = 'user' | 'domain'

/** Skill 执行上下文模式 */
export type SkillContext = 'inline' | 'fork'

/** Skill 平台门控 */
export type SkillPlatform = 'linux' | 'macos' | 'windows'

/** Skill config 声明项（市场安装后提示用户配置） */
export interface SkillConfigDecl {
  key: string
  description: string
  default?: string
  prompt?: string
}

/** SKILL.md frontmatter 解析结果（对齐开放标准 + 扩展字段） */
export interface SkillFrontmatter {
  /** skill 名称（kebab-case，≤64 字符） */
  name: string
  /** skill 描述（≤1024 字符，含"做什么"+"何时用"，是 AI 自动触发的唯一依据） */
  description: string
  /** 是否禁用 AI 自动触发（true 时不进 L1 索引，只能用户显式调用） */
  disableModelInvocation?: boolean
  /** 是否在用户菜单可见（false 时只能被其他 skill 或显式调用，默认 true） */
  userInvocable?: boolean
  /** 执行上下文：inline=主上下文执行 / fork=子 agent 隔离执行（默认 inline） */
  context?: SkillContext
  /** 工具白名单（fork 模式下限制子 agent 可用工具；inline 模式仅记录不限制） */
  allowedTools?: string[]
  /** 文件路径 glob，用户打开匹配文件时自动激活（如 ["*.tsx"]） */
  paths?: string[]
  /** 生命周期钩子（pre_execute / post_execute，执行前后调用） */
  hooks?: {
    pre_execute?: string
    post_execute?: string
  }
  // ===== 兼容扩展 =====
  /** 版本号（semver 宽松） */
  version?: string
  /** 作者 */
  author?: string
  /** 许可证 */
  license?: string
  /** 来源链接 */
  homepage?: string
  /** 平台门控（当前平台不匹配时 L1 不注入） */
  platforms?: SkillPlatform[]
  /** 依赖声明（展示用） */
  dependencies?: string[]
  /** 互链（必须指向真实存在的 skill） */
  relatedSkills?: string[]
  /** 分类标签 */
  tags?: string[]
  /** 分类（L1 索引分组用） */
  category?: string
  /**
   * 领域（文件夹即领域）：领域级 skill 的领域由其在 skills_domains 根下的父路径决定
   * （如根下 design/ 里的技能 → "design"，design/web/ 里的技能 → "design/web"），
   * 目录数量与层级不设上限，frontmatter 声明不参与判定；领域级根下扁平技能领域为空。
   * 用户级（source=user）保留 frontmatter 的 domain 声明值（旧兼容，不影响落位/分组）。
   * 为什么如此设计——领域是用户/社区按文件夹自由组织的分类，扫描/安装以同一文件夹
   * 路径为真源，保证「看起来在哪、装了去哪」一致；AI grep skills_domains/{领域}/ 时以同值定位。
   */
  domain?: string
  /** 条件激活：月蚀工具池缺少这些工具时 L1 不注入 */
  requiresTools?: string[]
  /** 条件激活：月蚀工具池有这些工具时 L1 不注入（有主工具则隐藏 fallback skill） */
  fallbackForTools?: string[]
  /** 配置声明（市场安装后提示用户配置） */
  config?: SkillConfigDecl[]
}

/** frontmatter 中的未知字段（市场来源锁定/诊断用） */
export interface SkillExtraFields {
  [key: string]: unknown
}

/** Skill 运行时配置（由 .skills.json 管理，不写在 frontmatter 里） */
export interface SkillRuntimeConfig {
  /** 是否启用（false 时完全不加载，不进 L1 索引，UI 灰显） */
  enabled: boolean
}

/** Skill 元数据（Level 1，始终注入 system prompt） */
export interface SkillMetadata extends SkillFrontmatter {
  /** 来源（用户级 / 领域级） */
  source: SkillSource
  /** 领域：领域级来源由目录父路径判定（文件夹即领域，frontmatter 不参与，根下扁平为空）；用户级保留 frontmatter 声明值 */
  domain?: string
  /** SKILL.md 完整路径（用于 Level 2 加载正文） */
  filePath: string
  /** skill 目录路径（用于 Level 3 加载资源） */
  dirPath: string
  /** 运行时配置（从 .skills.json 加载，默认 enabled=true） */
  runtime: SkillRuntimeConfig
  /** frontmatter 中的未知字段（metadata.* 等，市场来源锁定/诊断用） */
  extraFields?: SkillExtraFields
}

/** 完整 Skill（Level 2，含正文指令） */
export interface Skill extends SkillMetadata {
  /** SKILL.md 正文（frontmatter 之后的 Markdown 内容） */
  body: string
}

/** Skill 运行时状态（监控用） */
export interface SkillRuntimeStatus {
  /** skill 名称 */
  name: string
  /** 是否启用 */
  enabled: boolean
  /** 是否可被 AI 自动触发 */
  autoInvocable: boolean
  /** 是否在用户菜单可见 */
  userInvocable: boolean
  /** 来源 */
  source: SkillSource
  /** 领域级领域分类（用户级为 null） */
  domain: string | null
  /** 最后使用时间（timestamp，null 表示从未使用） */
  lastUsedAt: number | null
  /** 使用次数 */
  useCount: number
  /** 加载错误（null 表示无错误） */
  loadError: string | null
}

/** Skills 加载结果 */
export interface SkillsLoadResult {
  /** 所有 skill 元数据（按优先级去重，领域级覆盖用户级） */
  metadatas: SkillMetadata[]
  /** 加载错误（按文件路径记录，不阻断其他 skill 加载） */
  errors: Array<{ filePath: string; error: string }>
}

/** frontmatter 校验错误 */
export class SkillValidationError extends Error {
  constructor(public filePath: string, message: string) {
    super(message)
    this.name = 'SkillValidationError'
  }
}
