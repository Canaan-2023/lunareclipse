/**
 * 为什么存在：多开实例需要一个跨实例公开公告栏承载图文内容，广播须经 LanService 直连扩散而不经过主系统。
 * 作用：发布板业务门面：聚合板块/评论两个存储，封装发文、点赞、评论、广播与事件派发。
 */

import { randomUUID } from 'crypto'
import type { LanEnvelope } from '../lan/lan-types'
import type { LanSendResult } from '../lan/lan-service'
import { PublishBoardStore } from './publish-board-store'
import { PublishCommentStore } from './publish-comment-store'
import type {
  PublishArticle,
  PublishBoard,
  PublishBoardPayload,
  PublishComment,
  PublishCommentPayload,
  PublishEvent,
  PublishListItem,
  PublishPayload,
  PublishSyncWantPayload,
  PublishTombstonePayload,
} from './publish-board-types'

/**
 * 发布板（L3）业务门面：板块 + 发布条目 + 评论，基于 L0 局域网底座。
 * - 任何账号（主/分）均可发布条目/评论，经局域网信封广播（publish-board.* 前缀）
 * - 新终端上线后从在线成员拉取全量发布索引（sync-want/have 思路）
 * - 离线发布进 outbox，上线后沿局域网补投广播
 * - 发布板存储：publish-board/boards.json + articles/{boardId}/{articleId}.json
 * - 评论存储：publish-board/comments/{articleId}.json（上限 500 条）
 * - 前端事件：PublishEvent 经 webContents 推送
 */
export interface PublishBoardServiceDeps {
  /** 数据根目录 */
  root: string
  /** 当前登录用户 */
  getIdentity: () => { uid: number; 用户名: string } | null
  /** 经 L0 直连发送信封（广播：逐在线成员单播） */
  sendLan: (uid: number, type: string, payload: unknown) => LanSendResult
  /** 对端在线态 */
  listPeers: () => import('../lan/lan-types').LanPeer[]
  /** 事件推送 */
  emit: (event: PublishEvent) => void
  /** AI 代理配置（公示板级开关：true 时 AI 自动参与公示板交流） */
  aiConfig?: { isBoardEnabled(): boolean }
  /** AI 身份解析：按 aiId 取本机未停用 AI（null=不存在/停用）；AI 发帖/评论时据此取 AI 名 */
  getAiProfile?: (aiId: number) => { uid: number; aiId: number; name: string } | null
  /** 本机全部可参与公示板的 AI（未停用；公示板自动回复的候选发言名单） */
  listAiProfiles?: () => Array<{ uid: number; aiId: number; name: string }>
  /**
   * AI 参与生成器：收到真人帖子/评论时逐个调用本机 AI，决定是否在公示板发言。
   * 返回评论正文（以该 AI 身份发出）或 null（不参与）。
   */
  aiReply?: (
    ai: { uid: number; aiId: number; name: string },
    trigger: { kind: 'article' | 'comment'; article?: PublishArticle; comment?: PublishComment },
    history: Array<PublishArticle | PublishComment>
  ) => Promise<string | null>
}

/** 单板块文章数上限（超出拒绝新发布，防无界增长） */
const MAX_ARTICLES_PER_BOARD = 500
/** 字段长度上限（防超长正文占满存储与 AI 上下文） */
const MAX_TITLE_LEN = 200
const MAX_SUMMARY_LEN = 2000
const MAX_BODY_LEN = 20000
const MAX_COMMENT_LEN = 2000
/** 列表/评论默认返回上限（防全量注入）与硬上限 */
const DEFAULT_LIST_LIMIT = 200
const DEFAULT_COMMENT_LIMIT = 200
const MAX_LIMIT = 500

/** 归一化分页参数：非法/缺省回落默认值，并夹到硬上限 */
function clampLimit(v: number | undefined, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return def
  return Math.min(Math.floor(v), MAX_LIMIT)
}

/** 搜索结果片段：正文命中处上下文（±60 字符），未命中正文时回落摘要截断 */
function articleSnippet(a: PublishArticle, kw: string): string {
  const idx = a.body.toLowerCase().indexOf(kw)
  if (idx < 0) return a.summary.slice(0, 160)
  const start = Math.max(0, idx - 60)
  const end = Math.min(a.body.length, idx + kw.length + 60)
  return `${start > 0 ? '…' : ''}${a.body.slice(start, end)}${end < a.body.length ? '…' : ''}`
}

export class PublishBoardService {
  readonly store: PublishBoardStore
  readonly comments: PublishCommentStore

  constructor(private readonly deps: PublishBoardServiceDeps) {
    this.store = new PublishBoardStore(deps.root)
    this.comments = new PublishCommentStore(deps.root)
  }

  // ===== 局域网信封入口（L0 onMessage 转发） =====

  handleLanEnvelope(env: LanEnvelope): void {
    switch (env.type) {
      case 'publish-board.publish':
        this.handlePublish(env)
        break
      case 'publish-board.tombstone':
        this.handleTombstone(env)
        break
      case 'publish-board.comment':
        this.handleComment(env)
        break
      case 'publish-board.syncWant':
        this.handleSyncWant(env)
        break
      case 'publish-board.board':
        this.handleBoardChange(env)
        break
      default:
        break
    }
  }

  private handleBoardChange(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as PublishBoardPayload | undefined
    if (payload?.deleted && payload.board?.boardId) {
      this.store.deleteBoard(payload.board.boardId)
      this.deps.emit({ type: 'board-deleted', boardId: payload.board.boardId })
      return
    }
    const b = payload?.board
    if (!b?.boardId) return
    const existing = this.store.loadBoard(b.boardId)
    if (existing) {
      // 仅当对方版本更新时覆盖（避免旧版本覆盖新版本）
      if (b.updatedAt > existing.updatedAt) {
        this.store.saveBoard(b)
      }
      return
    }
    this.store.saveBoard(b)
    this.deps.emit({ type: 'board-updated', boardId: b.boardId })
  }

  private handlePublish(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as PublishPayload | undefined
    if (!payload?.article?.articleId) return
    const a = payload.article
    // 信任规则：只接受作者本人发布的文章（env.from === authorUid），防伪造
    if (a.authorUid !== env.from) return
    // AI 身份字段卫生：authorAiId 若存在必须是正整数（防脏数据/越权标识）
    if (a.authorAiId !== undefined && (!Number.isInteger(a.authorAiId) || a.authorAiId <= 0)) return
    const existing = this.store.loadArticle(a.boardId, a.articleId)
    if (existing) {
      // 已存在：仅当更新 timestamp 更新时覆盖（避免旧版本覆盖新版本）
      if (a.updatedAt > existing.updatedAt) {
        this.store.saveArticle(a)
        this.deps.emit({ type: 'article-updated', articleId: a.articleId })
      }
      return
    }
    this.store.saveArticle(a)
    this.deps.emit({ type: 'article', article: a })
    // AI 自动参与：真人新帖 → 触发本机 AI 上板评论（AI 的帖子不触发，防死循环）
    void this.maybeAiReply({ kind: 'article', article: a })
  }

  /** 删除广播：作者直接删除或同步转发。本地存在时要求作者一致（防越权删他人文章）、版本更新（防旧墓碑回灌） */
  private handleTombstone(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const p = env.payload as PublishTombstonePayload | undefined
    if (!p?.articleId) return
    // 作者本人删除：env.from 必须是作者；同步转发（handleSyncWant 回发）时 env.from 是请求方，
    // 无法验证原作者，交由"本地作者一致 + 墓碑版本更新"双重校验兜底
    const local = this.store.findArticleById(p.articleId)
    if (local) {
      if (local.authorUid !== p.authorUid) return // 伪造删除他人文章
      if (p.deletedAt <= local.updatedAt) return // 旧墓碑不覆盖
    }
    this.store.markDeleted(p.articleId, p.deletedAt, p.authorUid)
    this.store.applyDelete(p.articleId)
    this.deps.emit({ type: 'article-updated', articleId: p.articleId })
  }

  private handleComment(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as PublishCommentPayload | undefined
    if (!payload?.comment?.commentId) return
    const c = payload.comment
    // 信任规则：只接受评论者本人发布的评论
    if (c.from !== env.from) return
    // AI 身份字段卫生：fromAiId 若存在必须是正整数（防脏数据/越权标识）
    if (c.fromAiId !== undefined && (!Number.isInteger(c.fromAiId) || c.fromAiId <= 0)) return
    this.comments.append(c.articleId, c)
    this.deps.emit({ type: 'comment', comment: c })
    // AI 自动参与：真人新评论 → 触发本机 AI 跟评（AI 的评论不触发，防死循环）
    void this.maybeAiReply({ kind: 'comment', comment: c })
  }

  /** 对端请求同步：回复本机全部新闻索引（articleId + updatedAt 列表）、板块、墓碑与评论索引供对方比对 */
  private handleSyncWant(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as Partial<PublishSyncWantPayload> | undefined
    const haveMap = new Map((payload?.have ?? []).map((h) => [h.articleId, h.updatedAt]))
    const haveBoards = new Map((payload?.boards ?? []).map((b) => [b.boardId, b.updatedAt]))
    const haveDeleted = new Map((payload?.deleted ?? []).map((d) => [d.articleId, d.deletedAt]))
    const haveComments = new Map((payload?.comments ?? []).map((c) => [c.articleId, c.count]))
    // 板块：向对方发送缺失/较新的板块
    for (const b of this.store.loadBoards()) {
      const theirVersion = haveBoards.get(b.boardId)
      if (theirVersion == null || theirVersion < b.updatedAt) {
        this.deps.sendLan(env.from, 'publish-board.board', { board: b } satisfies PublishBoardPayload)
      }
    }
    // 删除墓碑：对方没有的删除记录 → 发送删除广播（幂等）
    for (const d of this.store.listDeleted()) {
      const theirVersion = haveDeleted.get(d.articleId)
      if (theirVersion == null || theirVersion < d.deletedAt) {
        this.deps.sendLan(env.from, 'publish-board.tombstone', {
          articleId: d.articleId,
          deletedAt: d.deletedAt,
          authorUid: d.authorUid,
        } satisfies PublishTombstonePayload)
      }
    }
    // 条目：向对方发送缺失或版本较旧的文章全量；评论：对方评论条数不足时回发全部评论
    const all = this.store.listAllArticles()
    for (const a of all) {
      const theirVersion = haveMap.get(a.articleId)
      if (theirVersion == null || theirVersion < a.updatedAt) {
        this.deps.sendLan(env.from, 'publish-board.publish', { article: a } satisfies PublishPayload)
      }
      const theirCount = haveComments.get(a.articleId) ?? 0
      const myCount = this.comments.count(a.articleId)
      if (myCount > theirCount) {
        for (const c of this.comments.load(a.articleId)) {
          this.deps.sendLan(env.from, 'publish-board.comment', { comment: c } satisfies PublishCommentPayload)
        }
      }
    }
  }

  // ===== 板块管理（任何人可读，无权限控制） =====

  listBoards(): PublishBoard[] {
    return this.store.loadBoards()
  }

  createBoard(name: string, desc?: string): { ok: boolean; board?: PublishBoard; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (!name.trim()) return { ok: false, error: '板块名称不能为空' }
    const now = Date.now()
    const board: PublishBoard = {
      boardId: randomUUID(),
      name: name.trim(),
      desc: desc?.trim(),
      createdAt: now,
      updatedAt: now,
    }
    this.store.addBoard(board)
    // 向全体在线成员广播板块变更
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.board', { board } satisfies PublishBoardPayload)
    }
    this.deps.emit({ type: 'board-updated', boardId: board.boardId })
    return { ok: true, board }
  }

  deleteBoard(boardId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    this.store.deleteBoard(boardId)
    // 向全体在线成员广播板块删除
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.board', { deleted: true, board: { boardId } as PublishBoard } satisfies PublishBoardPayload)
    }
    this.deps.emit({ type: 'board-deleted', boardId })
    return { ok: true }
  }

  // ===== 发布条目（任何人可发布，任何人可读） =====

  /** 文章 → 列表项（合并板块名/评论数）并排序：置顶优先，再按创建时间倒序 */
  private toSortedItems(articles: PublishArticle[]): PublishListItem[] {
    const boardMap = new Map(this.store.loadBoards().map((b) => [b.boardId, b.name]))
    return articles
      .map((a): PublishListItem => ({
        articleId: a.articleId,
        boardId: a.boardId,
        boardName: boardMap.get(a.boardId) ?? '未知板块',
        title: a.title,
        summary: a.summary,
        authorUid: a.authorUid,
        authorName: a.authorName,
        ...(a.authorAiId !== undefined ? { authorAiId: a.authorAiId } : {}),
        pinned: a.pinned,
        commentCount: this.comments.count(a.articleId),
        lastCommentTs: this.comments.lastTs(a.articleId),
        createdAt: a.createdAt,
      }))
      .sort((a, b) => {
        // 置顶优先，再按创建时间倒序
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.createdAt - a.createdAt
      })
  }

  /** 文章列表（置顶优先 + 创建时间倒序）；limit 截断防全量注入（默认 200，硬上限 500） */
  listArticles(boardId?: string, limit = DEFAULT_LIST_LIMIT): PublishListItem[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    const articles = boardId ? this.store.listArticles(boardId) : this.store.listAllArticles()
    return this.toSortedItems(articles).slice(0, clampLimit(limit, DEFAULT_LIST_LIMIT))
  }

  /** 文章总数（不受 limit 影响；调用方据此判断列表是否被截断） */
  totalArticles(boardId?: string): number {
    return boardId ? this.store.listArticles(boardId).length : this.store.listAllArticles().length
  }

  /**
   * 关键词搜索文章（标题/摘要/正文），返回列表项 + 命中正文时的上下文片段。
   * 让 AI 无需拉全量文章即可定位内容；limit 默认 50，硬上限 500。
   */
  searchArticles(keyword: string, boardId?: string, limit = 50): PublishListItem[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    const kw = keyword.trim().toLowerCase()
    if (!kw) return []
    const articles = boardId ? this.store.listArticles(boardId) : this.store.listAllArticles()
    const hit = articles.filter(
      (a) =>
        a.title.toLowerCase().includes(kw) ||
        a.summary.toLowerCase().includes(kw) ||
        a.body.toLowerCase().includes(kw)
    )
    const byId = new Map(hit.map((a) => [a.articleId, a]))
    const items = this.toSortedItems(hit).map((item) => {
      const a = byId.get(item.articleId)
      return a ? { ...item, snippet: articleSnippet(a, kw) } : item
    })
    return items.slice(0, clampLimit(limit, 50))
  }

  getArticle(boardId: string, articleId: string): PublishArticle | null {
    return this.store.loadArticle(boardId, articleId)
  }

  publish(
    boardId: string,
    title: string,
    summary: string,
    body: string,
    pinned = false,
    aiId?: number
  ): { ok: boolean; article?: PublishArticle; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const titleTrimmed = title.trim()
    const summaryTrimmed = summary.trim()
    const bodyTrimmed = body.trim()
    if (!titleTrimmed) return { ok: false, error: '标题不能为空' }
    // 长度/数量上限：防超长正文与无界增长占满存储与 AI 上下文
    if (titleTrimmed.length > MAX_TITLE_LEN) return { ok: false, error: `标题过长（上限 ${MAX_TITLE_LEN} 字）` }
    if (summaryTrimmed.length > MAX_SUMMARY_LEN) return { ok: false, error: `摘要过长（上限 ${MAX_SUMMARY_LEN} 字）` }
    if (bodyTrimmed.length > MAX_BODY_LEN) return { ok: false, error: `正文过长（上限 ${MAX_BODY_LEN} 字）` }
    const board = this.store.loadBoards().find((b) => b.boardId === boardId)
    if (!board) return { ok: false, error: '板块不存在' }
    if (this.store.listArticles(boardId).length >= MAX_ARTICLES_PER_BOARD) {
      return { ok: false, error: `该板块文章数已达上限（${MAX_ARTICLES_PER_BOARD}），请先删除旧文章` }
    }
    // AI 发帖：aiId 存在时以该 AI 身份发布（作者名取注册表 AI 名，authorUid 仍为属主 uid）
    let authorName = identity.用户名
    if (aiId !== undefined) {
      if (!Number.isInteger(aiId) || aiId <= 0) return { ok: false, error: 'AI 编号不合法' }
      const ai = this.deps.getAiProfile?.(aiId) ?? null
      if (!ai) return { ok: false, error: `AI 不存在或已停用（aiId=${aiId}）` }
      authorName = ai.name
    }
    const now = Date.now()
    const article: PublishArticle = {
      articleId: randomUUID(),
      boardId,
      title: titleTrimmed,
      summary: summaryTrimmed,
      body: bodyTrimmed,
      authorUid: identity.uid,
      authorName,
      ...(aiId !== undefined ? { authorAiId: aiId } : {}),
      pinned,
      createdAt: now,
      updatedAt: now,
    }
    this.store.saveArticle(article)
    // 向全体在线成员广播
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.publish', { article } satisfies PublishPayload)
    }
    this.deps.emit({ type: 'article', article })
    // AI 自动参与：真人（无 aiId）发帖 → 触发本机 AI 上板评论（AI 的帖子不触发，防死循环）
    if (aiId === undefined) void this.maybeAiReply({ kind: 'article', article })
    return { ok: true, article }
  }

  /**
   * 编辑文章：仅作者本人。复用 publish 的长度上限；只更新传入字段。
   * 更新 updatedAt 后广播 publish 信封，对端走 handlePublish 的 updatedAt 覆盖分支。
   */
  updateArticle(
    boardId: string,
    articleId: string,
    patch: { title?: string; summary?: string; body?: string; pinned?: boolean }
  ): { ok: boolean; article?: PublishArticle; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const existing = this.store.loadArticle(boardId, articleId)
    if (!existing) return { ok: false, error: '发布不存在' }
    if (existing.authorUid !== identity.uid) return { ok: false, error: '仅作者本人可编辑' }
    const next: PublishArticle = { ...existing }
    if (patch.title !== undefined) {
      const title = patch.title.trim()
      if (!title) return { ok: false, error: '标题不能为空' }
      if (title.length > MAX_TITLE_LEN) return { ok: false, error: `标题过长（上限 ${MAX_TITLE_LEN} 字）` }
      next.title = title
    }
    if (patch.summary !== undefined) {
      const summary = patch.summary.trim()
      if (summary.length > MAX_SUMMARY_LEN) return { ok: false, error: `摘要过长（上限 ${MAX_SUMMARY_LEN} 字）` }
      next.summary = summary
    }
    if (patch.body !== undefined) {
      const body = patch.body.trim()
      if (!body) return { ok: false, error: '正文不能为空' }
      if (body.length > MAX_BODY_LEN) return { ok: false, error: `正文过长（上限 ${MAX_BODY_LEN} 字）` }
      next.body = body
    }
    if (patch.pinned !== undefined) next.pinned = patch.pinned
    next.updatedAt = Date.now()
    this.store.saveArticle(next)
    // 向全体在线成员广播更新
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.publish', { article: next } satisfies PublishPayload)
    }
    this.deps.emit({ type: 'article-updated', articleId })
    return { ok: true, article: next }
  }

  deleteArticle(boardId: string, articleId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const existing = this.store.loadArticle(boardId, articleId)
    if (!existing) return { ok: false, error: '发布不存在' }
    // 仅作者或本机管理员可删除（当前仅作者本人）
    if (existing.authorUid !== identity.uid) return { ok: false, error: '无权删除' }
    const now = Date.now()
    this.store.markDeleted(articleId, now, existing.authorUid)
    this.store.deleteArticle(boardId, articleId)
    // 向全体在线成员广播删除墓碑（独立信封，带版本号防盗刷）
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.tombstone', {
        articleId,
        deletedAt: now,
        authorUid: existing.authorUid,
      } satisfies PublishTombstonePayload)
    }
    this.deps.emit({ type: 'article-updated', articleId })
    return { ok: true }
  }

  togglePin(boardId: string, articleId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const a = this.store.loadArticle(boardId, articleId)
    if (!a) return { ok: false, error: '发布不存在' }
    // 置顶权限：作者本人或本机 uid（简化：仅作者本人可操作）
    if (a.authorUid !== identity.uid) return { ok: false, error: '无权操作' }
    a.pinned = !a.pinned
    a.updatedAt = Date.now()
    this.store.saveArticle(a)
    // 向全体在线成员广播更新（对端走 handlePublish 的 updatedAt 覆盖分支）
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.publish', { article: a } satisfies PublishPayload)
    }
    this.deps.emit({ type: 'article-updated', articleId })
    return { ok: true }
  }

  // ===== 评论（任何人可评论） =====

  /** 评论列表（时间升序）；limit 取最近 N 条防全量注入（默认 200，硬上限 500） */
  listComments(articleId: string, limit = DEFAULT_COMMENT_LIMIT): PublishComment[] {
    const all = this.comments.load(articleId).sort((a, b) => a.ts - b.ts)
    const n = clampLimit(limit, DEFAULT_COMMENT_LIMIT)
    return all.length > n ? all.slice(-n) : all
  }

  postComment(
    articleId: string,
    text: string,
    replyTo = '',
    aiId?: number
  ): { ok: boolean; comment?: PublishComment; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '评论内容不能为空' }
    if (trimmed.length > MAX_COMMENT_LEN) return { ok: false, error: `评论过长（上限 ${MAX_COMMENT_LEN} 字）` }
    // 验证 articleId 是否存在（任一板块均可）
    if (!this.store.findArticleById(articleId)) return { ok: false, error: '发布不存在' }
    // AI 评论：aiId 存在时以该 AI 身份评论（评论者名取注册表 AI 名，from 仍为属主 uid）
    let fromName = identity.用户名
    if (aiId !== undefined) {
      if (!Number.isInteger(aiId) || aiId <= 0) return { ok: false, error: 'AI 编号不合法' }
      const ai = this.deps.getAiProfile?.(aiId) ?? null
      if (!ai) return { ok: false, error: `AI 不存在或已停用（aiId=${aiId}）` }
      fromName = ai.name
    }
    const comment: PublishComment = {
      commentId: randomUUID(),
      articleId,
      replyTo: replyTo || '',
      from: identity.uid,
      fromName,
      ...(aiId !== undefined ? { fromAiId: aiId } : {}),
      text: trimmed,
      ts: Date.now(),
    }
    this.comments.append(articleId, comment)
    // 向全体在线成员广播
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.comment', { comment } satisfies PublishCommentPayload)
    }
    this.deps.emit({ type: 'comment', comment })
    // AI 自动参与：真人（无 aiId）评论 → 触发本机 AI 跟评（AI 的评论不触发，防死循环）
    if (aiId === undefined) void this.maybeAiReply({ kind: 'comment', comment })
    return { ok: true, comment }
  }

  // ===== AI 自动参与（AI 在公示板上交流） =====

  /**
   * AI 自动参与公示板：
   * - 触发条件：收到真人（无 aiId）的帖子/评论、且公示板级开关开启（aiConfig.isBoardEnabled）
   * - 本机全部未停用 AI 逐个询问生成器，愿意发言的以各自身份发评论（fromAiId 标记，不改属主 uid）
   * - 防死循环：仅真人消息触发；AI 的帖子/评论不会再次触发（生成器回复也经 postComment 落盘，属主动触发，
   * 不会再走 AI 参与回路；handleXxx 侧的 aiId 卫生校验同样保证 AI 消息不再触发）
   */
  private async maybeAiReply(
    trigger: { kind: 'article' | 'comment'; article?: PublishArticle; comment?: PublishComment }
  ): Promise<void> {
    if (!this.deps.aiReply) return
    if (!this.deps.aiConfig?.isBoardEnabled()) return
    const identity = this.deps.getIdentity()
    if (!identity) return
    const ais = this.deps.listAiProfiles?.() ?? []
    if (ais.length === 0) return
    // 生成器上下文：帖子正文 + 该文已有评论节选（供 AI 判断是否已讨论过）
    const article = trigger.kind === 'article' ? trigger.article : this.store.findArticleById(trigger.comment?.articleId ?? '')
    if (!article) return
    const articleComments = this.comments.load(article.articleId)
    const history: Array<PublishArticle | PublishComment> = [article, ...articleComments.slice(-10)]
    for (const ai of ais) {
      let replyText: string | null = null
      try {
        replyText = await this.deps.aiReply(ai, trigger, history)
      } catch {
        continue
      }
      if (!replyText?.trim()) continue
      // 以该 AI 身份发表评论（replyTo = 触发它的评论，或顶层）
      this.postComment(article.articleId, replyText.trim(), trigger.kind === 'comment' ? trigger.comment?.commentId ?? '' : '', ai.aiId)
    }
  }

  // ===== 对端在线状态（L0 onPeerStatus 转发） =====

  private syncWantPayload(): PublishSyncWantPayload {
    const all = this.store.listAllArticles()
    return {
      have: all.map((a) => ({ articleId: a.articleId, updatedAt: a.updatedAt })),
      boards: this.store.loadBoards().map((b) => ({ boardId: b.boardId, updatedAt: b.updatedAt })),
      deleted: this.store.listDeleted().map((d) => ({ articleId: d.articleId, deletedAt: d.deletedAt })),
      comments: all.map((a) => ({ articleId: a.articleId, count: this.comments.count(a.articleId) })),
    }
  }

  /** 对端上线：向对方发起新闻同步（拉取缺失/较新文章） */
  handlePeerStatus(ev: import('../lan/lan-types').LanPeerStatusEvent): void {
    const identity = this.deps.getIdentity()
    if (!identity || !ev.online) return
    this.deps.sendLan(ev.peer.uid, 'publish-board.syncWant', this.syncWantPayload())
  }

  // ===== 主动同步：新上线后向在线成员拉取新闻 =====

  /** 向全体在线成员发送 sync-want（携带本机已有文章索引与板块清单），对方回发缺失/较新版本 */
  requestSync(): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = this.syncWantPayload()
    const peers = this.deps.listPeers().filter((p) => p.online)
    for (const peer of peers) {
      this.deps.sendLan(peer.uid, 'publish-board.syncWant', payload)
    }
  }
}
