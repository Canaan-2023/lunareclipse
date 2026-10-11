/**
 * 为什么存在：局域网好友 + 私聊 + 本机 AI 私聊的社交能力需要统一面板入口，
 * 事件驱动（请求/消息/在线态）状态集中在主组件持有（批次 E-5a 拆分产物）。
 * 作用：渲染好友面板——视图状态机（列表/私聊/AI 私聊）、onFriendEvent 事件订阅、
 * AI 代聊开关、好友增删改与我的 AI 会话。
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import type { FriendItem, CandidateItem, FriendMsg, View, AiSocialContact, AiSocialChatListItem, AiChatMessage } from './types'
import type { RelayEvent } from '../../../electron/main/multi-instance/relay/relay-types'
import { FriendListView } from './FriendListView'
import { FriendChatView, type FileProgress } from './FriendChatView'
import { AiChatView } from './AiChatView'
import { FriendEditDialog } from './FriendEditDialog'

/**
 * 好友面板（右侧抽屉）：局域网好友 + 私聊 + 本机 AI 私聊。
 * - 上层 API：window.lunareclipse.friend*（主进程 FriendService → L0 LAN 直连）
 * - 实时事件：onFriendEvent（收到请求/接受回执/新消息/在线态变化）驱动列表与消息追加
 * - AI 代聊：aiAgentGet/SetDirectChat 控制本机 AI 是否自动回复该好友（好友系统对 AI 开放）
 * - 我的 AI：aiSocial* 会话独立于好友列表，`aiChats` 驱动「我的 AI」分组，
 * 会话消息走 AiChatMessage（真人↔AI），对端恒在线
 * - 批次 E-5a 拆分：列表/私聊/编辑浮层已抽为受控子组件（状态仍全部驻留本组件，不下放）
 */
export function FriendsPanel({ embedded, externalQuery }: { embedded?: boolean; externalQuery?: string } = {}) {
  const open = useAppStore((s) => (embedded || s.activeDrawer === 'friend') && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const myUid = useAppStore((s) => s.currentUser?.UID ?? 0)
  const t = useT()

  const [ready, setReady] = useState<boolean | null>(null) // null=检测中
  const [view, setView] = useState<View>('list')
  const [activeUid, setActiveUid] = useState<number | null>(null)
  // ：当前 AI 私聊对端（aiId；null=未在 AI 会话）
  const [activeAiId, setActiveAiId] = useState<number | null>(null)
  const [tab, setTab] = useState<'chats' | 'discover' | 'requests' | 'relay'>('chats')
  const [query, setQuery] = useState('')
  const [friends, setFriends] = useState<FriendItem[]>([])
  const [candidates, setCandidates] = useState<CandidateItem[]>([])
  const [messages, setMessages] = useState<FriendMsg[]>([])
  const [draft, setDraft] = useState('')
  // ：AI 社交数据（我的 AI 分组 + AI 私聊会话）
  const [aiContacts, setAiContacts] = useState<AiSocialContact[]>([])
  const [aiChats, setAiChats] = useState<AiSocialChatListItem[]>([])
  const [aiMessages, setAiMessages] = useState<AiChatMessage[]>([])
  const [editUid, setEditUid] = useState<number | null>(null)
  const [editGroup, setEditGroup] = useState('')
  const [editNote, setEditNote] = useState('')
  // 交互反馈：刷新旋转 / 发送中 / 逐条操作防重 / 错误提示
  const [refreshing, setRefreshing] = useState(false)
  const [sending, setSending] = useState(false)
  const [busyUids, setBusyUids] = useState<number[]>([])
  const [error, setError] = useState<string | null>(null)
  // 编辑浮层保存中：防双击重复提交 friendUpdate（幂等性未知，重复点击会发两次 IPC），期间禁用保存按钮
  const [savingEdit, setSavingEdit] = useState(false)
  // 本机 AI 是否自动回复当前私聊（好友系统对 AI 开放）
  const [aiReplyOn, setAiReplyOn] = useState(false)
  // 邀请制直传：文件邀请操作进行中（dialog/同意/拒绝/撤回防重）与传输进度快照（transferId → 进度）
  const [fileBusy, setFileBusy] = useState(false)
  const [fileProgress, setFileProgress] = useState<Record<string, FileProgress>>({})
  // 后端全文搜索命中（联系人与私聊消息全文，覆盖已加载列表之外的历史消息）；null=未搜索/无结果
  const [searching, setSearching] = useState(false)
  const [searchMsgs, setSearchMsgs] = useState<Array<{ uid: number; message: FriendMsg }> | null>(null)
  // 中继待确认数：我收到的、尚未下载的条目数（驱动「中继」Tab 徽标，提示去领取）
  const [relayPending, setRelayPending] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const editGroupRef = useRef<HTMLInputElement>(null)
  const editTriggerRef = useRef<HTMLElement | null>(null)
  const searchTimer = useRef<number | null>(null)

  const reportError = useCallback((msg: string) => {
    setError(msg)
    window.setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 4000)
  }, [])

  const loadList = useCallback(async () => {
    const r = await window.lunareclipse.friendList()
    if (r.ok && r.list) {
      setFriends(r.list)
      setReady(true)
    } else {
      // LAN 未启动：显示禁用态
      setReady(false)
    }
  }, [])

  // ：我的 AI 分组与 AI 私聊会话
  const loadAiChats = useCallback(async () => {
    const r = await window.lunareclipse.aiSocialChats()
    if (r.ok && r.list) {
      setAiChats(r.list)
      setAiContacts(r.list.map((x) => x.contact))
    }
  }, [])

  const loadAiContacts = useCallback(async () => {
    const r = await window.lunareclipse.aiSocialContacts()
    if (r.ok && r.contacts) setAiContacts(r.contacts)
  }, [])

  const loadAiMessages = useCallback(async (aiId: number) => {
    const r = await window.lunareclipse.aiSocialMessages(aiId)
    if (r.ok && r.messages) {
      setAiMessages(r.messages)
      void window.lunareclipse.aiSocialMarkRead(aiId)
      void loadAiChats()
    }
  }, [loadAiChats])

  const loadCandidates = useCallback(async () => {
    const r = await window.lunareclipse.friendCandidates()
    if (r.ok && r.candidates) setCandidates(r.candidates)
  }, [])

  const loadMessages = useCallback(async (uid: number) => {
    const r = await window.lunareclipse.friendMessages(uid)
    if (r.ok && r.messages) {
      setMessages(r.messages)
      void window.lunareclipse.friendMarkRead(uid)
    }
  }, [])

  // 中继待确认数：与我收到的、尚未取走（uploaded/notified）的中继条目一致，
  // 与 RelayPanel 的 canConfirm 同口径，驱动「中继」Tab 徽标（对方经中继发来需确认领取）
  const loadRelayPending = useCallback(async () => {
    const r = await window.lunareclipse.relayList()
    if (r.ok && r.list) {
      setRelayPending(r.list.filter((i) => i.direction === 'receive' && (i.status === 'uploaded' || i.status === 'notified')).length)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadList(), loadCandidates(), loadAiChats()])
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, loadList, loadCandidates, loadAiChats])

  /** 逐条操作防重：执行期间该 uid 的按钮禁用 */
  const runForUid = useCallback(async (uid: number, fn: () => Promise<{ ok: boolean }>) => {
    if (busyUids.includes(uid)) return
    setBusyUids((cur) => [...cur, uid])
    try {
      const r = await fn()
      if (!r.ok) reportError(t('friend.operateFailed'))
      await loadList()
    } finally {
      setBusyUids((cur) => cur.filter((x) => x !== uid))
    }
  }, [busyUids, loadList, reportError, t])

  // 打开面板：检测 LAN 状态 + 拉列表（含我的 AI）
  useEffect(() => {
    if (!open) return
    void loadList()
    void loadCandidates()
    void loadAiChats()
    void loadAiContacts()
    void loadRelayPending()
  }, [open, loadList, loadCandidates, loadAiChats, loadAiContacts, loadRelayPending])

  // 中继待确认徽标实时化：条目/状态变化（entry/notify/done/revoked/error）后刷新；
  // progress 是高频传输进度，徽标口径不依赖它，跳过。RelayPanel 内部也订阅同源事件，
  // 两者各自刷新互不冲突。
  useEffect(() => {
    if (!open) return
    const unsubscribe = window.lunareclipse.onRelayEvent((ev: RelayEvent) => {
      if (ev.type === 'progress') return
      void loadRelayPending()
    })
    return () => { unsubscribe?.() }
  }, [open, loadRelayPending])

  // 实时事件订阅（消息/在线态/请求 + 文件传输全生命周期）
  useEffect(() => {
    if (!open) return
    const unsubscribe = window.lunareclipse.onFriendEvent((ev) => {
      const e = ev as {
        type: string
        uid?: number
        message?: FriendMsg
        online?: boolean
        transferId?: string
        ok?: boolean
        doneBytes?: number
        totalBytes?: number
        doneFiles?: number
        totalFiles?: number
      }
      if (e.type === 'message' && e.uid === activeUid && e.message) {
        setMessages((m) => (m.some((x) => x.id === e.message!.id) ? m : [...m, e.message!]))
        void window.lunareclipse.friendMarkRead(activeUid)
      }
      // 文件传输事件：进度刷新瞬态条；终态（完成/拒绝/撤回/失败）清进度并重载消息
      if (e.type === 'file-progress' && e.transferId) {
        setFileProgress((cur) => ({
          ...cur,
          [e.transferId!]: {
            doneBytes: e.doneBytes ?? 0,
            totalBytes: e.totalBytes ?? 0,
            doneFiles: e.doneFiles ?? 0,
            totalFiles: e.totalFiles ?? 0
          }
        }))
      }
      if (e.transferId && e.type !== 'file-progress') {
        setFileProgress((cur) => {
          if (!(e.transferId! in cur)) return cur
          const next = { ...cur }
          delete next[e.transferId!]
          return next
        })
      }
      if (e.type === 'file-invite-sent' || e.type === 'file-accepted' || e.type === 'file-rejected' || e.type === 'file-canceled' || e.type === 'file-done' || e.type === 'file-relayed' || e.type === 'file-resume') {
        if (e.uid === activeUid) void loadMessages(activeUid)
      }
      // 任一事件都刷新列表（在线态/未读/请求变化）
      void loadList()
      if (tab === 'discover') void loadCandidates()
    })
    return () => { unsubscribe?.() }
  }, [open, activeUid, tab, loadList, loadCandidates, loadMessages])

  // ：AI 私聊实时事件（真人↔AI 会话消息/已读）
  useEffect(() => {
    if (!open) return
    const unsubscribe = window.lunareclipse.onAiSocialEvent((ev) => {
      if (ev.type === 'message') {
        const msg = ev.message
        const isActive = activeAiId !== null && msg.fromAiId === activeAiId
        if (isActive) {
          setAiMessages((m) => (m.some((x) => x.id === msg.id) ? m : [...m, msg]))
          void window.lunareclipse.aiSocialMarkRead(activeAiId)
        } else {
          // 非当前会话：只刷未读列表
          void loadAiChats()
        }
      }
      if (ev.type === 'read') void loadAiChats()
    })
    return () => { unsubscribe?.() }
  }, [open, activeAiId, loadAiChats])

  // 列表滚动到底
  useEffect(() => {
    if (view === 'chat' && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [view, messages])

  /** 全文搜索：输入防抖 350ms 后调后端 friendSearch（含未加载历史消息），命中消息可点击直达会话 */
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current)
    // 外部搜索框（SocialBrowserPanel 地址栏）与面板内搜索共用同一查询源：
    // 地址栏输入即触发消息搜索，否则那个输入框只改面包屑文本、无任何过滤效果（无效控件）
    const kw = (externalQuery || query).trim()
    if (!kw) {
      setSearching(false)
      setSearchMsgs(null)
      return
    }
    setSearching(true)
    searchTimer.current = window.setTimeout(async () => {
      const r = await window.lunareclipse.friendSearch(kw)
      // 搜索失败不能静默吞掉：置空命中并提示，避免用户误以为“无结果”
      if (!r.ok) reportError(t('friend.operateFailed'))
      setSearchMsgs(r.ok ? (r.messages ?? []) : null)
      setSearching(false)
    }, 350)
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current)
    }
  }, [query, externalQuery])

  // 聊天视图 Esc 返回列表
  useEffect(() => {
    if (view !== 'chat') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setView('list')
        setActiveUid(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  // 编辑浮层：自动聚焦 + Esc 关闭 + 关闭后焦点归还触发按钮
  useEffect(() => {
    if (editUid === null) return
    editGroupRef.current?.focus()
    editGroupRef.current?.select()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEdit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // closeEdit 每次渲染重建但行为一致（仅操作 ref/DOM），deps 只需 editUid
  }, [editUid])

  const openChat = (uid: number) => {
    setActiveUid(uid)
    setActiveAiId(null)
    setView('chat')
    setAiReplyOn(false)
    void loadMessages(uid)
    void window.lunareclipse.aiAgentGetDirectChat(uid).then((r) => {
      if (r.ok) setAiReplyOn(!!r.enabled)
    })
  }

  /** ：打开与某 AI 的私聊（真人↔AI） */
  const openAiChat = (aiId: number) => {
    setActiveAiId(aiId)
    setActiveUid(null)
    setView('chat')
    void loadAiMessages(aiId)
  }

  /** ：向当前 AI 发送消息（触发对端 AI 自动回复） */
  const sendAi = async () => {
    const text = draft.trim()
    if (sending || !text || activeAiId === null) return
    setSending(true)
    try {
      const r = await window.lunareclipse.aiSocialSend(activeAiId, text)
      if (r.ok) {
        setDraft('')
        if (inputRef.current) inputRef.current.style.height = 'auto'
        await loadAiMessages(activeAiId)
        void loadAiChats()
      } else {
        reportError(t('friend.sendFailed'))
      }
    } finally {
      setSending(false)
    }
  }

  const toggleAiReply = async () => {
    if (activeUid === null) return
    const next = !aiReplyOn
    const r = await window.lunareclipse.aiAgentSetDirectChat(activeUid, next)
    if (r.ok) setAiReplyOn(next)
    else reportError(t('friend.operateFailed'))
  }

  const send = async () => {
    const text = draft.trim()
    if (sending || !text || activeUid === null) return
    setSending(true)
    try {
      const r = await window.lunareclipse.friendSendMessage(activeUid, text)
      if (r.ok) {
        setDraft('')
        if (inputRef.current) inputRef.current.style.height = 'auto'
        await loadMessages(activeUid)
        void loadList()
      } else {
        reportError(t('friend.sendFailed'))
      }
    } finally {
      setSending(false)
    }
  }

  // ===== 邀请制直传：发送方选文件/文件夹 → 只发邀请信封；接收方同意 → 对方推流 =====
  const inviteFile = async (uid: number, mode: 'file' | 'dir') => {
    if (fileBusy) return
    setFileBusy(true)
    try {
      // 主进程 dialog 选择对象（取消不报错）
      const r = await window.lunareclipse.friendInviteFile(uid, mode)
      if (!r.ok && !r.canceled) reportError(r.error ?? t('friend.operateFailed'))
      if (r.ok) {
        await loadMessages(uid)
        void loadList()
      }
    } finally {
      setFileBusy(false)
    }
  }

  const acceptFile = async (uid: number, transferId: string) => {
    if (fileBusy) return
    setFileBusy(true)
    try {
      const r = await window.lunareclipse.friendAcceptFileInvite(uid, transferId)
      if (!r.ok) reportError(r.error ?? t('friend.operateFailed'))
      await loadMessages(uid)
    } finally {
      setFileBusy(false)
    }
  }

  const rejectFile = async (uid: number, transferId: string) => {
    if (fileBusy) return
    setFileBusy(true)
    try {
      const r = await window.lunareclipse.friendRejectFileInvite(uid, transferId)
      if (!r.ok) reportError(r.error ?? t('friend.operateFailed'))
      await loadMessages(uid)
    } finally {
      setFileBusy(false)
    }
  }

  const cancelFile = async (uid: number, transferId: string) => {
    if (fileBusy) return
    setFileBusy(true)
    try {
      const r = await window.lunareclipse.friendCancelFileInvite(uid, transferId)
      if (!r.ok) reportError(r.error ?? t('friend.operateFailed'))
      await loadMessages(uid)
    } finally {
      setFileBusy(false)
    }
  }

  /** 发送方切换到中继线路：直传不可达/失败时改走中继（接收方在中继面板确认后领取） */
  const switchToRelay = async (uid: number, transferId: string) => {
    if (fileBusy) return
    setFileBusy(true)
    try {
      const r = await window.lunareclipse.friendSwitchToRelay(uid, transferId)
      if (!r.ok) reportError(r.error ?? t('friend.operateFailed'))
      await loadMessages(uid)
      void loadList()
    } finally {
      setFileBusy(false)
    }
  }

  const openFileLocation = async (uid: number, transferId: string) => {
    const r = await window.lunareclipse.friendOpenFileLocation(uid, transferId)
    if (!r.ok) reportError(r.error ?? t('friend.operateFailed'))
  }

  const accept = (uid: number) => runForUid(uid, () => window.lunareclipse.friendAccept(uid))
  const reject = (uid: number) => runForUid(uid, () => window.lunareclipse.friendReject(uid))
  const block = (uid: number) => runForUid(uid, () => window.lunareclipse.friendBlock(uid))
  const unblock = (uid: number) => runForUid(uid, () => window.lunareclipse.friendUnblock(uid))
  const addFriend = (uid: number) => runForUid(uid, () => window.lunareclipse.friendRequest(uid))

  const remove = async (uid: number) => {
    if (busyUids.includes(uid)) return
    if (!window.confirm(t('friend.confirmRemove'))) return
    setBusyUids((cur) => [...cur, uid])
    try {
      const r = await window.lunareclipse.friendRemove(uid)
      if (!r.ok) reportError(t('friend.operateFailed'))
      if (activeUid === uid) {
        setActiveUid(null)
        setView('list')
      }
      await loadList()
    } finally {
      setBusyUids((cur) => cur.filter((x) => x !== uid))
    }
  }

  const openEdit = (uid: number, group: string, note: string, trigger: HTMLElement) => {
    editTriggerRef.current = trigger
    setEditUid(uid)
    setEditGroup(group)
    setEditNote(note ?? '')
  }

  const closeEdit = () => {
    setEditUid(null)
    editTriggerRef.current?.focus()
    editTriggerRef.current = null
  }

  const saveEdit = async () => {
    if (editUid === null || savingEdit) return
    setSavingEdit(true)
    try {
      const r = await window.lunareclipse.friendUpdate(editUid, { 备注: editNote, 分组: editGroup })
      if (!r.ok) reportError(t('friend.operateFailed'))
      closeEdit()
      void loadList()
    } finally {
      setSavingEdit(false)
    }
  }

  if (!open) return null

  const contact = view === 'chat' && activeUid !== null ? friends.find((f) => f.uid === activeUid) : undefined
  const aiContact = view === 'chat' && activeAiId !== null
    ? aiContacts.find((c) => c.aiId === activeAiId)
    : undefined

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {view === 'chat' ? (
        aiContact ? (
          <AiChatView
            contact={aiContact}
            messages={aiMessages}
            sending={sending}
            draft={draft}
            onDraftChange={setDraft}
            onBack={() => { setView('list'); setActiveAiId(null) }}
            onClose={closeDrawer}
            onSend={() => void sendAi()}
            listRef={listRef}
            inputRef={inputRef}
            t={t}
          />
        ) : contact ? (
          <FriendChatView
            contact={contact}
            myUid={myUid}
            messages={messages}
            aiReplyOn={aiReplyOn}
            sending={sending}
            fileBusy={fileBusy}
            progress={fileProgress}
            draft={draft}
            onDraftChange={setDraft}
            busyUids={busyUids}
            onBack={() => { setView('list'); setActiveUid(null) }}
            onClose={closeDrawer}
            onToggleAiReply={() => void toggleAiReply()}
            onRemove={(uid) => void remove(uid)}
            onSend={() => void send()}
            onInviteFile={(mode) => { if (activeUid !== null) void inviteFile(activeUid, mode) }}
            onAcceptFile={(uid, tid) => void acceptFile(uid, tid)}
            onRejectFile={(uid, tid) => void rejectFile(uid, tid)}
            onCancelFile={(uid, tid) => void cancelFile(uid, tid)}
            onSwitchToRelay={(uid, tid) => void switchToRelay(uid, tid)}
            onOpenFileLocation={(uid, tid) => void openFileLocation(uid, tid)}
            listRef={listRef}
            inputRef={inputRef}
            t={t}
          />
        ) : null
      ) : (
        <FriendListView
          embedded={embedded ?? false}
          ready={ready}
          error={error}
          refreshing={refreshing}
          tab={tab}
          onTabChange={setTab}
          query={query}
          onQueryChange={setQuery}
          searching={searching}
          searchMsgs={searchMsgs}
          friends={friends}
          candidates={candidates}
          aiChats={aiChats}
          activeAiId={activeAiId}
          busyUids={busyUids}
          activeUid={activeUid}
          relayPending={relayPending}
          onRefresh={() => void refresh()}
          onClose={closeDrawer}
          onOpenChat={openChat}
          onOpenAiChat={openAiChat}
          onOpenEdit={openEdit}
          onBlock={(uid) => void block(uid)}
          onRemove={(uid) => void remove(uid)}
          onUnblock={(uid) => void unblock(uid)}
          onAddFriend={(uid) => void addFriend(uid)}
          onAccept={(uid) => void accept(uid)}
          onReject={(uid) => void reject(uid)}
          t={t}
        />
      )}

      {/* 编辑分组/备注浮层（列表页内联） */}
      {editUid !== null && view === 'list' && (
        <FriendEditDialog
          group={editGroup}
          note={editNote}
          onGroupChange={setEditGroup}
          onNoteChange={setEditNote}
          groupRef={editGroupRef}
          saving={savingEdit}
          onClose={closeEdit}
          onSave={() => void saveEdit()}
          t={t}
        />
      )}
    </div>
  )
}