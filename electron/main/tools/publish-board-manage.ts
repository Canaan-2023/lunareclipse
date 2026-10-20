/**
 * 局域网公示板管理工具：为什么存在——多个月蚀实例共用的布告栏（L3 层）需要 AI 可发布、
 * 阅读、评论，是实例间沉淀与分享协作信息的通道。
 * 作用：publish_board_manage 封装公示板文章的发布/列表/详情/评论等动作。
 */
import type { ToolContext, ToolResult } from './base-tool'

// publish_board_manage 工具：AI 操作局域网公示板（L3）
//
// 公示板是局域网内多个月蚀实例共用的布告栏：谁都可以发布文章，
// 大家都能看到并评论——适合不同月蚀之间发布公告、分享经验、沉淀协作信息。
//
// 动作：
// - list_boards 列出全部公示板
// - create_board 新建公示板（name，可选 desc）
// - delete_board 删除公示板（boardId）
// - list 列出文章（可选 boardId，可选 limit，置顶优先）
// - search 关键词搜索文章（keyword；可选 boardId，可选 limit）
// - get 读单篇文章正文（boardId + articleId）
// - publish 发布文章（boardId + title + summary 可选 + body，可选 pinned 置顶）
// - update 编辑文章（boardId + articleId，可改 title/summary/body/pinned；仅作者本人）
// - delete 删除文章（boardId + articleId）
// - pin 置顶/取消置顶（boardId + articleId）
// - comments 读某文章评论（articleId，可选 limit）
// - comment 评论（articleId + text，可选 replyTo 评论 id）
// - sync 主动向局域网对端请求全量同步
export class PublishBoardManageTool {
  name = 'publish_board_manage'
  description = `操作局域网公示板（L3）：局域网内多个月蚀实例共用的布告栏。action 见参数表。身份：UID-AIID=AI 身份（编号先看本机 AI 编号列表，每个 AI 编号独立、无固定主次），纯 UID=真人，据此判断作者。用途：发公告/分享经验/沉淀协作信息，发完可 sync 让对端同步。文章可能很多：先 search 定位再 get 读正文，不要一次拉全量。`

  parameters = [
    {
      name: 'action',
      type: 'string' as const,
      description:
        'list_boards / create_board / delete_board / list / search / get / publish / update / delete / pin / comments / comment / sync',
      required: true
    },
    {
      name: 'keyword',
      type: 'string' as const,
      description: '搜索关键词（search 必填）：匹配文章标题/摘要/正文',
      required: false
    },
    {
      name: 'limit',
      type: 'number' as const,
      description: '返回条数上限（list 默认 200 / search 默认 50 / comments 默认 200，硬上限 500）',
      required: false
    },
    {
      name: 'boardId',
      type: 'string' as const,
      description: '公示板 ID（list/search/get/publish/update/delete/pin 时使用）',
      required: false
    },
    {
      name: 'articleId',
      type: 'string' as const,
      description: '文章 ID（get/update/delete/pin/comments/comment 时使用）',
      required: false
    },
    {
      name: 'name',
      type: 'string' as const,
      description: '公示板名（create_board 必填）',
      required: false
    },
    {
      name: 'desc',
      type: 'string' as const,
      description: '公示板简介（create_board 可选）',
      required: false
    },
    {
      name: 'title',
      type: 'string' as const,
      description: '文章标题（publish 必填；update 可选）',
      required: false
    },
    {
      name: 'summary',
      type: 'string' as const,
      description: '文章摘要（publish/update 可选，列表展示用）',
      required: false
    },
    {
      name: 'body',
      type: 'string' as const,
      description: '文章正文（publish 必填；update 可选）',
      required: false
    },
    {
      name: 'pinned',
      type: 'boolean' as const,
      description: '是否置顶（publish/update 可选）',
      required: false
    },
    {
      name: 'text',
      type: 'string' as const,
      description: '评论内容（comment 必填）',
      required: false
    },
    {
      name: 'replyTo',
      type: 'string' as const,
      description: '回复的评论 ID（comment 回复时传入）',
      required: false
    }
  ]

  async execute(params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    const board = ctx?.getMultiInstance?.()?.getPublishBoard()
    if (!board) return { ok: false, error: '公示板不可用（未初始化或未登录）' }

    const action = params.action as string | undefined
    const boardId = (params.boardId as string | undefined)?.trim()
    const articleId = (params.articleId as string | undefined)?.trim()

    if (action === 'list_boards') {
      return { ok: true, data: { boards: board.listBoards() } }
    }

    if (action === 'create_board') {
      const name = (params.name as string | undefined)?.trim()
      if (!name) return { ok: false, error: 'create_board 需要 name' }
      const desc = (params.desc as string | undefined)?.trim()
      const res = board.createBoard(name, desc || undefined)
      if (!res.ok || !res.board) return { ok: false, error: res.error ?? '创建失败' }
      return { ok: true, data: { board: res.board, note: `公示板「${name}」已创建` } }
    }

    if (action === 'delete_board') {
      if (!boardId) return { ok: false, error: 'delete_board 需要 boardId' }
      return toResult(board.deleteBoard(boardId), `公示板 ${boardId} 已删除`)
    }

    if (action === 'list') {
      const limit = asNumber(params.limit)
      const bid = boardId || undefined
      const articles = board.listArticles(bid, limit)
      const total = board.totalArticles(bid)
      return { ok: true, data: { articles, total, truncated: total > articles.length } }
    }

    if (action === 'search') {
      const keyword = (params.keyword as string | undefined)?.trim()
      if (!keyword) return { ok: false, error: 'search 需要 keyword' }
      const articles = board.searchArticles(keyword, boardId || undefined, asNumber(params.limit))
      return { ok: true, data: { keyword, articles, note: `命中 ${articles.length} 篇` } }
    }

    if (action === 'get') {
      if (!boardId || !articleId) return { ok: false, error: 'get 需要 boardId + articleId' }
      const article = board.getArticle(boardId, articleId)
      if (!article) return { ok: false, error: `文章不存在: ${articleId}` }
      return { ok: true, data: { article } }
    }

    if (action === 'publish') {
      if (!boardId) return { ok: false, error: 'publish 需要 boardId' }
      const title = (params.title as string | undefined)?.trim()
      const body = (params.body as string | undefined)?.trim()
      if (!title) return { ok: false, error: 'publish 需要 title' }
      if (!body) return { ok: false, error: 'publish 需要 body' }
      const summary = (params.summary as string | undefined)?.trim()
      const pinned = params.pinned === true
      const res = board.publish(boardId, title, summary ?? '', body, pinned)
      if (!res.ok || !res.article) return { ok: false, error: res.error ?? '发布失败' }
      return { ok: true, data: { articleId: res.article.articleId, note: `文章「${title}」已发布` } }
    }

    if (action === 'update') {
      if (!boardId || !articleId) return { ok: false, error: 'update 需要 boardId + articleId' }
      const patch: { title?: string; summary?: string; body?: string; pinned?: boolean } = {}
      if (typeof params.title === 'string') patch.title = params.title
      if (typeof params.summary === 'string') patch.summary = params.summary
      if (typeof params.body === 'string') patch.body = params.body
      if (typeof params.pinned === 'boolean') patch.pinned = params.pinned
      if (Object.keys(patch).length === 0) return { ok: false, error: 'update 至少需要 title/summary/body/pinned 之一' }
      const res = board.updateArticle(boardId, articleId, patch)
      if (!res.ok) return { ok: false, error: res.error ?? '编辑失败' }
      return { ok: true, data: { articleId, note: `文章 ${articleId} 已更新` } }
    }

    if (action === 'delete') {
      if (!boardId || !articleId) return { ok: false, error: 'delete 需要 boardId + articleId' }
      return toResult(board.deleteArticle(boardId, articleId), `文章 ${articleId} 已删除`)
    }

    if (action === 'pin') {
      if (!boardId || !articleId) return { ok: false, error: 'pin 需要 boardId + articleId' }
      return toResult(board.togglePin(boardId, articleId), `文章 ${articleId} 置顶已切换`)
    }

    if (action === 'comments') {
      if (!articleId) return { ok: false, error: 'comments 需要 articleId' }
      return { ok: true, data: { comments: board.listComments(articleId, asNumber(params.limit)) } }
    }

    if (action === 'comment') {
      if (!articleId) return { ok: false, error: 'comment 需要 articleId' }
      const text = (params.text as string | undefined)?.trim()
      if (!text) return { ok: false, error: 'comment 需要 text' }
      const replyTo = (params.replyTo as string | undefined)?.trim()
      const res = board.postComment(articleId, text, replyTo ?? '')
      if (!res.ok) return { ok: false, error: res.error ?? '评论失败' }
      return { ok: true, data: { commentId: res.comment?.commentId, note: '评论已发布' } }
    }

    if (action === 'sync') {
      board.requestSync()
      return { ok: true, data: { note: '已向局域网对端请求全量同步' } }
    }

    return {
      ok: false,
      error: `未知 action: ${String(action)}（支持 list_boards/create_board/delete_board/list/search/get/publish/update/delete/pin/comments/comment/sync）`
    }
  }
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function toResult(res: { ok: boolean; error?: string }, successNote: string): ToolResult {
  if (!res.ok) return { ok: false, error: res.error ?? '操作失败' }
  return { ok: true, data: { note: successNote } }
}