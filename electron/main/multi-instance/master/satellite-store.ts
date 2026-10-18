/**
 * 为什么存在：分系统断线重连后须从上次水位续传增量，主系统必须为每台分系统独立保存同步进度。
 * 作用：按 instanceId 读写同步水位（各路径 seq 索引与删除标记），处理 ABYSS 归档备份与过期记录清理。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import type { OpEntry, SyncPushResult } from '../types'

/** 原始字节 sha256（staged 实体校验用，格式 'sha256:'+hex；upsert 一律外置后统一比对原始字节指纹） */
function sha256Buffer(raw: Buffer): string {
  return 'sha256:' + createHash('sha256').update(raw).digest('hex')
}

/**
 * 主系统侧账号数据归集（设计依据：主/分系统账号同存工作域，uid 全局唯一发放即可
 * 保证跨实例不冲突——合并归集到同一工作域使多实例共享同一份记忆与知识资产）：
 * memory → memory/U{uid}/AI{aiId}/...
 * sessions → sessions_satellite/{instanceId}/U{uid}/AI{aiId}/...
 * NNG → NNG/AI{aiId}/U{uid}/...（主/分同存，不再镜像到 nng_satellite）
 * cache → cache/AI{aiId}/U{uid}/...（跨系统同步；分系统 CacheSync 派生后上送，
 * 主系统收镜像，分账号 cache 不由主系统本机 CacheSync 重新生成）
 * ABYSS → ABYSS/U{uid}/USER.md（用户级）与 ABYSS/U{uid}/AI{aiId}/AI.md（AI 级）
 * 用户资料体系，与记忆/NNG 同等同步归档
 * 备份（账号统一，独立根防备份被指纹扫描递归捕获）：快照恒为"昨天"日期目录，每账号只保留一份
 * memory → backup/U{uid}/{date}/memory/U{uid}/AI{aiId}/...（域内路径与真实工作域一字不差）
 * NNG → backup/U{uid}/{date}/NNG/AI{aiId}/U{uid}/...
 * cache → backup/U{uid}/{date}/cache/AI{aiId}/U{uid}/...
 * ABYSS → backup/U{uid}/{date}/ABYSS/U{uid}/...（uid 级整体归档，同 uid 只拷贝一份，
 * USER.md 属于用户级数据不归属单一 AI，避免按 scope 重复归档同 uid 多 AI 的 ABYSS）
 * 日内有同步变动、新的一天到来归档时快照此刻数据；无变动水位指纹比对零 IO 不写；
 * 恢复时从该日期目录取走整体覆盖回真实工作域。
 * oplog 按 (instanceId, key) 维护单调 seq 索引，杜绝乱序/重放/删除复活。
 */
export class SatelliteStore {
  constructor(private readonly root: string) {}

  /** 当日已归档过 ABYSS 的 uid（key=`${uid}|${date}`）：ABYSS 按 uid 级整体归档，同 uid 多 AI 只归档一份 */
  private archivedAbyss = new Set<string>()

  private seqPath(instanceId: string): string {
    return join(this.root, 'master_seq', `${instanceId}.json`)
  }

  private readSeq(instanceId: string): Record<string, { seq: number; deleted: boolean }> {
    const path = this.seqPath(instanceId)
    if (!existsSync(path)) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { seq: number; deleted: boolean }>
    } catch {
      return {}
    }
  }

  private writeSeq(instanceId: string, idx: Record<string, { seq: number; deleted: boolean }>): void {
    mkdirSync(dirname(this.seqPath(instanceId)), { recursive: true })
    writeFileSync(this.seqPath(instanceId), JSON.stringify(idx, null, 2), 'utf-8')
  }

  /** oplog key（相对 dataRoot）→ 落地绝对路径；非法 key 返回 null
   * （memory/sessions 带 U/AI 前缀，NNG/cache 带 AI/U 前缀，ABYSS 为 USER.md/AI.md）
   * 目录级 key（3 段作用域根 / ABYSS 2 段用户根、3 段 AI 根）返回对应目录路径，
   * 供 delete op 递归删除整棵作用域树，避免主系统镜像残留空目录骨架。 */
  private mirrorPath(instanceId: string, key: string): string | null {
    const parts = key.split('/')
    const kind = parts[0]
    if (kind === 'ABYSS') {
      // ABYSS/U{uid}（用户根目录）→ 目录路径；/USER.md → 文件路径；
      // /AI{aiId}（AI 根目录）→ 目录路径；/AI{aiId}/AI.md → 文件路径
      const uidMatch = /^U(\d+)$/.exec(parts[1] ?? '')
      if (!uidMatch) return null
      if (parts.length === 2) return join(this.root, 'ABYSS', parts[1])
      if (parts[2] === 'USER.md' && parts.length === 3) return join(this.root, 'ABYSS', parts[1], 'USER.md')
      const aiMatch = /^AI(\d+)$/.exec(parts[2] ?? '')
      if (aiMatch && parts.length === 3) return join(this.root, 'ABYSS', parts[1], parts[2])
      if (aiMatch && parts.length === 4 && parts[3] === 'AI.md') {
        return join(this.root, 'ABYSS', parts[1], parts[2], 'AI.md')
      }
      return null
    }
    if (parts.length < 3) return null
    const [a, b] = [parts[1], parts[2]]
    const rest = parts.slice(3).join('/')
    switch (kind) {
      case 'memory': {
        const uidMatch = /^U(\d+)$/.exec(a)
        const aiMatch = /^AI(\d+)$/.exec(b)
        if (!uidMatch || !aiMatch) return null
        return join(this.root, 'memory', a, b, rest)
      }
      case 'sessions': {
        const uidMatch = /^U(\d+)$/.exec(a)
        const aiMatch = /^AI(\d+)$/.exec(b)
        if (!uidMatch || !aiMatch) return null
        return join(this.root, `${kind}_satellite`, instanceId, a, b, rest)
      }
      case 'NNG':
      case 'cache': {
        // 主/分系统账号同存 NNG/AI{aiId}/U{uid}、cache/AI{aiId}/U{uid}（uid 全局唯一不冲突）
        const aiMatch = /^AI(\d+)$/.exec(a)
        const uidMatch = /^U(\d+)$/.exec(b)
        if (!aiMatch || !uidMatch) return null
        return join(this.root, kind, a, b, rest)
      }
      default:
        return null
    }
  }

  /**
   * 同步分块面暂存路径：{root}/sync_staging/U{uid}/{instanceId}/{key 多级目录}/file。
   * 单例推导点（SyncStreamSink 落盘与 applyPush 读取共用，路径不一致则实体永远不被消费）：
   * - key 必须已过 isValidKey 白名单（rest 段禁 . / .. / 反斜杠 / 冒号），可直接拼多级子路径
   * - staged 实体的原始 fallthrough 由 applyPush 落镜像前按 size/hash 校验把守，分块面仅临时存字节
   * - 目录级 key（delete 语义）不会走到这里（staged 只产自文件 upsert 采集）
   */
  static stagingPathFor(root: string, uid: number, instanceId: string, key: string): string {
    // memory/NNG/cache 等带 U/AI 作用域前缀，逐段重建目录层级（目录级 key 也在其列，防御）
    return join(root, 'sync_staging', `U${uid}`, instanceId, ...key.split('/'))
  }

  /** key 是否为目录级（作用域根本身，无文件名后段）：memory/sessions/NNG/cache 3 段、ABYSS 2 段用户根或 3 段 AI 根。
   * 为什么存在：目录级 key 只能承载 delete（整树删除语义），不允许 upsert 落盘——upsert 写目录会 EISDIR 崩溃。 */
  static isDirKey(key: string): boolean {
    const parts = key.split('/')
    const kind = parts[0]
    if (kind === 'ABYSS') {
      if (parts.length === 2) return true
      return parts.length === 3 && /^AI\d+$/.test(parts[2] ?? '')
    }
    return parts.length === 3
  }

  /** 校验 key 的 rest 段安全（rest 会直接拼入落盘绝对路径）：
   * - 每段非空且不是 . / ..（防路径穿越逃出 dataRoot）
   * - 不含反斜杠与盘符冒号（防 Windows 绝对路径/UNC 注入）
   * 为什么存在：key 由网络侧传入，先经过 isValidKey 白名单再进 mirrorPath join；
   * 前两段已由 U\d+/AI\d+ 约束，rest 若不设防，构造 key='memory/U1/AI1/../../token.json'
   * 可把镜像写到工作域之外，必须以段级白名单兜底。 */
  private static hasSafeRest(parts: string[]): boolean {
    for (let i = 3; i < parts.length; i++) {
      const seg = parts[i]
      if (seg === '' || seg === '.' || seg === '..') return false
      if (seg.includes('\\') || seg.includes(':')) return false
    }
    return true
  }

  /** 标定合法 key 以统计批次条目数（memory/sessions 要求 U/AI 前缀，NNG/cache 要求 AI/U 前缀；cache 在同步域内；ABYSS 为用户根/USER.md/AI.md，目录级与文件级均合法；ABYSS 用户根为 2 段例外） */
  static isValidKey(key: string): boolean {
    const parts = key.split('/')
    if (parts.length < 2) return false
    if (!SatelliteStore.hasSafeRest(parts)) return false
    const kind = parts[0]
    if (kind !== 'memory' && kind !== 'sessions' && kind !== 'NNG' && kind !== 'cache' && kind !== 'ABYSS') return false
    if (kind === 'ABYSS') {
      // 用户根（ABYSS/U{uid} 目录级 2 段）、USER.md 文件、AI{aiId} 目录级、AI{aiId}/AI.md 文件均合法
      if (!/^U\d+$/.test(parts[1])) return false
      if (parts.length === 2) return true
      if (parts[2] === 'USER.md') return parts.length === 3
      if (!/^AI\d+$/.test(parts[2])) return false
      return parts.length === 3 || (parts.length === 4 && parts[3] === 'AI.md')
    }
    if (parts.length < 3) return false
    if (kind === 'memory' || kind === 'sessions') {
      return /^U\d+$/.test(parts[1]) && /^AI\d+$/.test(parts[2])
    }
    if (kind === 'NNG' || kind === 'cache') {
      return /^AI\d+$/.test(parts[1]) && /^U\d+$/.test(parts[2])
    }
    return false
  }

  /**
   * 应用一批 oplog（按 seq 单调收敛，幂等可重放），返回 ackedSeq。
   * 安全校验（为什么存在：sync/push 是网络入向接口，key 与 content 均不可信）：
   * - entry.uid 必须等于令牌账号 uid（防分系统越权覆写其他账号记忆域）
   * - 从 key 解析的账号作用域同样必须等于令牌账号 uid（防 key 与 entry.uid 不一致探路）
   * - upsert 时若携带 hash 则必须与 content 匹配（防传输损坏/篡改落盘）
   * - 未通过校验的条目不应用、也不推进 ackedSeq（分系统保留 outbox 重推，不静默丢弃）
   */
  applyPush(satelliteUid: number, instanceId: string, entries: OpEntry[]): SyncPushResult {
    const idx = this.readSeq(instanceId)
    // ack 水位初值 = 历史已应用的最大 seq（idx 中所有 key 已应用 seq 的最大值）：
    // 主系统无持久化 ackedSeq，重放/坏条批（本批无成功条目）时 ackedSeq 也必须反映
    // 历史已确认位置（如历史 ack 到 5、本批 [6 坏, 7 坏] → 返回 5 而非 0），否则分系统
    // 无限重推已应用的批。安全论证：返回 ackedSeq = min(maxSeq, firstBad-1)，任何坏条
    // （firstBad）都在卫星 outbox 中持续存在并被反复重推，本水位再高也会被该 min 截断，
    // 坏条及其后条目不会被误删。
    let maxSeq = 0
    for (const v of Object.values(idx)) {
      if (v.seq > maxSeq) maxSeq = v.seq
    }
    // 批内首个校验失败条目的 seq：ackedSeq 必须截断在它之前，失败条目及其后条目
    // 都保留在分系统 outbox 中重推（重推时已应用的条目被幂等丢弃）。
    // 为什么存在：分系统按 ackedSeq 清理 outbox（删 seq ≤ ackedSeq 的全部条目），
    // 若 ackedSeq 只统计通过校验的条目，批内先失败后成功的组合（如 [100ok, 101 坏, 102ok]）
    // 会把失败的 101 连带删除，该更新在主/分两端永久丢失且无任何报错。
    let firstBadSeq: number | null = null
    const markBad = (entry: OpEntry): void => {
      if (firstBadSeq === null || entry.seq < firstBadSeq) firstBadSeq = entry.seq
    }
    // staged 条目校验通过的原始字节（不许经字符串往返：非 UTF-8 实体 toString 会损坏，须 Buffer 直写镜像）
    const stagedBuffers = new Map<OpEntry, Buffer>()
    for (const entry of entries) {
      if (entry.instanceId !== instanceId) {
        markBad(entry)
        continue
      }
      if (entry.uid !== satelliteUid) {
        markBad(entry)
        continue
      }
      if (!SatelliteStore.isValidKey(entry.key)) {
        markBad(entry)
        continue
      }
      const scope = SatelliteStore.scopeFromKey(entry.key)
      if (!scope || scope.uid !== satelliteUid) {
        markBad(entry)
        continue
      }
      // 幂等/乱序重放必须在内容校验之前识别：镜像已不旧于本条（idx 已应用 seq ≥
      // entry.seq）时直接丢弃，不再读 staging/校验 hash——重放条的原实体可能在首次
      // 应用时已被消费删除（staging 清理），若此时重读 staging 会误判"实体未达"
      // 而 markBad，重放批的 ackedSeq 被截断为 0、永远无法收敛。
      const prev = idx[entry.key]
      if (prev && entry.seq <= prev.seq) {
        // staged 重放时镜像已不旧于本条，暂存实体无保留价值，顺手清理避免残留
        // （实体经 LAN 重推会再次覆盖暂存；文件不存在视为清理成功）
        if (entry.staged) {
          const stalePath = SatelliteStore.stagingPathFor(this.root, satelliteUid, instanceId, entry.key)
          try {
            rmSync(stalePath, { force: true })
          } catch {
            // 不存在视为清理成功
          }
        }
        continue
      }
      if (entry.op === 'upsert') {
        // upsert 一律 staged（采集端统一外置，无内联路径）：实体经 LAN 分块面先行到达
        // sync_staging，从暂存区读回全部字节、按 size/hash 与原文件字节比对一致后才允许
        // 落镜像——暂存区字节不可信，即使 LAN 内伪造 staging 文件也过不了这里的哈希校验
        // （落镜像仍由令牌 uid 绑定）。实体未达（分块传输未完成/失败）→ 本条 markBad、
        // 不推进 ackedSeq，分系统保留 outbox 重推（重推时先重发实体再 push 元数据，幂等覆盖暂存）。
        const stagedPath = SatelliteStore.stagingPathFor(this.root, satelliteUid, instanceId, entry.key)
        let raw: Buffer
        try {
          raw = readFileSync(stagedPath)
        } catch {
          markBad(entry)
          continue
        }
        if (entry.size != null && raw.length !== entry.size) {
          markBad(entry)
          continue
        }
        if (entry.hash && entry.hash !== sha256Buffer(raw)) {
          markBad(entry)
          continue
        }
        // 原字节随条目记住，落盘处 Buffer 直写（见下方 stagedBuffers 用法）
        stagedBuffers.set(entry, raw)
      }
      if (entry.seq > maxSeq) maxSeq = entry.seq
      const mirror = this.mirrorPath(instanceId, entry.key)
      if (!mirror) {
        markBad(entry)
        continue
      }
      if (entry.op === 'delete') {
        // 目录级 delete op 表示分系统删除了整棵作用域树（watcher 实测父目录事件先到），
        // 必须 recursive 删除镜像整树；文件级 delete 同样 recursive 幂等（文件不存在即删除成功）。
        // 为什么 recursive：同步的是文件夹结构而非仅文件，非递归 rmSync 遇非空目录抛
        // ENOTEMPTY 被 catch 吞掉后主系统残留空目录骨架，重建目录树时产生幽灵目录。
        try {
          rmSync(mirror, { recursive: true, force: true })
        } catch {
          // 镜像已不存在视为删除成功
        }
        idx[entry.key] = { seq: entry.seq, deleted: true }
      } else {
        const stagedRaw = stagedBuffers.get(entry)
        // 非 delete 意外 op（upsert 一律 staged，实体未读回即坏条）：拒绝落盘并截断 ack
        if (!stagedRaw) {
          markBad(entry)
          continue
        }
        // 目录级 key 只允许 delete（整树语义）；upsert 写目录路径会 EISDIR 崩溃，显式拒绝
        if (SatelliteStore.isDirKey(entry.key)) {
          markBad(entry)
          continue
        }
        // 原字节直写镜像，不经过字符串往返（非 UTF-8 实体 toString 会损坏）；
        // 落盘成功后删暂存，暂存残留由 applyPush 之后的主系统定期清理兜底
        mkdirSync(dirname(mirror), { recursive: true })
        writeFileSync(mirror, stagedRaw)
        const stagedPath = SatelliteStore.stagingPathFor(this.root, satelliteUid, instanceId, entry.key)
        try {
          rmSync(stagedPath, { force: true })
        } catch {
          // 已不存在视为清理成功
        }
        idx[entry.key] = { seq: entry.seq, deleted: false }
      }
    }
    if (entries.length > 0) this.writeSeq(instanceId, idx)
    return { ok: true, ackedSeq: firstBadSeq !== null ? Math.min(maxSeq, firstBadSeq - 1) : maxSeq }
  }

  /** 从 oplog key 提取账号作用域（memory/sessions: U{uid}/AI{aiId}；NNG/cache: AI{aiId}/U{uid}；ABYSS: USER.md→{uid,0} 用户级/AI.md→{uid,aiId}；目录级→归属账号）。
   * public 供收端 SyncStreamSink 做账号隔离前置校验（防卫星用他人 uid 作用域的 key 写暂存）。 */
  static scopeFromKey(key: string): { uid: number; aiId: number } | null {
    const parts = key.split('/')
    if (parts[0] === 'ABYSS') {
      const uidMatch = /^U(\d+)$/.exec(parts[1] ?? '')
      if (!uidMatch) return null
      // 目录级（ABYSS/U{uid} 2 段、ABYSS/U{uid}/AI{aiId} 3 段）→ 归属账号，供 delete 整树收敛
      if (parts.length === 2) return { uid: Number(uidMatch[1]), aiId: 0 }
      if (parts[2] === 'USER.md' && parts.length === 3) return { uid: Number(uidMatch[1]), aiId: 0 }
      const aiMatch = /^AI(\d+)$/.exec(parts[2] ?? '')
      if (aiMatch && parts.length === 3) return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
      if (aiMatch && parts[3] === 'AI.md' && parts.length === 4) {
        return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
      }
      return null
    }
    if (parts[0] === 'memory' || parts[0] === 'sessions') {
      const uidMatch = /^U(\d+)$/.exec(parts[1] ?? '')
      const aiMatch = uidMatch && /^AI(\d+)$/.exec(parts[2] ?? '')
      if (uidMatch && aiMatch) return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
    } else if (parts[0] === 'NNG' || parts[0] === 'cache') {
      const aiMatch = /^AI(\d+)$/.exec(parts[1] ?? '')
      const uidMatch = aiMatch && /^U(\d+)$/.exec(parts[2] ?? '')
      if (aiMatch && uidMatch) return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
    }
    return null
  }

  /** 按账号快照备份：memory/U{uid}/AI{aiId} → backup/U{uid}/{date}/memory/U{uid}/AI{aiId}，NNG/cache 同构（域内相对路径与真实工作域一字不差；同日期先清本账号两棵子树再写，幂等；同 uid 多 AI 互不覆盖）。ABYSS 按 uid 级整体归档（USER.md 用户级数据不归属单一 AI，同 uid 只归档一份，避免同 uid 多 AI 重复拷贝；同日内再次归档跳过 ABYSS，USER.md/AI.md 变化留待次日 archive date 更新后归档，与"快照恒为昨天"语义一致） */
  snapshotArchive(scope: { uid: number; aiId: number }, date: string): number {
    const scopeDir = this.scopeRoot(scope)
    const nngDir = this.nngRoot(scope)
    const cacheDir = this.cacheRoot(scope)
    const abyssDir = this.abyssRoot(scope.uid)
    const dateDir = this.scopeArchiveRoot(scope, date)
    const hasMemory = existsSync(scopeDir)
    const hasNng = existsSync(nngDir)
    const hasCache = existsSync(cacheDir)
    const hasAbyss = existsSync(abyssDir) && !this.archivedAbyss.has(`${scope.uid}|${date}`)
    if (!hasMemory && !hasNng && !hasCache && !hasAbyss) return 0
    let count = 0
    if (hasMemory) {
      const dst = join(dateDir, 'memory', `U${scope.uid}`, `AI${scope.aiId}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(scopeDir, dst, [])
    }
    if (hasNng) {
      const dst = join(dateDir, 'NNG', `AI${scope.aiId}`, `U${scope.uid}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(nngDir, dst, [])
    }
    if (hasCache) {
      const dst = join(dateDir, 'cache', `AI${scope.aiId}`, `U${scope.uid}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(cacheDir, dst, [])
    }
    if (hasAbyss) {
      const dst = join(dateDir, 'ABYSS', `U${scope.uid}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(abyssDir, dst, [])
      this.archivedAbyss.add(`${scope.uid}|${date}`)
    }
    return count
  }

  /** 账号记忆工作域：memory/U{uid}/AI{aiId}（主/分同构，uid 全局唯一） */
  private scopeRoot(scope: { uid: number; aiId: number }): string {
    return join(this.root, 'memory', `U${scope.uid}`, `AI${scope.aiId}`)
  }

  /** 账号 ABYSS 工作域：ABYSS/U{uid}（用户级 USER.md 与 AI 级 AI.md 都在该 uid 路径下） */
  private abyssRoot(uid: number): string {
    return join(this.root, 'ABYSS', `U${uid}`)
  }

  /** 账号 NNG 工作域：NNG/AI{aiId}/U{uid}（主/分同构，uid 全局唯一） */
  private nngRoot(scope: { uid: number; aiId: number }): string {
    return join(this.root, 'NNG', `AI${scope.aiId}`, `U${scope.uid}`)
  }

  /** 账号 cache 工作域：cache/AI{aiId}/U{uid}（主/分同构，uid 全局唯一） */
  private cacheRoot(scope: { uid: number; aiId: number }): string {
    return join(this.root, 'cache', `AI${scope.aiId}`, `U${scope.uid}`)
  }

  /** 账号备份根（独立根，防被指纹扫描递归捕获）：backup/U{uid}，date 时含日期层（恒为昨天，每账号只保留一份） */
  private scopeArchiveRoot(scope: { uid: number; aiId: number }, date?: string): string {
    const base = join(this.root, 'backup', `U${scope.uid}`)
    return date ? join(base, date) : base
  }

  private walkCopy(src: string, dst: string, exclude: string[]): number {
    if (!existsSync(src)) return 0
    let count = 0
    const stack: Array<{ s: string; d: string }> = [{ s: src, d: dst }]
    while (stack.length > 0) {
      const { s, d } = stack.pop()!
      for (const name of readdirSync(s)) {
        if (exclude.includes(name)) continue
        const sPath = join(s, name)
        const dPath = join(d, name)
        const st = statSync(sPath)
        if (st.isDirectory()) {
          stack.push({ s: sPath, d: dPath })
        } else {
          mkdirSync(d, { recursive: true })
          writeFileSync(dPath, readFileSync(sPath))
          count++
        }
      }
    }
    return count
  }

  /** 列出某账号的全部归档（按日期降序） */
  listArchives(instanceId: string, scope: { uid: number; aiId: number }): Array<{ date: string; entryCount: number }> {
    const archiveRoot = this.scopeArchiveRoot(scope)
    if (!existsSync(archiveRoot)) return []
    return readdirSync(archiveRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        let count = 0
        this.walkCount(join(archiveRoot, e.name), () => (count += 1))
        return { date: e.name, entryCount: count }
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  }

  private walkCount(dir: string, onFile: () => void): void {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) this.walkCount(p, onFile)
      else onFile()
    }
  }

  /** 归档水位：{date: 上次归档日期, maxSeq: 归档时最大 seq} */
  private watermarkPath(instanceId: string): string {
    return join(this.root, 'master_archive', `${instanceId}.json`)
  }

  private readWatermark(instanceId: string): { date: string; maxSeq: number } | null {
    const path = this.watermarkPath(instanceId)
    if (!existsSync(path)) return null
    try {
      const w = JSON.parse(readFileSync(path, 'utf-8')) as { date?: string; maxSeq?: number }
      if (typeof w.date !== 'string' || typeof w.maxSeq !== 'number') return null
      return { date: w.date, maxSeq: w.maxSeq }
    } catch {
      return null
    }
  }

  private writeWatermark(instanceId: string, date: string, maxSeq: number): void {
    const path = this.watermarkPath(instanceId)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ date, maxSeq }), 'utf-8')
  }

  /** 本地时区 YYYY-MM-DD（含偏移天数） */
  private static localDateStr(offsetDays: number): string {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${day}`
  }

  /**
   * 被动日备份：目标日期恒为"昨天"；仅当 maxSeq 有新增时才快照账号当日数据并清理旧日期备份。
   * 水位命中（同日且无新数据）时零 IO 直接返回。
   */
  maybeArchiveDaily(instanceId: string): { archived: boolean; date: string; scopes: number; count: number } {
    const idx = this.readSeq(instanceId)
    let maxSeq = 0
    const scopes = new Set<string>()
    for (const [key, v] of Object.entries(idx)) {
      if (v.seq > maxSeq) maxSeq = v.seq
      if (v.deleted) continue
      const scope = SatelliteStore.scopeFromKey(key)
      if (scope) scopes.add(`${scope.uid}-${scope.aiId}`)
    }
    const date = SatelliteStore.localDateStr(-1)
    const wm = this.readWatermark(instanceId)
    if (wm && wm.date === date && maxSeq <= wm.maxSeq) {
      return { archived: false, date, scopes: scopes.size, count: 0 }
    }
    if (scopes.size === 0 && maxSeq === 0) {
      return { archived: false, date, scopes: 0, count: 0 }
    }
    let count = 0
    for (const s of scopes) {
      const [uid, aiId] = s.split('-').map(Number)
      count += this.snapshotArchive({ uid, aiId }, date)
    }
    this.removeArchivesExcept(scopes, date)
    this.writeWatermark(instanceId, date, maxSeq)
    return { archived: true, date, scopes: scopes.size, count }
  }

  /** 清理非目标日期的历史备份（只保留昨天一份；按 uid 归并，同 uid 多 AI 不重复扫；只作用于本实例拥有的账号） */
  private removeArchivesExcept(scopes: Set<string>, keepDate: string): void {
    const uids = new Set<number>()
    for (const s of scopes) uids.add(Number(s.split('-')[0]))
    for (const uid of uids) {
      const archiveRoot = join(this.root, 'backup', `U${uid}`)
      if (!existsSync(archiveRoot)) continue
      for (const name of readdirSync(archiveRoot)) {
        if (name === keepDate) continue
        rmSync(join(archiveRoot, name), { recursive: true, force: true })
      }
    }
  }

  /** 某实例全部账号归档汇总（跨 uid/aiId 聚合；无归档返回 null） */
  latestArchiveInfo(instanceId: string): { date: string; entryCount: number } | null {
    const details = this.listArchiveDetails(instanceId)
    if (details.length === 0) return null
    const bestDate = details[0].date
    let count = 0
    for (const d of details) {
      if (d.date === bestDate) count += d.entryCount
    }
    return { date: bestDate, entryCount: count }
  }

  /** 某实例全部账号备份明细（按 uid 聚合、日期降序） */
  listArchiveDetails(instanceId: string): Array<{ uid: number; date: string; entryCount: number }> {
    const idx = this.readSeq(instanceId)
    const uids = new Set<number>()
    for (const key of Object.keys(idx)) {
      const scope = SatelliteStore.scopeFromKey(key)
      if (scope) uids.add(scope.uid)
    }
    const out: Array<{ uid: number; date: string; entryCount: number }> = []
    for (const uid of uids) {
      const archiveRoot = join(this.root, 'backup', `U${uid}`)
      if (!existsSync(archiveRoot)) continue
      for (const date of readdirSync(archiveRoot)) {
        const d = join(archiveRoot, date)
        if (!statSync(d).isDirectory()) continue
        let count = 0
        this.walkCount(d, () => { count += 1 })
        out.push({ uid, date, entryCount: count })
      }
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1))
  }

  /** 读取某账号某日备份的全部条目：key 相对备份日期根，带 memory//NNG//cache/ 完整域前缀（与真实工作域路径一字不差，恢复端按前缀路由回工作域） */
  collectArchive(uid: number, date: string): Array<{ key: string; content: string }> {
    const dateDir = join(this.root, 'backup', `U${uid}`, date)
    if (!existsSync(dateDir)) return []
    const out: Array<{ key: string; content: string }> = []
    const stack = [dateDir]
    while (stack.length > 0) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          stack.push(p)
        } else {
          out.push({ key: p.slice(dateDir.length + 1).replace(/\\/g, '/'), content: readFileSync(p, 'utf-8') })
        }
      }
    }
    return out
  }

  /** 备份内容明细（备份中心展示"备份里有什么"）：按顶层域聚合 + 文件清单（路径/大小/文本预览） */
  inspectArchive(uid: number, date: string): {
    count: number
    bytes: number
    domains: Array<{ domain: string; files: number; bytes: number }>
    files: Array<{ path: string; size: number; preview?: string }>
  } {
    return this.inspectArchiveDir(join(this.root, 'backup', `U${uid}`, date))
  }

  private inspectArchiveDir(archiveDir: string): {
    count: number
    bytes: number
    domains: Array<{ domain: string; files: number; bytes: number }>
    files: Array<{ path: string; size: number; preview?: string }>
  } {
    if (!existsSync(archiveDir)) return { count: 0, bytes: 0, domains: [], files: [] }
    const files: Array<{ path: string; size: number; preview?: string }> = []
    const byDomain = new Map<string, { files: number; bytes: number }>()
    const stack = [archiveDir]
    while (stack.length > 0) {
      const dir = stack.pop()!
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          stack.push(p)
          continue
        }
        const rel = p.slice(archiveDir.length + 1).replace(/\\/g, '/')
        const size = statSync(p).size
        const domain = rel.split('/')[0] ?? '(根)'
        const agg = byDomain.get(domain) ?? { files: 0, bytes: 0 }
        agg.files += 1
        agg.bytes += size
        byDomain.set(domain, agg)
        files.push({ path: rel, size, preview: this.peekText(p, size) })
      }
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1))
    const domains = [...byDomain.entries()]
      .map(([domain, d]) => ({ domain, files: d.files, bytes: d.bytes }))
      .sort((a, b) => (a.domain < b.domain ? -1 : 1))
    const bytes = files.reduce((sum, f) => sum + f.size, 0)
    return { count: files.length, bytes, domains, files }
  }

  /** 文本文件内容预览（≤512B，二进制/超大文件跳过） */
  private peekText(p: string, size: number): string | undefined {
    if (size > 64 * 1024 || size === 0) return undefined
    try {
      const content = readFileSync(p, 'utf-8')
      if (content.includes('\u0000')) return undefined
      return content.slice(0, 512)
    } catch {
      return undefined
    }
  }

  // ===== 主系统账号备份（备份使用由本机自己承担；分系统账号归 maybeArchiveDaily 管，两套备份共用 backup/ 根，uid 唯一不冲突） =====
  // memory/U{uid}/AI{aiId} → backup/U{uid}/{date}/memory/U{uid}/AI{aiId}（NNG 同构，域内路径与真实一致）
  // 水位：backup/.watermark.json（date + 内容指纹，无变化零 IO）

  private localArchiveDir(uid: number, aiId: number, date: string): string {
    return this.scopeArchiveRoot({ uid, aiId }, date)
  }

  private localScopeRoot(uid: number, aiId: number): string {
    return this.scopeRoot({ uid, aiId })
  }

  /** 本机账号备份到达即评估：目标日期恒为"昨天"，内容指纹无变化时零 IO。skipUids 为分系统账号，本机备份不接管 */
  maybeArchiveLocalDaily(skipUids?: Set<number>): { archived: boolean; date: string; scopes: number; count: number } {
    const date = SatelliteStore.localDateStr(-1)
    const scopes = this.scanLocalScopes(skipUids)
    const fp = this.fingerprintLocal(scopes)
    const wm = this.readLocalWatermark()
    if (wm && wm.date === date && wm.fingerprint === fp) {
      return { archived: false, date, scopes: scopes.length, count: 0 }
    }
    if (scopes.length === 0) return { archived: false, date, scopes: 0, count: 0 }
    let count = 0
    for (const s of scopes) count += this.snapshotLocalScope(s.uid, s.aiId, date)
    this.removeLocalArchivesExcept(scopes, date)
    this.writeLocalWatermark(date, fp)
    return { archived: true, date, scopes: scopes.length, count }
  }

  /** 快照单个本机账号：memory/U{uid}/AI{aiId} → backup/U{uid}/{date}/memory/U{uid}/AI{aiId}，NNG/cache 同构（域内路径与真实一致；同日期先清本账号两棵子树再写，幂等；同 uid 多 AI 互不覆盖）。ABYSS 按 uid 级整体归档（USER.md 用户级数据不归属单一 AI，同 uid 只归档一份；同日内再次归档跳过 ABYSS，变化留待次日归档） */
  snapshotLocalScope(uid: number, aiId: number, date: string): number {
    const scopeDir = this.localScopeRoot(uid, aiId)
    const nngDir = this.nngRoot({ uid, aiId })
    const cacheDir = this.cacheRoot({ uid, aiId })
    const abyssDir = this.abyssRoot(uid)
    const dateDir = this.localArchiveDir(uid, aiId, date)
    const hasMemory = existsSync(scopeDir)
    const hasNng = existsSync(nngDir)
    const hasCache = existsSync(cacheDir)
    const hasAbyss = existsSync(abyssDir) && !this.archivedAbyss.has(`${uid}|${date}`)
    if (!hasMemory && !hasNng && !hasCache && !hasAbyss) return 0
    let count = 0
    if (hasMemory) {
      const dst = join(dateDir, 'memory', `U${uid}`, `AI${aiId}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(scopeDir, dst, [])
    }
    if (hasNng) {
      const dst = join(dateDir, 'NNG', `AI${aiId}`, `U${uid}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(nngDir, dst, [])
    }
    if (hasCache) {
      const dst = join(dateDir, 'cache', `AI${aiId}`, `U${uid}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(cacheDir, dst, [])
    }
    if (hasAbyss) {
      const dst = join(dateDir, 'ABYSS', `U${uid}`)
      rmSync(dst, { recursive: true, force: true })
      count += this.walkCopy(abyssDir, dst, [])
      this.archivedAbyss.add(`${uid}|${date}`)
    }
    return count
  }

  /** 扫描本机已有账号作用域（memory/U{uid}/AI{aiId}、NNG 与 cache 的 AI{aiId}/U{uid}、ABYSS/U{uid} 四方合并；rel 带 memory:/NNG:/cache:/ABYSS: 前缀区分域；skipUids 排除分系统账号；ABYSS 以 aiId=0 用户级哨兵进入指纹，保证 USER.md/AI.md 变化也会触发归档） */
  private scanLocalScopes(skipUids?: Set<number>): Array<{ uid: number; aiId: number; files: Array<{ rel: string; m: number; s: number }> }> {
    const memoryRoot = join(this.root, 'memory')
    const nngRoot = join(this.root, 'NNG')
    const cacheRoot = join(this.root, 'cache')
    const abyssRoot = join(this.root, 'ABYSS')
    if (!existsSync(memoryRoot) && !existsSync(nngRoot) && !existsSync(cacheRoot) && !existsSync(abyssRoot)) return []
    type ScopeFiles = { uid: number; aiId: number; files: Array<{ rel: string; m: number; s: number }> }
    const scopes = new Map<string, ScopeFiles>()
    const addScope = (uid: number, aiId: number, domainPrefix: string, dir: string): void => {
      const files: Array<{ rel: string; m: number; s: number }> = []
      this.walkFingerprint(dir, dir, domainPrefix, files)
      if (files.length === 0) return
      const key = `${uid}-${aiId}`
      const existing = scopes.get(key)
      if (existing) {
        existing.files.push(...files)
      } else {
        scopes.set(key, { uid, aiId, files })
      }
    }
    if (existsSync(abyssRoot)) {
      for (const uidName of readdirSync(abyssRoot, { withFileTypes: true })) {
        const uidMatch = uidName.isDirectory() && /^U(\d+)$/.exec(uidName.name)
        if (!uidMatch) continue
        const uid = Number(uidMatch[1])
        if (skipUids?.has(uid)) continue
        addScope(uid, 0, 'ABYSS', join(abyssRoot, uidName.name))
      }
    }
    if (existsSync(memoryRoot)) {
      for (const uidName of readdirSync(memoryRoot, { withFileTypes: true })) {
        const uidMatch = uidName.isDirectory() && /^U(\d+)$/.exec(uidName.name)
        if (!uidMatch) continue
        const uid = Number(uidMatch[1])
        if (skipUids?.has(uid)) continue
        const uidDir = join(memoryRoot, uidName.name)
        for (const aiName of readdirSync(uidDir, { withFileTypes: true })) {
          const aiMatch = aiName.isDirectory() && /^AI(\d+)$/.exec(aiName.name)
          if (!aiMatch) continue
          addScope(uid, Number(aiMatch[1]), 'memory', join(uidDir, aiName.name))
        }
      }
    }
    if (existsSync(nngRoot)) {
      for (const aiName of readdirSync(nngRoot, { withFileTypes: true })) {
        const aiMatch = aiName.isDirectory() && /^AI(\d+)$/.exec(aiName.name)
        if (!aiMatch) continue
        const aiDir = join(nngRoot, aiName.name)
        for (const uidName of readdirSync(aiDir, { withFileTypes: true })) {
          const uidMatch = uidName.isDirectory() && /^U(\d+)$/.exec(uidName.name)
          if (!uidMatch) continue
          const uid = Number(uidMatch[1])
          if (skipUids?.has(uid)) continue
          addScope(uid, Number(aiMatch[1]), 'NNG', join(aiDir, uidName.name))
        }
      }
    }
    if (existsSync(cacheRoot)) {
      for (const aiName of readdirSync(cacheRoot, { withFileTypes: true })) {
        const aiMatch = aiName.isDirectory() && /^AI(\d+)$/.exec(aiName.name)
        if (!aiMatch) continue
        const aiDir = join(cacheRoot, aiName.name)
        for (const uidName of readdirSync(aiDir, { withFileTypes: true })) {
          const uidMatch = uidName.isDirectory() && /^U(\d+)$/.exec(uidName.name)
          if (!uidMatch) continue
          const uid = Number(uidMatch[1])
          if (skipUids?.has(uid)) continue
          addScope(uid, Number(aiMatch[1]), 'cache', join(aiDir, uidName.name))
        }
      }
    }
    return [...scopes.values()].sort((a, b) => a.uid - b.uid || a.aiId - b.aiId)
  }

  private walkFingerprint(dir: string, base: string, domainPrefix: string, out: Array<{ rel: string; m: number; s: number }>): void {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) {
        this.walkFingerprint(p, base, domainPrefix, out)
      } else {
        const st = statSync(p)
        out.push({ rel: `${domainPrefix}:${p.slice(base.length + 1).replace(/\\/g, '/')}`, m: st.mtimeMs, s: st.size })
      }
    }
  }

  /** 内容指纹：全部作用域文件的（相对路径|mtime|size）按序拼接哈希；内容未变则恒定 */
  private fingerprintLocal(scopes: Array<{ uid: number; aiId: number; files: Array<{ rel: string; m: number; s: number }> }>): string {
    const parts: string[] = []
    for (const s of scopes) {
      for (const f of s.files) parts.push(`${s.uid}/${s.aiId}|${f.rel}|${f.m}|${f.s}`)
    }
    return 'sha256:' + createHash('sha256').update(parts.join('\n')).digest('hex')
  }

  private localWatermarkPath(): string {
    return join(this.root, 'backup', '.watermark.json')
  }

  private readLocalWatermark(): { date: string; fingerprint: string } | null {
    const path = this.localWatermarkPath()
    if (!existsSync(path)) return null
    try {
      const w = JSON.parse(readFileSync(path, 'utf-8')) as { date?: string; fingerprint?: string }
      if (typeof w.date !== 'string' || typeof w.fingerprint !== 'string') return null
      return { date: w.date, fingerprint: w.fingerprint }
    } catch {
      return null
    }
  }

  private writeLocalWatermark(date: string, fingerprint: string): void {
    const path = this.localWatermarkPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ date, fingerprint }), 'utf-8')
  }

  /** 清理非目标日期的本机历史备份（只保留昨天一份；按 uid 归并，不碰分系统账号备份） */
  private removeLocalArchivesExcept(scopes: Array<{ uid: number; aiId: number }>, keepDate: string): void {
    const uids = new Set<number>()
    for (const s of scopes) uids.add(s.uid)
    for (const uid of uids) {
      const archiveRoot = join(this.root, 'backup', `U${uid}`)
      if (!existsSync(archiveRoot)) continue
      for (const name of readdirSync(archiveRoot)) {
        if (name === keepDate) continue
        rmSync(join(archiveRoot, name), { recursive: true, force: true })
      }
    }
  }

  /** 本机账号备份明细（backup/U{uid}/{date} 按 uid 聚合；仅本机账号，跳过 backup/.watermark.json） */
  listLocalArchives(): Array<{ uid: number; date: string; entryCount: number }> {
    const backupRoot = join(this.root, 'backup')
    if (!existsSync(backupRoot)) return []
    const out: Array<{ uid: number; date: string; entryCount: number }> = []
    for (const uidName of readdirSync(backupRoot, { withFileTypes: true })) {
      const uidMatch = uidName.isDirectory() && /^U(\d+)$/.exec(uidName.name)
      if (!uidMatch) continue
      const uidDir = join(backupRoot, uidName.name)
      for (const date of readdirSync(uidDir, { withFileTypes: true })) {
        if (!date.isDirectory()) continue
        const d = join(uidDir, date.name)
        let count = 0
        this.walkCount(d, () => { count += 1 })
        out.push({ uid: Number(uidMatch[1]), date: date.name, entryCount: count })
      }
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1))
  }

  /** 本机账号备份内容明细（backup/U{uid}/{date} 全量，含 memory/NNG/cache 三域） */
  inspectLocalArchive(uid: number, date: string): {
    count: number
    bytes: number
    domains: Array<{ domain: string; files: number; bytes: number }>
    files: Array<{ path: string; size: number; preview?: string }>
  } {
    return this.inspectArchiveDir(join(this.root, 'backup', `U${uid}`, date))
  }

  /** 本机账号备份整体覆盖恢复：清空真实 memory/U{uid}、NNG 与 cache 域中该 uid 的全部子树后，由备份日期目录完全重建（memory/NNG/cache 域内路径与真实一字不差；完全替换，不增量合并） */
  restoreLocalOverwrite(uid: number, date: string): { ok: boolean; restored: number; error?: string } {
    const dateDir = join(this.root, 'backup', `U${uid}`, date)
    if (!existsSync(dateDir)) return { ok: false, restored: 0, error: '备份不存在' }
    const memBackup = join(dateDir, 'memory', `U${uid}`)
    const memReal = join(this.root, 'memory', `U${uid}`)
    rmSync(memReal, { recursive: true, force: true })
    let restored = 0
    if (existsSync(memBackup)) {
      mkdirSync(memReal, { recursive: true })
      restored += this.walkCopy(memBackup, memReal, [])
    }
    // NNG：清真实域中该 uid 的所有子树（NNG/AI{aiId}/U{uid}），再由备份 NNG 域回拷
    const nngRoot = join(this.root, 'NNG')
    if (existsSync(nngRoot)) {
      for (const aiName of readdirSync(nngRoot, { withFileTypes: true })) {
        if (!aiName.isDirectory()) continue
        rmSync(join(nngRoot, aiName.name, `U${uid}`), { recursive: true, force: true })
      }
    }
    const nngBackup = join(dateDir, 'NNG')
    if (existsSync(nngBackup)) {
      for (const aiName of readdirSync(nngBackup, { withFileTypes: true })) {
        if (!aiName.isDirectory()) continue
        const src = join(nngBackup, aiName.name, `U${uid}`)
        if (!existsSync(src)) continue
        const dst = join(nngRoot, aiName.name, `U${uid}`)
        mkdirSync(dst, { recursive: true })
        restored += this.walkCopy(src, dst, [])
      }
    }
    // cache：清真实域中该 uid 的所有子树（cache/AI{aiId}/U{uid}），再由备份 cache 域回拷
    const cacheRoot = join(this.root, 'cache')
    if (existsSync(cacheRoot)) {
      for (const aiName of readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!aiName.isDirectory()) continue
        rmSync(join(cacheRoot, aiName.name, `U${uid}`), { recursive: true, force: true })
      }
    }
    const cacheBackup = join(dateDir, 'cache')
    if (existsSync(cacheBackup)) {
      for (const aiName of readdirSync(cacheBackup, { withFileTypes: true })) {
        if (!aiName.isDirectory()) continue
        const src = join(cacheBackup, aiName.name, `U${uid}`)
        if (!existsSync(src)) continue
        const dst = join(cacheRoot, aiName.name, `U${uid}`)
        mkdirSync(dst, { recursive: true })
        restored += this.walkCopy(src, dst, [])
      }
    }
    // ABYSS：清真实域中该 uid 的整体目录（ABYSS/U{uid}，含 USER.md 与各 AI 的 AI.md），由备份 ABYSS 域整棵回拷
    const abyssReal = join(this.root, 'ABYSS', `U${uid}`)
    rmSync(abyssReal, { recursive: true, force: true })
    const abyssBackup = join(dateDir, 'ABYSS', `U${uid}`)
    if (existsSync(abyssBackup)) {
      mkdirSync(abyssReal, { recursive: true })
      restored += this.walkCopy(abyssBackup, abyssReal, [])
    }
    return { ok: true, restored }
  }
}