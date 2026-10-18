/**
 * @category 技能市场
 * @summary 市场源与仓库扫描：源 CRUD、内置源自动注册、目录/JSON 源扫描、条目与技能目录解析
 *
 * 为什么独立成文件：源管理与仓库扫描是「市场内容从哪来」的一类行为，原先与安装、上传、局域网同步
 * 同处 1428 行；且 dir 源的可移植标识解析（builtin://）是跨模块共用的落点规则。
 * ADR-05 拆分自 market.ts（纯搬移不改行为）：函数收 `host` 句柄（状态与跨模块能力经它读写）。
 */
import { existsSync, readdirSync } from 'fs'
import { basename, join, sep } from 'path'
import { parseSkillFile } from '../loader'
import { isSafeUrl } from '../url-safety'
import {
  BUILTIN_SOURCE_URL,
  shaOfFile,
  type MarketSkillEntry,
  type MarketSource
} from './market-types'
import type { MarketHost } from './market-host'

export function listSources(host: MarketHost, ): MarketSource[] {
    return [...host.store.manifest.sources]
  }

export function addSource(host: MarketHost, name: string, url: string): { ok: boolean; error?: string } {
    const trimmed = url.trim()
    if (!trimmed) return { ok: false, error: 'URL 不能为空' }
    let type: MarketSource['type'] = 'json'
    if (trimmed.startsWith('http')) type = 'json'
    else type = 'dir' // 本地路径
    // id 必须全局唯一：仅用毫秒时间戳时，同毫秒内连续添加两个源（如启动自动注册内置源
    // 后立刻添加自定义源）会得到相同 id；listMarketSkills/install 按 id 反查来源，
    // 重复会让安装解析到错误的源目录（读不到 SKILL.md）。补随机后缀消除碰撞。
    const source: MarketSource = {
      id: `src_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim() || basename(trimmed),
      url: trimmed,
      type
    }
    host.store.manifest.sources.push(source)
    host.store.persist()
    return { ok: true }
  }

export function removeSource(host: MarketHost, id: string): { ok: boolean; error?: string } {
    const before = host.store.manifest.sources.length
    host.store.manifest.sources = host.store.manifest.sources.filter((s) => s.id !== id)
    if (host.store.manifest.sources.length === before) return { ok: false, error: '源不存在' }
    host.store.persist()
    return { ok: true }
  }

  // ===== 市场列表 =====

  /** 收集所有源的可安装 skill（过滤已下架墓碑；上传条目附 canDelete 供前端显示删除入口） */
export async function listMarketSkills(host: MarketHost, ): Promise<
    Array<MarketSkillEntry & { sourceId: string; installed: boolean; hasUpdate: boolean; userModified: boolean; uploaderUid?: number; canDelete?: boolean }>
  > {
    const entries: Array<MarketSkillEntry & { sourceId: string; installed: boolean; hasUpdate: boolean; userModified: boolean; uploaderUid?: number; canDelete?: boolean }> = []
    const removed = host.store.manifest.removed
    for (const source of host.store.manifest.sources) {
      try {
        let skills: MarketSkillEntry[] = []
        if (source.type === 'dir') {
          // dir 源先解析可移植标识：builtin://market-repo → 本机内置仓库目录，
          // 用户自定义本地目录原样使用。返回条目里 repo 字段保持 source.url
          // （标识/用户输入）而不露解析后的绝对路径，见下面对 repo 的脱敏。
          const dir = host.resolveDirSourceUrl(source.url)
          skills = host.scanRepoForSkills(dir)
          // repo 脱敏：scanRepoForSkills 会把实际目录填进 entry.repo（本机绝对
          // 路径，分发给他人即失效且暴露本机结构），这里统一改回源的可移植
          // 标识/用户输入值，UI 展示与后端传输都不携带本机路径。
          for (const s of skills) s.repo = source.url
        } else {
          // json 清单：网络拉取
          const list = await host.fetchJsonList(source.url)
          skills = list
        }
        for (const s of skills) {
          // 删除墓碑过滤：被主系统/上传者下架的条目全网不再显示（含内置源与上传源）
          if (removed[s.name]) continue
          // 安装真源 = 当前作用域磁盘目录存在（与 SkillLoader 扫描同源，且按条目 domain 定位）：
          // 修复跨作用域误显示——A 用户/AI{1} 装的 skill，B 用户/AI{2} 市场不再显示「已安装」。
          const installed = host.isInstalledOnDisk(s.name, s.domain)
          // 元数据（来源/版本/是否用户改过）只取当前作用域记录，legacy 兜底
          const inst = host.getInstalled(s.name)
          const hasUpdate = installed && inst ? Boolean((s.sha && inst.sha !== s.sha) || (s.version && inst.version !== s.version)) : false
          // userModified：本地已被用户改过的 skill，更新按钮必须可见禁用态，
          // 且 UI 需要徽章提示——否则用户点「更新」只会收到 update() 里
          // “已被本地修改，更新跳过”的报错，认为是 bug
          // 上传条目判定：以 manifest.uploads 记录为准（上传已并入内置仓库源，
          // 不再靠独立的 local://uploads 源区分）——有记录才附 uploaderUid 与删除权限
          const rec = host.store.manifest.uploads[s.name]
          entries.push({
            ...s,
            sourceId: source.id,
            installed,
            hasUpdate,
            userModified: installed && inst?.userModified === true,
// 上传条目附上传者标识；删除权限统一判定（主系统/单机可删任意市场条目
          // 含内置源，分系统仅可删自己上传的——见 canDeleteEntry）
          ...(rec ? { uploaderUid: rec.uploaderUid } : {}),
          canDelete: host.canDeleteEntry(rec)
          })
        }
      } catch (err) {
        host.emitProgress({ phase: 'fetch', status: 'error', message: `源 ${source.name} 加载失败: ${(err as Error).message}` })
      }
    }
    return entries
  }

  /** 首次启动自动注册内置市场源（幂等，详见构造函数注释） */
export function ensureBuiltinSource(host: MarketHost, ): void {
    // 注册条件：manifest 尚无任何源（含首次创建与用户清空两种情况）；
    // 为什么仅看源数量：内置仓库只应出现一次，不应在用户删除后强制加回，
    // 因此用「无源即注册」而非「manifest 不存在才注册」——宿主自带能力，
    // 用户清空市场后重启自动补回内置仓库，符合分发预期；
    // 留存理由：不重复执行（已有源直接返回），注册无效目录会污染用户体验，
    // 仓库目录真实存在才注册，否则静默跳过。
    if (host.store.manifest.sources.length > 0) {
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
      for (const s of host.store.manifest.sources) {
        const repoUrl = host.builtinRepoDir
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
      if (migrated) host.store.persist()
      return
    }
    const repoDir = host.builtinRepoDir
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
    const added = host.addSource('内置市场', BUILTIN_SOURCE_URL)
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
export function resolveDirSourceUrl(host: MarketHost, url: string): string {
    // 内置源：builtin://market-repo → 随包仓库目录（打包=resources，dev=源码）；
    // 上传已并入该源（不再有独立的 local://uploads 层）
    if (url === BUILTIN_SOURCE_URL) return host.builtinRepoDir
    return url
  }

  /**
   * 扫描仓库内的技能：根 SKILL.md、{dir}/skills/（用户级）、{dir}/skills_domains/（领域级）。
   * 文件夹即领域真源（与 SkillLoader 同构）：
   * - skills/{name}/ 平铺 = 用户级（domain 空）；skills_domains/{领域路径}/{name} → 领域路径
   *   （skills_domains/code/fmt → code；skills_domains/design/web/palette → design/web）；
   * - 根 SKILL.md 领域为空（用户级）。
   * frontmatter 声明不参与判定。两文件夹分别对应运行期 skills/ 与 skills_domains/ 两个落位根。
   */
export function scanRepoForSkills(host: MarketHost, dir: string): MarketSkillEntry[] {
    const result: MarketSkillEntry[] = []
    // 根 SKILL.md（用户级平铺形态）
    const rootSkill = join(dir, 'SKILL.md')
    if (existsSync(rootSkill)) {
      try {
        const meta = parseSkillFile(rootSkill, 'user')
        result.push({ name: meta.name, description: meta.description, repo: dir, sha: shaOfFile(rootSkill), domain: undefined })
      } catch { /* 忽略 */ }
    }
    // skills/ 目录树：用户级，任何层级 domain 均为空
    const skillsDir = join(dir, 'skills')
    if (existsSync(skillsDir)) {
      for (const entry of host.scanSkillTree(skillsDir, 'skills', dir, false)) {
        result.push(entry)
      }
    }
    // skills_domains/ 目录树：领域级，领域 = 相对 skills_domains 根的父路径
    const domainsDir = join(dir, 'skills_domains')
    if (existsSync(domainsDir)) {
      for (const entry of host.scanSkillTree(domainsDir, 'skills_domains', dir, true)) {
        result.push(entry)
      }
    }
    return result
  }

  /**
   * 递归扫描技能目录树（与 loader.scanDir 同语义）：
   * 目录含 SKILL.md = 技能，领域按 domainRoot 决定（true=领域级：相对根父路径；
   * false=用户级：恒无领域）；目录不含 SKILL.md 则视为领域分类文件夹继续下钻。
   * subdir 统一用正斜杠拼接、且相对仓库根（含 skills/ 或 skills_domains/ 前缀），
   * 与 resolveSkillDir 的 join 语义、UI 展示拼接一致，跨平台稳定。
   */
export function scanSkillTree(host: MarketHost, 
    dir: string,
    subdir: string,
    repoRoot: string,
    domainRoot: boolean
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
            sha: shaOfFile(skillMd),
            // 领域 = 子目录相对路径去掉根前缀与技能名末段（正斜杠，跨平台稳定）
            domain: host.domainOfSubdir(childSubdir, domainRoot)
          })
        } catch { /* 忽略 */ }
      } else {
        // 领域分类文件夹：继续下钻，领域路径累加
        result.push(...host.scanSkillTree(childDir, childSubdir, repoRoot, domainRoot))
      }
    }
    return result
  }

  /** subdir（如 skills_domains/code/fmt、skills_domains/design/web/palette）→ 领域路径（code / design/web）；
   * domainRoot=false（skills/ 用户级根）恒返回 undefined；skills_domains/{name} 单段亦无领域。 */
export function domainOfSubdir(host: MarketHost, subdir: string, domainRoot: boolean): string | undefined {
    if (!domainRoot) return undefined
    // 兼容正斜杠（当前统一格式）与历史平台分隔符数据
    const parts = subdir.split(/[\\/]/).filter(Boolean) // 去空段：['skills_domains', ...]
    // 去掉 skills_domains/ 前缀后的剩余路径
    const rest = parts[0] === 'skills_domains' ? parts.slice(1) : parts
    // 只剩技能名一段 = 无领域；否则去掉末段技能名，中间即领域路径链
    if (rest.length <= 1) return undefined
    return rest.slice(0, -1).join('/')
  }

/** 网络拉取 JSON 清单 */
export async function fetchJsonList(host: MarketHost, url: string): Promise<MarketSkillEntry[]> {
    if (!isSafeUrl(url)) throw new Error(`URL 不合法或非公网地址: ${url}`)
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`清单拉取失败 ${resp.status}`)
    return (await resp.json()) as MarketSkillEntry[]
  }

  /** 找到某 skill 的市场条目（含 sourceId） */
export async function findEntry(host: MarketHost, name: string): Promise<(MarketSkillEntry & { sourceId: string }) | null> {
    const all = await host.listMarketSkills()
    return all.find((e) => e.name === name) ?? null
  }

  /** 解析 skill 实际目录（本地目录源的 subdir） */
export async function resolveSkillDir(host: MarketHost, source: MarketSource, entry: MarketSkillEntry): Promise<string> {
    if (source.type === 'dir') {
      // 与 listMarketSkills 同一解析入口：builtin://market-repo → 本机仓库目录；
      // 否则安装时 entry.repo 已是可移植标识但 skillDir 仍可能是本机路径 —
      // 必须走 resolveDirSourceUrl 保证安装读的是本机真实目录，而不是把标识当路径 join 出错
      const dir = host.resolveDirSourceUrl(source.url)
      return entry.subdir ? join(dir, entry.subdir) : dir
    }
    throw new Error('json 清单源不支持直接安装（请用本地目录源）')
  }