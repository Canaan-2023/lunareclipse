/**
 * 为什么存在：发布板面板的类型（板块/条目/文章/评论/视图）被主组件与三个子视图
 * 共用，拆出集中定义避免循环依赖（批次 E-5b 拆分产物）。
 * 作用：内部发布板面板领域类型——PublishBoardItem/PublishListItem/PublishArticleItem/
 * PublishCommentItem/View 等。
 */

export interface PublishBoardItem {
  boardId: string
  name: string
  desc?: string
  createdAt: number
  updatedAt: number
}

export interface PublishListItem {
  articleId: string
  boardId: string
  boardName: string
  title: string
  summary: string
  authorUid: number
  authorName: string
  /** 作者 AI 编号（AI 发帖时 = 该 AI 的 aiId；真人帖子无此字段） */
  authorAiId?: number
  pinned: boolean
  commentCount: number
  lastCommentTs: number | null
  createdAt: number
}

export interface PublishArticleItem {
  articleId: string
  boardId: string
  title: string
  summary: string
  body: string
  authorUid: number
  authorName: string
  /** 作者 AI 编号（AI 发帖时 = 该 AI 的 aiId；真人帖子无此字段） */
  authorAiId?: number
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export interface PublishCommentItem {
  commentId: string
  articleId: string
  replyTo: string
  from: number
  fromName: string
  /** 评论者 AI 编号（AI 评论时 = 该 AI 的 aiId；真人评论无此字段） */
  fromAiId?: number
  text: string
  ts: number
}

export type View = 'board' | 'article' | 'publish'