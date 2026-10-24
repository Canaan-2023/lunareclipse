/**
 * 内部会话存储（v11 双层会话：AI 看的会话池；v0.24 NNG 逆生树物理结构）。
 *
 * 物理布局（NNG 嵌套：文件 + 同名文件夹）：
 * sessions/U{uid}/AI{aiId}/{ownerSessionId}/ai/
 * root.json ← 根会话（无 parentId）
 * root/ ← root 的同名文件夹（NNG：文件 + 同名文件夹）
 * branch.json ← 分支子会话（parentId=root，原样继承 root 内容）
 * branch/
 * branch2.json ← 再分支（深层嵌套）
 *
 * AI 隔离（ADR-25 L5）：目录根由注入的解析器按 owner 会话**所属 AI** 解析
 * （`getRoot(ownerSessionId)`），不再所有 AI 共用 AI1 目录——两个 AI 用同一 ownerSessionId
 * 时内部会话互不可见。兼容读老目录：迁移前内部会话都写在 `sessions/U{uid}/AI1/` 下，
 * 若某 owner 的主目录尚未建立而老目录存在，则读与写一律沿用老目录（见 `aiDir`），
 * 避免「新建主目录后老内部会话消失」的分裂态。
 *
 * 索引：pathIndex Map<id, relativePath>，由递归扫描建立并在 create/delete 时同步维护；
 * 为保证与磁盘一致（session_select 等外部可能直接改文件），list() 每次调用全量重建索引，
 * get() 仅索引未命中时补扫一次。写链：同一会话的读-改-写整体串行化（per-key promise 链，
 * 防并发覆盖损坏与并发读旧丢失更新）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { renameFileWithRetry } from '../utils/atomic-write'
import { DEFAULT_AI_ID, type InternalMessage, type InternalSession, type InternalSessionSummary } from '@shared/types'
import { validateSessionId } from '../api/session-store'

export const DEFAULT_INTERNAL_SESSION_TITLE = '新内部会话'

/** 会话存储的最小结构（只取本模块需要的两项，避免 services 层依赖 api 层的具体类） */
export interface SessionScopeSource {
  getDir: () => string
  get: (id: string) => { aiId?: number } | null
}

/**
 * 构造内部会话的 AI 作用域目录解析器（ADR-25 L5）。
 *
 * 为什么存在：内部会话根此前恒为 `sessions/U{uid}/AI1/`（所有 AI 共用），两个 AI 用同一
 * ownerSessionId 时共享内部会话。改为按 owner 会话**所属 AI** 解析，组合根与
 * `createInternalSessionLayer` 的非共享回退都复用本函数，避免两处各写一份。
 *
 * 口径：
 * - `getRoot(owner)` → 该 AI 的会话根 `…/AI{aiId}`（AI1 直接用 sessionStore 当前目录，零换算）；
 * - `getLegacyRoot(owner)` → AI1 的会话根（兼容读老目录）；owner 属 AI1 时返回 null（无兜底需求）。
 * - 会话根 = 当前目录（`…/sessions/U{uid}/AI1`）去掉尾部 `AI{n}` 段；未登录态
 *   `switchUser(dataPaths.sessions)` 的目录尾部无 AI 段 → 原样返回（该态无内部会话写入）。
 *
 * 已知边界：`aiId` 取自 SessionStore 内存缓存；会话数超上限被逐出（>50）的 owner 会回落 AI1
 * ——极端情形，且只影响该 owner 的落位，不影响已有数据可见性（老目录兜底仍在）。
 */
export function createAiScopedSessionRoots(src: SessionScopeSource): {
  getRoot: (ownerSessionId: string) => string
  getLegacyRoot: (ownerSessionId: string) => string | null
} {
  const sessionsRoot = (): string => {
    const dir = src.getDir().replace(/[\\/]+$/, '')
    return /[\\/]AI\d+$/.test(dir) ? dirname(dir) : dir
  }
  const aiIdOf = (ownerSessionId: string): number => {
    const aiId = src.get(ownerSessionId)?.aiId
    return typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID
  }
  return {
    getRoot: (ownerSessionId) => {
      const aiId = aiIdOf(ownerSessionId)
      return aiId === DEFAULT_AI_ID ? src.getDir() : join(sessionsRoot(), `AI${aiId}`)
    },
    getLegacyRoot: (ownerSessionId) =>
      aiIdOf(ownerSessionId) === DEFAULT_AI_ID ? null : join(sessionsRoot(), `AI${DEFAULT_AI_ID}`)
  }
}

/**
 * 一次性清空**旧自主房间树**（0.53.18）。
 *
 * 为什么需要：0.53.18 起自主模式不再自持 room-autonomous-* 会话树，改为继承
 * 「开启自主的那个会话」的树。旧树若留着，只会是一堆永远无人再读的纸——用户裁决「直接清空」。
 *
 * 口径：
 * - 只删每个 room-autonomous* owner 下的 ai/ 内部会话树；owner 目录里的会话记录
 *   （消息 / RAW）保留——那不属于「树」，删了等于丢历史。
 * - 扫描 sessions/ 下所有用户的每个 AI 目录（U{uid}/AI{aiId}）：房间可能在不同 AI 下跑过，
 *   只清当前用户 / 当前 AI 不够。
 * - 返回被删的树路径（供启动日志与单测断言）；没有旧树时返回空数组。
 */
export function purgeLegacyAutonomousTrees(sessionDir: string): string[] {
  const removed: string[] = []
  const dir = sessionDir.replace(/[\\/]+$/, '')
  const marker = /[\\/]sessions(?=$|[\\/])/i.exec(dir)
  const base = marker ? dir.slice(0, marker.index + marker[0].length) : dir
  if (!existsSync(base)) return removed
  const listDirs = (p: string): string[] => {
    try {
      return readdirSync(p, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    } catch {
      return []
    }
  }
  for (const user of listDirs(base)) {
    if (!/^U\d+$/.test(user)) continue
    const userDir = join(base, user)
    for (const ai of listDirs(userDir)) {
      if (!/^AI\d+$/.test(ai)) continue
      const aiDir = join(userDir, ai)
      for (const owner of listDirs(aiDir)) {
        if (!owner.startsWith('room-autonomous')) continue
        const tree = join(aiDir, owner, 'ai')
        if (!existsSync(tree)) continue
        rmSync(tree, { recursive: true, force: true })
        removed.push(tree)
      }
    }
  }
  return removed
}

export class InternalSessionStore {
  private writeChains: Map<string, Promise<void>> = new Map()
  /** id → 相对 aiDir 的物理路径；冷启动扫描建立，运行时由 create/delete 同步维护 */
  private pathIndex: Map<string, string> = new Map()
  /**
   * 每个用户会话「当前承接中的内部会话」指针（session_select 工具写入）。
   * ownerSessionId → internalId。为什么存在：AI 经 session_select 显式选择承接会话后，
   * 需要跨请求/跨轮次持久（连接级 activeInternalContext 只在单轮闭包内有效），
   * 下一轮 resolveStreamSessionContext 据此直接装载所选会话；落盘到 aiDir/.active
   * （无 .json 扩展名 → scanAndIndex 不纳入会话索引），delete/deleteByOwner 时同步清理。
   */
  private activeByOwner: Map<string, string> = new Map()
  /**
   * REWIND 回退竞态黑名单：ownerSessionId → 已被回退删除的消息 id。
   * 为什么存在：两写链路里 AI 层维护队列延迟 500ms 执行（enqueueInternalSessionJob
   * 在流结束时入队、runInternalSessionMaintenance 到点才 append），用户在 AI 回复刚完成
   * 时立刻 REWIND，排队中的 job 仍携带着「被截断的未来消息」——若不加拦截，撤回后这些
   * 消息会被 append 回 AI 层会话，形成「撤回后消息又冒出来」的污染。
   * 语义：每轮回退把本次删除的消息 id 并入集合（不替换——多轮回退时早轮仍在排队的 job
   * 也必须被过滤）；前端消息 id 为 {prefix}_{ts}_{seq} 全局唯一，重复 id 不会再现，故
   * 集合随时间增长无实际冲突；appendMessages mutate 前按该集合过滤即完成拦截。
   */
  private rewindDeletedIds: Map<string, Set<string>> = new Map()

  /**
   * @param getRoot 解析某 owner 会话所属 AI 的会话根（`sessions/U{uid}/AI{aiId}`）；
   *   存储在其下追加 `{ownerSessionId}/ai`。参数化是 AI 隔离的关键（ADR-25 L5）。
   * @param getLegacyRoot 兼容读老目录：迁移前所有内部会话都在 AI1 下，返回 AI1 的会话根；
   *   返回 null/不传表示无兜底（测试与新建库）。
   */
  constructor(
    private getRoot: (ownerSessionId: string) => string,
    private getLegacyRoot?: (ownerSessionId: string) => string | null
  ) {}

  private aiDir(ownerSessionId: string): string {
    validateSessionId(ownerSessionId)
    const primary = join(this.getRoot(ownerSessionId), ownerSessionId, 'ai')
    const legacyRoot = this.getLegacyRoot?.(ownerSessionId)
    if (!legacyRoot) return primary
    const legacy = join(legacyRoot, ownerSessionId, 'ai')
    // 兼容读老目录：主目录尚未建立、老目录已存在 → 该 owner 读与写一律沿用老目录。
    // 为什么读写同址：若只读老、写新，第一次写入会新建主目录，此后老目录数据立刻「消失」。
    // 新 owner（无老目录）直接落主目录，AI 隔离对增量数据即刻生效。
    if (legacy !== primary && !existsSync(primary) && existsSync(legacy)) return legacy
    return primary
  }

  private key(ownerSessionId: string, internalId: string): string {
    return `${ownerSessionId}/${internalId}`
  }

  /**
   * 会话文件绝对路径（正斜杠分隔）。
   * 为什么存在：锚点注入时需给出可被 read_md/Read 直接使用的绝对路径，
   * 供 AI 回翻原始会话文件；其余调用方也可复用（如测试断言）。
   */
  absFilePath(ownerSessionId: string, filePath: string): string {
    return join(this.aiDir(ownerSessionId), filePath).replace(/\\/g, '/')
  }

  private ensureAiDir(ownerSessionId: string): string {
    const dir = this.aiDir(ownerSessionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** totalChars = messages 全部 content 字符数 + summary 字符数（写入/压缩后重算） */
  private recomputeTotalChars(s: InternalSession): void {
    let chars = s.summary.length
    for (const m of s.messages) {
      chars += m.content.length
    }
    s.totalChars = chars
  }

  /**
   * 递归扫描 aiDir 下全部 .json 会话文件，建立 pathIndex，返回摘要列表（按 updatedAt 降序）。
   * 为什么存在：NNG 嵌套后目录深度不固定，扁平 readdir 无法覆盖子文件夹；递归扫描建立
   * pathIndex 后，get/update/delete 可 O(1) 定位物理路径。
   * 调用时机：list() 每次调用全量重建（外部可能直接改文件，索引必须与磁盘一致；重建成本
   * 与目录深度相关，会话数稳定时可控）；get() 索引未命中时补扫一次（懒加载兜底）。
   */
  private scanAndIndex(ownerSessionId: string): InternalSessionSummary[] {
    const dir = this.aiDir(ownerSessionId)
    if (!existsSync(dir)) return []

    // 清掉该归属的旧索引（重建）
    const prefix = `${ownerSessionId}/`
    for (const k of this.pathIndex.keys()) {
      if (k.startsWith(prefix)) this.pathIndex.delete(k)
    }

    const out: InternalSessionSummary[] = []

    const recurse = (absDir: string, relPrefix: string) => {
      if (!existsSync(absDir)) return
      for (const entry of readdirSync(absDir, { withFileTypes: true })) {
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          recurse(join(absDir, entry.name), relPath)
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          try {
            const raw = readFileSync(join(absDir, entry.name), 'utf-8')
            const s = JSON.parse(raw) as InternalSession
            if (typeof s.id !== 'string' || s.ownerSessionId !== ownerSessionId) continue
            // 防御存量字段缺失
            s.messages ??= []
            s.cacheLocations ??= []
            s.summary ??= ''
            s.title ??= s.id
            this.pathIndex.set(`${ownerSessionId}/${s.id}`, relPath)
            out.push({
              id: s.id,
              ownerSessionId: s.ownerSessionId,
              title: s.title,
              summary: s.summary,
              parentId: s.parentId,
              gen: s.gen,
              isNewTopic: s.isNewTopic,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              messageCount: s.messages?.length ?? 0,
              totalChars: s.totalChars ?? 0,
              cacheLocations: s.cacheLocations ?? [],
              timeBranchId: s.timeBranchId,
              isTimeFork: s.isTimeFork,
              timeSourceId: s.timeSourceId,
              filePath: relPath
            })
          } catch (err) {
            console.error(`Failed to load internal session ${relPath}:`, err)
          }
        }
      }
    }

    recurse(dir, '')
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * 计算新会话的 NNG 相对路径。
   * 规则：有 timeSourceId（时间分叉）或 parentId（继承）→ 放入锚点会话的同名文件夹内；
   * 时间关系优先于继承关系（副本从源创建，物理上在源的文件夹内）；无锚点 → 根目录。
   * 锚点未索引时触发一次 scanAndIndex 重建。
   */
  private computeFilePath(
    ownerSessionId: string,
    id: string,
    parentId?: string,
    timeSourceId?: string
  ): string {
    const anchorId = timeSourceId || parentId
    if (!anchorId) return `${id}.json`

    const idxKey = `${ownerSessionId}/${anchorId}`
    let anchorPath = this.pathIndex.get(idxKey)

    if (!anchorPath) {
      this.scanAndIndex(ownerSessionId)
      anchorPath = this.pathIndex.get(idxKey)
    }

    if (anchorPath) {
      const anchorDir = anchorPath.replace(/\.json$/, '')
      return `${anchorDir}/${id}.json`
    }

    return `${id}.json`
  }

  /** 清理删除文件后遗留的空文件夹（向上递归到 aiDir 为止） */
  private cleanupEmptyDirs(ownerSessionId: string, relPath: string): void {
    const aiDir = this.aiDir(ownerSessionId)
    let dir = dirname(join(aiDir, relPath))

    while (dir !== aiDir && dir.startsWith(aiDir)) {
      try {
        if (!existsSync(dir)) break
        const entries = readdirSync(dir)
        if (entries.length === 0) {
          rmSync(dir, { recursive: true, force: true })
          dir = dirname(dir)
        } else {
          break
        }
      } catch {
        break
      }
    }
  }

  /** 列出某用户会话名下全部内部会话（按 updatedAt 降序，最新在上；不含消息正文） */
  list(ownerSessionId: string): InternalSessionSummary[] {
    return this.scanAndIndex(ownerSessionId)
  }

  // ===== 承接指针（active）：session_select 工具显式选择结果的持久化 =====
  // 语义：AI 经「会话选择」工具把某个内部会话定为当前承接会话后，本轮结束后该选择
  // 必须对下一轮生效（连接级状态在请求边界丢失）。.active 文件无 .json 扩展名，
  // scanAndIndex 只认 .json，天然不会被当作会话索引项；读写用同步原子写防半截文件。
  private activePath(ownerSessionId: string): string {
    return join(this.aiDir(ownerSessionId), '.active')
  }

  /** 读取当前承接会话 internalId；无选择记录返回 null（读文件一次后走内存缓存） */
  getActive(ownerSessionId: string): string | null {
    validateSessionId(ownerSessionId)
    if (this.activeByOwner.has(ownerSessionId)) {
      // 缓存值可能为 ''（曾确认无指针）——统一归一化返回 null，避免调用方收到假指针
      const v = this.activeByOwner.get(ownerSessionId)
      return v ? v : null
    }
    const p = this.activePath(ownerSessionId)
    let id: string | null = null
    if (existsSync(p)) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf-8')) as { internalId?: unknown }
        id = typeof raw.internalId === 'string' ? raw.internalId : null
      } catch {
        // 损坏的 .active 视为无选择，下方按 null 缓存并继续
        id = null
      }
    }
    this.activeByOwner.set(ownerSessionId, id ?? '')
    return id
  }

  /** 设置当前承接会话（须为真实存在的内部会话，否则拒绝并返回 false） */
  setActive(ownerSessionId: string, internalId: string): boolean {
    validateSessionId(internalId)
    const existing = this.get(ownerSessionId, internalId)
    if (!existing) return false // 会话不存在 → 不落无效指针
    this.activeByOwner.set(ownerSessionId, internalId)
    this.ensureAiDir(ownerSessionId)
    this.atomicWriteSync(this.activePath(ownerSessionId), JSON.stringify({ internalId, updatedAt: Date.now() }))
    return true
  }

  /** 清除当前承接指针（释放后下一轮恢复自动路由） */
  clearActive(ownerSessionId: string): void {
    validateSessionId(ownerSessionId)
    this.activeByOwner.delete(ownerSessionId)
    const p = this.activePath(ownerSessionId)
    if (existsSync(p)) {
      try {
        rmSync(p, { force: true })
      } catch (err) {
        console.error(`Failed to clear active pointer of ${ownerSessionId}:`, err)
      }
    }
  }

  get(ownerSessionId: string, internalId: string): InternalSession | null {
    validateSessionId(internalId)
    const idxKey = `${ownerSessionId}/${internalId}`
    let relPath = this.pathIndex.get(idxKey)

    if (!relPath) {
      // 未命中索引：冷启动或索引过期，执行一次扫描重建
      this.scanAndIndex(ownerSessionId)
      relPath = this.pathIndex.get(idxKey)
    }

    if (!relPath) {
      // 扫描后仍无：回退到扁平根目录（兼容存量）
      relPath = `${internalId}.json`
    }

    const absPath = join(this.aiDir(ownerSessionId), relPath)
    if (!existsSync(absPath)) return null

    try {
      const raw = readFileSync(absPath, 'utf-8')
      const s = JSON.parse(raw) as InternalSession
      if (typeof s.id !== 'string' || s.ownerSessionId !== ownerSessionId) return null
      s.messages ??= []
      s.cacheLocations ??= []
      s.summary ??= ''
      s.title ??= s.id
      // 同步文件实际路径到对象（防手动移动后不一致；存量缺失时回补）
      if (s.filePath !== relPath) s.filePath = relPath
      return s
    } catch (err) {
      console.error(`Failed to load internal session ${internalId}:`, err)
      return null
    }
  }

  /**
   * 新建内部会话。content 可选：提供则生成首条 user 消息（含 createdAt）。
   * messages 可选：整体复制既有消息（时间分叉副本用；复制后在本方法内深拷一份，
   * 两个会话的消息对象互不共享引用，后续各自 append/update 互不影响）。
   * 继承参数可选：parentId/gen 由超限继承链路传入（父会话不动，子会话承接继承摘要）。
   * createdAt 在本步固定，之后任何操作不触碰。
   * NNG 物理路径由 parentId/timeSourceId 自动推导（放入锚点同名文件夹内）。
   */
  create(
    ownerSessionId: string,
    opts: { title: string; content?: string; messages?: InternalMessage[]; parentId?: string; gen?: number; summary?: string; cacheLocations?: string[]; isTimeFork?: boolean; timeSourceId?: string; isNewTopic?: boolean }
  ): InternalSession {
    const now = Date.now()
    const id = `is_${now}_${Math.random().toString(36).slice(2, 8)}`
    const messages: InternalMessage[] = (opts.messages ?? []).map((m) => ({
      ...m,
      toolSummaries: m.toolSummaries ? [...m.toolSummaries] : undefined
    }))
    if (typeof opts.content === 'string' && opts.content.trim().length > 0) {
      messages.push({
        id: `m_${now}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'user',
        content: opts.content,
        createdAt: now
      })
    }

    const relPath = this.computeFilePath(ownerSessionId, id, opts.parentId, opts.timeSourceId)

    const s: InternalSession = {
      id,
      ownerSessionId,
      title: opts.title || DEFAULT_INTERNAL_SESSION_TITLE,
      summary: opts.summary ?? '',
      createdAt: now,
      updatedAt: now,
      messages,
      totalChars: 0,
      cacheLocations: opts.cacheLocations ?? [],
      filePath: relPath,
      ...(opts.parentId ? { parentId: opts.parentId, gen: opts.gen ?? 1 } : {}),
      ...(opts.isTimeFork ? { isTimeFork: true, ...(opts.timeSourceId ? { timeSourceId: opts.timeSourceId } : {}) } : {}),
      // AI 判定「话题需要新开」的新会话（逆生树虚线边）：与继承子同用 parentId 但语义对立
      ...(opts.isNewTopic ? { isNewTopic: true } : {})
    }

    this.recomputeTotalChars(s)
    this.ensureAiDir(ownerSessionId)

    const absPath = join(this.aiDir(ownerSessionId), relPath)
    const parentDir = dirname(absPath)
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true })
    }

    // create 必须同步落盘：后续 append/update 的读取-改-写以磁盘为准
    this.atomicWriteSync(absPath, JSON.stringify(s))
    this.pathIndex.set(`${ownerSessionId}/${id}`, relPath)
    return s
  }

  /** 追加消息（展示层两写的上下文层；调用方负责把需要的字段编成 InternalMessage） */
  async appendMessages(ownerSessionId: string, internalId: string, messages: InternalMessage[]): Promise<void> {
    if (messages.length === 0) return
    // REWIND 竞态防护：回退后延迟维护队列（500ms 单飞）仍可能携带被截断的未来消息到达，
    // 黑名单 id 一律过滤，杜绝「撤回后消息又冒出来」（黑名单由 truncateMessagesByOwner 归并）。
    const blocked = this.rewindDeletedIds.get(ownerSessionId)
    const pending =
      blocked && blocked.size > 0
        ? messages.filter((m) => m.id && !blocked.has(m.id))
        : messages
    if (pending.length === 0) return
    await this.mutate(ownerSessionId, internalId, (s) => {
      for (const m of pending) {
        const msg: InternalMessage = {
          ...m,
          id: m.id || `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          createdAt: m.createdAt ?? Date.now(),
          content: m.content ?? ''
        }
        s.messages.push(msg)
      }
    })
  }

  /** 追加单条消息（便捷形态，同步返回——内部也走写链） */
  appendMessage(
    ownerSessionId: string,
    internalId: string,
    message: InternalMessage
  ): Promise<void> {
    return this.appendMessages(ownerSessionId, internalId, [message])
  }

  /**
   * 用户直接编辑（title/summary/messages/cacheLocations/timeBranchId 整体替换或单条增删改）。
   * 传 undefined 表示不动该字段；createdAt 恒写不碰。无锁：最后写回者胜。
   */
  async update(
    ownerSessionId: string,
    internalId: string,
    patch: Partial<Pick<InternalSession, 'title' | 'summary' | 'messages' | 'cacheLocations' | 'timeBranchId'>>
  ): Promise<void> {
    await this.mutate(ownerSessionId, internalId, (s) => {
      if (patch.title !== undefined) s.title = patch.title
      if (patch.summary !== undefined) s.summary = patch.summary
      if (patch.messages !== undefined) {
        for (const m of patch.messages) {
          if (!m.id) m.id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          if (!m.createdAt) m.createdAt = Date.now()
        }
        s.messages = patch.messages
      }
      if (patch.cacheLocations !== undefined) s.cacheLocations = patch.cacheLocations
      if (patch.timeBranchId !== undefined) s.timeBranchId = patch.timeBranchId
    })
  }

  /** 并入记忆缓存位置（去重：相同路径覆盖式更新，updatedAt 刷新由 mutate 统一做） */
  async addCacheLocation(ownerSessionId: string, internalId: string, location: string): Promise<void> {
    if (!location) return
    await this.mutate(ownerSessionId, internalId, (s) => {
      const idx = s.cacheLocations.indexOf(location)
      if (idx >= 0) {
        s.cacheLocations[idx] = location
      } else {
        s.cacheLocations.push(location)
      }
    })
  }

  /**
   * 按消息 id 从某用户会话名下全部内部会话中剔除消息（用户撤回/删除消息时同步）。
   */
  async removeMessagesByOwner(
    ownerSessionId: string,
    messageIds: readonly string[]
  ): Promise<number> {
    if (messageIds.length === 0) return 0
    const idSet = new Set(messageIds)
    const summaries = this.list(ownerSessionId)
    let removed = 0
    for (const s of summaries) {
      const full = this.get(ownerSessionId, s.id)
      if (!full) continue
      const before = full.messages.length
      if (before === 0) continue
      const kept = full.messages.filter((m) => !idSet.has(m.id))
      if (kept.length === before) continue
      removed += before - kept.length
      await this.update(ownerSessionId, s.id, { messages: kept })
    }
    return removed
  }

  /**
   * REWIND 回退（AI 上下文层落点）：把该用户会话名下内部会话截断/清理到目标消息（含）为止。
   * 语义（两层同步：用户展示层由 SessionStore.saveMessages 截断，本方法负责 AI 层）：
   * - 含目标消息的会话：messages 截断到目标消息（含），summary 置空——旧摘要描述的是
   *   完整历史，截断后必然失真，由后续维护队列按新窗口重新生成，避免过时摘要注入；
   * - 不含目标消息、但含「被撤未来消息」的会话：整体删除（该会话在回退时间点之后才产生，
   *   回退后从未存在过；active 指针指向它时一并清除）；
   * - 无关会话（不含目标也不含被删消息）：原样保留（历史冻结会话等不受影响）。
   * 竞态防护：把本次被删除的 futureMessageIds 并入 rewindDeletedIds 黑名单，
   * appendMessages 排队任务到达时过滤（见 appendMessages 注释）。
   * 返回 { truncated, deletedSessions } 供调用方记录/测试断言。
   */
  async truncateMessagesByOwner(
    ownerSessionId: string,
    targetMessageId: string,
    futureMessageIds: readonly string[]
  ): Promise<{ truncated: number; deletedSessions: number }> {
    let blocked = this.rewindDeletedIds.get(ownerSessionId)
    if (!blocked) {
      blocked = new Set()
      this.rewindDeletedIds.set(ownerSessionId, blocked)
    }
    for (const id of futureMessageIds) blocked.add(id)

    const futureSet = new Set(futureMessageIds)
    const summaries = this.list(ownerSessionId)
    let truncated = 0
    let deletedSessions = 0

    for (const s of summaries) {
      const full = this.get(ownerSessionId, s.id)
      if (!full) continue
      const msgs = full.messages
      const targetIdx = msgs.findIndex((m) => m.id === targetMessageId)
      const hasFuture = futureSet.size > 0 && msgs.some((m) => futureSet.has(m.id))

      if (targetIdx >= 0) {
        // 目标消息就在本会话：截断到目标（含），清空失效摘要
        if (targetIdx + 1 < msgs.length) {
          await this.update(ownerSessionId, s.id, {
            messages: msgs.slice(0, targetIdx + 1),
            summary: ''
          })
          truncated += msgs.length - (targetIdx + 1)
        }
        // 目标已是最后一条：无需改动（摘要基于目标之前的历史，仍有效）
      } else if (hasFuture) {
        // 不含目标、只含未来消息：回退时间点之后才产生的会话 → 整体删除
        this.delete(ownerSessionId, s.id)
        deletedSessions++
      }
    }
    return { truncated, deletedSessions }
  }

  /** 删除单个内部会话（文件即删；用户点删除无确认）。清理空父文件夹。 */
  delete(ownerSessionId: string, internalId: string): void {
    validateSessionId(internalId)
    // 若当前承接指针正指向被删会话 → 一并清除（避免后续轮次装载已删除会话）
    if (this.getActive(ownerSessionId) === internalId) {
      this.clearActive(ownerSessionId)
    }
    const idxKey = `${ownerSessionId}/${internalId}`
    const relPath = this.pathIndex.get(idxKey) || `${internalId}.json`
    const absPath = join(this.aiDir(ownerSessionId), relPath)

    this.writeChains.delete(this.key(ownerSessionId, internalId))
    this.pathIndex.delete(idxKey)

    if (existsSync(absPath)) {
      try {
        rmSync(absPath, { force: true })
      } catch (err) {
        console.error(`Failed to delete internal session ${internalId}:`, err)
      }
    }

    this.cleanupEmptyDirs(ownerSessionId, relPath)
  }

  /**
   * 级联删除某用户会话名下全部内部会话（删整个 ai/ 目录；User 会话删除时调用）。
   * 0.53.17：不再有自主域例外——`room-autonomous-*` 与普通会话一样直接清空。
   * 为什么撤销（用户 2026-10-23）：「干净没啥用还烦死了」——保护只让自主数据越积越多，
   * 自动清理和用户显式删除都应该按同一语义删掉，不保留第二套判据。
   * @returns 是否真的执行了删除（目录不存在也算完成）
   */
  deleteByOwner(ownerSessionId: string): boolean {
    validateSessionId(ownerSessionId)
    this.clearActive(ownerSessionId)
    for (const k of this.writeChains.keys()) {
      if (k.startsWith(`${ownerSessionId}/`)) this.writeChains.delete(k)
    }
    const prefix = `${ownerSessionId}/`
    for (const k of this.pathIndex.keys()) {
      if (k.startsWith(prefix)) this.pathIndex.delete(k)
    }
    const dir = this.aiDir(ownerSessionId)
    if (existsSync(dir)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        console.error(`Failed to delete internal sessions of ${ownerSessionId}:`, err)
      }
    }
    return true
  }

  /** 等待全部在飞写盘完成（before-quit 前调用；写盘失败=动作未执行，不阻塞退出） */
  async flush(): Promise<void> {
    const chains = Array.from(this.writeChains.values())
    await Promise.allSettled(chains)
    this.writeChains.clear()
  }

  /** 原子读改写：同一会话的读-改-写整体进写链，保证并发 append/update 不丢更新 */
  private async mutate(
    ownerSessionId: string,
    internalId: string,
    fn: (s: InternalSession) => void
  ): Promise<void> {
    const k = this.key(ownerSessionId, internalId)
    // 读（get）→ 改（fn）→ 写盘必须整段串行：若只串行写盘，两个并发 append 会各自
    // 读到旧版本、后写覆盖先写（真 lost update）；前一个 mutate 完成后一个才读盘执行。
    const prev = this.writeChains.get(k) ?? Promise.resolve()
    const next = prev.then(async () => {
      const existing = this.get(ownerSessionId, internalId)
      if (!existing) return // 会话不存在 → 动作未执行
      // 在 fn 修改前缓存路径：get() 可能触发 scanAndIndex 重建 pathIndex，
      // existing.filePath 是对象内字段（get() 时已从磁盘同步），不受后续重建影响。
      const relPath = existing.filePath || this.pathIndex.get(k) || `${internalId}.json`
      fn(existing)
      existing.updatedAt = Date.now()
      this.recomputeTotalChars(existing)
      const path = join(this.aiDir(ownerSessionId), relPath)
      await this.atomicWrite(path, JSON.stringify(existing))
    })
    this.writeChains.set(k, next)
    void next.finally(() => {
      if (this.writeChains.get(k) === next) this.writeChains.delete(k)
    })
    await next
  }

  /** 原子写（同步；create 用，确保返回时文件已在盘上） */
  private atomicWriteSync(path: string, data: string): void {
    const tmp = path + '.tmp'
    try {
      writeFileSync(tmp, data, 'utf-8')
      // Windows 文件锁容错：目标被占用时 EPERM，交由公共工具重试或删除后重试
      renameFileWithRetry(tmp, path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // 目标会话已被级联删除：本次写盘指向不存在的对象 → 动作自然作废，静默终止
        return
      }
      throw err
    }
  }

  /** 原子写：先 .tmp 再 rename（进程被强杀最多留半截 tmp，正文件完整） */
  private async atomicWrite(path: string, data: string): Promise<void> {
    const tmp = path + '.tmp'
    try {
      await writeFile(tmp, data, 'utf-8')
      renameFileWithRetry(tmp, path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return
      }
      throw err
    }
  }
}
