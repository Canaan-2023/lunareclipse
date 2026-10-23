/**
 * 为什么存在：文章正文 + 评论区是浏览后进入的详情层（批次 E-5b 拆出），
 * 独立视图便于聚焦阅读与评论交互。
 * 作用：渲染文章详情视图——正文（可折叠展开）、评论列表与评论发布框、
 * 置顶/编辑/删除与 AI 发帖标识。
 */
import { Newspaper, Pin, PinOff, Pencil, Trash2, Send, RefreshCw, Bot } from 'lucide-react'
import type { TFunc } from '../../i18n/useT'
import type { PublishArticleItem, PublishCommentItem } from './types'
import { formatTime, splitLinks } from './utils'
import { PanelHeader } from './PanelHeader'

/** 焦点可见样式（a11y）：与 ChatRooms/Friends 面板一致的键盘聚焦提示，操作按钮均需，不可删 */
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

interface ArticleViewProps {
  article: PublishArticleItem
  myUid: number
  comments: PublishCommentItem[]
  bodyExpanded: boolean
  onToggleBody: () => void
  commentDraft: string
  onCommentDraftChange: (v: string) => void
  commenting: boolean
  busyId: string | null
  onBack: () => void
  onTogglePin: (article: PublishArticleItem) => void
  onEdit: (article: PublishArticleItem) => void
  onDelete: (article: PublishArticleItem) => void
  onPostComment: () => void
  onRefresh: () => void
  showClose: boolean
  onClose: () => void
  t: TFunc
}

/** 发布板面板 · 文章详情视图（正文 + 评论区；受控组件，状态不下放） */
export function ArticleView({
  article,
  myUid,
  comments,
  bodyExpanded,
  onToggleBody,
  commentDraft,
  onCommentDraftChange,
  commenting,
  busyId,
  onBack,
  onTogglePin,
  onEdit,
  onDelete,
  onPostComment,
  onRefresh,
  showClose,
  onClose,
  t,
}: ArticleViewProps) {
  const isMine = article.authorUid === myUid
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      <PanelHeader
        title={t('publishBoard.article')}
        icon={<Newspaper size={13} className="text-accent" />}
        onBack={onBack}
        onRefresh={onRefresh}
        showClose={showClose}
        onClose={onClose}
        t={t}
        extra={
          <>
            {isMine && (
              <button
                onClick={() => void onTogglePin(article)}
                disabled={busyId === article.articleId}
                className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-accent disabled:opacity-40 ${FOCUS}`}
                title={article.pinned ? t('publishBoard.unpin') : t('publishBoard.pin')}
                aria-label={article.pinned ? t('publishBoard.unpin') : t('publishBoard.pin')}
              >
                {article.pinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
            )}
            {isMine && (
              <button
                onClick={() => onEdit(article)}
                className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-accent ${FOCUS}`}
                title={t('publishBoard.edit')}
                aria-label={t('publishBoard.edit')}
              >
                <Pencil size={11} />
              </button>
            )}
            {isMine && (
              <button
                onClick={() => void onDelete(article)}
                disabled={busyId === article.articleId}
                className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
                title={t('publishBoard.deleteArticle')}
                aria-label={t('publishBoard.deleteArticle')}
              >
                <Trash2 size={11} />
              </button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-1 flex items-center gap-1.5">
          {article.pinned && <Pin size={11} className="text-accent" />}
          <h3 className="text-[13px] font-medium leading-snug text-fg-primary">{article.title}</h3>
        </div>
        <div className="mb-2 flex items-center gap-1 text-[9px] text-fg-muted">
          {article.authorAiId !== undefined ? (
            <span className="flex items-center gap-0.5 rounded bg-accent/15 px-1 py-0.5 text-accent" title={t('publishBoard.aiAuthor')} aria-label={t('publishBoard.aiAuthor')}>
              <Bot size={8} />
              {article.authorName}（AI {article.authorAiId}）
            </span>
          ) : (
            <span>{article.authorName}</span>
          )}
          <span>· {formatTime(article.createdAt)}</span>
        </div>
        {article.summary && (
          <div className="mb-2 rounded-card border border-border-subtle bg-bg-muted/50 px-2.5 py-1.5 text-caption text-fg-secondary">
            {splitLinks(article.summary)}
          </div>
        )}
        {/* 超长正文默认折叠，避免滚动过长 */}
        <div className="whitespace-pre-wrap break-words text-caption leading-relaxed text-fg-primary">
          {splitLinks(
            !bodyExpanded && article.body.length > 1200
              ? `${article.body.slice(0, 1200)}…`
              : article.body,
          )}
        </div>
        {article.body.length > 1200 && (
          <button
            onClick={onToggleBody}
            className={`mt-2 text-[10px] text-accent hover:underline ${FOCUS}`}
          >
            {bodyExpanded ? t('publishBoard.showLess') : t('publishBoard.showMore')}
          </button>
        )}

        {/* 评论区 */}
        <div className="mt-4 border-t border-border-subtle pt-2">
          <div className="mb-2 text-[10px] font-medium text-fg-secondary">
            {t('publishBoard.comments', { count: comments.length })}
          </div>
          {comments.length === 0 ? (
            <div className="px-3 py-4 text-center text-caption text-fg-muted">{t('publishBoard.noComments')}</div>
          ) : (
            comments.map((c) => (
              <div key={c.commentId} className="mb-1.5 rounded-card border border-border-subtle bg-bg-elevated px-2.5 py-1.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1">
                    {c.fromAiId !== undefined ? (
                      <span className="flex items-center gap-0.5 rounded bg-accent/15 px-1 py-0.5 text-[9px] font-medium text-accent" title={t('publishBoard.aiAuthor')} aria-label={t('publishBoard.aiAuthor')}>
                        <Bot size={8} />
                        {c.fromName}（AI {c.fromAiId}）
                      </span>
                    ) : (
                      <span className="text-[9px] font-medium text-fg-secondary">{c.fromName}</span>
                    )}
                  </span>
                  <span className="text-[9px] text-fg-muted">{formatTime(c.ts)}</span>
                </div>
                <div className="mt-0.5 whitespace-pre-wrap break-words text-caption text-fg-primary">{splitLinks(c.text)}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 border-t border-border-subtle p-2">
        <input
          value={commentDraft}
          onChange={(e) => onCommentDraftChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onPostComment() } }}
          placeholder={t('publishBoard.commentPlaceholder')}
          className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <button
          onClick={() => void onPostComment()}
          disabled={commenting || !commentDraft.trim()}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-btn bg-accent/15 text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          title={t('input.send')}
          aria-label={t('input.send')}
        >
          {commenting ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
      </div>
    </div>
  )
}