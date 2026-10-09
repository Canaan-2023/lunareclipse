/**
 * Skills 加载器：用户级与领域级 skill 的扫描、frontmatter 解析、
 * 配置合并与热重载的单一入口，支撑两级渐进式披露模型
 * （L0 常驻索引 + L0.5 领域摘要）；监听 SKILL.md / .skills.json
 * 变化即时生效，并维护技能使用统计供运行时监控。
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync, mkdirSync, renameSync, type FSWatcher } from 'fs'
import { basename, join, dirname, sep } from 'path'
import { getScopedPath, getCurrentUid, getCurrentAiId, getDataRoot } from '../models/path-context'
import { scopedDomainPath } from '../models/paths'
import type {
  SkillMetadata,
  Skill,
  SkillSource,
  SkillRuntimeStatus,
  SkillsLoadResult
} from './types'
import { SkillValidationError } from './types'
import {
  loadSkillsConfig,
  getSkillRuntimeConfig,
  setSkillEnabled,
  removeSkillConfig,
  ensureSkillsConfigExists,
  watchSkillsConfig,
  stopWatchingSkillsConfig,
  type SkillsConfig
} from './skill-config'
import { parseSkillFile, extractBody } from './frontmatter'
export {
  parseSkillFile,
  parseFrontmatter,
  applyFrontmatterField,
  normalizeStringArray,
  validateFrontmatter
} from './frontmatter'
export { matchSkillPath, skillsActivatedByPath } from './path-match'

/** frontmatter 字段限制常量（供 skill-config 等引用时保持单点） */
const SKILL_MD_FILENAME = 'SKILL.md'
const SKILL_RELOAD_DEBOUNCE_MS = 300

/** 用户级 skills 目录：{root}/skills/U{uid}/AI{aiId}/（域内 U/AI 前缀分层；仅在登录态解析，见 getScopedPath） */
export function getUserSkillsDir(): string {
  return getScopedPath('skills')
}

/**
 * Skills 加载器：扫描用户级 / 领域级 skills 目录，解析 SKILL.md frontmatter。

 * 两层披露模型：
 * - L0 用户级常驻索引：用户级技能（领域无关），name+description 常驻系统提示词（渐进披露）
 * - 领域级领域摘要：按领域分类子目录组织，系统提示词只注入领域名+数量，
 * AI 自行用 Grep/Glob 检索 skills_domains/{领域}/ 目录定位 SKILL.md（frontmatter 的 name/description 判断匹配），再 use_skill(skill_name=xxx) 加载正文

 * 目录结构：
 * - 用户级：{root}/skills/U{uid}/AI{aiId}/{skillName}/SKILL.md（扁平结构）
 * - 领域级：{root}/skills_domains/U{uid}/AI{aiId}/{domain0}/{...}/{domainN}/{skillName}/SKILL.md
 * 领域 = SKILL.md 所在目录相对领域级根的父路径（文件夹即领域真源，数量不设上限）；
 * 领域级根下直接放技能时领域为空（按未分类展示）

 * 设计要点：
 * - 配置层：.skills.json 管理 per-skill enabled 覆盖
 * - 加载层：启动时全量扫描 + 解析 frontmatter + 热重载
 * - 运用层：不同字段被系统层针对性运用
 * - disable-model-invocation → 控制 L1 索引注入
 * - user-invocable → 控制 UI 可见性
 * - enabled（运行时配置）→ 控制整体是否加载
 * - paths → glob 自动激活
 * - live change detection：监听 SKILL.md + .skills.json 变化，热重载
 * - 优先级：用户级 < 领域级（后扫描覆盖先扫描）
 * - 运行时状态监控：lastUsedAt / useCount / loadError
 */
export class SkillLoader {
  private metadatas: SkillMetadata[] = []
  private errors: Array<{ filePath: string; error: string }> = []
  private watchers: FSWatcher[] = []
  private loaded = false
  /** 上次全量加载时的作用域键（uid:aiId）；作用域变化时 listMetadata 自动重扫
   * （切换 AI 会话后技能列表仍显示上一 AI 数据的根因修复，见 ensureCurrentScope）。
   * null 表示从未按作用域加载过（首次加载/未登录守护） */
  private lastScopeKey: string | null = null
  /** 热重载完成回调：磁盘 SKILL 变动（SKILL.md/.skills.json 变化）重载后调用，
   * 由装配方注入，广播到前端触发界面自动刷新（面板/市场已打开时无需手动刷新）。
   * 切换 AI 会话不触发本回调（无磁盘变动），由前端会话切换逻辑另行刷新。 */
  private changeCb: (() => void) | null = null
  private config: SkillsConfig = { skills: {} }
  /** 运行时状态（使用次数、最后使用时间）——落盘 {configPath 同目录}/.skills-usage.json，重启保留 */
  private runtimeStats = new Map<string, { lastUsedAt: number | null; useCount: number }>()
  private usageFlushTimer?: ReturnType<typeof setTimeout>
  private skillReloadTimer?: ReturnType<typeof setTimeout>

  constructor(
    private getDomainSkillsDir: () => string | null,
    configPath: string | (() => string)
  ) {
    /**
     * configPath 动态求值而不是构造时固化：
     * 为什么存在——SkillLoader 在启动早期构造，若此时把
     * getDefaultSkillsConfigPath() 求值固化，路径将不再随当前 uid/aiId 变化；
     * 每次使用时才经 getScopedPath() 按当前 uid/aiId 动态解析，
     * 登录后 load() 与配置、技能目录始终处于同一分层（技能安装不显示的根因修复）。
     * 留存理由——测试传字符串路径仍兼容（包一层 () => string）。
     */
    this._configPathProvider =
      typeof configPath === 'function' ? configPath : () => configPath
    this.loadUsage()
  }

  /** 配置路径：每次使用时动态求值（仅在登录态解析，未登录时 getScopedPath 抛错） */
  private _configPathProvider: () => string
  private get configPath(): string {
    return this._configPathProvider()
  }

  /** 读取落盘的使用统计 */
  private loadUsage(): void {
    try {
      const usagePath = join(dirname(this.configPath), '.skills-usage.json')
      if (existsSync(usagePath)) {
        const data = JSON.parse(readFileSync(usagePath, 'utf-8'))
        if (!data || typeof data !== 'object' || Array.isArray(data)) return
        for (const [name, stats] of Object.entries(data as Record<string, unknown>)) {
          if (!stats || typeof stats !== 'object' || Array.isArray(stats)) continue
          const s = stats as Record<string, unknown>
          if (s.lastUsedAt !== null && typeof s.lastUsedAt !== 'number') continue
          if (typeof s.useCount !== 'number') continue
          this.runtimeStats.set(name, {
            lastUsedAt: s.lastUsedAt as number | null,
            useCount: s.useCount as number
          })
        }
      }
    } catch {
      /* 读取失败忽略（统计是增强，不影响功能） */
    }
  }

  /** 防抖写盘使用统计 */
  private persistUsage(): void {
    if (this.usageFlushTimer) clearTimeout(this.usageFlushTimer)
    this.usageFlushTimer = setTimeout(() => {
      try {
        const usagePath = join(dirname(this.configPath), '.skills-usage.json')
        const data = Object.fromEntries(this.runtimeStats.entries())
        writeFileSync(usagePath, JSON.stringify(data, null, 2), 'utf-8')
      } catch {
        /* 写盘失败忽略 */
      }
    }, 500)
  }

  /** 全量加载：扫描用户级 + 领域级，解析所有 SKILL.md，按优先级去重。
   * 仅在登录态调用（系统强制登录后才可用），未登录访问 getScopedPath 即抛错。 */
  load(): SkillsLoadResult {
    this.metadatas = []
    this.errors = []

    const byName = new Map<string, SkillMetadata>()

    // 历史遗留数据迁移（幂等）：曾因未登录回退顶层把用户级技能/配置写到
    // {root}/skills/{name}、{root}/config/.skills.json，登录态扫描是
    // {root}/skills/U{uid}/AI{aiId}——列表不显示的根因。此处登录后一次性
    // 把顶层遗留搬到当前 U{uid}/AI{aiId} 分层目录（含旧裸数字 {uid}/{aiId} 分层），
    // 保证旧数据立即可见。
    migrateLegacyScopedData()

    // 加载运行时配置
    ensureSkillsConfigExists(this.configPath)
    this.config = loadSkillsConfig(this.configPath)

    // 用户级
    this.scanDir(getUserSkillsDir(), 'user', byName)

    // 领域级（优先级最高，覆盖用户级同名）
    const domainDir = this.getDomainSkillsDir()
    if (domainDir) {
      this.scanDir(domainDir, 'domain', byName)
    }

    this.metadatas = Array.from(byName.values())
    this.validateDependencies()
    this.detectRelatedSkillsCycles()
    this.loaded = true
    // 作用域感知：load() 扫描的是"当前 uid/aiId 作用域"目录，此处记录本次作用域键。
    // 若作用域相对上次变化（如切换 AI 会话）且正在监听，重建 watcher 指向新作用域目录
    // （旧 watcher 仍监听上一 AI 目录，不重建则热重载失效且目录持续被监听）。
    // 首次加载（lastScopeKey===null）不重建——登录成功后 onAuthSuccess 统一 startWatching。
    const nextScope = this.currentScopeKeyOrNull()
    if (nextScope !== null && nextScope !== this.lastScopeKey && this.lastScopeKey !== null && this.watchers.length > 0) {
      console.log(`[skills] 作用域变化 ${this.lastScopeKey} -> ${nextScope}，重建热重载监听`)
      this.startWatching()
    }
    if (nextScope !== null) this.lastScopeKey = nextScope
    return { metadatas: this.metadatas, errors: this.errors }
  }

  /** K-M13: 校验 dependencies 字段——检查声明的依赖是否已加载，缺失时 console.warn（不阻断） */
  private validateDependencies(): void {
    const loadedNames = new Set(this.metadatas.map((m) => m.name))
    for (const meta of this.metadatas) {
      if (!meta.dependencies || meta.dependencies.length === 0) continue
      const missing = meta.dependencies.filter((d) => !loadedNames.has(d))
      if (missing.length > 0) {
        console.warn(
          `[skills] 技能 "${meta.name}" 声明的依赖未加载: ${missing.join(', ')}`
        )
      }
    }
  }

  /** K-M14: related_skills 循环引用检测——DFS 遍历依赖图，发现环时 console.warn（不阻断） */
  private detectRelatedSkillsCycles(): void {
    const graph = new Map<string, string[]>()
    for (const meta of this.metadatas) {
      graph.set(meta.name, meta.relatedSkills ?? [])
    }
    const WHITE = 0
    const GRAY = 1
    const BLACK = 2
    const color = new Map<string, number>()
    for (const name of graph.keys()) {
      color.set(name, WHITE)
    }
    const stack: string[] = []
    const hasCycle = (node: string): boolean => {
      color.set(node, GRAY)
      stack.push(node)
      const neighbors = graph.get(node) ?? []
      for (const neighbor of neighbors) {
        if (!graph.has(neighbor)) continue
        const c = color.get(neighbor)
        if (c === GRAY) {
          const cycleStart = stack.indexOf(neighbor)
          const cycle = stack.slice(cycleStart).concat(neighbor)
          console.warn(`[skills] related_skills 检测到循环引用: ${cycle.join(' → ')}`)
          return true
        }
        if (c === WHITE && hasCycle(neighbor)) {
          return true
        }
      }
      stack.pop()
      color.set(node, BLACK)
      return false
    }
    for (const name of graph.keys()) {
      if (color.get(name) === WHITE) {
        hasCycle(name)
      }
    }
  }

  /** 列出所有 skill 元数据（L1，含禁用的；UI 管理用） */
  listMetadata(): SkillMetadata[] {
    this.ensureCurrentScope()
    if (!this.loaded) this.load()
    return this.metadatas
  }

  /**
   * 注册热重载完成回调：磁盘 SKILL 变动（SKILL.md / .skills.json / 市场安装/更新/卸载）完成
   * 重载后调用，由装配方广播到前端触发界面自动刷新（面板/市场已打开时无需手动刷新）。
   * 切换 AI 会话不触发本回调（无磁盘变动），由前端会话切换逻辑另行刷新。
   */
  setChangeCallback(cb: (() => void) | null): void {
    this.changeCb = cb
  }

  /** 当前作用域键（uid:aiId）；未登录（缺 uid/aiId）时返回 null——未登录态无分层数据域 */
  private currentScopeKeyOrNull(): string | null {
    const uid = getCurrentUid()
    const aiId = getCurrentAiId()
    if (uid === null || aiId === null) return null
    return `${uid}:${aiId}`
  }

  /** 作用域感知：会话切到其他 AI 后，已缓存的 metadatas 仍属上一 AI 作用域，
   * 此处检测到 uid/aiId 变化即自动重扫，保证 skill:list/status/errors 始终返回当前 AI 的数据
   * （「切换 AI 会话后打开 SKILL 列表仍显示上一 AI 列表」的根因修复）。 */
  private ensureCurrentScope(): void {
    if (!this.loaded || this.lastScopeKey === null) return
    const key = this.currentScopeKeyOrNull()
    if (key !== null && key !== this.lastScopeKey) {
      console.log(`[skills] 当前作用域 ${this.lastScopeKey} -> ${key}，自动重扫（切换 AI 会话）`)
      this.load()
    }
  }

  /** 列出已启用且可被 AI 自动触发的 skill（过滤 enabled=false 和 disable-model-invocation=true）
   * 条件激活（机制）：传入月蚀工具池名称列表后，
   * - requiresTools：池中缺少声明工具 → 隐藏（不注入）
   * - fallbackForTools：池中有主工具 → 隐藏（有主工具则 fallback skill 不注入）
   * - platforms：当前平台不匹配 → 隐藏
   */
  listAutoInvocable(toolNames?: string[]): SkillMetadata[] {
    const pool = toolNames ? new Set(toolNames) : null
    return this.listMetadata().filter((s) => {
      if (!s.runtime.enabled || s.disableModelInvocation) return false
      // 平台门控
      if (s.platforms && s.platforms.length > 0 && !s.platforms.includes(currentPlatform())) return false
      // 条件激活（只在传入工具池时生效；不传 = 不过滤，保持向后兼容）
      if (pool) {
        if (s.requiresTools && s.requiresTools.length > 0) {
          const missing = s.requiresTools.filter((t) => !pool.has(t))
          if (missing.length > 0) return false
        }
        if (s.fallbackForTools && s.fallbackForTools.length > 0) {
          const hasMain = s.fallbackForTools.some((t) => pool.has(t))
          if (hasMain) return false
        }
      }
      return true
    })
  }

  /** 按来源过滤的可自动触发 skill */
  listAutoInvocableBySource(source: SkillSource, toolNames?: string[]): SkillMetadata[] {
    return this.listAutoInvocable(toolNames).filter((s) => s.source === source)
  }

  /** 领域级按领域分组的摘要（渐进式披露：只给领域名+数量，不给具体 skill 列表） */
  getDomainGroups(): Array<{ domain: string; count: number }> {
    const byDomain = new Map<string, number>()
    for (const s of this.metadatas) {
      if (s.source !== 'domain') continue
      const d = s.domain ?? '(未分类)'
      byDomain.set(d, (byDomain.get(d) ?? 0) + 1)
    }
    return Array.from(byDomain.entries()).map(([domain, count]) => ({ domain, count }))
  }

  /** 列出已启用且在用户菜单可见的 skill（过滤 enabled=false 和 user-invocable=false） */
  listUserInvocable(): SkillMetadata[] {
    return this.listMetadata().filter(
      (s) => s.runtime.enabled && s.userInvocable !== false
    )
  }

  /** 按 name 查找 skill 元数据 */
  findMetadata(name: string): SkillMetadata | null {
    return this.metadatas.find((s) => s.name === name) ?? null
  }

  /** 加载 skill 完整正文（L2，use_skill 工具调用），同时更新使用统计 */
  loadBody(name: string): Skill | null {
    const meta = this.findMetadata(name)
    if (!meta) return null
    // 运行时配置禁用时拒绝加载
    if (!meta.runtime.enabled) return null
    try {
      const raw = readFileSync(meta.filePath, 'utf-8')
      const body = extractBody(raw)
      // 更新使用统计
      const stats = this.runtimeStats.get(name) ?? { lastUsedAt: null, useCount: 0 }
      this.runtimeStats.set(name, {
        lastUsedAt: Date.now(),
        useCount: stats.useCount + 1
      })
      this.persistUsage() // 落盘（500ms 防抖）
      return { ...meta, body }
    } catch (err) {
      console.error(`[skills] 加载 skill 正文失败 ${meta.filePath}:`, err)
      return null
    }
  }

  /** 设置 skill 启用状态（写入 .skills.json，触发热重载） */
  setEnabled(name: string, enabled: boolean): void {
    this.config = setSkillEnabled(this.configPath, name, enabled)
    // 更新内存中的元数据
    const meta = this.findMetadata(name)
    if (meta) {
      meta.runtime.enabled = enabled
    }
  }

  /** 删除 skill（user / domain 来源均可删除） */
  deleteSkill(name: string): { ok: boolean; error?: string } {
    const meta = this.findMetadata(name)
    if (!meta) return { ok: false, error: '技能不存在' }
    try {
      rmSync(meta.dirPath, { recursive: true, force: true })
    } catch (err) {
      return { ok: false, error: `删除文件失败: ${(err as Error).message}` }
    }
    // 从内存列表移除
    const idx = this.metadatas.findIndex((s) => s.name === name)
    if (idx !== -1) this.metadatas.splice(idx, 1)
    // 清理运行时统计
    this.runtimeStats.delete(name)
    this.persistUsage()
    // 清理配置中的 enabled 覆盖（如果有）
    this.config = removeSkillConfig(this.configPath, name)
    return { ok: true }
  }

  /** 获取所有 skill 运行时状态（UI 监控用） */
  getStatuses(): SkillRuntimeStatus[] {
    return this.listMetadata().map((meta) => {
      const stats = this.runtimeStats.get(meta.name) ?? { lastUsedAt: null, useCount: 0 }
      const errorEntry = this.errors.find((e) => e.filePath === meta.filePath)
      return {
        name: meta.name,
        enabled: meta.runtime.enabled,
        autoInvocable: meta.runtime.enabled && !meta.disableModelInvocation,
        userInvocable: meta.runtime.enabled && meta.userInvocable !== false,
        source: meta.source,
        domain: meta.domain ?? null,
        lastUsedAt: stats.lastUsedAt,
        useCount: stats.useCount,
        loadError: errorEntry?.error ?? null
      }
    })
  }

  /** 获取加载错误列表 */
  getErrors(): Array<{ filePath: string; error: string }> {
    return this.errors
  }

  /** 启动 live change detection：监听 SKILL.md + .skills.json + .workspaces.json 变化，热重载。
   * 仅在登录态调用（系统强制登录后才可用），未登录访问 getUserSkillsDir 即抛错。 */
  startWatching(): void {
    this.stopWatching()
    const dirs = [getUserSkillsDir()]
    const domainDir = this.getDomainSkillsDir()
    if (domainDir) dirs.push(domainDir)

    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      try {
        const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
          if (filename && filename.endsWith(SKILL_MD_FILENAME)) {
            if (this.skillReloadTimer) clearTimeout(this.skillReloadTimer)
            this.skillReloadTimer = setTimeout(() => {
              console.log(`[skills] 检测到 ${filename} 变化（${eventType}），热重载 skills`)
              this.load()
              this.changeCb?.()
            }, SKILL_RELOAD_DEBOUNCE_MS)
          }
        })
        this.watchers.push(watcher)
      } catch (err) {
        console.error(`[skills] 监听目录失败 ${dir}:`, err)
      }
    }

    // 监听 SKILL 配置文件变化（.skills.json）
    watchSkillsConfig(this.configPath, () => {
      this.load()
      this.changeCb?.()
    })
  }

  /** 停止监听（应用退出或重新加载时调用） */
  stopWatching(): void {
    for (const w of this.watchers) {
      try { w.close() } catch { /* 忽略关闭错误 */ }
    }
    this.watchers = []
    if (this.skillReloadTimer) {
      clearTimeout(this.skillReloadTimer)
      this.skillReloadTimer = undefined
    }
    stopWatchingSkillsConfig()
  }

  /** 递归扫描技能目录树：
   * 子目录含 SKILL.md = 技能（领域 = 相对根目录的父路径，单层即领域文件夹名）；
   * 子目录不含 SKILL.md = 领域分类文件夹，下钻一层继续扫描（领域可无限层级与数量）。
   * 文件夹即领域真源，frontmatter 的 domain 声明不再参与判定；
   * 用户级（source=user）目录保持扁平语义：只扫一层，领域始终为空。 */
  private scanDir(
    dir: string,
    source: SkillSource,
    byName: Map<string, SkillMetadata>,
    domainPath?: string
  ): void {
    if (!existsSync(dir)) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (err) {
      console.error(`[skills] 读取目录失败 ${dir}:`, err)
      return
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry)
      let stat
      try { stat = statSync(entryPath) } catch { continue }
      if (!stat.isDirectory()) continue
      const skillMdPath = join(entryPath, SKILL_MD_FILENAME)
      if (existsSync(skillMdPath)) {
        // 技能目录：领域由文件夹路径直接给出，不再依赖 frontmatter 声明
        this.parseAndRegister(skillMdPath, source, byName, domainPath)
      } else {
        // 领域分类文件夹：累加目录名后继续递归（skill 文件夹名不入领域值）
        const next = domainPath ? `${domainPath}/${entry}` : entry
        this.scanDir(entryPath, source, byName, next)
      }
    }
  }

  /** 解析并注册单个 SKILL.md；领域由目录层级给出，frontmatter 声明不参与判定 */
  private parseAndRegister(
    filePath: string,
    source: SkillSource,
    byName: Map<string, SkillMetadata>,
    domainPath?: string
  ): void {
    try {
      const meta = parseSkillFile(filePath, source)
      // 领域真源 = 技能目录在根下的父路径（文件夹即领域，数量/层级不设上限）：
      // 领域级来源一律由目录路径决定，frontmatter 声明不参与判定（根下扁平技能领域为空）；
      // 用户级来源保留 frontmatter 声明值（旧兼容，不影响落位/分组）。
      if (source === 'domain') meta.domain = domainPath ?? undefined
      meta.runtime = getSkillRuntimeConfig(this.config, meta.name)
      // 优先级：后扫描的覆盖先扫描的（领域级覆盖用户级）
      byName.set(meta.name, meta)
    } catch (err) {
      const msg = err instanceof SkillValidationError
        ? err.message
        : (err as Error).message
      this.errors.push({ filePath, error: msg })
      console.error(`[skills] 解析失败 ${filePath}:`, msg)
    }
  }
}

/**
 * 获取领域级 skills 目录：{root}/skills_domains/U{uid}/AI{aiId}/

 * 按领域分类存放不同领域的技能，不跟工作区走。
 *
 * 未登录（uid=null）时 getScopedPath 抛错（曾回退顶层目录，见 path-context 注释），
 * 系统强制登录后才可用，未登录态的 load/startWatching 调用即抛错，无守卫。
 */
export function getDomainSkillsDir(): string {
  return getScopedPath('skills_domains')
}

// ===== 机制辅助 =====

/** 当前平台（映射到 skill platforms 声明的合法值） */
export function currentPlatform(): 'linux' | 'macos' | 'windows' {
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

/** L1 索引注入描述截断（SKILL_PROMPT_DESC_LIMIT=60）：超长描述截断 + "..." 省 token */
export const SKILL_DESC_LIMIT = 60
export function truncateSkillDescription(desc: string, limit = SKILL_DESC_LIMIT): string {
  if (desc.length <= limit) return desc
  return desc.slice(0, limit) + '…'
}

/** 按 category 分组 skill（无 category 归 "通用"） */
export function groupSkillsByCategory(skills: SkillMetadata[]): Map<string, SkillMetadata[]> {
  const groups = new Map<string, SkillMetadata[]>()
  for (const s of skills) {
    const cat = s.category?.trim() || '通用'
    const arr = groups.get(cat) ?? []
    arr.push(s)
    groups.set(cat, arr)
  }
  return groups
}

/**
 * 历史遗留数据迁移（幂等）：把未分层残留/旧裸数字分层搬到当前 U{uid}/AI{aiId} 分层目录。
 * 为什么存在——① 旧实现 getScopedPath 在未登录（uid=null）时回退 {root}/{domain}，
 * 导致数据落在顶层，而登录态扫描/安装路径是分层目录，两边错位：已安装技能列表不显示、
 * 启用开关写不到分层配置；② 旧分层曾用裸数字 {uid}/{aiId}（例如 {root}/skills/1/1），
 * 与 memory/NNG/cache 的 U/AI 字面前缀约定不一致，已统一为 {root}/{domain}/U{uid}/AI{aiId}；
 * 什么作用——登录后首次 load() 把顶层遗留迁移到当前 U{uid}/AI{aiId} 分层，并把旧裸数字
 * 分层数据搬到新前缀分层（幂等：目标已存在则跳过）；
 * 留存理由——升级/分发场景已有数据，不迁移则修复后旧技能依然不可见。
 * 幂等：目标已存在则跳过；顶层扫描跳过纯数字 uid 分层目录（迁移后不再是正确分层，
 * 由下方 moveLegacyNumericScope 负责搬到 U/AI 前缀）。
 */
export function migrateLegacyScopedData(): void {
  const root = getDataRoot()
  const uid = getCurrentUid()
  const aiId = getCurrentAiId()
  // 未登录/缺 uid/aiId 一律抛错（系统强制登录后才可迁移；曾静默 return 掩盖未登录路径错误）
  if (!root || uid === null || aiId === null) {
    throw new Error(
      `[skills] migrateLegacyScopedData 仅在登录态可执行（root=${root ? 'ok' : 'null'}, uid=${uid}, aiId=${aiId}）`
    )
  }

  const legacyUserSkills = join(root, 'skills')
  const scopedUserSkills = scopedDomainPath(root, 'skills', uid, aiId)
  migrateSkillEntries(legacyUserSkills, scopedUserSkills)
  // 旧裸数字分层 {root}/skills/{uid}/{aiId} → {root}/skills/U{uid}/AI{aiId}
  moveLegacyNumericScope(legacyUserSkills, uid, aiId, scopedUserSkills)

  const legacyDomainSkills = join(root, 'skills_domains')
  const scopedDomainSkills = scopedDomainPath(root, 'skills_domains', uid, aiId)
  migrateSkillEntries(legacyDomainSkills, scopedDomainSkills)
  moveLegacyNumericScope(legacyDomainSkills, uid, aiId, scopedDomainSkills)

  // 顶层配置残留 → 分层配置（含 .skills-usage.json 使用统计）
  const legacyConfigDir = join(root, 'config')
  const scopedConfigDir = scopedDomainPath(root, 'config', uid, aiId)
  for (const file of ['.skills.json', '.skills-usage.json', '.workspaces.json']) {
    const from = join(legacyConfigDir, file)
    const to = join(scopedConfigDir, file)
    if (existsSync(from) && !existsSync(to)) {
      try {
        mkdirSync(scopedConfigDir, { recursive: true })
        renameSync(from, to)
        console.log(`[skills] 迁移遗留配置文件 ${basename(from)} → ${basename(to)}`)
      } catch (err) {
        console.warn(`[skills] 迁移配置文件失败 ${basename(from)} → ${basename(to)}:`, (err as Error).message)
      }
    }
  }
  // 旧裸数字分层 {root}/config/{uid}/{aiId} → {root}/config/U{uid}/AI{aiId}（整体搬，含上述配置文件）
  moveLegacyNumericScope(legacyConfigDir, uid, aiId, scopedConfigDir)
}

/**
 * 旧裸数字分层迁移：{root}/{domain}/{uid}/{aiId} → {root}/{domain}/U{uid}/AI{aiId}。
 * 为什么存在——getScopedPath 曾返回裸数字 {uid}/{aiId}（历史欠账），本次统一
 * U/AI 前缀后搬到新位置；目标已存在则跳过（不覆盖新数据）。
 * 为什么删不掉旧目录——搬完后旧路径可能残留空壳，属正常（幂等，删除 AI 时
 * ai-workspace-purge 会一并清理旧裸数字分层）。
 */
function moveLegacyNumericScope(root: string, uid: number, aiId: number, scopedTarget: string): void {
  const from = join(root, String(uid), String(aiId))
  if (!existsSync(from)) return
  if (existsSync(scopedTarget)) return
  try {
    mkdirSync(dirname(scopedTarget), { recursive: true })
    renameSync(from, scopedTarget)
    console.log(`[skills] 迁移旧裸数字分层 ${basename(from)} → ${basename(scopedTarget)}`)
  } catch (err) {
    console.warn(`[skills] 迁移旧裸数字分层失败 ${basename(from)} → ${basename(scopedTarget)}:`, (err as Error).message)
  }
}

/** 把一层目录下的技能条目从 srcRoot 迁移到 dstRoot（跳过旧裸数字 uid 层与 U/AI 前缀分层骨架） */
function migrateSkillEntries(srcRoot: string, dstRoot: string): void {
  if (!existsSync(srcRoot)) return
  let entries: string[]
  try {
    entries = readdirSync(srcRoot)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    // 纯数字目录 = 旧裸数字分层 uid 目录（迁移后不再是正确分层，由 moveLegacyNumericScope 整体搬）；
    // U{uid}/AI{aiId} 前缀目录 = 正确分层骨架（已登录态立目录），都不是遗留技能条目，跳过
    if (/^\d+$/.test(entry) || /^U\d+$/.test(entry) || /^AI\d+$/.test(entry)) continue
    const from = join(srcRoot, entry)
    let stat
    try { stat = statSync(from) } catch { continue }
    if (!stat.isDirectory()) {
      // 顶层直接散落的 .json 等文件（如 .skills.json 的迁移已单独处理，这里跳过非技能）
      continue
    }
    const to = join(dstRoot, entry)
    if (existsSync(to)) continue
    // 防御性兜底：目标落在源目录自身内部（自嵌套）时，Windows rename 必然 EPERM，
    // 且意味着扫描器把分层骨架误当遗留条目——跳过并告警，避免每次启动刷错
    if (to.startsWith(from + sep)) {
      console.warn(`[skills] 跳过自嵌套迁移 ${basename(from)} → ${basename(to)}（目标位于源目录内部，不是遗留技能条目）`)
      continue
    }
    try {
      mkdirSync(dstRoot, { recursive: true })
      renameSync(from, to)
      console.log(`[skills] 迁移遗留技能目录 ${basename(from)} → ${basename(to)}`)
    } catch (err) {
      console.warn(`[skills] 迁移技能目录失败 ${basename(from)} → ${basename(to)}:`, (err as Error).message)
    }
  }
}