/**
 * @category 技能市场
 * @summary 上传 / 下架 / 局域网同步：发布到内置仓库、墓碑、信封分派与增量补齐
 *
 * 为什么独立成文件：这是「市场内容如何全网共享」的一类行为（上传即分发 + 墓碑过滤 + 上线增量同步），
 * 信封形状对旧版对端冻结，改动风险集中，独立后可与其余四类行为分别阅读与回归。
 * ADR-05 拆分自 market.ts（纯搬移不改行为）：函数收 `host` 句柄（状态与跨模块能力经它读写）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { getCurrentUid } from '../../models/path-context'
import { parseSkillFile } from '../loader'
import { lintSkill, summarizeLint } from '../linter'
import { parseFrontmatter, validateFrontmatter } from '../frontmatter'
import { first_threat_message } from '../../tools/security-engine/threat-patterns'
import type { LanEnvelope } from '../../multi-instance/lan/lan-types'
import {
  isStructuralContainerDir,
  shaOfFile,
  type SkillMarketRemovePayload,
  type SkillMarketReplayPayload,
  type SkillMarketSyncWantPayload,
  type SkillMarketTombstonePayload,
  type SkillMarketUploadPayload,
  type UploadedSkillRecord
} from './market-types'
import type { MarketHost } from './market-host'

  /**
   * 上传条目/安装条目的仓库落点：领域级 → {builtinRepoDir}/skills_domains/{领域}/{name}，
   * 用户级 → {builtinRepoDir}/skills/{name}。
   * 为什么存在——上传（含局域网接收）直接写进内置市场仓库，与安装落位同构
   * （用户级 skills/、领域级 skills_domains/），市场仓库即分发源；
   * 什么作用——uploadSkill/applyUpload/readUploadBody/readUploadLanFiles/unpublish/
   * applyTombstone 统一经此定位磁盘，避免多处各自拼路径导致落点漂移；
   * 留存理由——「文件夹即领域」的落位规则集中在一处，领域多级（design/web）
   * 经 split('/') 展开为真实层级目录。
   */
export function marketRepoSkillDir(host: MarketHost, name: string, domain?: string): string {
    const d = domain?.trim()
    return d
      ? join(host.builtinRepoDir, 'skills_domains', ...d.split('/'), name)
      : join(host.builtinRepoDir, 'skills', name)
  }

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
export function canDeleteEntry(host: MarketHost, rec: UploadedSkillRecord | undefined): boolean {
    const role = host.lan?.getRole?.() ?? null
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
   * → 复制到内置市场仓库 market-repo 的 skills_domains/{领域}/{name}/SKILL.md
   * （领域 = 技能目录相对 skills_domains 根的父路径；无领域平铺 skills/{name}，
   * 与 scanRepoForSkills 目录判定同构）→ manifest.uploads 登记 → 广播 upload 信封。
   * 上传即分发：仓库内容随包分发（属月蚀系统的一部分），不再写独立的 uploads 层。
   * 重名拒绝：市场已存在同名技能（官方条目或其他上传，无论领域/是否被下架）即拒绝，
   * 技能名是市场的全局唯一键——统一落同一仓库后，同名会磁盘覆盖，必须拒绝。
   * 离线对端不丢数据：上线时 syncWant/replay 增量补齐（见局域网同步区块）。
   */
export async function uploadSkill(host: MarketHost, 
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
    // 重名拒绝：技能名是市场全局唯一键。三类碰撞都拒绝：
    // ① manifest.uploads 已有同上传记录；② manifest.removed 已下架（墓碑全网广播，
    //    同名上传会被列表过滤 → 「上传成功但不可见」）；③ 任一市场源（含内置仓库
    //    官方条目）已存在同名——统一落同一仓库后若不拦③，上传会直接覆盖官方技能文件。
    if (host.store.manifest.uploads[meta.name] || host.store.manifest.removed[meta.name]) {
      return { ok: false, error: `市场上已存在同名技能 "${meta.name}"，技能名需全局唯一，请改名后重新上传` }
    }
    if (await host.findEntry(meta.name)) {
      return { ok: false, error: `市场上已存在同名技能 "${meta.name}"，技能名需全局唯一，请改名后重新上传` }
    }
    const lint = lintSkill({ ...meta, body: raw })
    const lintSummary = summarizeLint(lint)
    // 附属文件安全检查：SKILL.md 之上已扫；scripts/、_meta.json 等文本附属文件
    // 同样纳入 strict 扫描——上传 = 发布，源目录内存在威胁内容就不能进入市场流通
    const fileThreat = host.scanSkillTreeForThreats(skillDir)
    if (fileThreat) {
      return { ok: false, error: `安全检查失败：${fileThreat}` }
    }
    const uid = getCurrentUid()
    if (uid === null) return { ok: false, error: '未登录态禁止上传（上传者身份缺失）' }
    // 内置仓库不可用时拒绝上传（builtinRepoDir 为空 = 打包未内置/仓库缺失）：
    // 不静默降级到相对路径写入（会落到进程 cwd，产生「上传成功但市场看不到」的幽灵副本）
    if (!host.builtinRepoDir) return { ok: false, error: '内置市场仓库不可用，无法上传' }
    // 文件夹即领域：领域 = 技能目录相对 skills_domains 根的父路径（支持多级，如 design/web）；
    // 用户自选的外部目录无 skills/skills_domains 祖先时回退父目录名，保持既有上传体验。
    const domain = host.domainOfUploadDir(skillDir)
    const destDir = host.marketRepoSkillDir(meta.name, domain)
    mkdirSync(destDir, { recursive: true })
    // 整目录上传（不只是 SKILL.md）：scripts/、_meta.json 等附属文件是技能的
    // 一部分，只发布 SKILL.md 会让对端安装出无法运行的残缺技能；与 install
    // 的整目录复制对称，发布面 = 安装面。
    host.copySkillTree(skillDir, destDir)
    const now = Date.now()
    host.store.manifest.uploads[meta.name] = {
      uploaderUid: uid,
      uploadedAt: now,
      sha: shaOfFile(join(destDir, 'SKILL.md')),
      version: meta.version,
      domain
    }
    // uploads 以 name 为唯一键，重名已拒绝，不存在同名条目可被覆盖或复活；
    // 被下架的同名技能同样拒绝上传（名称仍被占用），不产生墓碑清除分支
    host.store.persist()
    // 广播给在线对端（发起端已校验过权限与内容；对端只做幂等落位）
    host.broadcastToPeers('skill-market.upload', {
      name: meta.name,
      description: meta.description,
      body: raw,
      files: host.collectLanFiles(skillDir),
      authorUid: uid,
      uploadedAt: now,
      version: meta.version,
      domain,
      sha: host.store.manifest.uploads[meta.name].sha
    } satisfies SkillMarketUploadPayload)
    // 市场内容已变（新条目落仓）：通知渲染侧重拉市场与已装列表
    host.emitChange()
    return { ok: true, name: meta.name, lint: lintSummary }
  }

  /**
   * 上传目录 → 领域推导（文件夹即领域）：
   * - 命中 skills_domains 祖先 → 其间非结构路径（跳过 U{uid}/AI{aiId}）即领域，
   *   多级领域（design/web）完整保留，不再取父目录名而塌缩；
   * - 命中 skills 祖先 → 用户级（无领域）；
   * - 都没有（用户自选的外部目录）→ 回退父目录名，保持「选 design/xxx 即设计领域」体验。
   */
export function domainOfUploadDir(host: MarketHost, skillDir: string): string | undefined {
    const chain: string[] = []
    let fallbackParent = ''
    let cur = dirname(skillDir)
    while (cur && cur !== dirname(cur)) {
      const base = basename(cur)
      if (base === 'skills_domains') return chain.length ? chain.join('/') : undefined
      if (base === 'skills') return undefined
      if (base && !isStructuralContainerDir(base)) {
        if (!fallbackParent) fallbackParent = base
        chain.unshift(base)
      }
      cur = dirname(cur)
    }
    return fallbackParent || undefined
  }

  /** 扫描技能目录内 SKILL.md 之外的文本附属文件，返回首个命中「相对路径: 威胁消息」；无命中返回 null。
   * 为什么存在——威胁不只可能藏在主文件：scripts/*.py、_meta.json 等附属文本
   * 同样可以携带注入/外泄载荷（如果装的技能悄悄读 .env 上传），整目录复制前
   * 必须对目录内所有文本文件过一遍与 SKILL.md 同款 strict 扫描，才能拒绝含威胁的技能。
   * 什么作用——install()/uploadSkill() 在整目录复制前调用；命中即中止安装/上传，
   * 不会把可疑附属文件带进运行目录；二进制文件（含 NUL 字节）不参与文本威胁扫描。
   * 留存理由——扫描边界与复制边界共用 listSkillFiles，杜绝"复制了就没扫"的绕行口。 */
export function scanSkillTreeForThreats(host: MarketHost, skillDir: string): string | null {
    for (const rel of host.listSkillFiles(skillDir)) {
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
export function collectLanFiles(host: MarketHost, skillDir: string): Record<string, string> {
    const files: Record<string, string> = {}
    for (const rel of host.listSkillFiles(skillDir)) {
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
export function isSafeRelPath(host: MarketHost, rel: string): boolean {
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
   * - 上传条目（manifest.uploads 有记录）：同时清理其在市场仓库内的磁盘副本；
   * - 非上传条目（内置市场源官方条目等）：只写墓碑不删仓库文件（仓库随包分发，下架 = 全网不再展示）。
   * 权限：canDeleteEntry 不通过直接拒绝（分系统删他人 / 删内置条目 / 未登录均视为无权限）。
   * 为什么用墓碑而不是直接删 uploads 条目——墓碑广播给全网后，各终端列表统一
   * 过滤；若只删本机条目，对端残留旧列表，还可能被 syncWant 回推重新拉复活。
   */
export async function unpublish(host: MarketHost, name: string): Promise<{ ok: boolean; error?: string }> {
    const rec = host.store.manifest.uploads[name]
    // 权限兜底：主系统/单机删任意；分系统仅删自己上传的（非上传条目一律拒绝）
    if (!host.canDeleteEntry(rec)) {
      return { ok: false, error: '无权限删除：分系统只能删除自己上传的 skill' }
    }
    // 条目必须真实存在于市场（上传记录或任一市场源扫描结果），防止对不存在的
    // 名字空写墓碑；findEntry 已过滤 removed，重删不存在的名字同样返回未找到。
    if (!rec) {
      const entry = await host.findEntry(name)
      if (!entry) return { ok: false, error: `市场中没有 skill "${name}"` }
    }
    const removedBy = getCurrentUid() ?? 0
    const now = Date.now()
    host.store.manifest.removed[name] = { removedAt: now, removedBy }
    // 磁盘副本按记录领域定位：仅「有上传记录」的条目才删仓库副本——官方条目
    // 无记录、仓库文件随包分发必须保留，只写墓碑（全网列表过滤）。rmSync 包
    // try/catch：打包态仓库可能只读，删不掉不阻断下架（墓碑已写、列表已过滤）。
    if (rec) {
      const dir = host.marketRepoSkillDir(name, rec.domain)
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[skill-market] 下架清理仓库副本失败（继续写墓碑）: ${(err as Error).message}`)
      }
    }
    host.store.persist()
    host.broadcastToPeers('skill-market.remove', {
      name,
      authorUid: rec?.uploaderUid ?? 0,
      removedAt: now,
      removedBy
    } satisfies SkillMarketRemovePayload)
    // 市场内容已变（条目下架）：通知渲染侧重拉
    host.emitChange()
    return { ok: true }
  }

  // ===== 局域网同步 =====

  /**
   * 向所有在线对端单播业务信封（主分系统共享市场用；排除自身）。
   * 离线对端由 syncWant/replay 增量补齐，广播只是「在线即同步」的即时通道。
   */
export function broadcastToPeers(host: MarketHost, type: string, payload: unknown): void {
    if (!host.lan) return
    const selfUid = getCurrentUid()
    for (const p of host.lan.listPeers?.() ?? []) {
      if (!p.online) continue
      if (selfUid !== null && p.uid === selfUid) continue
      host.lan.sendLan?.(p.uid, type, payload)
    }
  }

  /** LAN 业务信封入口（index.ts 经 registerLanCallbacks.onMessage 接线；按 type 分发） */
export function handleLanEnvelope(host: MarketHost, env: LanEnvelope): void {
    try {
      switch (env.type) {
        case 'skill-market.upload':
          host.applyUpload(env.payload as SkillMarketUploadPayload)
          break
        case 'skill-market.remove':
          host.applyTombstone(env.payload as SkillMarketRemovePayload)
          break
        case 'skill-market.tombstone':
          host.applyTombstone(env.payload as SkillMarketTombstonePayload)
          break
        case 'skill-market.syncWant':
          host.respondSyncWant(env.from, env.payload as SkillMarketSyncWantPayload)
          break
        case 'skill-market.replay':
          host.applyReplay(env.payload as SkillMarketReplayPayload)
          break
        default:
          // 非本模块信封（好友/聊天室/发布板等）按模块边界静默忽略
          break
      }
    } catch (err) {
      // 单个信封失败不影响后续：丢弃并告警，LAN 链路继续可用
      host.emitProgress({ phase: 'sync', status: 'error', message: `局域网上传/下架信封处理失败: ${(err as Error).message}` })
    }
  }

  /** 对端上线：请求增量同步（携带本机已有版本，对方回推缺失/更新的上传与墓碑）。 */
export function handlePeerStatus(host: MarketHost, ev: import('../../multi-instance/lan/lan-types').LanPeerStatusEvent): void {
    if (!ev.online) return
    const want: SkillMarketSyncWantPayload = {
      have: Object.entries(host.store.manifest.uploads)
        .filter(([name]) => !host.store.manifest.removed[name])
        .map(([name, rec]) => ({ name, uploadedAt: rec.uploadedAt })),
      removed: Object.entries(host.store.manifest.removed).map(([name, rec]) => ({ name, removedAt: rec.removedAt }))
    }
    host.lan?.sendLan?.(ev.peer.uid, 'skill-market.syncWant', want)
  }

  /**
   * 收端落位上传广播/回推：校验 → 写 uploads 目录 → 登记上表 → 按时间戳复活。
   * 幂等：同一上传者同一 uploadedAt 的记录已存在则跳过（重放/重复广播无害）；
   * 乱序防护：若本机墓碑时间晚于上传时间（先删后收到旧广播），保留墓碑。
   */
export function applyUpload(host: MarketHost, payload: SkillMarketUploadPayload): void {
    const existing = host.store.manifest.uploads[payload.name]
    if (existing && existing.uploaderUid === payload.authorUid && existing.uploadedAt === payload.uploadedAt) return
    const threat = first_threat_message(payload.body, 'strict')
    if (threat) {
      host.emitProgress({ phase: 'sync', status: 'error', message: `局域网上传 ${payload.name} 安全检查失败，已丢弃` })
      return
    }
    // 收端复校验与主动上传同套（发起端已校验；这里防伪造/损坏载荷）
    let fm: { name: string; description: string; version?: string; domain?: string }
    try {
      const parsed = parseFrontmatter(payload.body)
      validateFrontmatter(parsed, `<lan-upload:${payload.name}>`)
      fm = parsed
    } catch (err) {
      host.emitProgress({ phase: 'sync', status: 'error', message: `局域网上传 ${payload.name} frontmatter 校验失败，已丢弃: ${(err as Error).message}` })
      return
    }
    // 收端领域取发起端广播的领域（发起端已按目录路径判定并复验），与 uploadSkill 落位同构；
    // 幂等场景（重放）里两条相同 payload 落位路径一致，不会产生双份副本。
    // 仓库不可用（builtinRepoDir 空）时丢弃：不写相对路径幽灵副本，只告警。
    if (!host.builtinRepoDir) {
      host.emitProgress({ phase: 'sync', status: 'error', message: `局域网上传 ${payload.name} 失败：内置市场仓库不可用，已丢弃` })
      return
    }
    const destDir = host.marketRepoSkillDir(fm.name, payload.domain)
    // 附属文件入盘前的收端防线：先整体校验（路径越界 + 威胁内容），任一文件
    // 不合格即丢弃整个载荷——SKILL.md 已在上面扫过，files 是 LAN 外部输入，
    // 不能信任发起端已校验（防伪造/被篡改信封），更不能把越界路径写进磁盘。
    const files = payload.files ?? {}
    for (const [rel, content] of Object.entries(files)) {
      if (!host.isSafeRelPath(rel)) {
        host.emitProgress({
          phase: 'sync',
          status: 'error',
          message: `局域网上传 ${payload.name} 附属文件路径非法，已丢弃: ${rel}`
        })
        return
      }
      const threat = first_threat_message(content, 'strict')
      if (threat) {
        host.emitProgress({
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
    host.store.manifest.uploads[fm.name] = {
      uploaderUid: payload.authorUid,
      uploadedAt: payload.uploadedAt,
      sha: shaOfFile(join(destDir, 'SKILL.md')),
      version: fm.version,
      domain: payload.domain
    }
    const tombAt = host.store.manifest.removed[fm.name]?.removedAt ?? 0
    if (payload.uploadedAt > tombAt) delete host.store.manifest.removed[fm.name]
    host.store.persist()
    // 市场内容已变（收到上传）：通知渲染侧重拉
    host.emitChange()
  }

  /** 收端落位下架广播/墓碑回推：写墓碑（时间戳比本地新才生效）+ 清理本机上传目录副本。 */
export function applyTombstone(host: MarketHost, p: SkillMarketRemovePayload | SkillMarketTombstonePayload): void {
    const cur = host.store.manifest.removed[p.name]
    if (cur && cur.removedAt >= p.removedAt) return
    host.store.manifest.removed[p.name] = { removedAt: p.removedAt, removedBy: p.removedBy }
    // 磁盘副本按本机记录领域定位（收端记录的领域来自发起端广播，与磁盘落位一致，
    // 可精确清理）；仅上传条目有仓库副本，官方条目无记录不删仓库文件。
    const rec = host.store.manifest.uploads[p.name]
    if (rec) {
      const dir = host.marketRepoSkillDir(p.name, rec.domain)
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        console.warn(`[skill-market] 墓碑清理仓库副本失败（继续写墓碑）: ${(err as Error).message}`)
      }
    }
    // uploads 表保留原记录（追溯上传者用），列表已按墓碑过滤
    host.store.persist()
    // 市场内容已变（收到下架）：通知渲染侧重拉
    host.emitChange()
  }

  /** 收到 syncWant：对比对方已有版本，回推缺失/更新的上传（含全文）与墓碑。 */
export function respondSyncWant(host: MarketHost, fromUid: number, want: SkillMarketSyncWantPayload): void {
    const haveByName = new Map(want.have.map((h) => [h.name, h.uploadedAt]))
    const uploads: SkillMarketUploadPayload[] = []
    for (const [name, rec] of Object.entries(host.store.manifest.uploads)) {
      if (host.store.manifest.removed[name]) continue
      if ((haveByName.get(name) ?? 0) >= rec.uploadedAt) continue
      const body = host.readUploadBody(name)
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
        files: host.readUploadLanFiles(name),
        authorUid: rec.uploaderUid,
        uploadedAt: rec.uploadedAt,
        version: rec.version,
        domain: rec.domain,
        sha: rec.sha
      })
    }
    const removedByName = new Map(want.removed.map((r) => [r.name, r.removedAt]))
    const tombstones: SkillMarketTombstonePayload[] = []
    for (const [name, rec] of Object.entries(host.store.manifest.removed)) {
      if ((removedByName.get(name) ?? 0) < rec.removedAt) {
        tombstones.push({ name, removedAt: rec.removedAt, removedBy: rec.removedBy })
      }
    }
    if (uploads.length === 0 && tombstones.length === 0) return
    host.lan?.sendLan?.(fromUid, 'skill-market.replay', { uploads, tombstones } satisfies SkillMarketReplayPayload)
  }

  /** 收到 replay 回推：逐条按 upload/tombstone 语义落位（幂等）。 */
export function applyReplay(host: MarketHost, payload: SkillMarketReplayPayload): void {
    for (const u of payload.uploads) host.applyUpload(u)
    for (const t of payload.tombstones) host.applyTombstone(t)
  }

  /** 读市场仓库中该上传条目的 SKILL.md 全文（replay 回推给对方用）；缺失返回空串。
   * 按记录领域定位磁盘（与 marketRepoSkillDir 一致）。 */
export function readUploadBody(host: MarketHost, name: string): string {
    const rec = host.store.manifest.uploads[name]
    const p = join(host.marketRepoSkillDir(name, rec?.domain), 'SKILL.md')
    return existsSync(p) ? readFileSync(p, 'utf-8') : ''
  }

  /** 读市场仓库中该上传条目的文本附属文件（replay 回推给对方用，随 SKILL.md 一并下发）。
   * 按记录领域定位磁盘；SKILL.md 由 readUploadBody 单独读取，这里只收集其余文本。 */
export function readUploadLanFiles(host: MarketHost, name: string): Record<string, string> {
    const rec = host.store.manifest.uploads[name]
    return host.collectLanFiles(host.marketRepoSkillDir(name, rec?.domain))
  }

  /**
   * 一次性迁移/清理已退役的 local://uploads 上传层（构造函数在 loadManifest 后调用）。
   * 为什么存在——旧版本把上传落在 {marketDir}/uploads 并注册 local://uploads 源；
   * 现上传统一写内置市场仓库，旧数据若不迁移，用户此前上传的技能会从市场消失。
   * 什么作用——① 把 uploads/skills/ 下条目按 manifest.uploads[name].domain 移动到
   * 市场仓库落点（目标已存在则跳过，不覆盖）；② 从 manifest.sources 移除退役源；
   * ③ 清理 uploads/ 目录。
   * 留存理由——跨版本升级仍需它做一次幂等迁移；仓库不可用（builtinRepoDir 空）时
   * 直接返回、保留旧源与旧目录，避免丢数据；写入失败则整体回退并告警。
   * 保留理由（不删本方法）——应在确认不再有旧数据的版本再移除。
   */
export function migrateRetiredUploadsLayer(host: MarketHost, ): void {
    const staleIdx = host.store.manifest.sources.findIndex((s) => s.url === 'local://uploads')
    const uploadsRoot = join(host.marketDir, 'uploads')
    const skillsRoot = join(uploadsRoot, 'skills')
    if (staleIdx < 0 && !existsSync(skillsRoot)) return
    // 仓库不可用时不迁移也不清理：保留旧数据，下次可写时再迁
    if (!host.builtinRepoDir) return
    try {
      if (existsSync(skillsRoot)) {
        for (const [name, rec] of Object.entries(host.store.manifest.uploads)) {
          // 旧落点 = uploads/skills/{domain?}/{name}
          const legacy = rec.domain ? join(skillsRoot, ...rec.domain.split('/'), name) : join(skillsRoot, name)
          if (!existsSync(join(legacy, 'SKILL.md'))) continue
          const dest = host.marketRepoSkillDir(name, rec.domain)
          if (existsSync(dest)) continue // 目标已存在（如官方条目同名/已迁移）不覆盖
          mkdirSync(dirname(dest), { recursive: true })
          renameSync(legacy, dest)
        }
      }
      if (staleIdx >= 0) host.store.manifest.sources.splice(staleIdx, 1)
      if (existsSync(uploadsRoot)) rmSync(uploadsRoot, { recursive: true, force: true })
      host.store.persist()
    } catch (err) {
      console.error(`[skill-market] 退役 uploads 层迁移失败（保留旧数据）: ${(err as Error).message}`)
    }
  }
