/**
 * @category 工具
 * @summary 多实例内部发布板 IPC 注册（L3，LAN 直连；未启动时返回 unready）
 * 为什么存在：发布板 UI 需经 IPC 访问板块/文章操作，且 LAN 未启动时应明确返回 unready 而非静默出错。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import type { PublishBoardService } from '../publish-board/publish-board-service'

/** 发布板域所需上下文：以 getter 形式注入 MultiInstanceService 私有状态 */
export interface PublishBoardIpcCtx {
  getPublishBoard(): PublishBoardService | null
}

/** 注册内部发布板 IPC 通道（13 个 publish-board:*） */
export function registerPublishBoardIpc(ipc: typeof ipcMainType, ctx: PublishBoardIpcCtx): void {
  // ===== 内部发布板（L3，LAN 直连；未启动时返回 unready） =====
  const withPublishBoard = <T>(fn: (n: PublishBoardService) => T): T | { ok: false; error: string } => {
    const publishBoard = ctx.getPublishBoard()
    if (!publishBoard) return { ok: false, error: '局域网协作未启动' }
    try {
      return fn(publishBoard)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  safeHandle(
    ipc, 'publish-board:listBoards',
    () => withPublishBoard((n) => ({ ok: true as const, list: n.listBoards() })),
    { ok: false, error: '读取板块列表失败' }
  )
  safeHandle(
    ipc, 'publish-board:createBoard',
    (_e, name: unknown, desc?: unknown) => {
      if (typeof name !== 'string') return { ok: false, error: '参数不合法' }
      return withPublishBoard((n) => n.createBoard(name, typeof desc === 'string' ? desc : undefined))
    },
    { ok: false, error: '创建板块失败' }
  )
  safeHandle(
    ipc, 'publish-board:deleteBoard',
    (_e, boardId: unknown) => {
      if (typeof boardId !== 'string') return { ok: false, error: '参数不合法' }
      return withPublishBoard((n) => n.deleteBoard(boardId))
    },
    { ok: false, error: '删除板块失败' }
  )
  safeHandle(
    ipc, 'publish-board:listArticles',
    (_e, boardId?: unknown, limit?: unknown) => {
      if (boardId != null && typeof boardId !== 'string') return { ok: false, error: '参数不合法' }
      const bid = typeof boardId === 'string' ? boardId : undefined
      return withPublishBoard((n) => ({
        ok: true as const,
        list: n.listArticles(bid, typeof limit === 'number' ? limit : undefined),
        total: n.totalArticles(bid)
      }))
    },
    { ok: false, error: '读取发布列表失败' }
  )
  safeHandle(
    ipc, 'publish-board:searchArticles',
    (_e, keyword: unknown, boardId?: unknown, limit?: unknown) => {
      if (typeof keyword !== 'string') return { ok: false, error: '参数不合法' }
      if (boardId != null && typeof boardId !== 'string') return { ok: false, error: '参数不合法' }
      return withPublishBoard((n) => ({
        ok: true as const,
        list: n.searchArticles(keyword, typeof boardId === 'string' ? boardId : undefined, typeof limit === 'number' ? limit : undefined)
      }))
    },
    { ok: false, error: '搜索发布失败' }
  )
  safeHandle(
    ipc, 'publish-board:getArticle',
    (_e, boardId: unknown, articleId: unknown) => {
      if (typeof boardId !== 'string' || typeof articleId !== 'string') return { ok: false, error: '参数不合法' }
      const a = withPublishBoard((n) => n.getArticle(boardId, articleId))
      return a && typeof a === 'object' && 'articleId' in a ? { ok: true as const, article: a } : { ok: false, error: '发布不存在' }
    },
    { ok: false, error: '读取发布失败' }
  )
  safeHandle(
    ipc, 'publish-board:publish',
    (_e, boardId: unknown, title: unknown, summary: unknown, body: unknown, aiId?: unknown) => {
      if (typeof boardId !== 'string' || typeof title !== 'string' || typeof summary !== 'string' || typeof body !== 'string') {
        return { ok: false, error: '参数不合法' }
      }
      if (aiId != null && (typeof aiId !== 'number' || !Number.isInteger(aiId))) return { ok: false, error: 'AI 编号不合法' }
      return withPublishBoard((n) => n.publish(boardId, title, summary, body, false, aiId as number | undefined))
    },
    { ok: false, error: '发布失败' }
  )
  safeHandle(
    ipc, 'publish-board:deleteArticle',
    (_e, boardId: unknown, articleId: unknown) => {
      if (typeof boardId !== 'string' || typeof articleId !== 'string') return { ok: false, error: '参数不合法' }
      return withPublishBoard((n) => n.deleteArticle(boardId, articleId))
    },
    { ok: false, error: '删除发布失败' }
  )
  safeHandle(
    ipc, 'publish-board:updateArticle',
    (_e, boardId: unknown, articleId: unknown, patch: unknown) => {
      if (typeof boardId !== 'string' || typeof articleId !== 'string' || typeof patch !== 'object' || patch === null) {
        return { ok: false, error: '参数不合法' }
      }
      const p = patch as { title?: unknown; summary?: unknown; body?: unknown; pinned?: unknown }
      return withPublishBoard((n) => n.updateArticle(boardId, articleId, {
        title: typeof p.title === 'string' ? p.title : undefined,
        summary: typeof p.summary === 'string' ? p.summary : undefined,
        body: typeof p.body === 'string' ? p.body : undefined,
        pinned: typeof p.pinned === 'boolean' ? p.pinned : undefined,
      }))
    },
    { ok: false, error: '编辑发布失败' }
  )
  safeHandle(
    ipc, 'publish-board:togglePin',
    (_e, boardId: unknown, articleId: unknown) => {
      if (typeof boardId !== 'string' || typeof articleId !== 'string') return { ok: false, error: '参数不合法' }
      return withPublishBoard((n) => n.togglePin(boardId, articleId))
    },
    { ok: false, error: '置顶操作失败' }
  )
  safeHandle(
    ipc, 'publish-board:listComments',
    (_e, articleId: unknown) => {
      if (typeof articleId !== 'string') return { ok: false, error: '参数不合法' }
      return withPublishBoard((n) => ({ ok: true as const, list: n.listComments(articleId) }))
    },
    { ok: false, error: '读取评论失败' }
  )
  safeHandle(
    ipc, 'publish-board:postComment',
    (_e, articleId: unknown, text: unknown, replyTo?: unknown, aiId?: unknown) => {
      if (typeof articleId !== 'string' || typeof text !== 'string') return { ok: false, error: '参数不合法' }
      if (aiId != null && (typeof aiId !== 'number' || !Number.isInteger(aiId))) return { ok: false, error: 'AI 编号不合法' }
      return withPublishBoard((n) => n.postComment(articleId, text, typeof replyTo === 'string' ? replyTo : '', aiId as number | undefined))
    },
    { ok: false, error: '发表评论失败' }
  )
  safeHandle(
    ipc, 'publish-board:requestSync',
    () => withPublishBoard((n) => {
      n.requestSync()
      return { ok: true as const }
    }),
    { ok: false, error: '同步发布失败' }
  )
}