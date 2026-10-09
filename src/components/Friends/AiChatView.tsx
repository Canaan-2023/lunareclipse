/**
 * 为什么存在：真人↔本机 AI 私聊是好友面板的特殊会话形态（对端是注册表 AI 实体、
 * 恒在线、不可删），与真人私聊同构但语义不同，独立视图承载。
 * 作用：渲染 AI 私聊视图——对端档案头像/名称 + UID-AIID 编号、消息流与输入，
 * 不提供代聊开关与删除好友操作。
 */
import { ArrowLeft, X, Send, RefreshCw, Bot } from 'lucide-react'
import type { RefObject } from 'react'
import type { TFunc } from '../../i18n/useT'
import { FOCUS } from './types'
import { autoGrow, formatBubbleTime } from './utils'

/**
 * 好友面板 · AI 私聊视图（：真人↔本机 AI）。
 * 与真人好友私聊（FriendChatView）同构但模型独立：消息为 AiChatMessage，
 * 对端展示档案头像/名称 + UID-AIID 编号；不提供 AI 代聊开关（对方就是 AI）与删除好友（注册表实体不可删）。
 * 受控组件，状态由 FriendsPanel 持有，不下放。
 */

interface AiChatViewProps {
  /** 对端 AI 联系人（注册表档案） */
  contact: { uid: number; aiId: number; name: string; avatar?: string; online: true }
  messages: Array<{
    id: string
    from: number
    fromAiId?: number
    to: number
    toAiId?: number
    text: string
    ts: number
    read: boolean
    isAiGenerated?: boolean
  }>
  sending: boolean
  draft: string
  onDraftChange: (v: string) => void
  onBack: () => void
  onClose: () => void
  onSend: () => void
  listRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  t: TFunc
}

export function AiChatView({
  contact,
  messages,
  sending,
  draft,
  onDraftChange,
  onBack,
  onClose,
  onSend,
  listRef,
  inputRef,
  t,
}: AiChatViewProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <button
            onClick={onBack}
            className={`flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary ${FOCUS}`}
            title={t('friend.back')}
            aria-label={t('friend.back')}
          >
            <ArrowLeft size={12} />
          </button>
          <div className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent/15 text-accent">
            {contact.avatar ? (
              <span className="text-[11px] leading-none" aria-hidden="true">{contact.avatar}</span>
            ) : (
              <Bot size={10} />
            )}
          </div>
          <span className="truncate">{contact.name}</span>
          <span className="shrink-0 text-[9px] text-fg-muted">{contact.uid}-{contact.aiId}</span>
          <span className="shrink-0 text-[9px] text-success">{t('friend.online')}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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

      {/* 消息区 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2.5" aria-live="polite" aria-atomic="false">
        {messages.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">{t('friend.noMessages')}</div>
        ) : (
          messages.map((m) => {
            // 无 fromAiId = 真人（本机 uid）发送；有 fromAiId = AI 发言
            const isMine = m.fromAiId === undefined
            return (
              <div key={m.id} className={`mb-2 flex ${isMine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[min(78%,360px)] rounded-card px-2.5 py-1.5 text-caption ${
                    isMine
                      ? 'bg-accent/15 text-fg-primary'
                      : 'border border-border-subtle bg-bg-elevated text-fg-primary'
                  }`}
                >
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  <div className={`mt-0.5 flex items-center gap-1 text-[9px] ${isMine ? 'justify-end text-fg-muted/70' : 'text-fg-muted'}`}>
                    {!isMine && (
                      <span className="rounded bg-accent/15 px-1 text-[8px] text-accent">
                        AI {m.from}-{m.fromAiId}
                      </span>
                    )}
                    <span>{formatBubbleTime(m.ts)}</span>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 输入区 */}
      <div className="flex items-end gap-1.5 border-t border-border-subtle p-2">
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => { onDraftChange(e.target.value); autoGrow(e.currentTarget) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onSend() } }}
          placeholder={t('friend.messagePlaceholder')}
          className="max-h-[120px] min-h-[36px] min-w-0 flex-1 resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <button
          onClick={() => void onSend()}
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