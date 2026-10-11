/**
 * 为什么存在：内部发布板（板块 + 条目 + 评论，LAN 广播）需要统一面板入口，
 * 事件驱动状态集中于主组件，视图拆给三个子组件（批次 E-5b 拆分产物）。
 * 作用：渲染发布板面板——视图状态机（板块/发布/详情）、onPublishBoardEvent 事件
 * 订阅、发布/编辑/删除条目与评论发布。
 */
import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import type { PublishBoardItem, PublishListItem, PublishArticleItem, PublishCommentItem, View } from './types'
import { BoardView } from './BoardView'
import { ArticleView } from './ArticleView'
import { PublishView } from './PublishView'

/**
 * 内部发布板面板（右侧抽屉）：板块 + 发布条目 + 评论。
 * - 任何账号（主/分）均可发布条目/评论，经 L3 PublishBoardService → L0 LAN 直连广播
 * - 实时事件：onPublishBoardEvent（收到文章/评论/板块变更）驱动列表与评论追加
 * - 视图：板块栏（全部/按板块）→ 发布列表 → 详情+评论区；发布页覆盖
 * - 批次 E-5b 拆分：板块/文章/发布三视图已抽为受控子组件（状态仍全部驻留本组件，不下放）
 */
export function PublishBoardPanel({ embedded, externalQuery }: { embedded?: boolean; externalQuery?: string } = {}) {
  const open = useAppStore((s) => (embedded || s.activeDrawer === 'publishBoard') && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const t = useT()

  const [ready, setReady] = useState<boolean | null>(null)
  const [view, setView] = useState<View>('board')
  const [activeBoard, setActiveBoard] = useState<string | null>(null)
  const [activeArticle, setActiveArticle] = useState<PublishArticleItem | null>(null)
  const [boards, setBoards] = useState<PublishBoardItem[]>([])
  const [articles, setArticles] = useState<PublishListItem[]>([])
  // 当前板块文章总数（>articles.length 说明被分页截断，提示用搜索定位）
  const [total, setTotal] = useState(0)
  const [comments, setComments] = useState<PublishCommentItem[]>([])
  // 操作错误反馈（发布/删除/评论失败时展示，可自动消失）
  const [error, setError] = useState<string | null>(null)
  // 发布表单
  const [showCreateBoard, setShowCreateBoard] = useState(false)
  const [boardName, setBoardName] = useState('')
  const [boardDesc, setBoardDesc] = useState('')
  const [pubTitle, setPubTitle] = useState('')
  const [pubSummary, setPubSummary] = useState('')
  const [pubBody, setPubBody] = useState('')
  // 编辑态：非 null 时发布表单复用为编辑表单，提交走 updateArticle
  const [editingId, setEditingId] = useState<string | null>(null)
  const [commentDraft, setCommentDraft] = useState('')
  // 异步防重：发布/创建板块/评论/单条操作（置顶/删除）
  const [publishing, setPublishing] = useState(false)
  const [creatingBoard, setCreatingBoard] = useState(false)
  const [commenting, setCommenting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  // 超长正文折叠
  const [bodyExpanded, setBodyExpanded] = useState(false)
  // 关键词搜索（本地过滤已加载列表；避免全量注入/全量渲染）
  const [query, setQuery] = useState('')

  // 外部搜索框（SocialBrowserPanel 地址栏）作为查询源之一：
  // 地址栏输入关键词时同步到面板内查询，让地址栏真正过滤发布板列表，
  // 否则该输入框只更新面包屑文本、对列表毫无作用（社交面板搜索框无效按钮问题的根因）
  useEffect(() => {
    if (externalQuery !== undefined) setQuery(externalQuery)
  }, [externalQuery])

  const reportError = useCallback((msg: string) => {
    setError(msg)
    window.setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 4000)
  }, [])

  const loadBoards = useCallback(async () => {
    const r = await window.lunareclipse.publishBoardListBoards()
    if (r.ok && r.list) {
      setBoards(r.list)
      setReady(true)
    } else {
      setReady(false)
    }
  }, [])

  const loadArticles = useCallback(async (boardId?: string) => {
    const r = await window.lunareclipse.publishBoardListArticles(boardId)
    if (r.ok && r.list) {
      setArticles(r.list)
      if (typeof r.total === 'number') setTotal(r.total)
      // 列表刷新后若当前详情被删除，退回列表
      setActiveArticle((cur) => {
        if (cur && !r.list!.some((a) => a.articleId === cur.articleId)) {
          setView('board')
          return null
        }
        return cur
      })
    } else {
      // 列表加载失败不能静默吞掉：否则用户会误以为"该板块无发布"
      reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
    }
  }, [reportError, t])

  const loadComments = useCallback(async (articleId: string) => {
    const r = await window.lunareclipse.publishBoardListComments(articleId)
    if (r.ok && r.list) {
      setComments(r.list)
    } else {
      // 评论加载失败不能静默吞掉：否则"暂无评论"会误导用户
      reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
    }
  }, [reportError, t])

  const refresh = useCallback(() => {
    void loadBoards()
    void loadArticles(activeBoard ?? undefined)
    if (activeArticle) void loadComments(activeArticle.articleId)
  }, [loadBoards, loadArticles, loadComments, activeBoard, activeArticle])

  useEffect(() => {
    if (!open) return
    void loadBoards()
    void loadArticles()
  }, [open, loadBoards, loadArticles])

  useEffect(() => {
    if (!open) return
    const unsubscribe = window.lunareclipse.onPublishBoardEvent((ev) => {
      if (ev.type === 'article' && ev.article) {
        // 新文章：若属于当前板块或看全部，刷新列表；若正在查看该文章则同步正文
        const a = ev.article
        if (!activeBoard || a.boardId === activeBoard || activeArticle?.articleId === a.articleId) {
          void loadArticles(activeBoard ?? undefined)
        }
        if (activeArticle?.articleId === a.articleId) {
          setActiveArticle(a)
        }
      }
      if (ev.type === 'comment' && ev.comment) {
        // 新评论：正在查看该文章时追加评论并刷新计数
        if (activeArticle?.articleId === ev.comment.articleId) {
          setComments((cur) => (cur.some((c) => c.commentId === ev.comment.commentId) ? cur : [...cur, ev.comment]))
        }
        void loadArticles(activeBoard ?? undefined)
      }
      if (ev.type === 'article-updated' || ev.type === 'board-updated' || ev.type === 'board-deleted') {
        void loadBoards()
        void loadArticles(activeBoard ?? undefined)
        if (ev.type === 'board-deleted' && ev.boardId === activeBoard) {
          setActiveBoard(null)
          setView('board')
        }
      }
    })
    return () => { unsubscribe?.() }
  }, [open, activeBoard, activeArticle, loadBoards, loadArticles])

  const openBoard = (boardId: string | null) => {
    setActiveBoard(boardId)
    setView('board')
    void loadArticles(boardId ?? undefined)
  }

  const openArticle = async (item: PublishListItem) => {
    const r = await window.lunareclipse.publishBoardGetArticle(item.boardId, item.articleId)
    if (r.ok && r.article) {
      setActiveArticle(r.article)
      setBodyExpanded(false)
      setView('article')
      void loadComments(item.articleId)
    } else {
      // 打开详情失败必须提示：否则用户点击列表行无任何反应，也不知道详情为何没加载
      reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
    }
  }

  const createBoard = async () => {
    const name = boardName.trim()
    if (creatingBoard || !name) return
    setCreatingBoard(true)
    try {
      const r = await window.lunareclipse.publishBoardCreateBoard(name, boardDesc.trim() || undefined)
      if (r.ok) {
        setShowCreateBoard(false)
        setBoardName('')
        setBoardDesc('')
        void loadBoards()
        if (r.board) openBoard(r.board.boardId)
      } else {
        reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
      }
    } finally {
      setCreatingBoard(false)
    }
  }

  const deleteBoard = async (boardId: string) => {
    if (busyId || !window.confirm(t('publishBoard.confirmDeleteBoard'))) return
    setBusyId(boardId)
    try {
      const r = await window.lunareclipse.publishBoardDeleteBoard(boardId)
      if (r.ok) {
        if (activeBoard === boardId) {
          setActiveBoard(null)
          setView('board')
        }
        void loadBoards()
        void loadArticles()
      } else {
        reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
      }
    } finally {
      setBusyId(null)
    }
  }

  const publish = async () => {
    if (publishing || !activeBoard || !pubTitle.trim()) return
    setPublishing(true)
    try {
      // 编辑态：走 updateArticle（仅作者本人可改）
      if (editingId) {
        const r = await window.lunareclipse.publishBoardUpdateArticle(activeBoard, editingId, {
          title: pubTitle,
          summary: pubSummary,
          body: pubBody,
        })
        if (r.ok && r.article) {
          setPubTitle('')
          setPubSummary('')
          setPubBody('')
          setEditingId(null)
          setActiveArticle(r.article)
          setBodyExpanded(false)
          setView('article')
          void loadArticles(activeBoard)
        } else {
          reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
        }
        return
      }
      const r = await window.lunareclipse.publishBoardPublish(activeBoard, pubTitle, pubSummary, pubBody)
      if (r.ok && r.article) {
        setPubTitle('')
        setPubSummary('')
        setPubBody('')
        // 发布成功：进入详情并刷新列表
        const item = r.article
        setActiveArticle(item)
        setBodyExpanded(false)
        setView('article')
        void loadComments(item.articleId)
        void loadArticles(activeBoard)
      } else {
        reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
      }
    } finally {
      setPublishing(false)
    }
  }

  /** 进入发布表单（新建态：清空编辑标记与字段） */
  const openPublishForm = () => {
    setEditingId(null)
    setPubTitle('')
    setPubSummary('')
    setPubBody('')
    setView('publish')
  }

  /** 进入编辑表单：复用发布表单，填充原文，提交走 update */
  const openEditForm = (article: PublishArticleItem) => {
    setEditingId(article.articleId)
    setPubTitle(article.title)
    setPubSummary(article.summary)
    setPubBody(article.body)
    setView('publish')
  }

  const togglePin = async (article: PublishArticleItem) => {
    if (busyId) return
    setBusyId(article.articleId)
    try {
      const r = await window.lunareclipse.publishBoardTogglePin(article.boardId, article.articleId)
      if (!r.ok) reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
      await loadArticles(activeBoard ?? undefined)
    } finally {
      setBusyId(null)
    }
  }

  const deleteArticle = async (article: PublishArticleItem) => {
    const { boardId, articleId } = article
    if (busyId || !window.confirm(t('publishBoard.confirmDeleteArticle'))) return
    setBusyId(articleId)
    try {
      const r = await window.lunareclipse.publishBoardDeleteArticle(boardId, articleId)
      if (r.ok) {
        setActiveArticle(null)
        setView('board')
        void loadArticles(activeBoard ?? undefined)
      } else {
        reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
      }
    } finally {
      setBusyId(null)
    }
  }

  const postComment = async () => {
    const text = commentDraft.trim()
    if (commenting || !activeArticle || !text) return
    setCommenting(true)
    try {
      const r = await window.lunareclipse.publishBoardPostComment(activeArticle.articleId, text)
      if (r.ok && r.comment) {
        setCommentDraft('')
        setComments((cur) => [...cur, r.comment!])
        void loadArticles(activeBoard ?? undefined)
      } else {
        reportError(r.error ?? t('publishBoard.operateFail', { error: '' }))
      }
    } finally {
      setCommenting(false)
    }
  }

  const myUid = useAppStore((s) => s.currentUser?.UID ?? 0)

  if (!open) return null

  const showClose = !embedded
  const board = activeBoard !== null ? boards.find((b) => b.boardId === activeBoard) : undefined

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {error && (
        <div className="border-b border-danger/30 bg-danger-soft/60 px-3 py-1.5 text-[11px] text-danger">
          {error}
        </div>
      )}
      {view === 'board' && (
        <BoardView
          ready={ready}
          boards={boards}
          activeBoard={activeBoard}
          articles={articles}
          total={total}
          query={query}
          onQueryChange={setQuery}
          showCreateBoard={showCreateBoard}
          onOpenCreateBoard={() => setShowCreateBoard(true)}
          onCloseCreateBoard={() => setShowCreateBoard(false)}
          boardName={boardName}
          boardDesc={boardDesc}
          onBoardNameChange={setBoardName}
          onBoardDescChange={setBoardDesc}
          creatingBoard={creatingBoard}
          onCreateBoard={() => void createBoard()}
          onOpenBoard={openBoard}
          onDeleteBoard={(boardId) => void deleteBoard(boardId)}
          onOpenArticle={(item) => void openArticle(item)}
          onOpenPublish={openPublishForm}
          onRefresh={refresh}
          showClose={showClose}
          onClose={closeDrawer}
          t={t}
        />
      )}
      {view === 'article' && activeArticle && (
        <ArticleView
          article={activeArticle}
          myUid={myUid}
          comments={comments}
          bodyExpanded={bodyExpanded}
          onToggleBody={() => setBodyExpanded((v) => !v)}
          commentDraft={commentDraft}
          onCommentDraftChange={setCommentDraft}
          commenting={commenting}
          busyId={busyId}
          onBack={() => setView('board')}
          onTogglePin={(a) => void togglePin(a)}
          onEdit={openEditForm}
          onDelete={(a) => void deleteArticle(a)}
          onPostComment={() => void postComment()}
          onRefresh={refresh}
          showClose={showClose}
          onClose={closeDrawer}
          t={t}
        />
      )}
      {view === 'publish' && activeBoard && (
        <PublishView
          editingId={editingId}
          boardName={board?.name ?? ''}
          pubTitle={pubTitle}
          onPubTitleChange={setPubTitle}
          pubSummary={pubSummary}
          onPubSummaryChange={setPubSummary}
          pubBody={pubBody}
          onPubBodyChange={setPubBody}
          publishing={publishing}
          onCancel={() => { setEditingId(null); setView('board') }}
          onPublish={() => void publish()}
          onRefresh={refresh}
          showClose={showClose}
          onClose={closeDrawer}
          t={t}
        />
      )}
    </div>
  )
}