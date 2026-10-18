/**
 * 为什么存在：聊天室的编辑/代聊/邀请/解散等管理操作与浏览分离，
 * 独立设置视图减少互扰（从 ChatRoomsPanel 拆出）。
 * 作用：渲染聊天室设置视图——编辑信息（改名/改简介）、AI 代聊开关与
 * 主动协作开关、邀请成员与退出/解散操作。
 */
import { ArrowLeft, Settings, X, Pencil, Check, RefreshCw, Bot, UserPlus } from 'lucide-react'
import { useT } from '../../i18n/useT'
import type { ChatRoomDetail, ChatRoomItem, FriendOption } from './chat-room-types'
import { FOCUS } from './chat-room-utils'

interface ChatRoomSettingsProps {
  detail: ChatRoomDetail
  room: ChatRoomItem | null
  error: string | null
  editName: string
  setEditName: (name: string) => void
  editDesc: string
  setEditDesc: (desc: string) => void
  savingInfo: boolean
  aiReplyOn: boolean
  proactiveOn: boolean
  inviteUid: string
  setInviteUid: (uid: string) => void
  busyUids: number[]
  friends: FriendOption[]
  onBack: () => void
  onClose: () => void
  onSaveInfo: () => void
  onToggleAiReply: () => void
  onToggleProactive: () => void
  onInvite: () => void
  onLeave: () => void
  onDisband: () => void
}

/** 设置视图：编辑信息 / AI 代聊 / 主动协作 / 邀请成员 / 退出解散（纯展示，状态由 ChatRoomsPanel 持有） */
export function ChatRoomSettings(props: ChatRoomSettingsProps) {
  const {
    detail, room, error, editName, setEditName, editDesc, setEditDesc, savingInfo,
    aiReplyOn, proactiveOn, inviteUid, setInviteUid, busyUids, friends,
    onBack, onClose, onSaveInfo, onToggleAiReply, onToggleProactive, onInvite, onLeave, onDisband,
  } = props
  const t = useT()
  const inviteCandidates = friends.filter(
    (f) => f.status === 'friend' && !detail.members.some((m) => m.uid === f.uid),
  )
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <button
            onClick={onBack}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
            title={t('chatRoom.back')}
            aria-label={t('chatRoom.back')}
          >
            <ArrowLeft size={12} />
          </button>
          <Settings size={13} className="text-accent" />
          {t('chatRoom.settings')}
        </div>
        <button
          onClick={onClose}
          className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={12} />
        </button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {error && (
          <div className="rounded-btn bg-danger-soft/60 px-2.5 py-1.5 text-[11px] text-danger" role="alert">{error}</div>
        )}

        {/* 编辑名称/简介 */}
        <div>
          <div className="mb-1 flex items-center gap-1 text-micro uppercase tracking-wider text-fg-muted">
            <Pencil size={11} />
            {t('chatRoom.editInfo')}
          </div>
          <label htmlFor="chatroom-edit-name" className="mb-1 block text-[10px] text-fg-muted">{t('chatRoom.name')}</label>
          <input
            id="chatroom-edit-name"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
          <label htmlFor="chatroom-edit-desc" className="mb-1 block text-[10px] text-fg-muted">{t('chatRoom.desc')}</label>
          <textarea
            id="chatroom-edit-desc"
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            rows={2}
            className="mb-2 w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
          <button
            onClick={onSaveInfo}
            disabled={savingInfo || !editName.trim()}
            className={`flex items-center gap-1 rounded-btn bg-accent px-3 py-1 text-caption text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          >
            {savingInfo ? <RefreshCw size={11} className="animate-spin" /> : <Check size={11} />}
            {t('common.save')}
          </button>
        </div>

        {/* AI 代聊开关（本机 AI 自动回复该聊天室） */}
        {!detail.isSystem && (
          <div className="border-t border-border-subtle pt-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-caption font-medium text-fg-secondary">
                  <Bot size={12} className="text-accent" />
                  {t('chatRoom.aiReply')}
                </div>
                <div className="mt-0.5 text-[10px] text-fg-muted">{t('chatRoom.aiReplyHint')}</div>
              </div>
              <button
                onClick={onToggleAiReply}
                role="switch"
                aria-checked={aiReplyOn}
                aria-label={t('chatRoom.aiReply')}
                className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${FOCUS} ${
                  aiReplyOn ? 'bg-accent' : 'bg-bg-muted'
                }`}
              >
                <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${aiReplyOn ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          </div>
        )}

        {/* 主动协作开关（全局）：周期唤醒本机 AI，自行决定是否去各线路发起协作 */}
        {!detail.isSystem && (
          <div className="border-t border-border-subtle pt-3">
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-caption font-medium text-fg-secondary">
                  <Bot size={12} className="text-accent" />
                  {t('chatRoom.proactive')}
                </div>
                <div className="mt-0.5 text-[10px] text-fg-muted">{t('chatRoom.proactiveHint')}</div>
              </div>
              <button
                onClick={onToggleProactive}
                role="switch"
                aria-checked={proactiveOn}
                aria-label={t('chatRoom.proactive')}
                className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${FOCUS} ${
                  proactiveOn ? 'bg-accent' : 'bg-bg-muted'
                }`}
              >
                <span className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${proactiveOn ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          </div>
        )}

        {/* 邀请成员：好友选择器 + 手动 UID */}
        <div className="border-t border-border-subtle pt-3">
          <label htmlFor="chatroom-invite-friend" className="mb-1 block text-[10px] text-fg-muted">{t('chatRoom.pickFriend')}</label>
          <select
            id="chatroom-invite-friend"
            value={inviteCandidates.some((f) => String(f.uid) === inviteUid) ? inviteUid : ''}
            onChange={(e) => setInviteUid(e.target.value)}
            className="mb-1.5 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          >
            <option value="">{t('chatRoom.pickFriend')}</option>
            {inviteCandidates.map((f) => (
              <option key={f.uid} value={String(f.uid)}>
                {(f.备注 || f.昵称)} (UID {f.uid})
              </option>
            ))}
          </select>
          <label htmlFor="chatroom-invite-uid" className="mb-1 block text-[10px] text-fg-muted">{t('chatRoom.manualUid')}</label>
          <div className="flex gap-1">
            <input
              id="chatroom-invite-uid"
              value={inviteUid}
              onChange={(e) => setInviteUid(e.target.value)}
              placeholder={t('chatRoom.invitePlaceholder')}
              className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
            />
            <button
              onClick={onInvite}
              disabled={
                // 非数字 UID 在 onInvite 中会被静默丢弃，直接禁用避免“点了没反应”
                !inviteUid || Number.isNaN(Number(inviteUid)) || busyUids.includes(Number(inviteUid))
              }
              className={`flex shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40 ${FOCUS}`}
            >
              <UserPlus size={10} />
              {t('chatRoom.invite')}
            </button>
          </div>
        </div>

        {/* 退出 / 解散 */}
        <div className="space-y-2 border-t border-border-subtle pt-3">
          <button
            onClick={onLeave}
            className={`w-full rounded-btn bg-danger-soft/50 px-2 py-1.5 text-caption text-danger hover:bg-danger-soft ${FOCUS}`}
          >
            {t('chatRoom.leave')}
          </button>
          {room?.myRole === 'owner' && (
            <button
              onClick={onDisband}
              className={`w-full rounded-btn bg-danger-soft px-2 py-1.5 text-caption text-danger hover:bg-danger-soft/80 ${FOCUS}`}
            >
              {t('chatRoom.disband')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}