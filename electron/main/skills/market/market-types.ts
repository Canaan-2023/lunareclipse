/**
 * @category 技能市场
 * @summary 市场共享契约：全部类型 + 三个纯函数（scopeKeyOf / isStructuralContainerDir / shaOfFile）
 *
 * 为什么独立成文件：ADR-05 把 1428 行的 market.ts 按角色拆为五模块后，类型与纯函数需要一个零状态、
 * 零业务依赖的落点；放在本文件可让其余模块只 import 类型，避免「模块 ↔ 宿主」运行时环。
 * 不删理由：MarketManifest 是 manifest.json 的磁盘形状契约（manifest-store 与各消费方共用）；
 * scopeKeyOf 是安装记录作用域键的唯一真源（与磁盘 U{uid}/AI{aiId} 分层同构）。
 */
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

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

/** 市场上传条目的元数据（上传已并入内置仓库，仅保留登记用于删除权限与领域定位） */
export interface UploadedSkillRecord {
  /** 上传者 UID（主系统统一发放，全局唯一；删除权限按它判定） */
  uploaderUid: number
  uploadedAt: number
  sha?: string
  version?: string
  /** 上传时的目录领域（相对 skills_domains 根的多级路径；空 = 用户级平铺）。磁盘落位与卸载清理按它定位。 */
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

export interface MarketManifest {
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

export function shaOfFile(p: string): string {
  return createHash('sha1').update(readFileSync(p)).digest('hex').slice(0, 12)
}