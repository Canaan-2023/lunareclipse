/**
 * 为什么存在：聊天室入口（我的聊天室/邀请双 Tab + 搜索 + 创建）是浏览层
 * 主视图（从 ChatRoomsPanel 拆出），独立便于维护。
 * 作用：渲染聊天室列表页——双 Tab 切换、搜索过滤、聊天室行
 * （成员数/最后消息/未读）与创建聊天室浮层。
 */
import { Users, Plus, RefreshCw, X, Search, Inbox, MessageSquare } from 'lucide-react'
import { useT } from '../../i18n/useT'
import type { ChatRoomItem, ChatRoomInvite, ChatRoomMsg } from './chat-room-types'
import { FOCUS, formatRelativeTime } from './chat-room-utils'

interface ChatRoomListProps {
  embedded: boolean
  ready: boolean | null
  error: string | null
  tab: 'chats' | 'invites'
  setTab: (tab: 'chats' | 'invites') => void
  query: string
  setQuery: (q: string) => void
  /** 后端全文搜索中 */
  searching: boolean
  /** 后端全文消息命中（chatRoomSearch：含未加载的历史群消息） */
  searchMsgs: Array<{ gid: string; message: ChatRoomMsg }> | null
  chatRooms: ChatRoomItem[]
  invites: ChatRoomInvite[]
  showCreate: boolean
  setShowCreate: (show: boolean) => void
  createName: string
  setCreateName: (name: string) => void
  createDesc: string
  setCreateDesc: (desc: string) => void
  refreshing: boolean
  creating: boolean
  acceptingGid: string | null
  /** 正在忽略的邀请 gid（防重复提交，忽略期间禁用对应按钮） */
  ignoringGid: string | null
  onRefresh: () => void
  onClose: () => void
  onOpenChat: (gid: string) => void
  onAcceptInvite: (inv: ChatRoomInvite) => void
  onDismissInvite: (gid: string) => void
  onCreate: () => void
}

/** 列表页：我的聊天室 / 邀请（纯展示，状态由 ChatRoomsPanel 持有） */
export function ChatRoomList(props: ChatRoomListProps) {
  const {
    embedded, ready, error, tab, setTab, query, setQuery, searching, searchMsgs, chatRooms, invites,
    showCreate, setShowCreate, createName, setCreateName, createDesc, setCreateDesc,
    refreshing, creating, acceptingGid, ignoringGid, onRefresh, onClose, onOpenChat,
    onAcceptInvite, onDismissInvite, onCreate,
  } = props
  const t = useT()

  // 本地关键词过滤（聊天室名/简介/最近消息）
  const q = query.trim().toLowerCase()
  const match = (...fields: Array<string | null | undefined>): boolean =>
    !q || fields.some((v) => (v ?? '').toLowerCase().includes(q))
  const shownRooms = chatRooms.filter((g) => match(g.name, g.desc, g.lastMessage))
  const hasSearchHits = searchMsgs !== null && searchMsgs.length > 0

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部：embedded 模式下由外层容器提供标题/关闭，隐藏避免重复 */}
      {!embedded && (
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
            <Users size={13} className="text-accent" />
            {t('chatRoom.title')}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowCreate(true)}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
              title={t('chatRoom.create')}
              aria-label={t('chatRoom.create')}
            >
              <Plus size={12} />
            </button>
            <button
              onClick={() => onRefresh()}
              disabled={refreshing}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50 ${FOCUS}`}
              title={t('view.refresh')}
              aria-label={t('view.refresh')}
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={() => onClose()}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {ready === false && (
        <div className="border-b border-border-subtle bg-danger-soft/50 px-3 py-1.5 text-[11px] text-danger">
          {t('chatRoom.lanOffline')}
        </div>
      )}

      {error && (
        <div className="border-b border-danger/30 bg-danger-soft/60 px-3 py-1.5 text-[11px] text-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex gap-1 border-b border-border-subtle px-2 py-1.5" role="tablist" aria-label={t('chatRoom.title')}>
        {([
          ['chats', t('chatRoom.tab.chats'), chatRooms.length],
          ['invites', t('chatRoom.tab.invites'), invites.length],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1 rounded-btn px-2.5 py-2 text-[11px] transition-colors ${FOCUS} ${
              tab === key ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
          >
            {label}
            {count > 0 && (
              <span className={`rounded-full px-1 text-[9px] ${tab === key ? 'bg-accent text-accent-fg' : 'bg-bg-muted text-fg-muted'}`}>
                {count}
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chatRoom.searchPlaceholder')}
            aria-label={t('chatRoom.searchPlaceholder')}
            className={`w-full rounded-btn border border-border-subtle bg-bg-base py-1.5 pl-6 pr-6 text-caption text-fg-primary outline-none focus:border-accent ${FOCUS}`}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className={`absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:text-fg-primary ${FOCUS}`}
              aria-label={t('common.close')}
            >
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {ready === null && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-fg-muted">
            <RefreshCw size={16} className="animate-spin" />
            <span className="text-caption">{t('chatRoom.loading')}</span>
          </div>
        )}

        {ready !== null && tab === 'chats' && (
          <>
            {/* 后端全文消息命中（优先级最高；点击直达会话） */}
            {searching && !searchMsgs && (
              <div className="px-3 py-3 text-center text-caption text-fg-muted">{t('chatRoom.searchingMessages')}</div>
            )}
            {hasSearchHits && (
              <div className="mb-2 rounded-card border border-border-subtle bg-bg-base/60 p-1.5">
                <div className="mb-1 flex items-center gap-1 px-1 text-micro uppercase tracking-wider text-fg-muted">
                  <MessageSquare size={10} />
                  {t('chatRoom.messageHits', { n: searchMsgs!.length })}
                </div>
                {searchMsgs!.map(({ gid, message }) => {
                  const room = chatRooms.find((x) => x.gid === gid)
                  const title = room ? room.name : gid
                  return (
                    <div
                      key={message.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenChat(gid)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenChat(gid) } }}
                      className="mb-0.5 flex cursor-pointer items-start gap-2 rounded-btn px-2 py-1.5 transition-colors hover:bg-bg-muted/70"
                    >
                      {/* 全文搜索命中行：点击直达会话，补键盘可达；命中区是历史消息的唯一入口（本地列表不含未加载历史），不可删 */}
                      <div className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accent/15 text-[9px] font-medium text-accent">
                        {title.charAt(0)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] font-medium text-fg-primary">{title}</span>
                          <span className="shrink-0 text-[9px] text-fg-muted">{formatRelativeTime(message.ts, t)}</span>
                        </div>
                        <div className="truncate text-caption text-fg-muted">
                          {message.fromName ? `${message.fromName}：` : ''}{message.text}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {shownRooms.length === 0 && !hasSearchHits && !searching ? (
              <div className="px-3 py-8 text-center text-caption text-fg-muted">
                {q ? t('chatRoom.searchNoResult') : t('chatRoom.empty')}
              </div>
            ) : null}
            {/* 聊天室行：点击进入会话，补键盘可达；行是聊天室列表的基础条目，不可删 */}
            {shownRooms.length > 0 && shownRooms.map((g) => (
                <div
                  key={g.gid}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenChat(g.gid)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenChat(g.gid) } }}
                  className="group relative mb-1 flex cursor-pointer items-center gap-2 rounded-btn px-2.5 py-2 transition-colors hover:bg-bg-muted/70"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[11px] font-medium text-accent">
                    {g.name.charAt(0)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-caption font-medium text-fg-primary">
                        {g.name}
                        <span className="ml-1 text-[9px] text-fg-muted">({g.memberCount})</span>
                      </span>
                      <span className="ml-2 shrink-0 text-[9px] text-fg-muted">
                        {g.lastTs ? formatRelativeTime(g.lastTs, t) : ''}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between">
                      <span className="flex-1 truncate text-caption text-fg-muted">
                        {g.lastMessage ?? g.desc ?? t('chatRoom.noMessages')}
                      </span>
                      {g.unread > 0 && (
                        <span className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-medium text-accent-fg">
                          {g.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
          </>
        )}

        {ready !== null && tab === 'invites' && (
          <>
            {invites.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-fg-muted">
                <Inbox size={16} />
                <span className="text-caption">{t('chatRoom.noInvites')}</span>
              </div>
            ) : (
              invites.map((inv) => (
                <div key={inv.gid} className="mb-1 rounded-card border border-accent/30 bg-accent/5 px-2.5 py-2">
                  <div className="text-caption text-fg-primary">{inv.chatRoomName}</div>
                  <div className="mt-0.5 text-[10px] text-fg-muted">{t('chatRoom.inviteFrom', { name: inv.fromName || String(inv.fromUid) })}</div>
                  <div className="mt-1.5 flex gap-1.5">
                    <button
                      onClick={() => onAcceptInvite(inv)}
                      disabled={acceptingGid === inv.gid}
                      className={`rounded-btn bg-accent px-2.5 py-0.5 text-[11px] text-accent-fg hover:bg-accent/90 disabled:opacity-40 ${FOCUS}`}
                    >
                      {t('chatRoom.acceptInvite')}
                    </button>
                    <button
                      onClick={() => onDismissInvite(inv.gid)}
                      disabled={ignoringGid === inv.gid}
                      className={`rounded-btn bg-bg-muted px-2.5 py-0.5 text-[11px] text-fg-muted hover:bg-bg-muted/70 disabled:opacity-40 ${FOCUS}`}
                    >
                      {t('chatRoom.ignoreInvite')}
                    </button>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </div>

      {/* 创建群浮层：点击遮罩或按 Esc 关闭（与发布板/好友编辑浮层的行为一致，键盘用户必须能退出模态） */}
      {showCreate && (
        <div
          className="absolute inset-0 z-20 flex items-center justify-center bg-black/30"
          onClick={() => setShowCreate(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setShowCreate(false) }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="chatroom-create-title"
            className="w-72 rounded-card border border-border bg-bg-elevated p-3 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div id="chatroom-create-title" className="mb-2 text-caption font-medium text-fg-primary">{t('chatRoom.create')}</div>
            <label htmlFor="chatroom-name" className="mb-1 block text-[10px] text-fg-muted">{t('chatRoom.name')}</label>
            <input
              id="chatroom-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onCreate() }}
              autoFocus
              className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <label htmlFor="chatroom-desc" className="mb-1 block text-[10px] text-fg-muted">{t('chatRoom.desc')}</label>
            <input
              id="chatroom-desc"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              className="mb-3 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-1.5">
              <button
                onClick={() => setShowCreate(false)}
                className={`rounded-btn bg-bg-muted px-3 py-1 text-caption text-fg-secondary hover:bg-bg-muted/70 ${FOCUS}`}
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => onCreate()}
                disabled={creating || !createName.trim()}
                className={`rounded-btn bg-accent px-3 py-1 text-caption text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
              >
                {creating ? t('chatRoom.creating') : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}