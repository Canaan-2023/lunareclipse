/**
 * @category 技能市场
 * @summary 安装器：安装/更新/卸载/批量同步/标记用户修改 + 目录落位与整树复制
 *
 * 为什么独立成文件：安装面是「技能从市场到本机」的一类行为（含两档落位：用户级 / 领域级），
 * 与市场源、上传、局域网同步无共享逻辑。
 * ADR-05 拆分自 market.ts（纯搬移不改行为）：函数收 `host` 句柄（状态与跨模块能力经它读写）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { parseSkillFile } from '../loader'
import { lintSkill, summarizeLint } from '../linter'
import { adaptToolNames } from '../tool-name-adapt'
import { first_threat_message } from '../../tools/security-engine/threat-patterns'
import { type InstalledSkill } from './market-types'
import type { MarketHost } from './market-host'

  /** 当前用户级 skills 目录（按当前 uid/aiId 动态解析；未登录抛错——调用方在登录态使用） */
export function getUserSkillsDir(host: MarketHost, ): string {
    return host.userSkillsDirProvider()
  }

  /** 当前领域级 skills 目录（{root}/skills_domains/U{uid}/AI{aiId}/，按当前 uid/aiId 动态解析；
   * 与 loader.getDomainSkillsDir() 同源；未登录抛错——与用户级同守卫） */
export function getDomainSkillsDir(host: MarketHost, ): string {
    return host.domainSkillsDirProvider()
  }

  /**
   * 按 skill 的 domain 解析其安装目录：
   * 领域级（有 domain）→ {domainSkillsDir}/{domain}/{name}；
   * 用户级（无 domain，方法论/通用技能）→ {userSkillsDir}/{name}。
   * 为什么存在——市场两档并存：领域技能按大类落 skills_domains，所有人/所有 AI
   * install 判定、卸载、更新共用同一解析，避免领域技能被误当用户级读目录
   * （读不到即误报「未安装」/跨级删除）。
   */
export function resolveInstalledDir(host: MarketHost, name: string, domain?: string): string {
    const d = domain?.trim()
    return d ? join(host.getDomainSkillsDir(), d, name) : join(host.getUserSkillsDir(), name)
  }

  /** 当前作用域安装记录（仅元数据，安装真源见 isInstalledOnDisk；不跨作用域、无历史兜底） */
export function getInstalled(host: MarketHost, name: string): InstalledSkill | null {
    return host.store.readScopeInstalled()[name] ?? null
  }

  /** 安装真源：当前作用域磁盘目录是否存在（与 SkillLoader 扫描同源，跨 uid/aiId 不看 manifest）。
   * domain 为空查用户级，否则查领域级 {domain}/{name}——与 install 落位同规则。
   * 未登录时 provider 抛错（与 getScopedPath 同守卫），不吞——静默 false 会掩盖「未登录调市场」的程序错误。 */
export function isInstalledOnDisk(host: MarketHost, name: string, domain?: string): boolean {
    return existsSync(host.resolveInstalledDir(name, domain))
  }

export async function install(host: MarketHost, name: string): Promise<{ ok: boolean; error?: string; lint?: ReturnType<typeof summarizeLint>; config?: Array<{ key: string; description: string; default?: string }> }> {
    host.emitProgress({ phase: 'install', skillName: name, status: 'start' })
    // 找到来源
    const entry = await host.findEntry(name)
    if (!entry) return { ok: false, error: `市场中没有 skill "${name}"` }
    const source = host.store.manifest.sources.find((s) => s.id === entry.sourceId)
    if (!source) return { ok: false, error: '来源不存在' }

    // 获取 skill 目录（本地目录源）
    let skillDir: string
    try {
      skillDir = await host.resolveSkillDir(source, entry)
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
      const fileThreat = host.scanSkillTreeForThreats(skillDir)
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
        ? join(host.getDomainSkillsDir(), domain, meta.name)
        : join(host.getUserSkillsDir(), meta.name)
      // 旧落位收敛：目录领域变化时删除旧目录，避免同一技能在旧领域
      // 残留幽灵副本（卸载/同步按新记录定位，旧副本将永久不可达）。
      const prev = host.store.readScopeInstalled()[meta.name]
      if (prev && prev.domain !== domain) {
        const prevDir = host.resolveInstalledDir(meta.name, prev.domain)
        if (existsSync(prevDir)) rmSync(prevDir, { recursive: true, force: true })
      }
      // 整目录复制（不只是 SKILL.md）：技能不是单文件，scripts/、_meta.json、
      // assets/ 等附属文件随库分发，只写 SKILL.md 会让安装后的技能"缺腿"——
      // 如 ai-perspective-prompting 的执行脚本、code-review 的场景规则就无法用。
      // 先复制整目录，再用适配后的 SKILL.md 覆盖主文件（工具名适配只作用于正文）。
      mkdirSync(destDir, { recursive: true })
      host.copySkillTree(skillDir, destDir)
      writeFileSync(join(destDir, 'SKILL.md'), adapted, 'utf-8')

      // 来源锁定（写入当前作用域表，见 writeScopeInstalled；domain 一并记录，
      // 卸载/更新与磁盘存在性判定按它定位，不跨级误删）
      host.store.writeScopeInstalled()[meta.name] = {
        source: source.id,
        version: meta.version ?? entry.version,
        sha: entry.sha,
        installedAt: Date.now(),
        userModified: false,
        synced: true,
        domain
      }
      host.store.persist()
      // 热重载
      host.loader.load()
      host.emitProgress({ phase: 'install', skillName: name, status: 'done' })
      return { ok: true, lint: lintSummary, config: meta.config?.map((c) => ({ key: c.key, description: c.description, default: c.default })) }
    } catch (err) {
      host.emitProgress({ phase: 'install', skillName: name, status: 'error', message: (err as Error).message })
      return { ok: false, error: `安装失败: ${(err as Error).message}` }
    }
  }

export async function update(host: MarketHost, name: string): Promise<{ ok: boolean; error?: string }> {
    // 更新判定走当前作用域记录（磁盘存在 + 记录命中），不误判他人/AI 的安装
    const inst = host.getInstalled(name)
    if (!inst || !host.isInstalledOnDisk(name, inst.domain)) return { ok: false, error: `skill "${name}" 未安装` }
    if (inst.userModified) return { ok: false, error: `skill "${name}" 已被本地修改，更新跳过（如需更新请先重置 userModified）` }
    // 重新安装（install 按市场条目目录领域决定新落位并收敛旧目录；
    // 记录 domain 只是快照，用于定位旧目录，不参与落位判定）
    const result = await host.install(name)
    if (result.ok) {
      // 保留 userModified 状态（写入当前作用域表）
      host.store.writeScopeInstalled()[name].userModified = false
      host.store.persist()
    }
    return { ok: result.ok, error: result.error }
  }

export function remove(host: MarketHost, name: string): { ok: boolean; error?: string } {
    const inst = host.getInstalled(name)
    if (!inst || !host.isInstalledOnDisk(name, inst.domain)) {
      return { ok: false, error: `skill "${name}" 未安装（或不是市场来源）` }
    }
    // 按记录 domain 定位：领域级删 {domain}/{name}，用户级删用户目录——不跨级误删
    const destDir = host.resolveInstalledDir(name, inst.domain)
    if (existsSync(destDir)) {
      rmSync(destDir, { recursive: true, force: true })
    }
    // 只删当前作用域记录，不误删其它 uid/AI 的 manifest 记录；
    // 直接操作 manifest 现有表（不创建新表），表变空则移除作用域键，避免残留空记录
    const scopeKey = host.store.currentScopeKey()
    const table = host.store.manifest.installed[scopeKey]
    if (table) {
      delete table[name]
      if (Object.keys(table).length === 0) delete host.store.manifest.installed[scopeKey]
    }
    host.store.persist()
    host.loader.load()
    return { ok: true }
  }

  // ===== 批量同步 =====

  /** 同步所有 synced=true 且非 userModified 的已安装 skill（检查更新自动拉取） */
export async function syncAll(host: MarketHost, ): Promise<{ ok: boolean; updated: string[]; errors: string[] }> {
    const updated: string[] = []
    const errors: string[] = []
    // 只同步当前作用域安装记录——修复跨 uid/aiId 全局同步（会去更新别人/AI 目录下的同名 skill）
    for (const [name, inst] of Object.entries(host.store.readScopeInstalled())) {
      if (!inst.synced || inst.userModified) continue
      // 磁盘缺失的记录（目录被用户手动删/清理过）跳过，避免误判为可更新；
      // 领域级技能按记录 domain 定位磁盘，与 install 落位一致
      if (!host.isInstalledOnDisk(name, inst.domain)) continue
      try {
        const entry = await host.findEntry(name)
        if (!entry) continue
        const hasUpdate = (entry.sha && inst.sha !== entry.sha) || (entry.version && inst.version !== entry.version)
        if (hasUpdate) {
          host.emitProgress({ phase: 'sync', skillName: name, status: 'progress', message: '发现更新' })
          const r = await host.update(name)
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
export function markUserModified(host: MarketHost, name: string): void {
    const table = host.store.writeScopeInstalled()
    const inst = table[name]
    if (inst) {
      inst.userModified = true
      host.store.persist()
    }
  }

  // ===== 上传 / 下架 =====

  /** 列出技能目录内的全部文件（相对路径列表，跨平台统一用正斜杠）。
   * 为什么存在——技能不是单文件：scripts/、_meta.json、assets/ 等附属文件
   * 是技能可运行的一部分，install/upload/LAN 广播都要围绕「目录」而非「SKILL.md」
   * 做整体搬运；只列文件避免逐层拼路径时在 Windows/Linux 上分隔符漂移。
   * 什么作用——copySkillTree / scanSkillTreeForThreats / collectLanFiles 共用
   * 这一份清单，保证三条链路覆盖同一文件面，不会出现"复制了但没扫"的漏洞。
   * 留存理由——跳过符号链接与跟随目录的递归语义集中在此一处，其它链路
   * 无需各自实现遍历，避免目录树规则散落多处后行为不一致。 */
export function listSkillFiles(host: MarketHost, dir: string): string[] {
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
export function copySkillTree(host: MarketHost, srcDir: string, destDir: string): void {
    for (const rel of host.listSkillFiles(srcDir)) {
      const dst = join(destDir, ...rel.split('/'))
      mkdirSync(dirname(dst), { recursive: true })
      copyFileSync(join(srcDir, ...rel.split('/')), dst)
    }
  }