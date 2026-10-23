/**
 * 发布板（L3）类型契约。
 * 建立在 L0 局域网底座之上：板块与发布条目本机持有，信封经 LanService 直连广播。
 * 信封 type 前缀 'publish-board.'，业务负载定义见各分支。
 */

/** 发布板 */
export interface PublishBoard {
  /** 板块 ID */
  boardId: string
  /** 板块名称 */
  name: string
  /** 板块描述（可选） */
  desc?: string
  /** 创建时间（epoch ms） */
  createdAt: number
  /** 更新时间（epoch ms） */
  updatedAt: number
}

/** 发布条目 */
export interface PublishArticle {
  /** 条目 ID（UUID） */
  articleId: string
  /** 所属板块 */
  boardId: string
  /** 标题 */
  title: string
  /** 摘要 */
  summary: string
  /** 正文（富文本/长文；正文字数过多时前端分页展示） */
  body: string
  /** 作者 UID（属主 uid；AI 发帖时仍为属主 uid，另带 authorAiId） */
  authorUid: number
  /** 作者名（冗余存储，免查 roster） */
  authorName: string
  /** 作者 AI 编号（AI 发帖时 = 该 AI 的 aiId；真人帖子无此字段） */
  authorAiId?: number
  /** 是否置顶 */
  pinned: boolean
  /** 创建时间（epoch ms） */
  createdAt: number
  /** 更新时间（epoch ms） */
  updatedAt: number
}

/** 发布列表项（面板展示用：合并评论数/最新评论时间） */
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
  /** 搜索结果中命中正文时的片段（仅 search 返回，避免整篇正文注入） */
  snippet?: string
}

/** 评论 */
export interface PublishComment {
  /** 评论 ID */
  commentId: string
  articleId: string
  /** 回复对象 commentId（空串=顶层评论） */
  replyTo: string
  from: number
  fromName: string
  /** 评论者 AI 编号（AI 评论时 = 该 AI 的 aiId；真人评论无此字段） */
  fromAiId?: number
  text: string
  ts: number
}

/** 局域网信封负载：发布 */
export interface PublishPayload {
  article: PublishArticle
}

/** 局域网信封负载：板块变更（创建/更新＝board 存在；删除＝deleted:true） */
export interface PublishBoardPayload {
  board?: PublishBoard
  deleted?: boolean
}

/** 局域网信封负载：发布评论 */
export interface PublishCommentPayload {
  comment: PublishComment
}

/** 局域网信封负载：删除广播（publish-board.tombstone，作者删除或同步转发） */
export interface PublishTombstonePayload {
  /** 文章 ID */
  articleId: string
  /** 删除时间（epoch ms），作为墓碑版本号 */
  deletedAt: number
  /** 文章原作者 UID（防伪造删除他人文章；同步转发时保留原作者） */
  authorUid: number
}

/** 局域网信封负载：请求全量同步（syncWant/have 协议） */
export interface PublishSyncWantPayload {
  /** 本机已有文章索引（articleId → updatedAt） */
  have: Array<{ articleId: string; updatedAt: number }>
  /** 本机已有板块索引（boardId → updatedAt） */
  boards?: Array<{ boardId: string; updatedAt: number }>
  /** 本机已有删除墓碑（articleId → deletedAt） */
  deleted?: Array<{ articleId: string; deletedAt: number }>
  /** 本机已有评论索引（articleId → 条数） */
  comments?: Array<{ articleId: string; count: number }>
}

/** 前端事件（webContents.send('publish-board:event')） */
export type PublishEvent =
  | { type: 'article'; article: PublishArticle }
  | { type: 'comment'; comment: PublishComment }
  | { type: 'article-updated'; articleId: string }
  | { type: 'board-updated'; boardId: string }
  | { type: 'board-deleted'; boardId: string }
