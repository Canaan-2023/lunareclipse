/**
 * 为什么存在：好友面板入口层级（会话/发现/申请三级 Tab + 搜索 + 我的 AI 分组）
 * 交互密度高，独立成列表视图便于维护。
 * 作用：渲染好友列表页——三级 Tab 切换、搜索过滤、好友/候选/申请行
 * （接受/拒绝/删除）、与「我的 AI」会话分组入口。
 */
import { Users, UserPlus, Check, X, Ban, Trash2, User, Pencil, RefreshCw, Search, MessageSquare, Bot } from 'lucide-react'
import type { TFunc } from '../../i18n/useT'
import type { CandidateItem, FriendItem, FriendMsg, AiSocialChatListItem } from './types'
import { FOCUS } from './types'
import { formatRelativeTime } from './utils'
import { Avatar } from './Avatar'
import { RelayPanel } from './RelayPanel'

interface FriendListViewProps {
  /** embedded 模式下头部由外层容器提供，隐藏本组件头部 */
  embedded: boolean
  /** null=LAN 检测中；false=LAN 未启动；true=已加载 */
  ready: boolean | null
  error: string | null
refreshing: boolean
  tab: 'chats' | 'discover' | 'requests' | 'relay'
  onTabChange: (tab: 'chats' | 'discover' | 'requests' | 'relay') => void
  query: string
  onQueryChange: (q: string) => void
  /** 后端全文搜索中 */
  searching: boolean
  /** 后端全文消息命中（friendSearch：含未加载的历史消息） */
  searchMsgs: Array<{ uid: number; message: FriendMsg }> | null
  friends: FriendItem[]
  candidates: CandidateItem[]
  /** ：我的 AI（注册表未停用 AI 的会话列表项） */
  aiChats: AiSocialChatListItem[]
  activeAiId: number | null
busyUids: number[]
  activeUid: number | null
  /** 中继待确认数（我收到的尚未领取条目），驱动「中继」Tab 徽标提醒去确认下载 */
  relayPending: number
  onRefresh: () => void
  onClose: () => void
  onOpenChat: (uid: number) => void
  onOpenAiChat: (aiId: number) => void
  onOpenEdit: (uid: number, group: string, note: string, trigger: HTMLElement) => void
  onBlock: (uid: number) => void
  onRemove: (uid: number) => void
  onUnblock: (uid: number) => void
  onAddFriend: (uid: number) => void
  onAccept: (uid: number) => void
  onReject: (uid: number) => void
  t: TFunc
}

/** 好友面板 · 列表页：会话 / 发现 / 请求三个子视图（受控组件，状态不下放） */
export function FriendListView({
  embedded,
  ready,
  error,
  refreshing,
  tab,
  onTabChange,
  query,
  onQueryChange,
  searching,
  searchMsgs,
  friends,
  candidates,
  aiChats,
  activeAiId,
busyUids,
  activeUid,
  relayPending,
  onRefresh,
  onClose,
  onOpenChat,
  onOpenAiChat,
  onOpenEdit,
  onBlock,
  onRemove,
  onUnblock,
  onAddFriend,
  onAccept,
  onReject,
  t,
}: FriendListViewProps) {
  const friendItems = friends.filter((f) => f.status === 'friend')
  const requestItems = friends.filter((f) => f.status === 'pending')
  const blockedItems = friends.filter((f) => f.status === 'blocked')
  // 本地关键词过滤（列表已加载；不发请求）
  const q = query.trim().toLowerCase()
  const match = (...fields: Array<string | null | undefined>): boolean =>
    !q || fields.some((v) => (v ?? '').toLowerCase().includes(q))
  const shownFriends = friendItems.filter((f) => match(f.昵称, f.备注, f.分组, f.lastMessage))
  const shownRequests = requestItems.filter((f) => match(f.昵称, f.备注))
  const shownBlocked = blockedItems.filter((f) => match(f.昵称, f.备注))
  const shownCandidates = candidates.filter((c) => match(c.用户名, String(c.uid)))
  // ：我的 AI 分组（本机注册表未停用 AI；对端恒在线，未读数来自会话）
  const shownAiChats = aiChats.filter((c) => match(c.contact.name, c.lastMessage, c.contact.description))
  const hasSearchHits = searchMsgs !== null && searchMsgs.length > 0
  const noMatch = q.length > 0 && !hasSearchHits && shownFriends.length + shownRequests.length + shownCandidates.length + shownBlocked.length + shownAiChats.length === 0

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部：embedded 模式下由外层容器提供标题/关闭，隐藏避免重复 */}
      {!embedded && (
        <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
          <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
            <Users size={13} className="text-accent" />
            {t('friend.title')}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void onRefresh()}
              disabled={refreshing}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50 ${FOCUS}`}
              title={t('view.refresh')}
              aria-label={t('view.refresh')}
            >
              <RefreshCw size={11} className={refreshing ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
              title={t('common.close')}
              aria-label={t('common.close')}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* LAN 状态 */}
      {ready === false && (
        <div className="border-b border-border-subtle bg-danger-soft/50 px-3 py-1.5 text-[11px] text-danger">
          {t('friend.lanOffline')}
        </div>
      )}

      {/* 操作错误提示 */}
      {error && (
        <div className="border-b border-danger/30 bg-danger-soft/60 px-3 py-1.5 text-[11px] text-danger" role="alert">
          {error}
        </div>
      )}

      {/* 子视图切换 */}
      <div className="flex gap-1 border-b border-border-subtle px-2 py-1.5" role="tablist" aria-label={t('friend.title')}>
{([
          ['chats', t('friend.tab.chats'), friendItems.length],
          ['discover', t('friend.tab.discover'), candidates.length],
          ['requests', t('friend.tab.requests'), requestItems.length],
          ['relay', t('friend.tab.relay'), relayPending],
        ] as const).map(([key, label, count]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => onTabChange(key)}
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
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t('friend.searchPlaceholder')}
            aria-label={t('friend.searchPlaceholder')}
            className={`w-full rounded-btn border border-border-subtle bg-bg-base py-1.5 pl-6 pr-6 text-caption text-fg-primary outline-none focus:border-accent ${FOCUS}`}
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

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-2">
        {/* 初始加载：LAN 检测中 */}
        {ready === null && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-fg-muted">
            <RefreshCw size={16} className="animate-spin" />
            <span className="text-caption">{t('friend.loading')}</span>
          </div>
        )}

        {ready !== null && noMatch && (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">{t('friend.searchNoResult')}</div>
        )}

        {ready !== null && tab === 'relay' && (
          <RelayPanel friends={friends} t={t} />
        )}

        {ready !== null && !noMatch && tab === 'chats' && (
          <>
            {/* 后端全文消息命中（优先级最高；点击直达会话） */}
            {searching && !searchMsgs && (
              <div className="px-3 py-3 text-center text-caption text-fg-muted">{t('friend.searchingMessages')}</div>
            )}
            {searchMsgs && searchMsgs.length > 0 && (
              <div className="mb-2 rounded-card border border-border-subtle bg-bg-base/60 p-1.5">
                <div className="mb-1 flex items-center gap-1 px-1 text-micro uppercase tracking-wider text-fg-muted">
                  <MessageSquare size={10} />
                  {t('friend.messageHits', { n: searchMsgs.length })}
                </div>
                {searchMsgs.map(({ uid, message }) => {
                  const f = friends.find((x) => x.uid === uid)
                  const name = f ? (f.备注 || f.昵称) : `UID ${uid}`
                  return (
                    <div
                      key={message.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => onOpenChat(uid)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenChat(uid) } }}
                      className="group mb-0.5 flex cursor-pointer items-start gap-2 rounded-btn px-2 py-1.5 transition-colors hover:bg-bg-muted/70"
                    >
                      {/* 命中行承载“直达会话”：补键盘可达性，Enter/Space 等效点击；行是全文搜索结果的唯一入口，不可删 */}
                      <Avatar name={name} size={18} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-[11px] font-medium text-fg-primary">{name}</span>
                          <span className="shrink-0 text-[9px] text-fg-muted">{formatRelativeTime(message.ts, t)}</span>
                        </div>
                        <div className="truncate text-caption text-fg-muted">{message.text}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {/* 我的 AI：本机注册表 AI 实体（不依赖 LAN；点击进入 AI 私聊） */}
            {aiChats.length > 0 && (
              <div className="mb-2">
                <div className="mb-1 flex items-center gap-1 px-2.5 text-micro uppercase tracking-wider text-fg-muted">
                  <Bot size={10} />
                  {t('friend.myAi')}
                </div>
{shownAiChats.map((c) => (
                  <div
                    key={c.aiId}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpenAiChat(c.aiId)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenAiChat(c.aiId) } }}
                    className={`group mb-1 flex cursor-pointer items-center gap-2 rounded-btn px-2.5 py-2 transition-colors ${
                      activeAiId === c.aiId ? 'bg-accent/15 ring-1 ring-accent/30' : 'hover:bg-bg-muted/70'
                    }`}
                  >
                    {/* AI 会话行：点击进入 AI 私聊，补键盘可达；“我的 AI”分组是 AI 私聊的唯一入口，不可删 */}
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 text-accent">
                      {c.contact.avatar ? (
                        <span className="text-[13px] leading-none" aria-hidden="true">{c.contact.avatar}</span>
                      ) : (
                        <Bot size={13} />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-caption font-medium text-fg-primary">
                          {c.contact.name}
                          <span className="ml-1 text-[9px] font-normal text-fg-muted">{c.contact.uid}-{c.aiId}</span>
                        </span>
                        <span className="ml-2 shrink-0 text-[9px] text-fg-muted">
                          {c.lastTs ? formatRelativeTime(c.lastTs, t) : ''}
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center justify-between">
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" role="img" aria-label={t('friend.online')} />
                          <span className="flex-1 truncate text-caption text-fg-muted">
                            {c.lastMessage ?? t('friend.noMessages')}
                          </span>
                        </span>
                        {c.unread > 0 && (
                          <span
                            className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-medium text-accent-fg"
                            aria-label={t('friend.unreadCount', { n: c.unread })}
                          >
                            {c.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {shownAiChats.length === 0 && aiChats.length > 0 && (
              <div className="px-3 py-2 text-center text-caption text-fg-muted">{t('friend.searchNoResult')}</div>
            )}
            {shownFriends.length === 0 && !hasSearchHits && !searching && shownAiChats.length === 0 ? (
              <div className="px-3 py-8 text-center text-caption text-fg-muted">
                {q ? t('friend.searchNoResult') : t('friend.empty')}
              </div>
            ) : null}
            {shownFriends.length > 0 && (
              <>
              {/* 好友行：点击进入私聊（内置编辑/屏蔽/删除按钮），补键盘可达；“会话”Tab 的主体条目，不可删 */}
              {shownFriends.map((f) => (
                <div
                  key={f.uid}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenChat(f.uid)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenChat(f.uid) } }}
                  className={`group relative mb-1 flex cursor-pointer items-center gap-2 rounded-btn px-2.5 py-2 transition-colors ${
                    activeUid === f.uid ? 'bg-accent/15 ring-1 ring-accent/30' : 'hover:bg-bg-muted/70'
                  }`}
                >
                  <Avatar name={f.备注 || f.昵称} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="truncate text-caption font-medium text-fg-primary">
                        {f.备注 || f.昵称}
                      </span>
                      <span className="ml-2 shrink-0 text-[9px] text-fg-muted">
                        {f.lastTs ? formatRelativeTime(f.lastTs, t) : ''}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between">
                      <span className="flex min-w-0 items-center gap-1">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${f.online ? 'bg-success' : 'bg-fg-muted/40'}`}
                          role="img"
                          aria-label={f.online ? t('friend.online') : t('friend.offline')}
                        />
                        <span className="flex-1 truncate text-caption text-fg-muted">
                          {f.lastMessage ?? t('friend.noMessages')}
                        </span>
                      </span>
                      {f.unread > 0 && (
                        <span
                          className="ml-2 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-medium text-accent-fg"
                          aria-label={t('friend.unreadCount', { n: f.unread })}
                        >
                          {f.unread}
                        </span>
                      )}
                    </div>
                  </div>
                  {/* 操作按钮常驻（低对比度），hover 行时提升 */}
                  <div className="flex shrink-0 gap-0.5 opacity-40 transition-opacity group-hover:opacity-100">
                    <button
                      onClick={(e) => { e.stopPropagation(); onOpenEdit(f.uid, f.分组, f.备注 ?? '', e.currentTarget) }}
                      disabled={busyUids.includes(f.uid)}
                      className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-accent disabled:opacity-40 ${FOCUS}`}
                      title={t('friend.editGroup')}
                      aria-label={t('friend.editGroup')}
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); void onBlock(f.uid) }}
                      disabled={busyUids.includes(f.uid)}
                      className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
                      title={t('friend.block')}
                      aria-label={t('friend.block')}
                    >
                      <Ban size={10} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); void onRemove(f.uid) }}
                      disabled={busyUids.includes(f.uid)}
                      className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
                      title={t('friend.remove')}
                      aria-label={t('friend.remove')}
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                </div>
              ))}
              </>
            )}
            {/* 已拉黑折叠 */}
            {shownBlocked.length > 0 && (
              <div className="mt-3 border-t border-border-subtle pt-2">
                <div className="mb-1 px-2.5 text-micro uppercase tracking-wider text-fg-muted">{t('friend.blocked')}</div>
                {shownBlocked.map((f) => (
                  <div key={f.uid} className="mb-1 flex items-center gap-2 rounded-btn px-2.5 py-1.5 text-caption text-fg-muted">
                    <User size={12} className="shrink-0" />
                    <span className="flex-1 truncate">{f.昵称}</span>
                    <button
                      onClick={() => void onUnblock(f.uid)}
                      disabled={busyUids.includes(f.uid)}
                      className={`shrink-0 rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary hover:text-accent disabled:opacity-40 ${FOCUS}`}
                    >
                      {t('friend.unblock')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {ready !== null && !noMatch && tab === 'discover' && (
          <>
            {shownCandidates.length === 0 ? (
              <div className="px-3 py-8 text-center text-caption text-fg-muted">{q ? t('friend.searchNoResult') : t('friend.emptyDiscover')}</div>
            ) : (
              shownCandidates.map((c) => (
                <div key={c.uid} className="mb-1 flex items-center gap-2 rounded-btn px-2.5 py-2 hover:bg-bg-muted/70">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.online ? 'bg-success' : 'bg-fg-muted/40'}`}
                    role="img"
                    aria-label={c.online ? t('friend.online') : t('friend.offline')}
                  />
                  <Avatar name={c.用户名} />
                  <span className="min-w-0 flex-1 truncate text-caption text-fg-primary">{c.用户名}</span>
                  <button
                    onClick={() => void onAddFriend(c.uid)}
                    disabled={busyUids.includes(c.uid)}
                    className={`flex shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40 ${FOCUS}`}
                    title={t('friend.requestHint')}
                    aria-label={t('friend.add')}
                  >
                    <UserPlus size={10} />
                    {t('friend.add')}
                  </button>
                </div>
              ))
            )}
          </>
        )}

        {ready !== null && !noMatch && tab === 'requests' && (
          <>
            {shownRequests.length === 0 ? (
              <div className="px-3 py-8 text-center text-caption text-fg-muted">{q ? t('friend.searchNoResult') : t('friend.emptyRequests')}</div>
            ) : (
              shownRequests.map((f) => (
                <div key={f.uid} className="mb-1 flex items-center gap-2 rounded-btn px-2.5 py-2 hover:bg-bg-muted/70">
                  <User size={13} className="shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate text-caption text-fg-primary">{f.昵称}</span>
                  <button
                    onClick={() => void onAccept(f.uid)}
                    disabled={busyUids.includes(f.uid)}
                    className={`flex shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40 ${FOCUS}`}
                    aria-label={t('friend.accept')}
                  >
                    <Check size={10} />
                    {t('friend.accept')}
                  </button>
                  <button
                    onClick={() => void onReject(f.uid)}
                    disabled={busyUids.includes(f.uid)}
                    className={`flex shrink-0 items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[10px] text-fg-secondary hover:text-danger disabled:opacity-40 ${FOCUS}`}
                    aria-label={t('friend.reject')}
                  >
                    <X size={10} />
                    {t('friend.reject')}
                  </button>
                </div>
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}