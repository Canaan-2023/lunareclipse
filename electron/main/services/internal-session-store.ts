/**
 * 内部会话存储（v11 双层会话：AI 看的会话池；v0.24 NNG 逆生树物理结构）。
 *
 * 物理布局（NNG 嵌套：文件 + 同名文件夹）：
 * sessions/{ownerId}/ai/
 * root.json ← 根会话（无 parentId）
 * root/ ← root 的同名文件夹（NNG：文件 + 同名文件夹）
 * branch.json ← 分支子会话（parentId=root，原样继承 root 内容）
 * branch/
 * branch2.json ← 再分支（深层嵌套）
 *
 * 索引：pathIndex Map<id, relativePath>，冷启动递归扫描一次建立，后续所有 get/list/update/delete
 * 均 O(1) 定位磁盘位置；移动/分叉/删除时由 store 层同步维护。
 * 写链：同一文件写盘串行化（per-key promise 链，防并发覆盖损坏）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import type { InternalMessage, InternalSession, InternalSessionSummary } from '@shared/types'
import { validateSessionId } from '../api/session-store'

export const DEFAULT_INTERNAL_SESSION_TITLE = '新内部会话'

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

  constructor(private getDir: () => string) {}

  private aiDir(ownerSessionId: string): string {
    validateSessionId(ownerSessionId)
    return join(this.getDir(), ownerSessionId, 'ai')
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
   * 为什么存在：NNG 嵌套后目录深度不固定，扁平 readdir 无法覆盖子文件夹；冷启动扫描一次、
   * 后续 O(1) 索引，避免每次操作递归遍历。
   * 调用时机：list() 每次调用（重建索引保证与磁盘一致）；get() 索引未命中时（懒加载）。
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
    await this.mutate(ownerSessionId, internalId, (s) => {
      for (const m of messages) {
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

  /** 级联删除某用户会话名下全部内部会话（删整个 ai/ 目录；User 会话删除时调用） */
  deleteByOwner(ownerSessionId: string): void {
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
  }

  /** 等待全部在飞写盘完成（before-quit 前调用；写盘失败=动作未执行，不阻塞退出） */
  async flush(): Promise<void> {
    const chains = Array.from(this.writeChains.values())
    await Promise.allSettled(chains)
    this.writeChains.clear()
  }

  /** 原子读改写：改完整对象写回（同一文件写盘串行化） */
  private async mutate(
    ownerSessionId: string,
    internalId: string,
    fn: (s: InternalSession) => void
  ): Promise<void> {
    const existing = this.get(ownerSessionId, internalId)
    if (!existing) return // 会话不存在 → 动作未执行
    // 在 fn 修改前缓存路径：get() 可能触发 scanAndIndex 重建 pathIndex，
    // 若重建发生在 fn 与写盘之间，pathIndex 可能已被替换，导致写到错误位置。
    // existing.filePath 是对象内字段（get() 时已从磁盘或索引同步），不受后续重建影响。
    const relPath = existing.filePath || this.pathIndex.get(this.key(ownerSessionId, internalId)) || `${internalId}.json`
    fn(existing)
    existing.updatedAt = Date.now()
    this.recomputeTotalChars(existing)
    const k = this.key(ownerSessionId, internalId)
    const path = join(this.aiDir(ownerSessionId), relPath)
    const prev = this.writeChains.get(k) ?? Promise.resolve()
    const next = prev.then(() => this.atomicWrite(path, JSON.stringify(existing)))
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
      renameSync(tmp, path)
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
      renameSync(tmp, path)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return
      }
      throw err
    }
  }
}
