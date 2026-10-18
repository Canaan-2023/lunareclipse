/**
 * 为什么存在：局域网聊天室（含 AI 发言身份）需要统一面板入口，事件驱动状态
 * 集中在主组件持有，视图拆给四个子组件（批次拆分产物）。
 * 作用：渲染聊天室面板——视图状态机（列表/聊天/成员/设置）、onChatRoomEvent
 * 事件订阅（邀请/消息/成员变动）、创建/加入与 AI 发言身份（对外身份）管理。
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import type { ChatRoomItem, ChatRoomMsg, ChatRoomDetail, FriendOption, ChatRoomInvite, ChatRoomView } from './chat-room-types'
import { ChatRoomList } from './ChatRoomList'
import { ChatRoomChat } from './ChatRoomChat'
import { ChatRoomMembers } from './ChatRoomMembers'
import { ChatRoomSettings } from './ChatRoomSettings'
import { DEFAULT_AI_ID } from '@shared/types'

/**
 * 聊天室功能面板（右侧抽屉）：局域网聊天室 + 聊天室消息 + AI 发言身份。
 * - 上层 API：window.lunareclipse.chatRoom*（主进程 ChatRoomService → L0 LAN 直连）
 * - 实时事件：onChatRoomEvent（收到邀请/新消息/成员变动/群更新）驱动列表与消息追加
 * - AI 开放：aiAgentSet/GetChatRoom 控制本机 AI 是否在该聊天室代聊；
 * AI 发言身份（对外身份 = UID-AIID）是本机某个 AI 实体在该室的发言名，由属主或室主增删，收到真人消息后由属主本机 AI 代答
 * - 拆分说明：本文件只保留状态与交互逻辑（状态不下放）；视图渲染交给
 * ChatRoomList / ChatRoomChat / ChatRoomMembers / ChatRoomSettings 四个纯展示子组件。
 */
export function ChatRoomsPanel({ embedded, externalQuery }: { embedded?: boolean; externalQuery?: string } = {}) {
  const open = useAppStore((s) => (embedded || s.activeDrawer === 'chatRoom') && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const myUid = useAppStore((s) => s.currentUser?.UID ?? 0)
  const t = useT()

  const [ready, setReady] = useState<boolean | null>(null)
  const [view, setView] = useState<ChatRoomView>('list')
  const [activeGid, setActiveGid] = useState<string | null>(null)
  const [tab, setTab] = useState<'chats' | 'invites'>('chats')
  const [query, setQuery] = useState('')
  const [chatRooms, setChatRooms] = useState<ChatRoomItem[]>([])
  const [messages, setMessages] = useState<ChatRoomMsg[]>([])
  const [draft, setDraft] = useState('')
  const [detail, setDetail] = useState<ChatRoomDetail | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDesc, setCreateDesc] = useState('')
  const [inviteUid, setInviteUid] = useState('')
  const [friends, setFriends] = useState<FriendOption[]>([])
  const [invites, setInvites] = useState<ChatRoomInvite[]>([])
  // 编辑信息（改名/改简介）
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  // AI：聊天室代聊开关 + 新增 AI 发言身份（AI 列表动态拉取注册表，不再硬编码 1/2）
  const [aiReplyOn, setAiReplyOn] = useState(false)
  const [proactiveOn, setProactiveOn] = useState(false)
  const [aiOptions, setAiOptions] = useState<Array<{ aiId: number; name: string; avatar?: string }>>([])
  const [newAiId, setNewAiId] = useState(0)
  // 交互反馈：刷新/发送/创建/保存/添加 AI 的 pending + 逐条防重 + 错误提示
  const [refreshing, setRefreshing] = useState(false)
  const [sending, setSending] = useState(false)
  const [creating, setCreating] = useState(false)
  const [savingInfo, setSavingInfo] = useState(false)
  const [addingAi, setAddingAi] = useState(false)
  const [busyUids, setBusyUids] = useState<number[]>([])
  const [acceptingGid, setAcceptingGid] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // “忽略邀请”防重：双击会发起两次 IPC，第二次对已移除的邀请必然失败并误报“操作失败”，故记一个正在忽略的 gid
  const [ignoringGid, setIgnoringGid] = useState<string | null>(null)
  // AI 发言身份移除防重：确认弹窗后异步删身份，期间禁用删除按钮，避免重复提交
  const [removingAi, setRemovingAi] = useState(false)
  // 后端全文搜索命中（房间名 + 群消息全文）：房间由本地列表过滤兜底，这里聚焦消息命中
  const [searching, setSearching] = useState(false)
  const [searchMsgs, setSearchMsgs] = useState<Array<{ gid: string; message: ChatRoomMsg }> | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const searchTimer = useRef<number | null>(null)
  // 已打开并阅读过的群：loadList 时未读清零（后端未读为简化统计，已读状态由前端保持）
  const readGidsRef = useRef<Set<string>>(new Set())

  const reportError = useCallback((msg: string) => {
    setError(msg)
    window.setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 4000)
  }, [])

  const loadList = useCallback(async () => {
    const r = await window.lunareclipse.chatRoomList()
    if (r.ok && r.list) {
      setChatRooms(r.list.map((g) => (readGidsRef.current.has(g.gid) ? { ...g, unread: 0 } : g)))
      setReady(true)
    } else {
      setReady(false)
    }
  }, [])

  const loadMessages = useCallback(async (gid: string) => {
    const r = await window.lunareclipse.chatRoomMessages(gid)
    if (r.ok && r.messages) {
      setMessages(r.messages)
    }
  }, [])

  const loadDetail = useCallback(async (gid: string) => {
    const r = await window.lunareclipse.chatRoomDetail(gid)
    if (r.ok && r.detail) {
      setDetail(r.detail)
      setEditName(r.detail.name)
      setEditDesc(r.detail.desc ?? '')
    }
  }, [])

  const loadFriends = useCallback(async () => {
    const r = await window.lunareclipse.friendList()
    if (r.ok && r.list) setFriends(r.list)
  }, [])

  /** ：动态拉取注册表 AI 联系人（未停用）作为可添加发言身份 */
  const loadAiOptions = useCallback(async () => {
    const r = await window.lunareclipse.aiSocialContacts()
    if (r.ok && r.contacts) {
      const opts = r.contacts.map((c) => ({ aiId: c.aiId, name: c.name, avatar: c.avatar }))
      setAiOptions(opts)
      // 当前选中失效（被停用）时回落到第一个可用 AI
      setNewAiId((cur) => (opts.some((o) => o.aiId === cur) ? cur : (opts[0]?.aiId ?? 0)))
    }
  }, [])

  // 待处理邀请来自主进程落盘（重启后仍在）；事件 push 只做增量追加
  const loadInvites = useCallback(async () => {
    const r = await window.lunareclipse.chatRoomListInvites()
    if (r.ok && r.list) setInvites(r.list)
  }, [])

  const refresh = useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await Promise.all([loadList(), loadFriends(), loadInvites(), loadAiOptions()])
    } finally {
      setRefreshing(false)
    }
  }, [refreshing, loadList, loadFriends, loadInvites, loadAiOptions])

  useEffect(() => {
    if (!open) return
    void loadList()
    void loadFriends()
    void loadInvites()
    void loadAiOptions()
  }, [open, loadList, loadFriends, loadInvites, loadAiOptions])

  useEffect(() => {
    if (!open) return
    const unsubscribe = window.lunareclipse.onChatRoomEvent((ev) => {
      const e = ev as { type: string; gid?: string; message?: ChatRoomMsg; uid?: number; action?: string; actorUid?: number; chatRoomName?: string; fromUid?: number; fromName?: string; ownerUid?: number }
      if (e.type === 'invite' && e.gid && e.chatRoomName) {
        // 收到群邀请：去重后追加到邀请列表
        setInvites((cur) => (cur.some((x) => x.gid === e.gid) ? cur : [...cur, {
          gid: e.gid as string,
          chatRoomName: e.chatRoomName as string,
          fromUid: e.fromUid ?? 0,
          fromName: e.fromName ?? '',
          ownerUid: e.ownerUid ?? 0,
        }]))
      }
      if (e.type === 'message' && e.gid === activeGid && e.message) {
        setMessages((m) => (m.some((x) => x.id === e.message!.id) ? m : [...m, e.message!]))
      }
      void loadList()
      if (activeGid && (e.gid === activeGid)) {
        if (e.type === 'member-change' || e.type === 'updated') {
          void loadDetail(activeGid)
        }
      }
    })
    return () => { unsubscribe?.() }
  }, [open, activeGid, loadList, loadDetail])

  const acceptInvite = async (inv: { gid: string; ownerUid: number }) => {
    if (acceptingGid) return
    setAcceptingGid(inv.gid)
    try {
      const r = await window.lunareclipse.chatRoomAcceptInvite(inv.gid, inv.ownerUid || undefined)
      if (r.ok) {
        setInvites((cur) => cur.filter((x) => x.gid !== inv.gid))
        await loadList()
      } else {
        reportError(t('chatRoom.operateFailed'))
      }
    } finally {
      setAcceptingGid(null)
    }
  }

  // 忽略邀请：同步落盘移除，重启后不再出现；带防重（双击会重复 IPC，第二次失败会误报“操作失败”）
  const dismissInvite = async (gid: string) => {
    if (ignoringGid === gid) return
    setIgnoringGid(gid)
    try {
      const r = await window.lunareclipse.chatRoomDeclineInvite(gid)
      if (!r.ok) {
        reportError(t('chatRoom.operateFailed'))
        return
      }
      setInvites((cur) => cur.filter((x) => x.gid !== gid))
    } finally {
      setIgnoringGid(null)
    }
  }

  useEffect(() => {
    if (view === 'chat' && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [view, messages])

  /** 全文搜索：输入防抖 350ms 后调后端 chatRoomSearch（含未加载历史群消息），命中消息可点击直达会话 */
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
      const r = await window.lunareclipse.chatRoomSearch(kw)
      // 搜索失败不能静默吞掉：置空命中并提示，避免用户误以为“无结果”
      if (!r.ok) reportError(t('chatRoom.operateFailed'))
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
      if (e.key === 'Escape') { setView('list'); setActiveGid(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  const openChat = (gid: string) => {
    setActiveGid(gid)
    setView('chat')
    // 进入聊天即视为已读，之后该群未读在 loadList 中清零
    readGidsRef.current.add(gid)
    void loadMessages(gid)
    void loadDetail(gid)
    void loadList()
  }

  const openMembers = (gid: string) => {
    setView('members')
    void loadDetail(gid)
  }

  const openSettings = (gid: string) => {
    setView('settings')
    void loadDetail(gid)
    void window.lunareclipse.aiAgentGetChatRoom(gid).then((r) => {
      if (r.ok) setAiReplyOn(!!r.enabled)
    })
    void window.lunareclipse.aiAgentGetProactive().then((r) => {
      if (r.ok) setProactiveOn(!!r.enabled)
    })
  }

  const send = async () => {
    const text = draft.trim()
    if (sending || !text || !activeGid) return
    setSending(true)
    try {
      const r = await window.lunareclipse.chatRoomSendMessage(activeGid, text)
      if (r.ok) {
        setDraft('')
        if (inputRef.current) inputRef.current.style.height = 'auto'
        await loadMessages(activeGid)
        void loadList()
      } else {
        reportError(t('chatRoom.sendFailed'))
      }
    } finally {
      setSending(false)
    }
  }

  const create = async () => {
    const name = createName.trim()
    if (creating || !name) return
    setCreating(true)
    try {
      const r = await window.lunareclipse.chatRoomCreate(name, createDesc.trim() || undefined)
      if (r.ok) {
        setShowCreate(false)
        setCreateName('')
        setCreateDesc('')
        await loadList()
        if (r.gid) openChat(r.gid)
      } else {
        reportError(t('chatRoom.operateFailed'))
      }
    } finally {
      setCreating(false)
    }
  }

  const invite = async () => {
    const uid = Number(inviteUid)
    if (!activeGid || Number.isNaN(uid) || uid <= 0) return
    if (busyUids.includes(uid)) return
    setBusyUids((cur) => [...cur, uid])
    try {
      const r = await window.lunareclipse.chatRoomInvite(activeGid, uid)
      if (r.ok) {
        setInviteUid('')
        await loadDetail(activeGid)
      } else {
        reportError(t('chatRoom.operateFailed'))
      }
    } finally {
      setBusyUids((cur) => cur.filter((x) => x !== uid))
    }
  }

  const leave = async (gid: string) => {
    if (!window.confirm(t('chatRoom.confirmLeave'))) return
    const r = await window.lunareclipse.chatRoomLeave(gid)
    if (!r.ok) reportError(t('chatRoom.operateFailed'))
    if (activeGid === gid) {
      setActiveGid(null)
      setView('list')
    }
    void loadList()
  }

  const disband = async (gid: string) => {
    if (!window.confirm(t('chatRoom.confirmDisband'))) return
    const r = await window.lunareclipse.chatRoomDisband(gid)
    if (!r.ok) reportError(t('chatRoom.operateFailed'))
    if (activeGid === gid) {
      setActiveGid(null)
      setView('list')
    }
    void loadList()
  }

  const kick = async (uid: number) => {
    if (!activeGid) return
    if (!window.confirm(t('chatRoom.confirmKick'))) return
    if (busyUids.includes(uid)) return
    setBusyUids((cur) => [...cur, uid])
    try {
      const r = await window.lunareclipse.chatRoomKick(activeGid, uid)
      if (!r.ok) reportError(t('chatRoom.operateFailed'))
      await loadDetail(activeGid)
    } finally {
      setBusyUids((cur) => cur.filter((x) => x !== uid))
    }
  }

  const saveInfo = async () => {
    if (!activeGid || savingInfo) return
    setSavingInfo(true)
    try {
      const r = await window.lunareclipse.chatRoomUpdate(activeGid, { name: editName, desc: editDesc })
      if (r.ok) {
        await loadDetail(activeGid)
        await loadList()
      } else {
        reportError(t('chatRoom.operateFailed'))
      }
    } finally {
      setSavingInfo(false)
    }
  }

  const toggleAiReply = async () => {
    if (!activeGid) return
    const next = !aiReplyOn
    const r = await window.lunareclipse.aiAgentSetChatRoom(activeGid, next)
    if (r.ok) setAiReplyOn(next)
    else reportError(t('chatRoom.operateFailed'))
  }

  const toggleProactive = async () => {
    const next = !proactiveOn
    const r = await window.lunareclipse.aiAgentSetProactive(next)
    if (r.ok) setProactiveOn(next)
    else reportError(t('chatRoom.operateFailed'))
  }

  const addAi = async () => {
    if (!activeGid || addingAi || newAiId === 0) return
    setAddingAi(true)
    try {
      // ：name 可省，未注册 aiId 拒绝； 下拉已限定未停用 AI，name 由档案名兜底
      const r = await window.lunareclipse.chatRoomAddAiSpeaker(activeGid, undefined, newAiId)
      if (r.ok) {
        await loadDetail(activeGid)
      } else {
        reportError(r.error ?? t('chatRoom.operateFailed'))
      }
    } finally {
      setAddingAi(false)
    }
  }

  const removeAi = async (aiIdentity: string) => {
    if (!activeGid || removingAi) return
    if (!window.confirm(t('chatRoom.confirmRemoveAi'))) return
    setRemovingAi(true)
    try {
      const r = await window.lunareclipse.chatRoomRemoveAiSpeaker(activeGid, aiIdentity)
      if (r.ok) void loadDetail(activeGid)
      else reportError(r.error ?? t('chatRoom.operateFailed'))
    } finally {
      setRemovingAi(false)
    }
  }

  if (!open) return null

  const activeRoom = chatRooms.find((g) => g.gid === activeGid) ?? null

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {view === 'list' && (
        <ChatRoomList
          embedded={embedded ?? false}
          ready={ready}
          error={error}
          tab={tab}
          setTab={setTab}
          query={query}
          setQuery={setQuery}
          searching={searching}
          searchMsgs={searchMsgs}
          chatRooms={chatRooms}
          invites={invites}
          showCreate={showCreate}
          setShowCreate={setShowCreate}
          createName={createName}
          setCreateName={setCreateName}
          createDesc={createDesc}
          setCreateDesc={setCreateDesc}
          refreshing={refreshing}
          creating={creating}
          acceptingGid={acceptingGid}
          ignoringGid={ignoringGid}
          onRefresh={() => void refresh()}
          onClose={() => closeDrawer()}
          onOpenChat={openChat}
          onAcceptInvite={acceptInvite}
          onDismissInvite={dismissInvite}
          onCreate={() => void create()}
        />
      )}
      {view === 'chat' && activeRoom && (
        <ChatRoomChat
          room={activeRoom}
          messages={messages}
          draft={draft}
          setDraft={setDraft}
          sending={sending}
          myUid={myUid}
          listRef={listRef}
          inputRef={inputRef}
          onBack={() => { setView('list'); setActiveGid(null) }}
          onOpenMembers={() => openMembers(activeGid!)}
          onOpenSettings={() => openSettings(activeGid!)}
          onClose={() => closeDrawer()}
          onSend={() => void send()}
        />
      )}
      {view === 'members' && detail && (
        <ChatRoomMembers
          detail={detail}
          room={activeRoom}
          error={error}
          myUid={myUid}
          busyUids={busyUids}
          aiOptions={aiOptions.filter((o) => !detail.members.some((m) => m.isAi && (m.aiId ?? DEFAULT_AI_ID) === o.aiId))}
          newAiId={newAiId}
          setNewAiId={setNewAiId}
          addingAi={addingAi}
          removingAi={removingAi}
          onBack={() => setView('chat')}
          onClose={() => closeDrawer()}
          onKick={(uid) => void kick(uid)}
          onAddAi={() => void addAi()}
          onRemoveAi={(aiIdentity) => void removeAi(aiIdentity)}
        />
      )}
      {view === 'settings' && detail && (
        <ChatRoomSettings
          detail={detail}
          room={activeRoom}
          error={error}
          editName={editName}
          setEditName={setEditName}
          editDesc={editDesc}
          setEditDesc={setEditDesc}
          savingInfo={savingInfo}
          aiReplyOn={aiReplyOn}
          proactiveOn={proactiveOn}
          inviteUid={inviteUid}
          setInviteUid={setInviteUid}
          busyUids={busyUids}
          friends={friends}
          onBack={() => setView('chat')}
          onClose={() => closeDrawer()}
          onSaveInfo={() => void saveInfo()}
          onToggleAiReply={() => void toggleAiReply()}
          onToggleProactive={() => void toggleProactive()}
          onInvite={() => void invite()}
          onLeave={() => { if (activeGid) void leave(activeGid) }}
          onDisband={() => { if (activeGid) void disband(activeGid) }}
        />
      )}
    </div>
  )
}