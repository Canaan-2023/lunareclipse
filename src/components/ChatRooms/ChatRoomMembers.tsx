/**
 * 为什么存在：聊天室成员管理（真人踢出 + AI 发言身份增删）与聊天视图分离，
 * 独立成员视图降低主组件复杂度（从 ChatRoomsPanel 拆出）。
 * 作用：渲染成员视图——真人成员列表（按角色标识/踢出）、
 * AI 发言身份列表（添加/移除，按属主/室主权限控制）。
 */
import { ArrowLeft, Users, X, Crown, Shield, UserMinus, Bot, Trash2, Plus } from 'lucide-react'
import { useT } from '../../i18n/useT'
import type { ChatRoomDetail, ChatRoomItem } from './chat-room-types'
import { FOCUS, aiIdOf, aiIdentityOf } from './chat-room-utils'

interface ChatRoomMembersProps {
  detail: ChatRoomDetail
  room: ChatRoomItem | null
  error: string | null
  myUid: number
  busyUids: number[]
  /** ：可添加的 AI 列表（注册表未停用联系人，排除已在室的 aiId） */
  aiOptions: Array<{ aiId: number; name: string; avatar?: string }>
  newAiId: number
  setNewAiId: (id: number) => void
  addingAi: boolean
  /** AI 发言身份移除中（防重复提交，期间禁用删除按钮） */
  removingAi: boolean
  onBack: () => void
  onClose: () => void
  onKick: (uid: number) => void
  onAddAi: () => void
  onRemoveAi: (aiIdentity: string) => void
}

/** 成员视图：真人成员列表 + AI 发言身份管理（纯展示，状态由 ChatRoomsPanel 持有） */
export function ChatRoomMembers(props: ChatRoomMembersProps) {
  const {
    detail, room, error, myUid, busyUids, aiOptions, newAiId, setNewAiId,
    addingAi, removingAi, onBack, onClose, onKick, onAddAi, onRemoveAi,
  } = props
  const t = useT()
  const meOwner = room?.myRole === 'owner'
  const realMembers = detail.members.filter((m) => !m.isAi)
  const aiSpeakers = detail.members.filter((m) => m.isAi)
  const canManageAi = meOwner || room?.myRole === 'admin'
  // 当前下拉选择是否已加入（已加入时禁用添加按钮）
  const selectedAlreadyInRoom = aiSpeakers.some((m) => aiIdOf(m) === newAiId)
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
          <Users size={13} className="text-accent" />
          {t('chatRoom.members')}
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
      <div className="flex-1 overflow-y-auto p-2">
        {error && (
          <div className="mb-2 rounded-btn bg-danger-soft/60 px-2.5 py-1.5 text-[11px] text-danger" role="alert">{error}</div>
        )}

        {/* 真人成员 */}
        {realMembers.map((m) => (
          <div key={m.uid} className="mb-1 flex items-center gap-2 rounded-btn px-2.5 py-2 hover:bg-bg-muted/70">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-muted text-[9px] text-fg-muted">
              {String(m.uid).slice(-2)}
            </div>
            <span className="flex-1 truncate text-caption text-fg-primary">
              UID {m.uid}
              {m.uid === myUid && <span className="ml-1 text-[9px] text-accent">{t('chatRoom.me')}</span>}
            </span>
            {m.role === 'owner' && (
              <span title={t('chatRoom.owner')} className="shrink-0" aria-label={t('chatRoom.owner')}>
                <Crown size={12} className="text-accent" />
              </span>
            )}
            {m.role === 'admin' && (
              <span title={t('chatRoom.admin')} className="shrink-0" aria-label={t('chatRoom.admin')}>
                <Shield size={12} className="text-fg-muted" />
              </span>
            )}
            {meOwner && m.uid !== detail.ownerUid && m.uid !== myUid && (
              <button
                onClick={() => onKick(m.uid)}
                disabled={busyUids.includes(m.uid)}
                className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
                title={t('chatRoom.kick')}
                aria-label={t('chatRoom.kick')}
              >
                <UserMinus size={10} />
              </button>
            )}
          </div>
        ))}

        {/* AI 发言身份 */}
        {!detail.isSystem && (
          <div className="mt-3 border-t border-border-subtle pt-2">
            <div className="mb-1 flex items-center gap-1 px-2.5 text-micro uppercase tracking-wider text-fg-muted">
              <Bot size={11} />
              {t('chatRoom.aiSpeakers')}
            </div>
            {aiSpeakers.length === 0 ? (
              <div className="px-2.5 py-2 text-caption text-fg-muted">{t('chatRoom.noAiSpeakers')}</div>
            ) : (
              aiSpeakers.map((m) => (
                <div key={aiIdentityOf(m)} className="mb-1 flex items-center gap-2 rounded-btn px-2.5 py-1.5 hover:bg-bg-muted/70">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 text-accent">
                    {m.aiAvatar ? (
                      <span className="text-[13px] leading-none" aria-hidden="true">{m.aiAvatar}</span>
                    ) : (
                      <Bot size={11} />
                    )}
                  </div>
                  <span className="flex-1 truncate text-caption text-fg-primary">
                    {m.aiName || `AI ${aiIdOf(m)}`}
                    <span className="ml-1 text-[9px] text-fg-muted">{aiIdentityOf(m)}</span>
                  </span>
                  {m.uid === myUid && <span className="shrink-0 text-[9px] text-fg-muted">{t('chatRoom.me')}</span>}
                  {(meOwner || m.uid === myUid) && (
                    <button
                      onClick={() => onRemoveAi(aiIdentityOf(m))}
                      disabled={removingAi}
                      className={`flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-40 ${FOCUS}`}
                      title={t('chatRoom.removeAi')}
                      aria-label={t('chatRoom.removeAi')}
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
              ))
            )}

            {canManageAi && (
              <div className="mt-1.5 flex gap-1 px-2.5">
                <select
                  value={newAiId}
                  onChange={(e) => setNewAiId(Number(e.target.value))}
                  title={t('chatRoom.aiEntity')}
                  aria-label={t('chatRoom.aiEntity')}
                  className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-base px-1.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
                >
                  {aiOptions.length === 0 && <option value={newAiId}>{t('chatRoom.noAiSpeakers')}</option>}
                  {aiOptions.map((o) => (
                    <option key={o.aiId} value={o.aiId}>
                      {o.name}（AI {o.aiId}）
                    </option>
                  ))}
                </select>
                <button
                  onClick={onAddAi}
                  disabled={addingAi || aiOptions.length === 0 || selectedAlreadyInRoom}
                  className={`flex shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent hover:bg-accent/25 disabled:opacity-40 ${FOCUS}`}
                >
                  <Plus size={10} />
                  {t('chatRoom.addAi')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}