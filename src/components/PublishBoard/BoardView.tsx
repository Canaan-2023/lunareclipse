/**
 * 为什么存在：板块展示与发布列表是浏览层的核心视图（批次 E-5b 拆出），
 * 独立成组件以隔离列表渲染与筛选逻辑。
 * 作用：渲染板块视图——板块栏（全部/按板块）、发布列表（置顶/评论数/作者）、
 * 搜索过滤与创建板块浮层。
 */
import { Newspaper, Plus, RefreshCw, Pin, MessageSquare, Trash2, LayoutGrid, PenSquare, Search, X, Bot } from 'lucide-react'
import type { TFunc } from '../../i18n/useT'
import type { PublishBoardItem, PublishListItem } from './types'
import { formatTime, splitLinks } from './utils'
import { PanelHeader } from './PanelHeader'

/** 焦点可见样式（a11y）：PublishBoard 是最后拆分的一批，未随 ChatRooms/Friends 引入 FOCUS，这里补上与全项目一致；按钮/可点行键盘聚焦时可见，不可删 */
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

interface BoardViewProps {
  ready: boolean | null
  boards: PublishBoardItem[]
  activeBoard: string | null
  articles: PublishListItem[]
  total: number
  query: string
  onQueryChange: (q: string) => void
  showCreateBoard: boolean
  onOpenCreateBoard: () => void
  onCloseCreateBoard: () => void
  boardName: string
  boardDesc: string
  onBoardNameChange: (v: string) => void
  onBoardDescChange: (v: string) => void
  creatingBoard: boolean
  onCreateBoard: () => void
  onOpenBoard: (boardId: string | null) => void
  onDeleteBoard: (boardId: string) => void
  onOpenArticle: (item: PublishListItem) => void
  onOpenPublish: () => void
  onRefresh: () => void
  showClose: boolean
  onClose: () => void
  t: TFunc
}

/** 发布板面板 · 板块视图（板块栏 + 发布列表 + 创建板块浮层；受控组件，状态不下放） */
export function BoardView({
  ready,
  boards,
  activeBoard,
  articles,
  total,
  query,
  onQueryChange,
  showCreateBoard,
  onOpenCreateBoard,
  onCloseCreateBoard,
  boardName,
  boardDesc,
  onBoardNameChange,
  onBoardDescChange,
  creatingBoard,
  onCreateBoard,
  onOpenBoard,
  onDeleteBoard,
  onOpenArticle,
  onOpenPublish,
  onRefresh,
  showClose,
  onClose,
  t,
}: BoardViewProps) {
  // 本地关键词过滤（标题/摘要/板块名），避免列表全量渲染
  const q = query.trim().toLowerCase()
  const shownArticles = q
    ? articles.filter(
        (a) =>
          a.title.toLowerCase().includes(q) ||
          a.summary.toLowerCase().includes(q) ||
          a.boardName.toLowerCase().includes(q),
      )
    : articles

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      <PanelHeader
        title={t('publishBoard.title')}
        icon={<Newspaper size={13} className="text-accent" />}
        onRefresh={onRefresh}
        showClose={showClose}
        onClose={onClose}
        t={t}
        extra={
          <>
            <button
              onClick={onOpenCreateBoard}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
              title={t('publishBoard.createBoard')}
              aria-label={t('publishBoard.createBoard')}
            >
              <Plus size={12} />
            </button>
            {activeBoard && (
              <button
                onClick={onOpenPublish}
                className={`flex h-6 items-center gap-1 rounded-btn bg-accent/15 px-2 text-[10px] text-accent hover:bg-accent/25 ${FOCUS}`}
                title={t('publishBoard.publish')}
              >
                <PenSquare size={10} />
                {t('publishBoard.publish')}
              </button>
            )}
          </>
        }
      />

      {ready === false && (
        <div className="border-b border-border-subtle bg-danger-soft/50 px-3 py-1.5 text-[11px] text-danger">
          {t('publishBoard.lanOffline')}
        </div>
      )}

      {/* 板块栏：全部 + 各板块 */}
      <div className="flex max-w-full gap-1 overflow-x-auto border-b border-border-subtle px-2 py-1.5" role="tablist" aria-label={t('publishBoard.boards')}>
        <button
          role="tab"
          aria-selected={activeBoard === null}
          onClick={() => onOpenBoard(null)}
          className={`flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-[11px] transition-colors ${FOCUS} ${
            activeBoard === null ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
          }`}
        >
          <LayoutGrid size={10} />
          {t('publishBoard.all')}
        </button>
        {boards.map((b) => (
          <button
            key={b.boardId}
            role="tab"
            aria-selected={activeBoard === b.boardId}
            onClick={() => onOpenBoard(b.boardId)}
            title={b.desc ?? b.name}
            className={`flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-[11px] transition-colors ${FOCUS} ${
              activeBoard === b.boardId ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
          >
            {b.name}
            {activeBoard === b.boardId && (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('publishBoard.deleteBoard')}
                onClick={(e) => { e.stopPropagation(); void onDeleteBoard(b.boardId) }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void onDeleteBoard(b.boardId) } }}
                className="flex shrink-0 cursor-pointer items-center text-fg-muted hover:text-danger"
              >
                <Trash2 size={9} />
              </span>
            )}
          </button>
        ))}
      </div>

      {/* 关键词搜索（本地过滤已加载列表） */}
      <div className="border-b border-border-subtle px-2 py-1.5">
        <div className="relative">
          <Search size={11} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('publishBoard.searchPlaceholder')}
            aria-label={t('publishBoard.searchPlaceholder')}
            className="w-full rounded-btn border border-border-subtle bg-bg-base py-1.5 pl-6 pr-6 text-caption text-fg-primary outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          {query && (
            <button
              onClick={() => onQueryChange('')}
              className={`absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:text-fg-primary ${FOCUS}`}
              aria-label={t('common.close')}
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {/* 分页截断提示：列表已按上限返回，用搜索定位更早内容 */}
      {!q && total > articles.length && (
        <div className="border-b border-border-subtle bg-bg-muted/40 px-3 py-1 text-[10px] text-fg-muted">
          {t('publishBoard.truncated', { shown: articles.length, total })}
        </div>
      )}

      {/* 发布列表 */}
      <div className="flex-1 overflow-y-auto p-2">
        {ready === null ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-fg-muted">
            <RefreshCw size={16} className="animate-spin" />
            <span className="text-caption">{t('publishBoard.loading')}</span>
          </div>
        ) : shownArticles.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            {q ? t('publishBoard.searchNoResult') : activeBoard ? t('publishBoard.emptyBoard') : t('publishBoard.empty')}
          </div>
        ) : (
          shownArticles.map((a) => (
            <div
              key={a.articleId}
              role="button"
              tabIndex={0}
              onClick={() => void onOpenArticle(a)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); void onOpenArticle(a) } }}
              className="group mb-1 flex cursor-pointer items-start gap-2 rounded-card border border-transparent px-2.5 py-2 transition-colors hover:border-border-subtle hover:bg-bg-muted/70"
            >
              {/* 文章行：点击进入详情，补键盘可达；帖子列表是浏览板的核心条目，不可删 */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  {a.pinned && <Pin size={10} className="shrink-0 text-accent" />}
                  <span className="truncate text-caption font-medium text-fg-primary">{a.title}</span>
                </div>
                {a.summary && (
                  <div className="mt-0.5 line-clamp-2 text-caption text-fg-muted">{splitLinks(a.summary)}</div>
                )}
                <div className="mt-1 flex items-center gap-2 text-[9px] text-fg-muted">
                  <span className="rounded bg-bg-muted px-1 py-0.5">{a.boardName}</span>
                  {a.authorAiId !== undefined ? (
                    <span className="flex items-center gap-0.5 rounded bg-accent/15 px-1 py-0.5 text-accent" title={t('publishBoard.aiAuthor')} aria-label={t('publishBoard.aiAuthor')}>
                      <Bot size={8} />
                      {a.authorName}（AI {a.authorAiId}）
                    </span>
                  ) : (
                    <span>{a.authorName}</span>
                  )}
                  <span>{formatTime(a.createdAt)}</span>
                  <span className="flex items-center gap-0.5">
                    <MessageSquare size={8} />
                    {a.commentCount}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 创建板块浮层 */}
      {showCreateBoard && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/30"
          onClick={onCloseCreateBoard}
          onKeyDown={(e) => { if (e.key === 'Escape') onCloseCreateBoard() }}
        >
          <div className="w-72 rounded-card border border-border bg-bg-elevated p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 text-caption font-medium text-fg-primary">{t('publishBoard.createBoard')}</div>
            <label htmlFor="publish-board-name" className="mb-1 block text-[10px] text-fg-muted">{t('publishBoard.boardName')}</label>
            <input
              id="publish-board-name"
              value={boardName}
              onChange={(e) => onBoardNameChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void onCreateBoard() }}
              autoFocus
              className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <label htmlFor="publish-board-desc" className="mb-1 block text-[10px] text-fg-muted">{t('publishBoard.boardDesc')}</label>
            <input
              id="publish-board-desc"
              value={boardDesc}
              onChange={(e) => onBoardDescChange(e.target.value)}
              className="mb-3 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-1.5">
              <button
                onClick={onCloseCreateBoard}
                className={`rounded-btn bg-bg-muted px-3 py-1 text-caption text-fg-secondary hover:bg-bg-muted/70 ${FOCUS}`}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => void onCreateBoard()}
                disabled={creatingBoard || !boardName.trim()}
                className={`rounded-btn bg-accent px-3 py-1 text-caption text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
              >
                {creatingBoard ? t('publishBoard.creating') : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}