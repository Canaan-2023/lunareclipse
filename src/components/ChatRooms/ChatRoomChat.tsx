/**
 * 为什么存在：聊天室内的消息流 + 输入框是核心交互视图，与列表/成员/设置分离
 * （从 ChatRoomsPanel 拆出），保证消息渲染聚焦。
 * 作用：渲染聊天视图——消息流（含 AI 发言标识）与输入框，进成员/设置的入口。
 */
import type { RefObject } from 'react'
import { ArrowLeft, MessageSquare, Users, Settings, X, Send, RefreshCw, Bot } from 'lucide-react'
import { useT } from '../../i18n/useT'
import type { ChatRoomItem, ChatRoomMsg } from './chat-room-types'
import { FOCUS, formatBubbleTime, autoGrow } from './chat-room-utils'
import { DEFAULT_AI_ID } from '@shared/types'

interface ChatRoomChatProps {
  room: ChatRoomItem
  messages: ChatRoomMsg[]
  draft: string
  setDraft: (draft: string) => void
  sending: boolean
  myUid: number
  listRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  onBack: () => void
  onOpenMembers: () => void
  onOpenSettings: () => void
  onClose: () => void
  onSend: () => void
}

/** 聊天视图：消息流 + 输入框（纯展示，状态与交互由 ChatRoomsPanel 持有） */
export function ChatRoomChat(props: ChatRoomChatProps) {
  const { room, messages, draft, setDraft, sending, myUid, listRef, inputRef, onBack, onOpenMembers, onOpenSettings, onClose, onSend } = props
  const t = useT()
  const isOwner = room.myRole === 'owner'
  const isAdmin = room.myRole === 'admin'
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <button
            onClick={onBack}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
            title={t('chatRoom.back')}
            aria-label={t('chatRoom.back')}
          >
            <ArrowLeft size={12} />
          </button>
          <MessageSquare size={13} className="shrink-0 text-accent" />
          <span className="truncate">{room.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onOpenMembers}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
            title={t('chatRoom.members')}
            aria-label={t('chatRoom.members')}
          >
            <Users size={12} />
          </button>
          {(isOwner || isAdmin) && (
            <button
              onClick={onOpenSettings}
              className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
              title={t('chatRoom.settings')}
              aria-label={t('chatRoom.settings')}
            >
              <Settings size={12} />
            </button>
          )}
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

      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2.5" aria-live="polite" aria-atomic="false">
        {messages.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">{t('chatRoom.noMessages')}</div>
        ) : (
          messages.map((m) => {
            const isMine = m.from === myUid
            const isAi = !!m.isAi || !!m.isAiGenerated
            return (
              <div key={m.id} className={`mb-2 flex gap-2 ${isMine ? 'flex-row-reverse' : ''}`}>
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[9px] ${
                  isAi ? 'bg-accent/15 text-accent' : 'bg-bg-muted text-fg-muted'
                }`}>
                  {isAi ? <Bot size={11} /> : String(m.fromName || m.from).slice(-2)}
                </div>
                <div className={`max-w-[min(78%,360px)] rounded-card border px-2.5 py-1.5 text-caption text-fg-primary ${
                  isAi ? 'border-accent/20 bg-accent/5' : isMine ? 'border-accent/20 bg-accent/10' : 'border-border-subtle bg-bg-elevated'
                }`}>
                  <div className="mb-0.5 flex items-center gap-1 text-[9px] text-fg-muted">
                    <span className="truncate">{m.fromName || `UID ${m.from}`}</span>
                    {isMine && <span className="text-accent">{t('chatRoom.me')}</span>}
                    {isAi && (
                      <span className="rounded bg-accent/15 px-1 text-[8px] text-accent">
                        AI {m.from}-{m.aiId ?? DEFAULT_AI_ID}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  <div className="mt-0.5 text-[9px] text-fg-muted">{formatBubbleTime(m.ts)}</div>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="flex items-end gap-1.5 border-t border-border-subtle p-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); autoGrow(e.currentTarget) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() } }}
          placeholder={t('chatRoom.messagePlaceholder')}
          className="max-h-[120px] min-h-[36px] min-w-0 flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <button
          onClick={onSend}
          disabled={sending || !draft.trim()}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-btn bg-accent/15 text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          title={t('input.send')}
          aria-label={t('input.send')}
        >
          {sending ? <RefreshCw size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
      </div>
    </div>
  )
}