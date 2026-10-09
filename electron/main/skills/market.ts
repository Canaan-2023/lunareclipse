/**
 * Skill 市场：让用户从内置清单 / 本地目录安装第三方技能，
 * 是技能生态扩张的入口。负责市场源管理、安装/更新/卸载/同步全生命周期，
 * 安装时经 frontmatter 校验、工具名适配与来源锁定后，按「文件夹即领域」落位：
 * 技能在领域级目录树中的父路径即领域（skills_domains/{领域路径}/），平铺/用户级落用户级。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, copyFileSync } from 'fs'
import { join, basename, dirname, sep } from 'path'
import { createHash } from 'crypto'
import type { SkillLoader } from './loader'
import { parseSkillFile, getUserSkillsDir, getDomainSkillsDir } from './loader'
import { parseFrontmatter, validateFrontmatter } from './frontmatter'
import { lintSkill, summarizeLint } from './linter'
import { first_threat_message } from '../tools/security-engine/threat-patterns'
import { isSafeUrl } from './url-safety'
import { adaptToolNames } from './tool-name-adapt'
import { getCurrentUid, getCurrentAiId } from '../models/path-context'
import type { LanEnvelope } from '../multi-instance/lan/lan-types'

/**
 * Skill 市场（技能市场本土化）：
 * - 源管理：内置官方清单 URL + 用户 addSource（清单 JSON / 本地目录）
 * - 安装：从来源目录复制 → frontmatter 校验 + 工具名适配 → 按目录领域落位复制
 * （领域级 skills_domains/{领域路径}/{name} 或用户级）→ 来源锁定 → 热重载
 * - 更新：sha/version 对比，userModified 跳过
 * - 卸载：按安装记录 domain 定位删除 + 清记录（内置/领域级拒绝）
 * - 同步：批量检查已装 skill 更新

 * 数据：{userData}/skill-market/manifest.json
 * { sources: [{id, name, url, type}], installed: {name: {source, version, sha, installedAt, userModified, synced, domain}} }
 */

/**
 * 内置市场源的可移植标识（伪 URL）。
 * 为什么存在——manifest.json 持久化市场源时若直接写本机绝对路径，换机器/分发后
 * 路径即失效，且会把开发机目录结构泄露进用户数据与 UI；用固定标识代替真实路径，
 * 由消费端（listMarketSkills / resolveSkillDir）经 resolveDirSourceUrl 解析到
 * 当前机器的内置仓库目录（打包=resources/skills/market-repo，dev=源码目录）。
 * 作用——manifest 里只出现 "builtin://market-repo" 一个可移植串，任何机器读同一
 * manifest 都能解析到本机对应目录。
 * 留存理由——该标识是内置源在磁盘上的唯一身份，删除会破坏旧版 manifest 的
 * URL 兼容解析，必须保留。
 */
export const BUILTIN_SOURCE_URL = 'builtin://market-repo'

/**
 * 本地上传市场源的可移植标识（伪 URL），语义与 builtin://market-repo 同款：
 * manifest 不落本机绝对路径，由消费端 resolveDirSourceUrl 解析到本机
 * {marketDir}/uploads 目录。懒注册——首次上传（或收到他人上传广播）时才
 * 加入 sources，避免空源常驻市场列表。
 */
export const UPLOAD_SOURCE_URL = 'local://uploads'

/** 目录名是否为月蚀既有结构容器（非用户自定义领域）。
 * 为什么存在——上传时「文件夹即领域」取父目录名作领域，但月蚀目录体系自带
 * skills/skills_domains/U{uid}/AI{aiId}/config 等固定层级名，若被当成领域，
 * 从本机技能库上传的技能会错误归类到「skills」「AI1」这类伪领域；
 * 什么作用——uploadSkill 里命中结构容器名的父目录不产出领域，按用户级平铺落位。
 * U{uid}/AI{aiId} 为分层前缀字面量（与 loader/path-context 的约定同构）。 */
export function isStructuralContainerDir(name: string): boolean {
  if (name === 'skills' || name === 'skills_domains' || name === 'config' || name === 'uploads' || name === 'skill-market') {
    return true
  }
  return /^U\d+$/.test(name) || /^AI\d+$/.test(name)
}

/** 市场源 */
export interface MarketSource {
  id: string
  name: string
  /** 清单 JSON URL / 本地目录路径 / 内置源可移植标识（builtin://market-repo） */
  url: string
  /** json（清单）/ dir（本地目录） */
  type: 'json' | 'dir'
}

/** 市场清单里的 skill 条目 */
export interface MarketSkillEntry {
  name: string
  description: string
  repo: string
  /** 来源目录内 skill 所在子目录（可选） */
  subdir?: string
  version?: string
  sha?: string
  /** SKILL 所属领域：目录路径判定真源（文件夹即领域，与 SkillLoader 同构）——
   * 仓库 skills/{领域}/{name} 中领域 = 技能目录相对 skills/ 的父路径（可多层、数量不限）；
   * 平铺形态（skills/{name}）领域为空 = 用户级技能。frontmatter 声明不参与判定。 */
  domain?: string
}

/** 已安装记录 */
export interface InstalledSkill {
  source: string
  version?: string
  sha?: string
  installedAt: number
  /** 用户手动改过（更新时跳过） */
  userModified: boolean
  /** 参与批量同步 */
  synced: boolean
  /** 安装时的目录领域快照（用户级技能不写）。卸载/更新按它定位旧磁盘目录。 */
  domain?: string
}

/** 本地上传市场（local://uploads）的条目元数据 */
export interface UploadedSkillRecord {
  /** 上传者 UID（主系统统一发放，全局唯一；删除权限按它判定） */
  uploaderUid: number
  uploadedAt: number
  sha?: string
  version?: string
  /** 上传时的目录领域（父目录名；空 = 用户级平铺）。磁盘落位与卸载清理按它定位。 */
  domain?: string
}

/** 市场删除墓碑（全局共享，不分 uid/aiId 作用域：删除是市场级动作） */
export interface RemovedSkillRecord {
  removedAt: number
  removedBy: number
}

/**
 * 市场 × 局域网依赖（主分系统共享市场用；standalone 无 LAN 时缺省，仅本机可用）。
 * 全部可选注入，单机场景不注入也能本地上传/下架。
 */
export interface SkillMarketLanDeps {
  /** 当前实例角色（instance.json）；未知返回 null（删除权限按上传者本人收敛） */
  getRole?: () => 'standalone' | 'master' | 'satellite' | null
  /** 经 L0 直连发送业务信封（逐在线成员单播） */
  sendLan?: (uid: number, type: string, payload: unknown) => unknown
  /** 对端列表（含角色，用于识别主系统发起的跨作者删除） */
  listPeers?: () => Array<{ uid: number; role: string; online: boolean }>
}

/** skill-market.upload 信封载荷（上传广播 / 同步回推共用结构） */
export interface SkillMarketUploadPayload {
  name: string
  description: string
  /** SKILL.md 全文（对端落盘后与主动上传同一套校验） */
  body: string
  /** 技能目录内 SKILL.md 之外的附属文件（相对路径 → 内容，UTF-8 文本）。
   * 为什么存在——技能不是一个文件：ai-perspective-prompting / code-review 等
   * 依赖 scripts/、_meta.json 等附属文件，只广播 SKILL.md 会让对端装出"缺腿"技能；
   * 什么作用——发起端在 uploadSkill 广播时把目录内其余文本文件一并附上，
   * 对端 applyUpload 逐文件落位（与 install 整目录复制同构），保持两端技能完整；
   * 留存理由——可选字段，旧版广播（无 files）仍可被收端兼容落位 SKILL.md。 */
  files?: Record<string, string>
  /** 上传者 UID（对端据此信任校验与删除权限判定） */
  authorUid: number
  uploadedAt: number
  version?: string
  domain?: string
  sha?: string
}

/** skill-market.remove 信封载荷（主动下架广播） */
export interface SkillMarketRemovePayload {
  name: string
  /** 被下架技能的上传者——对端据此区分「本人删除」与「主系统删除」 */
  authorUid: number
  removedAt: number
  removedBy: number
}

/** skill-market.tombstone 信封载荷（同步回推墓碑，幂等） */
export interface SkillMarketTombstonePayload {
  name: string
  removedAt: number
  removedBy: number
}

/** skill-market.syncWant 信封载荷（对端上线请求同步：携带本机已有版本供对方比对） */
export interface SkillMarketSyncWantPayload {
  have: Array<{ name: string; uploadedAt: number }>
  removed: Array<{ name: string; removedAt: number }>
}

/** skill-market.replay 信封载荷（同步回推：缺失/较新的上传全量与墓碑） */
export interface SkillMarketReplayPayload {
  uploads: SkillMarketUploadPayload[]
  tombstones: SkillMarketTombstonePayload[]
}

/**
 * 安装记录的作用域键：U{uid}/AI{aiId}（与磁盘 skills 目录分层同构）。
 * 为什么存在——installed 记录必须和磁盘文件一样按 uid/aiId 分层，
 * 否则 A 用户装的 skill 会显示在 B 用户/其他 AI 的市场上（跨作用域误显「已安装」），
 * 卸载时还会误删别人的记录（manifest 全局删 → 其它作用域磁盘存在但记录丢失）。
 * 键与磁盘目录同款前缀约定（U/AI 字面量），禁止裸数字，防止再次分层漂移。
 */
export function scopeKeyOf(uid: number, aiId: number): string {
  return `U${uid}/AI${aiId}`
}

interface MarketManifest {
  sources: MarketSource[]
  /**
   * 安装记录：{ scopeKey: { name: InstalledSkill } }。
   * 曾为 { name: InstalledSkill } 全局扁平结构（跨 uid/aiId 共享同一记录，
   * 造成「别人/AI 装的 skill 显示为已装」「卸载误删全局记录」两类作用域错误），
   * 已按 scopeKeyOf(uid, aiId) 归一化；不兼容旧扁平记录，磁盘存在性才是安装真源。
   */
  installed: Record<string, Record<string, InstalledSkill>>
  /** 本地上传条目：{ name: UploadedSkillRecord }（全局，上传对全网可见） */
  uploads: Record<string, UploadedSkillRecord>
  /** 删除墓碑：{ name: RemovedSkillRecord }（全局；市场列表按它过滤已下架条目） */
  removed: Record<string, RemovedSkillRecord>
}

export interface MarketProgress {
  phase: 'fetch' | 'install' | 'update' | 'remove' | 'sync'
  skillName?: string
  status: 'start' | 'progress' | 'done' | 'error'
  message?: string
}

export class SkillMarket {
  private marketDir: string
  private manifestPath: string
  private cacheDir: string
  private manifest: MarketManifest
  private loader: SkillLoader
  private onProgress?: (p: MarketProgress) => void
  /** 市场 × 局域网依赖（主分系统共享市场；未注入时本地上传/下架仍可用） */
  private lan?: SkillMarketLanDeps
  /** 用户级 skills 目录 provider（默认 getUserSkillsDir()，测试可注入字符串） */
  private userSkillsDirProvider: () => string
  /** 领域级 skills 目录 provider（默认 getDomainSkillsDir()，测试可注入字符串）。
   * 领域级按 skills_domains/{domain}/{name} 落位，不跟用户级混放。 */
  private domainSkillsDirProvider: () => string
  /** 内置市场仓库目录（随包分发，resources/skills/market-repo）；为空则不自动注册 */
  private builtinRepoDir: string

  constructor(
    marketDir: string,
    loader: SkillLoader,
    userSkillsDir?: string | (() => string),
    builtinRepoDir?: string,
    domainSkillsDir?: string | (() => string)
  ) {
    this.marketDir = marketDir
    this.manifestPath = join(marketDir, 'manifest.json')
    this.cacheDir = join(marketDir, '.cache')
    this.loader = loader
    /**
     * userSkillsDir 动态求值而不是构造时固化：
     * 为什么存在——SkillMarket 常在启动早期（未登录）构造，若此时固化
     * getUserSkillsDir() 会得到顶层 {root}/skills；登录后 install/remove
     * 也写这个固化路径，而 SkillLoader 登录后按 U{uid}/AI{aiId} 前缀分层扫描，
     * 安装即不可见（已装技能列表不显示的直接原因）；
     * 什么作用——install/remove 每次经 provider 按当前 uid/aiId 解析目标目录，
     * 与 loader 扫描路径始终一致；测试传字符串仍兼容（包一层 () => string）。
     */
    this.userSkillsDirProvider =
      typeof userSkillsDir === 'function'
        ? userSkillsDir
        : userSkillsDir
          ? () => userSkillsDir
          : () => getUserSkillsDir()
    // domainSkillsDirProvider 与 userSkillsDirProvider 同型：
    // 登录后 install/remove 按当前 uid/aiId 动态解析领域级目录（skills_domains 域），
    // 与 loader 的 getDomainSkillsDir() 扫描路径保持一致，测试可传字符串覆盖。
    this.domainSkillsDirProvider =
      typeof domainSkillsDir === 'function'
        ? domainSkillsDir
        : domainSkillsDir
          ? () => domainSkillsDir
          : () => getDomainSkillsDir()
    this.builtinRepoDir = builtinRepoDir ?? ''
    mkdirSync(marketDir, { recursive: true })
    mkdirSync(this.cacheDir, { recursive: true })
    this.manifest = this.loadManifest()
    // 首次启动自动注册内置市场源：
    // 为什么存在——内置市场仓库随安装包分发，若首启不自动注册，用户看到空市场
    // 还要手动去设置页添加本地目录源，分发价值打折；
    // 什么作用——manifest 为空（从未建过源）且有内置仓库时，以 dir 源形式注册一次，
    // 用户打开技能市场即可直接浏览/安装 10 个内置技能；
    // 留存理由——仅当 manifest 无源且仓库目录真实存在时注册（幂等：已建过源或
    // 仓库缺失都不触发），用户后续可自行增删源，不影响现有源管理流程。
    this.ensureBuiltinSource()
  }

  /** 当前用户级 skills 目录（按当前 uid/aiId 动态解析；未登录抛错——调用方在登录态使用） */
  private getUserSkillsDir(): string {
    return this.userSkillsDirProvider()
  }

  /** 当前领域级 skills 目录（{root}/skills_domains/U{uid}/AI{aiId}/，按当前 uid/aiId 动态解析；
   * 与 loader.getDomainSkillsDir() 同源；未登录抛错——与用户级同守卫） */
  private getDomainSkillsDir(): string {
    return this.domainSkillsDirProvider()
  }

  /**
   * 按 skill 的 domain 解析其安装目录：
   * 领域级（有 domain）→ {domainSkillsDir}/{domain}/{name}；
   * 用户级（无 domain，方法论/通用技能）→ {userSkillsDir}/{name}。
   * 为什么存在——市场两档并存：领域技能按大类落 skills_domains，所有人/所有 AI
   * install 判定、卸载、更新共用同一解析，避免领域技能被误当用户级读目录
   * （读不到即误报「未安装」/跨级删除）。
   */
  private resolveInstalledDir(name: string, domain?: string): string {
    const d = domain?.trim()
    return d ? join(this.getDomainSkillsDir(), d, name) : join(this.getUserSkillsDir(), name)
  }

  /** 当前作用域键：scopeKeyOf(uid, aiId)；未登录（uid/aiId 缺失）禁止解析（与 getScopedPath 同守卫） */
  private currentScopeKey(): string {
    const uid = getCurrentUid()
    const aiId = getCurrentAiId()
    if (uid === null || aiId === null) {
      throw new Error('[skill-market] 未登录态禁止解析安装记录作用域（uid/aiId 缺失）：系统要求先登录')
    }
    return scopeKeyOf(uid, aiId)
  }

  /** 只读当前作用域记录表（不存在返回空表；不落盘） */
  private readScopeInstalled(): Record<string, InstalledSkill> {
    return this.manifest.installed[this.currentScopeKey()] ?? {}
  }

  /** 可写当前作用域记录表（不存在则创建，persist 时才落盘） */
  private writeScopeInstalled(): Record<string, InstalledSkill> {
    const key = this.currentScopeKey()
    let table = this.manifest.installed[key]
    if (!table) {
      table = {}
      this.manifest.installed[key] = table
    }
    return table
  }

  /** 当前作用域安装记录（仅元数据，安装真源见 isInstalledOnDisk；不跨作用域、无历史兜底） */
  private getInstalled(name: string): InstalledSkill | null {
    return this.readScopeInstalled()[name] ?? null
  }

  /** 安装真源：当前作用域磁盘目录是否存在（与 SkillLoader 扫描同源，跨 uid/aiId 不看 manifest）。
   * domain 为空查用户级，否则查领域级 {domain}/{name}——与 install 落位同规则。
   * 未登录时 provider 抛错（与 getScopedPath 同守卫），不吞——静默 false 会掩盖「未登录调市场」的程序错误。 */
  private isInstalledOnDisk(name: string, domain?: string): boolean {
    return existsSync(this.resolveInstalledDir(name, domain))
  }

  setProgressCallback(cb: (p: MarketProgress) => void): void {
    this.onProgress = cb
  }

  /** 注入市场 × 局域网依赖（index.ts 在 startLan 后接线；未注入则上传/下架仅本机生效） */
  setLanDeps(deps: SkillMarketLanDeps): void {
    this.lan = deps
  }

  /** 本地上传目录（{marketDir}/uploads；其下 skills/ 按领域结构落位：有领域 → skills/{领域}/{name}，平铺 → skills/{name}） */
  private uploadsDir(): string {
    return join(this.marketDir, 'uploads')
  }

  /**
   * 懒注册本地上传源（幂等）：首次上传 / 收到他人上传广播 / 收到同步回推时调用。
   * 用可移植标识 UPLOAD_SOURCE_URL，解析见 resolveDirSourceUrl——
   * 不落本机绝对路径（manifest 跨机可移植），平时不注册，避免空源常驻市场列表。
   */
  private ensureUploadsSource(): void {
    const exists = this.manifest.sources.some((s) => s.url === UPLOAD_SOURCE_URL)
    if (!exists) {
      this.manifest.sources.push({
        id: `src_upload_${Date.now().toString(36)}`,
        name: '本地上传',
        url: UPLOAD_SOURCE_URL,
        type: 'dir'
      })
      this.persist()
    }
  }

  // ===== 源管理 =====

  listSources(): MarketSource[] {
    return [...this.manifest.sources]
  }

  addSource(name: string, url: string): { ok: boolean; error?: string } {
    const trimmed = url.trim()
    if (!trimmed) return { ok: false, error: 'URL 不能为空' }
    let type: MarketSource['type'] = 'json'
    if (trimmed.startsWith('http')) type = 'json'
    else type = 'dir' // 本地路径
    const source: MarketSource = { id: `src_${Date.now().toString(36)}`, name: name.trim() || basename(trimmed), url: trimmed, type }
    this.manifest.sources.push(source)
    this.persist()
    return { ok: true }
  }

  removeSource(id: string): { ok: boolean; error?: string } {
    const before = this.manifest.sources.length
    this.manifest.sources = this.manifest.sources.filter((s) => s.id !== id)
    if (this.manifest.sources.length === before) return { ok: false, error: '源不存在' }
    this.persist()
    return { ok: true }
  }

  // ===== 市场列表 =====

  /** 收集所有源的可安装 skill（过滤已下架墓碑；上传条目附 canDelete 供前端显示删除入口） */
  async listMarketSkills(): Promise<
    Array<MarketSkillEntry & { sourceId: string; installed: boolean; hasUpdate: boolean; userModified: boolean; uploaderUid?: number; canDelete?: boolean }>
  > {
    const entries: Array<MarketSkillEntry & { sourceId: string; installed: boolean; hasUpdate: boolean; userModified: boolean; uploaderUid?: number; canDelete?: boolean }> = []
    const removed = this.manifest.removed
    for (const source of this.manifest.sources) {
      try {
        let skills: MarketSkillEntry[] = []
        if (source.type === 'dir') {
          // dir 源先解析可移植标识：builtin://market-repo → 本机内置仓库目录，
          // 用户自定义本地目录原样使用。返回条目里 repo 字段保持 source.url
          // （标识/用户输入）而不露解析后的绝对路径，见下面对 repo 的脱敏。
          const dir = this.resolveDirSourceUrl(source.url)
          skills = this.scanRepoForSkills(dir)
          // repo 脱敏：scanRepoForSkills 会把实际目录填进 entry.repo（本机绝对
          // 路径，分发给他人即失效且暴露本机结构），这里统一改回源的可移植
          // 标识/用户输入值，UI 展示与后端传输都不携带本机路径。
          for (const s of skills) s.repo = source.url
        } else {
          // json 清单：网络拉取
          const list = await this.fetchJsonList(source.url)
          skills = list
        }
        for (const s of skills) {
          // 删除墓碑过滤：被主系统/上传者下架的条目全网不再显示（含内置源与上传源）
          if (removed[s.name]) continue
          // 安装真源 = 当前作用域磁盘目录存在（与 SkillLoader 扫描同源，且按条目 domain 定位）：
          // 修复跨作用域误显示——A 用户/AI{1} 装的 skill，B 用户/AI{2} 市场不再显示「已安装」。
          const installed = this.isInstalledOnDisk(s.name, s.domain)
          // 元数据（来源/版本/是否用户改过）只取当前作用域记录，legacy 兜底
          const inst = this.getInstalled(s.name)
          const hasUpdate = installed && inst ? Boolean((s.sha && inst.sha !== s.sha) || (s.version && inst.version !== s.version)) : false
          // userModified：本地已被用户改过的 skill，更新按钮必须可见禁用态，
          // 且 UI 需要徽章提示——否则用户点「更新」只会收到 update() 里
          // “已被本地修改，更新跳过”的报错，认为是 bug
          const isUpload = source.url === UPLOAD_SOURCE_URL
          const rec = isUpload ? this.manifest.uploads[s.name] : undefined
          entries.push({
            ...s,
            sourceId: source.id,
            installed,
            hasUpdate,
            userModified: installed && inst?.userModified === true,
// 上传条目附上传者标识；删除权限统一判定（主系统/单机可删任意市场条目
          // 含内置源，分系统仅可删自己上传的——见 canDeleteEntry）
          ...(rec ? { uploaderUid: rec.uploaderUid } : {}),
          canDelete: this.canDeleteEntry(rec)
          })
        }
      } catch (err) {
        this.onProgress?.({ phase: 'fetch', status: 'error', message: `源 ${source.name} 加载失败: ${(err as Error).message}` })
      }
    }
    return entries
  }

  // ===== 安装 =====

  async install(name: string): Promise<{ ok: boolean; error?: string; lint?: ReturnType<typeof summarizeLint>; config?: Array<{ key: string; description: string; default?: string }> }> {
    this.onProgress?.({ phase: 'install', skillName: name, status: 'start' })
    // 找到来源
    const entry = await this.findEntry(name)
    if (!entry) return { ok: false, error: `市场中没有 skill "${name}"` }
    const source = this.manifest.sources.find((s) => s.id === entry.sourceId)
    if (!source) return { ok: false, error: '来源不存在' }

    // 获取 skill 目录（本地目录源）
    let skillDir: string
    try {
      skillDir = await this.resolveSkillDir(source, entry)
    } catch (err) {
      return { ok: false, error: `获取 skill 失败: ${(err as Error).message}` }
    }

    // 校验 + 工具名适配 + 复制到目标级
    try {
      const skillMdPath = join(skillDir, 'SKILL.md')
      if (!existsSync(skillMdPath)) return { ok: false, error: `SKILL.md 不存在: ${skillMdPath}` }
      const meta = parseSkillFile(skillMdPath, 'user')
      // lint
      const raw = readFileSync(skillMdPath, 'utf-8')
      const threat = first_threat_message(raw, 'strict')
      if (threat) {
        return { ok: false, error: `安全检查失败：${threat}` }
      }
      const lint = lintSkill({ ...meta, body: raw })
      const lintSummary = summarizeLint(lint)

      // 附属文件安全检查：威胁不只可能藏在 SKILL.md——scripts/*.py、_meta.json、
      // assets/ 等随库附属文件同样可能携带注入/外泄载荷（如悄悄读取 .env 上传），
      // 整目录复制前必须逐文件过一遍与主文件同一套 strict 威胁扫描，命中即拒绝安装。
      const fileThreat = this.scanSkillTreeForThreats(skillDir)
      if (fileThreat) {
        return { ok: false, error: `安全检查失败：${fileThreat}` }
      }

      // 适配工具名（正文 + frontmatter 里的外部工具名 → 月蚀）
      const adapted = adaptToolNames(raw)
      // 落位领域真源：市场条目的目录路径（与 SkillLoader「文件夹即领域」同构）——
      // 条目领域由 scanRepoForSkills 按技能目录相对 skills/ 的父路径给出，
      // 安装落位与扫描判定一致，frontmatter 声明不参与落位（避免两份真源漂移）。
      const domain = entry.domain
      // 写目标目录：领域级 {domainSkillsDir}/{domain}/{name}，用户级 {userSkillsDir}/{name}
      const destDir = domain
        ? join(this.getDomainSkillsDir(), domain, meta.name)
        : join(this.getUserSkillsDir(), meta.name)
      // 旧落位收敛：目录领域变化时删除旧目录，避免同一技能在旧领域
      // 残留幽灵副本（卸载/同步按新记录定位，旧副本将永久不可达）。
      const prev = this.readScopeInstalled()[meta.name]
      if (prev && prev.domain !== domain) {
        const prevDir = this.resolveInstalledDir(meta.name, prev.domain)
        if (existsSync(prevDir)) rmSync(prevDir, { recursive: true, force: true })
      }
      // 整目录复制（不只是 SKILL.md）：技能不是单文件，scripts/、_meta.json、
      // assets/ 等附属文件随库分发，只写 SKILL.md 会让安装后的技能"缺腿"——
      // 如 ai-perspective-prompting 的执行脚本、code-review 的场景规则就无法用。
      // 先复制整目录，再用适配后的 SKILL.md 覆盖主文件（工具名适配只作用于正文）。
      mkdirSync(destDir, { recursive: true })
      this.copySkillTree(skillDir, destDir)
      writeFileSync(join(destDir, 'SKILL.md'), adapted, 'utf-8')

      // 来源锁定（写入当前作用域表，见 writeScopeInstalled；domain 一并记录，
      // 卸载/更新与磁盘存在性判定按它定位，不跨级误删）
      this.writeScopeInstalled()[meta.name] = {
        source: source.id,
        version: meta.version ?? entry.version,
        sha: entry.sha,
        installedAt: Date.now(),
        userModified: false,
        synced: true,
        domain
      }
      this.persist()
      // 热重载
      this.loader.load()
      this.onProgress?.({ phase: 'install', skillName: name, status: 'done' })
      return { ok: true, lint: lintSummary, config: meta.config?.map((c) => ({ key: c.key, description: c.description, default: c.default })) }
    } catch (err) {
      this.onProgress?.({ phase: 'install', skillName: name, status: 'error', message: (err as Error).message })
      return { ok: false, error: `安装失败: ${(err as Error).message}` }
    }
  }

  // ===== 更新 =====

  async update(name: string): Promise<{ ok: boolean; error?: string }> {
    // 更新判定走当前作用域记录（磁盘存在 + 记录命中），不误判他人/AI 的安装
    const inst = this.getInstalled(name)
    if (!inst || !this.isInstalledOnDisk(name, inst.domain)) return { ok: false, error: `skill "${name}" 未安装` }
    if (inst.userModified) return { ok: false, error: `skill "${name}" 已被本地修改，更新跳过（如需更新请先重置 userModified）` }
    // 重新安装（install 按市场条目目录领域决定新落位并收敛旧目录；
    // 记录 domain 只是快照，用于定位旧目录，不参与落位判定）
    const result = await this.install(name)
    if (result.ok) {
      // 保留 userModified 状态（写入当前作用域表）
      this.writeScopeInstalled()[name].userModified = false
      this.persist()
    }
    return { ok: result.ok, error: result.error }
  }

  // ===== 卸载 =====

  remove(name: string): { ok: boolean; error?: string } {
    const inst = this.getInstalled(name)
    if (!inst || !this.isInstalledOnDisk(name, inst.domain)) {
      return { ok: false, error: `skill "${name}" 未安装（或不是市场来源）` }
    }
    // 按记录 domain 定位：领域级删 {domain}/{name}，用户级删用户目录——不跨级误删
    const destDir = this.resolveInstalledDir(name, inst.domain)
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true })
    }
    // 只删当前作用域记录，不误删其它 uid/AI 的 manifest 记录；
    // 直接操作 manifest 现有表（不创建新表），表变空则移除作用域键，避免残留空记录
    const scopeKey = this.currentScopeKey()
    const table = this.manifest.installed[scopeKey]
    if (table) {
      delete table[name]
      if (Object.keys(table).length === 0) delete this.manifest.installed[scopeKey]
    }
    this.persist()
    this.loader.load()
    return { ok: true }
  }

  // ===== 批量同步 =====

  /** 同步所有 synced=true 且非 userModified 的已安装 skill（检查更新自动拉取） */
  async syncAll(): Promise<{ ok: boolean; updated: string[]; errors: string[] }> {
    const updated: string[] = []
    const errors: string[] = []
    // 只同步当前作用域安装记录——修复跨 uid/aiId 全局同步（会去更新别人/AI 目录下的同名 skill）
    for (const [name, inst] of Object.entries(this.readScopeInstalled())) {
      if (!inst.synced || inst.userModified) continue
      // 磁盘缺失的记录（目录被用户手动删/清理过）跳过，避免误判为可更新；
      // 领域级技能按记录 domain 定位磁盘，与 install 落位一致
      if (!this.isInstalledOnDisk(name, inst.domain)) continue
      try {
        const entry = await this.findEntry(name)
        if (!entry) continue
        const hasUpdate = (entry.sha && inst.sha !== entry.sha) || (entry.version && inst.version !== entry.version)
        if (hasUpdate) {
          this.onProgress?.({ phase: 'sync', skillName: name, status: 'progress', message: '发现更新' })
          const r = await this.update(name)
          if (r.ok) updated.push(name)
          else errors.push(`${name}: ${r.error}`)
        }
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`)
      }
    }
    return { ok: errors.length === 0, updated, errors }
  }

  /** 标记某 skill 为 userModified（用户手动改过后调用）；只写当前作用域记录 */
  markUserModified(name: string): void {
    const table = this.writeScopeInstalled()
    const inst = table[name]
    if (inst) {
      inst.userModified = true
      this.persist()
    }
  }

  // ===== 上传 / 下架 =====

  /**
   * 删除权限判定（市场条目的 canDelete + unpublish 服务端兜底同用这一处）：
   * 主系统/单机（standalone/master/无 lan 注入）可删任意市场条目——既包括他人
   * 上传的技能，也包括内置市场源等非上传条目（主系统是市场管理者，能对整个
   * 共享市场做下架治理）；分系统仅可删自己上传的（上传者本人）。
   * 为什么存在——市场是全网共享资源，若分系统能删他人上传或内置条目，一次误
   * 操作就把别人发布的技能/随包分发技能全网下架；权限按「上传者本人 = 删除者」
   * 收敛，只有拥有市场管理权的角色（standalone/master）放开到任意条目。
   * 什么作用——listMarketSkills 据此给每个条目附 canDelete（上传与非上传一致），
   * 前端显隐删除按钮；unpublish 入口再判定一次（权限判定在服务端，前端只是展示层）。
   */
  private canDeleteEntry(rec: UploadedSkillRecord | undefined): boolean {
    const role = this.lan?.getRole?.() ?? null
    if (role === 'satellite') {
      // 分系统：非上传条目（内置源等）无上传者归属，一律无权删；上传条目仅限本人
      const uid = getCurrentUid()
      return rec !== undefined && uid !== null && rec.uploaderUid === uid
    }
    // 主系统 / 单机（含角色未知）：可删任意市场条目
    return true
  }

  /**
   * 把本机一个 SKILL 目录发布进市场（列表内「上传」入口的服务端实现）。
   * 流程：SKILL.md 读取 → frontmatter/威胁扫描/lint（与 install 同一套校验）
   * → 复制到本地上传目录 uploads/skills/{领域}/{name}/SKILL.md（领域 = 所选
   * SKILL 目录的父目录名，文件夹即领域；父目录缺失时平铺 uploads/skills/{name}，
   * 与 scanRepoForSkills 目录判定同构）→ manifest.uploads 登记 →
   * 广播 upload 信封给在线对端。
   * 重名拒绝：市场已存在同名技能（无论领域/是否被下架）即拒绝上传，
   * 技能名是市场的全局唯一键，防止两个不同技能互相覆盖。
   * 离线对端不丢数据：上线时 syncWant/replay 增量补齐（见局域网同步区块）。
   */
  async uploadSkill(
    skillDir: string
  ): Promise<{ ok: boolean; error?: string; name?: string; lint?: ReturnType<typeof summarizeLint> }> {
    const skillMdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(skillMdPath)) return { ok: false, error: `SKILL.md 不存在: ${skillMdPath}` }
    const raw = readFileSync(skillMdPath, 'utf-8')
    const threat = first_threat_message(raw, 'strict')
    if (threat) return { ok: false, error: `安全检查失败：${threat}` }
    let meta: { name: string; description: string; version?: string; domain?: string }
    try {
      meta = parseSkillFile(skillMdPath, 'user')
    } catch (err) {
      return { ok: false, error: `SKILL.md 解析失败: ${(err as Error).message}` }
    }
    // 重名拒绝：manifest.uploads 以 name 为 key，技能名必须全局唯一。
    // 为什么拒绝而非覆盖——两个不同技能同名若互相覆盖，一方发布的内容会被
    // 另一端悄悄替换，局域网各端 manifest 以 name 对齐，没有可辨识的区分键。
    // 什么作用——上传即失败返回，前端展示明确错误；同名只能改技能名再传。
    // 被下架的技能名同样不能重新上传：墓碑已全网广播，同名上传会被列表过滤
    // 导致「上传成功但不可见」的状态，与「名称全局唯一」契约冲突，拒绝更一致。
    if (this.manifest.uploads[meta.name] || this.manifest.removed[meta.name]) {
      return { ok: false, error: `市场上已存在同名技能 "${meta.name}"，技能名需全局唯一，请改名后重新上传` }
    }
    const lint = lintSkill({ ...meta, body: raw })
    const lintSummary = summarizeLint(lint)
    // 附属文件安全检查：SKILL.md 之上已扫；scripts/、_meta.json 等文本附属文件
    // 同样纳入 strict 扫描——上传 = 发布，源目录内存在威胁内容就不能进入市场流通
    const fileThreat = this.scanSkillTreeForThreats(skillDir)
    if (fileThreat) {
      return { ok: false, error: `安全检查失败：${fileThreat}` }
    }
    const uid = getCurrentUid()
    if (uid === null) return { ok: false, error: '未登录态禁止上传（上传者身份缺失）' }
    // 文件夹即领域：上传目录的父目录名即领域（用户按「领域文件夹/技能」摆放本机技能时的自然映射）。
    // 结构容器目录名（技能根、分层前缀）不构成领域——它们是月蚀既有目录体系的一部分，
    // 不是用户自定义的领域分类，视为用户级平铺上传（与 loader 扫描语义一致）。
    let domain: string | undefined
    const parent = dirname(skillDir)
    if (parent && parent !== skillDir) {
      const parentName = basename(parent)
      if (parentName && !isStructuralContainerDir(parentName)) domain = parentName
    }
    const destDir = this.uploadsSkillDir(meta.name, domain)
    mkdirSync(destDir, { recursive: true })
    // 整目录上传（不只是 SKILL.md）：scripts/、_meta.json 等附属文件是技能的
    // 一部分，只发布 SKILL.md 会让对端安装出无法运行的残缺技能；与 install
    // 的整目录复制对称，发布面 = 安装面。
    this.copySkillTree(skillDir, destDir)
    this.ensureUploadsSource()
    const now = Date.now()
    this.manifest.uploads[meta.name] = {
      uploaderUid: uid,
      uploadedAt: now,
      sha: this.shaOfFile(join(destDir, 'SKILL.md')),
      version: meta.version,
      domain
    }
    // uploads 以 name 为唯一键，重名已拒绝，不存在同名条目可被覆盖或复活；
    // 被下架的同名技能同样拒绝上传（名称仍被占用），不产生墓碑清除分支
    this.persist()
    // 广播给在线对端（发起端已校验过权限与内容；对端只做幂等落位）
    this.broadcastToPeers('skill-market.upload', {
      name: meta.name,
      description: meta.description,
      body: raw,
      files: this.collectLanFiles(skillDir),
      authorUid: uid,
      uploadedAt: now,
      version: meta.version,
      domain,
      sha: this.manifest.uploads[meta.name].sha
    } satisfies SkillMarketUploadPayload)
    return { ok: true, name: meta.name, lint: lintSummary }
  }

  /** 上传条目在 uploads 目录下的磁盘路径：有领域 → uploads/skills/{领域}/{name}，无 → 平铺 uploads/skills/{name} */
  private uploadsSkillDir(name: string, domain?: string): string {
    return domain
      ? join(this.uploadsDir(), 'skills', domain, name)
      : join(this.uploadsDir(), 'skills', name)
  }

  /** 列出技能目录内的全部文件（相对路径列表，跨平台统一用正斜杠）。
   * 为什么存在——技能不是单文件：scripts/、_meta.json、assets/ 等附属文件
   * 是技能可运行的一部分，install/upload/LAN 广播都要围绕「目录」而非「SKILL.md」
   * 做整体搬运；只列文件避免逐层拼路径时在 Windows/Linux 上分隔符漂移。
   * 什么作用——copySkillTree / scanSkillTreeForThreats / collectLanFiles 共用
   * 这一份清单，保证三条链路覆盖同一文件面，不会出现"复制了但没扫"的漏洞。
   * 留存理由——跳过符号链接与跟随目录的递归语义集中在此一处，其它链路
   * 无需各自实现遍历，避免目录树规则散落多处后行为不一致。 */
  private listSkillFiles(dir: string): string[] {
    const out: string[] = []
    const walk = (base: string, rel: string): void => {
      let entries: import('fs').Dirent[]
      try {
        entries = readdirSync(base, { withFileTypes: true })
      } catch {
        return // 目录读取失败按空清单处理（上层已有 SKILL.md 存在性兜底）
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue // 不跟随符号链接，防目录逃逸
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(join(base, e.name), childRel)
        else if (e.isFile()) out.push(childRel)
      }
    }
    walk(dir, '')
    return out
  }

  /** 把技能目录整棵复制到目标目录（保留目录结构），覆盖同名文件。
   * 为什么存在——安装/上传落位要的是完整技能（SKILL.md + scripts/ + _meta.json 等），
   * 只写 SKILL.md 会让安装后的技能缺附属文件没法用（如 code-review 的场景规则、
   * ai-perspective-prompting 的执行脚本）。
   * 什么作用——install() 与 uploadSkill() 落盘统一走这里；SKILL.md 由调用方
   * 在复制后用适配/原始版本覆盖（工具名适配只作用于正文，不影响附属文件）。
   * 留存理由——复制范围与 listSkillFiles 的清单严格一致，保证"所见清单即所复制的文件"。 */
  private copySkillTree(srcDir: string, destDir: string): void {
    for (const rel of this.listSkillFiles(srcDir)) {
      const dst = join(destDir, ...rel.split('/'))
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(join(srcDir, ...rel.split('/')), dst)
    }
  }

  /** 扫描技能目录内 SKILL.md 之外的文本附属文件，返回首个命中「相对路径: 威胁消息」；无命中返回 null。
   * 为什么存在——威胁不只可能藏在主文件：scripts/*.py、_meta.json 等附属文本
   * 同样可以携带注入/外泄载荷（如果装的技能悄悄读 .env 上传），整目录复制前
   * 必须对目录内所有文本文件过一遍与 SKILL.md 同款 strict 扫描，才能拒绝含威胁的技能。
   * 什么作用——install()/uploadSkill() 在整目录复制前调用；命中即中止安装/上传，
   * 不会把可疑附属文件带进运行目录；二进制文件（含 NUL 字节）不参与文本威胁扫描。
   * 留存理由——扫描边界与复制边界共用 listSkillFiles，杜绝"复制了就没扫"的绕行口。 */
  private scanSkillTreeForThreats(skillDir: string): string | null {
    for (const rel of this.listSkillFiles(skillDir)) {
      if (rel === 'SKILL.md') continue
      const buf = readFileSync(join(skillDir, ...rel.split('/')))
      if (buf.includes(0)) continue // 二进制文件不参与文本威胁扫描
      const text = buf.toString('utf-8')
      const threat = first_threat_message(text, 'strict')
      if (threat) return `${rel}: ${threat}`
    }
    return null
  }

  /** 收集技能目录内 SKILL.md 之外的文本附属文件（相对路径 → UTF-8 全文），供 LAN 广播/回推用。
   * 为什么存在——LAN 信封是 JSON 结构化载荷，二进制数据无法可靠内嵌；而在
   * 局域网同步场景里 scripts/、_meta.json 这些文本附属文件必须随 SKILL.md 一起
   * 送达对端，否则对方收到的技能同样"缺腿"。
   * 什么作用——uploadSkill 广播与 respondSyncWant 回推共用：把目录内文本附属
   * 文件打包进 files 字段，收端 applyUpload 逐一校验落盘；二进制文件（含 NUL）
   * 在 LAN 通道内不传输（本地 install/upload 仍由 copySkillTree 完整保留）。
   * 留存理由——与 listSkillFiles 共用文件面，保证"本地复制全量、LAN 文本子集"
   * 两套边界都从同一清单派生，不会各写各的。 */
  private collectLanFiles(skillDir: string): Record<string, string> {
    const files: Record<string, string> = {}
    for (const rel of this.listSkillFiles(skillDir)) {
      if (rel === 'SKILL.md') continue
      const buf = readFileSync(join(skillDir, ...rel.split('/')))
      if (buf.includes(0)) continue // 二进制不随 LAN 文本信封传输
      files[rel] = buf.toString('utf-8')
    }
    return files
  }

  /** 相对路径安全校验：拒绝绝对路径、盘符、空段与 .. 上跳（收端 files 落盘前用）。
   * 为什么存在——LAN 对端传来的 files 键是外部输入，若直接 join(destDir, key)，
   * `../x` 或 `C:\x` 可能把文件写到 uploads 目录之外，形成任意写漏洞；
   * 什么作用——applyUpload 对每个文件键先过本校验再落盘，非法键整体丢弃该载荷；
   * 留存理由——路径规则与 listSkillFiles 产出的相对路径（正斜杠、无 ..、无盘符）
   * 形成闭环：本端生成的本端合法，对端伪造的越界路径在入口被拦。 */
  private isSafeRelPath(rel: string): boolean {
    if (!rel || rel.length === 0) return false
    if (rel.startsWith('/') || rel.startsWith('\\')) return false
    if (/^[a-zA-Z]:/.test(rel)) return false
    const parts = rel.split(/[\\/]/)
    if (parts.some((p) => p === '' || p === '.' || p === '..')) return false
    return true
  }

  /**
   * 从市场下架一个 skill（列表内「删除」入口的服务端实现）。
   * 支持两类条目：
   * - 上传条目（manifest.uploads 有记录）：同时清理本机 uploads 磁盘副本；
   * - 非上传条目（内置市场源等）：只写墓碑不删仓库文件（仓库随包分发，下架 = 全网不再展示）。
   * 权限：canDeleteEntry 不通过直接拒绝（分系统删他人 / 删内置条目 / 未登录均视为无权限）。
   * 为什么用墓碑而不是直接删 uploads 条目——墓碑广播给全网后，各终端列表统一
   * 过滤；若只删本机条目，对端残留旧列表，还可能被 syncWant 回推重新拉复活。
   */
  async unpublish(name: string): Promise<{ ok: boolean; error?: string }> {
    const rec = this.manifest.uploads[name]
    // 权限兜底：主系统/单机删任意；分系统仅删自己上传的（非上传条目一律拒绝）
    if (!this.canDeleteEntry(rec)) {
      return { ok: false, error: '无权限删除：分系统只能删除自己上传的 skill' }
    }
    // 条目必须真实存在于市场（上传记录或任一市场源扫描结果），防止对不存在的
    // 名字空写墓碑；findEntry 已过滤 removed，重删不存在的名字同样返回未找到。
    if (!rec) {
      const entry = await this.findEntry(name)
      if (!entry) return { ok: false, error: `市场中没有 skill "${name}"` }
    }
    const removedBy = getCurrentUid() ?? 0
    const now = Date.now()
    this.manifest.removed[name] = { removedAt: now, removedBy }
    // 磁盘副本按记录领域定位（含旧版平铺记录：domain 缺失时回退平铺路径）；
    // 仅上传条目有本机 uploads 副本，内置源条目不删仓库文件。
    if (rec) {
      const dir = this.uploadsSkillDir(name, rec.domain)
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
    this.persist()
    this.broadcastToPeers('skill-market.remove', {
      name,
      authorUid: rec?.uploaderUid ?? 0,
      removedAt: now,
      removedBy
    } satisfies SkillMarketRemovePayload)
    return { ok: true }
  }

  // ===== 局域网同步 =====

  /**
   * 向所有在线对端单播业务信封（主分系统共享市场用；排除自身）。
   * 离线对端由 syncWant/replay 增量补齐，广播只是「在线即同步」的即时通道。
   */
  private broadcastToPeers(type: string, payload: unknown): void {
    if (!this.lan) return
    const selfUid = getCurrentUid()
    for (const p of this.lan.listPeers?.() ?? []) {
      if (!p.online) continue
      if (selfUid !== null && p.uid === selfUid) continue
      this.lan.sendLan?.(p.uid, type, payload)
    }
  }

  /** LAN 业务信封入口（index.ts 经 registerLanCallbacks.onMessage 接线；按 type 分发） */
  handleLanEnvelope(env: LanEnvelope): void {
    try {
      switch (env.type) {
        case 'skill-market.upload':
          this.applyUpload(env.payload as SkillMarketUploadPayload)
          break
        case 'skill-market.remove':
          this.applyTombstone(env.payload as SkillMarketRemovePayload)
          break
        case 'skill-market.tombstone':
          this.applyTombstone(env.payload as SkillMarketTombstonePayload)
          break
        case 'skill-market.syncWant':
          this.respondSyncWant(env.from, env.payload as SkillMarketSyncWantPayload)
          break
        case 'skill-market.replay':
          this.applyReplay(env.payload as SkillMarketReplayPayload)
          break
        default:
          // 非本模块信封（好友/聊天室/发布板等）按模块边界静默忽略
          break
      }
    } catch (err) {
      // 单个信封失败不影响后续：丢弃并告警，LAN 链路继续可用
      this.onProgress?.({ phase: 'sync', status: 'error', message: `局域网上传/下架信封处理失败: ${(err as Error).message}` })
    }
  }

  /** 对端上线：请求增量同步（携带本机已有版本，对方回推缺失/更新的上传与墓碑）。 */
  handlePeerStatus(ev: import('../multi-instance/lan/lan-types').LanPeerStatusEvent): void {
    if (!ev.online) return
    const want: SkillMarketSyncWantPayload = {
      have: Object.entries(this.manifest.uploads)
        .filter(([name]) => !this.manifest.removed[name])
        .map(([name, rec]) => ({ name, uploadedAt: rec.uploadedAt })),
      removed: Object.entries(this.manifest.removed).map(([name, rec]) => ({ name, removedAt: rec.removedAt }))
    }
    this.lan?.sendLan?.(ev.peer.uid, 'skill-market.syncWant', want)
  }

  /**
   * 收端落位上传广播/回推：校验 → 写 uploads 目录 → 登记上表 → 按时间戳复活。
   * 幂等：同一上传者同一 uploadedAt 的记录已存在则跳过（重放/重复广播无害）；
   * 乱序防护：若本机墓碑时间晚于上传时间（先删后收到旧广播），保留墓碑。
   */
  private applyUpload(payload: SkillMarketUploadPayload): void {
    const existing = this.manifest.uploads[payload.name]
    if (existing && existing.uploaderUid === payload.authorUid && existing.uploadedAt === payload.uploadedAt) return
    const threat = first_threat_message(payload.body, 'strict')
    if (threat) {
      this.onProgress?.({ phase: 'sync', status: 'error', message: `局域网上传 ${payload.name} 安全检查失败，已丢弃` })
      return
    }
    // 收端复校验与主动上传同套（发起端已校验；这里防伪造/损坏载荷）
    let fm: { name: string; description: string; version?: string; domain?: string }
    try {
      const parsed = parseFrontmatter(payload.body)
      validateFrontmatter(parsed, `<lan-upload:${payload.name}>`)
      fm = parsed
    } catch (err) {
      this.onProgress?.({ phase: 'sync', status: 'error', message: `局域网上传 ${payload.name} frontmatter 校验失败，已丢弃: ${(err as Error).message}` })
      return
    }
    // 收端领域取发起端广播的领域（发起端已按目录路径判定并复验），与 uploadSkill 落位同构；
    // 幂等场景（重放）里两条相同 payload 落位路径一致，不会产生双份副本
    const destDir = this.uploadsSkillDir(fm.name, payload.domain)
    // 附属文件入盘前的收端防线：先整体校验（路径越界 + 威胁内容），任一文件
    // 不合格即丢弃整个载荷——SKILL.md 已在上面扫过，files 是 LAN 外部输入，
    // 不能信任发起端已校验（防伪造/被篡改信封），更不能把越界路径写进磁盘。
    const files = payload.files ?? {}
    for (const [rel, content] of Object.entries(files)) {
      if (!this.isSafeRelPath(rel)) {
        this.onProgress?.({
          phase: 'sync',
          status: 'error',
          message: `局域网上传 ${payload.name} 附属文件路径非法，已丢弃: ${rel}`
        })
        return
      }
      const threat = first_threat_message(content, 'strict')
      if (threat) {
        this.onProgress?.({
          phase: 'sync',
          status: 'error',
          message: `局域网上传 ${payload.name} 附属文件安全检查失败，已丢弃: ${rel} ${threat}`
        })
        return
      }
    }
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'SKILL.md'), payload.body, 'utf-8')
    // 逐文件落盘（保持相对目录结构；安全校验已在上方整体通过，这里只负责写入）
    for (const [rel, content] of Object.entries(files)) {
      const dst = join(destDir, ...rel.split(/[\\/]/))
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, content, 'utf-8')
    }
    this.ensureUploadsSource()
    this.manifest.uploads[fm.name] = {
      uploaderUid: payload.authorUid,
      uploadedAt: payload.uploadedAt,
      sha: this.shaOfFile(join(destDir, 'SKILL.md')),
      version: fm.version,
      domain: payload.domain
    }
    const tombAt = this.manifest.removed[fm.name]?.removedAt ?? 0
    if (payload.uploadedAt > tombAt) delete this.manifest.removed[fm.name]
    this.persist()
  }

  /** 收端落位下架广播/墓碑回推：写墓碑（时间戳比本地新才生效）+ 清理本机上传目录副本。 */
  private applyTombstone(p: SkillMarketRemovePayload | SkillMarketTombstonePayload): void {
    const cur = this.manifest.removed[p.name]
    if (cur && cur.removedAt >= p.removedAt) return
    this.manifest.removed[p.name] = { removedAt: p.removedAt, removedBy: p.removedBy }
    // 磁盘副本按本机记录领域定位（旧平铺记录 domain 缺失时回退平铺路径；
    // 收端记录的领域来自发起端广播，与磁盘落位一致，可精确清理）
    const rec = this.manifest.uploads[p.name]
    const dir = this.uploadsSkillDir(p.name, rec?.domain)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    // uploads 表保留原记录（追溯上传者用），列表已按墓碑过滤
    this.persist()
  }

  /** 收到 syncWant：对比对方已有版本，回推缺失/更新的上传（含全文）与墓碑。 */
  private respondSyncWant(fromUid: number, want: SkillMarketSyncWantPayload): void {
    const haveByName = new Map(want.have.map((h) => [h.name, h.uploadedAt]))
    const uploads: SkillMarketUploadPayload[] = []
    for (const [name, rec] of Object.entries(this.manifest.uploads)) {
      if (this.manifest.removed[name]) continue
      if ((haveByName.get(name) ?? 0) >= rec.uploadedAt) continue
      const body = this.readUploadBody(name)
      if (!body) continue // 磁盘副本缺失（异常态）不下发，等对方发起者侧重传
      let description = ''
      try {
        description = String(parseFrontmatter(body).description ?? '')
      } catch {
        /* frontmatter 缺失不阻断同步：applyUpload 收端会再次校验并丢弃非法载荷 */
      }
      uploads.push({
        name,
        description,
        body,
        // 回推与广播同构：附属文件一并下发，收端 applyUpload 才能还原完整技能
        files: this.readUploadLanFiles(name),
        authorUid: rec.uploaderUid,
        uploadedAt: rec.uploadedAt,
        version: rec.version,
        domain: rec.domain,
        sha: rec.sha
      })
    }
    const removedByName = new Map(want.removed.map((r) => [r.name, r.removedAt]))
    const tombstones: SkillMarketTombstonePayload[] = []
    for (const [name, rec] of Object.entries(this.manifest.removed)) {
      if ((removedByName.get(name) ?? 0) < rec.removedAt) {
        tombstones.push({ name, removedAt: rec.removedAt, removedBy: rec.removedBy })
      }
    }
    if (uploads.length === 0 && tombstones.length === 0) return
    this.lan?.sendLan?.(fromUid, 'skill-market.replay', { uploads, tombstones } satisfies SkillMarketReplayPayload)
  }

  /** 收到 replay 回推：逐条按 upload/tombstone 语义落位（幂等）。 */
  private applyReplay(payload: SkillMarketReplayPayload): void {
    for (const u of payload.uploads) this.applyUpload(u)
    for (const t of payload.tombstones) this.applyTombstone(t)
  }

  /** 读本地上传目录中的 SKILL.md 全文（replay 回推给对方用）；缺失返回空串。
   * 按记录领域定位磁盘（与 uploadsSkillDir 一致，兼容旧平铺记录）。 */
  private readUploadBody(name: string): string {
    const rec = this.manifest.uploads[name]
    const p = join(this.uploadsSkillDir(name, rec?.domain), 'SKILL.md')
    return existsSync(p) ? readFileSync(p, 'utf-8') : ''
  }

  /** 读本地上传目录中的文本附属文件（replay 回推给对方用，随 SKILL.md 一并下发）。
   * 按记录领域定位磁盘；SKILL.md 由 readUploadBody 单独读取，这里只收集其余文本。 */
  private readUploadLanFiles(name: string): Record<string, string> {
    const rec = this.manifest.uploads[name]
    return this.collectLanFiles(this.uploadsSkillDir(name, rec?.domain))
  }

  // ===== 内部实现 =====

  private loadManifest(): MarketManifest {
    try {
      if (existsSync(this.manifestPath)) {
        const raw = JSON.parse(readFileSync(this.manifestPath, 'utf-8')) as Partial<MarketManifest>
        // installed 按作用域分表 { scopeKey: { name: InstalledSkill } }。
        // 旧版全局扁平记录（{ name: InstalledSkill }）不再迁移/兜底——读不到即空表，
        // 「已安装」以磁盘存在性为真源（isInstalledOnDisk），下次安装会覆盖记录。
        return {
          sources: Array.isArray(raw.sources) ? (raw.sources as MarketSource[]) : [],
          installed:
            raw.installed && typeof raw.installed === 'object'
              ? (raw.installed as MarketManifest['installed'])
              : {},
          // uploads/removed 为本版本新增：旧 manifest 缺失时按空表处理，不迁移不兜底
          uploads:
            raw.uploads && typeof raw.uploads === 'object'
              ? (raw.uploads as MarketManifest['uploads'])
              : {},
          removed:
            raw.removed && typeof raw.removed === 'object'
              ? (raw.removed as MarketManifest['removed'])
              : {}
        }
      }
    } catch {
      /* 损坏则重建 */
    }
    return { sources: [], installed: {}, uploads: {}, removed: {} }
  }

  private persist(): void {
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8')
  }

  /** 首次启动自动注册内置市场源（幂等，详见构造函数注释） */
  private ensureBuiltinSource(): void {
    // 注册条件：manifest 尚无任何源（含首次创建与用户清空两种情况）；
    // 为什么仅看源数量：内置仓库只应出现一次，不应在用户删除后强制加回，
    // 因此用「无源即注册」而非「manifest 不存在才注册」——宿主自带能力，
    // 用户清空市场后重启自动补回内置仓库，符合分发预期；
    // 留存理由：不重复执行（已有源直接返回），注册无效目录会污染用户体验，
    // 仓库目录真实存在才注册，否则静默跳过。
    if (this.manifest.sources.length > 0) {
      // 兼容旧版 manifest（可移植化迁移）：
      // 为什么存在——旧版本把内置仓库的本机绝对路径直接写进了 manifest
      // （如 "<workspace>/app/electron/main/skills/market-repo"），这是分发给
      // 他人后市场指向开发机、路径彻底失效的根因；
      // 什么作用——发现 dir 型源且 url 恰好是「内置仓库目录形态」（以
      // skills/market-repo 结尾）时，迁移为可移植标识 BUILTIN_SOURCE_URL；
      // 用户手动添加的自定义本地目录源（url 不是内置仓库形态）不动；
      // 留存理由——迁移必须在这里完成：构造函数末尾调用，早于任何消费方
      // （listSources/listMarketSkills）读取，保证旧数据一启动即归一化，
      // 不把旧绝对路径继续透出 UI。
      let migrated = false
      for (const s of this.manifest.sources) {
        const repoUrl = this.builtinRepoDir
        const isOldBuiltin =
          s.type === 'dir' &&
          s.url !== BUILTIN_SOURCE_URL &&
          repoUrl !== '' &&
          (s.url === repoUrl ||
            (!s.url.startsWith('http') &&
              (s.url.includes(`${sep}skills${sep}market-repo`) ||
                s.url.endsWith(`${sep}skills${sep}market-repo`) ||
                s.url.endsWith('skills/market-repo') ||
                s.url.endsWith('skills\\market-repo'))))
        if (isOldBuiltin) {
          s.url = BUILTIN_SOURCE_URL
          migrated = true
        }
      }
      if (migrated) this.persist()
      return
    }
    const repoDir = this.builtinRepoDir
    if (!repoDir || !existsSync(repoDir)) return
    // 用可移植标识（而非本机绝对路径）注册内置源：
    // 为什么存在——manifest 是持久化数据，直接写 repoDir 会把分发包内部目录
    // （随包分发的 resources/skills/market-repo 或开发机源码目录）以绝对路径
    // 固化下来；分发给他人后该路径在对方机器上不存在，市场即失效，且前置
    // 版本的 manifest 已因这一做法把开发机目录暴露给了所有使用者；
    // 什么作用——持久化只记固定标识 builtin://market-repo，真实目录由
    // resolveDirSourceUrl 在消费时按本机环境解析（打包=resources 目录，
    // dev=源码目录），任何机器上同一份 manifest 都能解析到属于自己的仓库；
    // 留存理由——标识与真实路径解耦是「市场随包可分发、路径干净」的根基，
    // 若改回直接写物理路径，等同于退回被本次修复废弃的做法。
    const added = this.addSource('内置市场', BUILTIN_SOURCE_URL)
    if (!added.ok) {
      // 注册失败不阻塞启动：市场仍可用，只是内置源需要用户手动添加
      console.warn(`[skill-market] 内置市场源注册失败: ${added.error}`)
    }
  }

  /**
   * dir 型市场源的 url → 真实目录解析。
   * 为什么存在——内置源持久化的是 builtin://market-repo 标识，无法直接当路径用；
   * 此方法统一把标识解析为当前环境的内置仓库目录；
   * 什么作用——listMarketSkills / resolveSkillDir 等 dir 消费点都经它取真实路径，
   * 用户自定义本地目录源原样返回；
   * 留存理由——解析集中在一处，避免多个消费点各自硬编码 builtin 语义；
   * 缺仓库时返回空串，调用方按「该源暂不可用」处理（不抛错不崩溃）。
   */
  private resolveDirSourceUrl(url: string): string {
    // 内置源：builtin://market-repo → 随包仓库目录（打包=resources，dev=源码）
    if (url === BUILTIN_SOURCE_URL) return this.builtinRepoDir
    // 本地上传源：local://uploads → 本机市场数据目录下的 uploads/（每终端各有一份，
    // 经局域网广播汇聚成全网一致的上传市场）
    if (url === UPLOAD_SOURCE_URL) return this.uploadsDir()
    return url
  }

  /**
   * 扫描仓库内的技能：{dir}/SKILL.md（根）与 {dir}/skills/ 下任意层级目录树。
   * 文件夹即领域真源（与 SkillLoader 同构）：技能目录相对 skills/ 的父路径即领域
   * （skills/code/fmt → code；skills/design/web/palette → design/web），
   * 平铺形态 skills/{name}/ 与根 SKILL.md 领域为空（用户级）。frontmatter 声明不参与判定。
   */
  private scanRepoForSkills(dir: string): MarketSkillEntry[] {
    const result: MarketSkillEntry[] = []
    // 根 SKILL.md（用户级平铺形态）
    const rootSkill = join(dir, 'SKILL.md')
    if (existsSync(rootSkill)) {
      try {
        const meta = parseSkillFile(rootSkill, 'user')
        result.push({ name: meta.name, description: meta.description, repo: dir, sha: this.shaOfFile(rootSkill), domain: undefined })
      } catch { /* 忽略 */ }
    }
    // skills/ 目录树：递归扫描，目录层级即领域
    const skillsDir = join(dir, 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of this.scanSkillTree(skillsDir, 'skills', dir)) {
        result.push(entry)
      }
    }
    return result
  }

  /**
   * 递归扫描技能目录树（与 loader.scanDir 同语义）：
   * 目录含 SKILL.md = 技能，领域 = 技能目录相对 skills/ 根的父路径（正斜杠拼接，
   * 与 loader 的 domainPath 一致）；目录不含 SKILL.md 则视为领域分类文件夹继续下钻。
   * subdir 统一用正斜杠拼接、且相对仓库根（含 skills/ 前缀，如 skills/design/web/palette），
   * 与 resolveSkillDir 的 join 语义、UI 展示拼接一致，跨平台稳定。
   */
  private scanSkillTree(
    dir: string,
    subdir: string,
    repoRoot: string
  ): Array<{ name: string; description: string; repo: string; subdir: string; sha: string; domain: string | undefined }> {
    const result: Array<{ name: string; description: string; repo: string; subdir: string; sha: string; domain: string | undefined }> = []
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return result
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const childDir = join(dir, entry.name)
      const childSubdir = `${subdir}/${entry.name}`
      const skillMd = join(childDir, 'SKILL.md')
      if (existsSync(skillMd)) {
        try {
          const meta = parseSkillFile(skillMd, 'user')
          result.push({
            name: meta.name,
            description: meta.description,
            repo: repoRoot,
            subdir: childSubdir,
            sha: this.shaOfFile(skillMd),
            // 领域 = 子目录相对路径去掉 skills/ 前缀与技能名末段（正斜杠，跨平台稳定）
            domain: this.domainOfSubdir(childSubdir)
          })
        } catch { /* 忽略 */ }
      } else {
        // 领域分类文件夹：继续下钻，领域路径累加
        result.push(...this.scanSkillTree(childDir, childSubdir, repoRoot))
      }
    }
    return result
  }

  /** subdir（如 skills/code/fmt、skills/design/web/palette）→ 领域路径（code / design/web）；平铺（skills/fmt）→ undefined */
  private domainOfSubdir(subdir: string): string | undefined {
    // 兼容正斜杠（当前统一格式）与历史平台分隔符数据
    const parts = subdir.split(/[\\/]/).filter(Boolean) // 去空段：['skills', ...]
    // 去掉 skills/ 前缀后的剩余路径
    const rest = parts[0] === 'skills' ? parts.slice(1) : parts
    // 只剩技能名一段 = 平铺（用户级）；否则去掉末段技能名，中间即领域路径链
    if (rest.length <= 1) return undefined
    return rest.slice(0, -1).join('/')
  }

/** 网络拉取 JSON 清单 */
  private async fetchJsonList(url: string): Promise<MarketSkillEntry[]> {
    if (!isSafeUrl(url)) throw new Error(`URL 不合法或非公网地址: ${url}`)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`清单拉取失败 ${resp.status}`)
    return (await resp.json()) as MarketSkillEntry[]
  }

  /** 找到某 skill 的市场条目（含 sourceId） */
  private async findEntry(name: string): Promise<(MarketSkillEntry & { sourceId: string }) | null> {
    const all = await this.listMarketSkills()
    return all.find((e) => e.name === name) ?? null
  }

  /** 解析 skill 实际目录（本地目录源的 subdir） */
  private async resolveSkillDir(source: MarketSource, entry: MarketSkillEntry): Promise<string> {
    if (source.type === 'dir') {
      // 与 listMarketSkills 同一解析入口：builtin://market-repo → 本机仓库目录；
      // 否则安装时 entry.repo 已是可移植标识但 skillDir 仍可能是本机路径 —
      // 必须走 resolveDirSourceUrl 保证安装读的是本机真实目录，而不是把标识当路径 join 出错
      const dir = this.resolveDirSourceUrl(source.url)
      return entry.subdir ? join(dir, entry.subdir) : dir
    }
    throw new Error('json 清单源不支持直接安装（请用本地目录源）')
  }

private shaOfFile(p: string): string {
    return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12)
  }
}

export { isSafeUrl, isPrivateHost } from './url-safety'
export { TOOL_NAME_MAP, adaptToolNames } from './tool-name-adapt'

/** 获取市场根目录（用户数据下） */
export function getMarketRoot(dataRoot: string): string {
  return join(dataRoot, 'skill-market')
}