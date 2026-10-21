/**
 * @category 前端组件
 * @summary 内部会话详情视图（消息增删改）
 * @note 为什么存在：原 `InternalSessionsView.tsx` 1408 行破 800 硬红线（ADR-27 拆分）；详情视图与树画布是两种互斥展示态。
 * @note 不删理由：消息增删改是内部会话面板的编辑面，独立成文件后与画布可各自演进。
 */

import {
  useRef,
  useState
} from 'react'
import {
  Plus,
  ChevronLeft
} from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import { InternalMessage } from '@shared/types'
import { useT } from '../../../i18n/useT'
import { MessageRow } from './MessageRow'


/** 详情视图：消息增删改 */
export function DetailView({
  sessionId,
  internalId,
  onBack
}: {
  sessionId: string
  internalId: string
  onBack: () => void
}) {
  const t = useT()
  const active = useAppStore((s) => s.activeInternalSession)
  const updateInternalSession = useAppStore((s) => s.updateInternalSession)
  const [newRole, setNewRole] = useState<InternalMessage['role']>('note')
  const [newContent, setNewContent] = useState('')
  const [busy, setBusy] = useState(false)
  // 同步防重入：setState 是异步生效的，快速双击 Enter 时 busy state 尚未 flush，
  // 会基于同一 messages 快照并发提交两次（服务端整体替换）导致首条消息被覆盖丢失
  const busyRef = useRef(false)

  const removeMessage = async (msgId: string) => {
    if (!active) return
    await updateInternalSession(sessionId, internalId, {
      messages: active.messages.filter((m) => m.id !== msgId)
    })
  }

  const addMessage = async () => {
    if (!active || !newContent.trim()) return
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      const msg: InternalMessage = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: newRole,
        content: newContent.trim(),
        createdAt: Date.now()
      }
      const ok = await updateInternalSession(sessionId, internalId, {
        messages: [...active.messages, msg]
      })
      if (ok) setNewContent('')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const saveMessage = async (msgId: string, content: string) => {
    if (!active) return
    await updateInternalSession(sessionId, internalId, {
      messages: active.messages.map((m) => (m.id === msgId ? { ...m, content } : m))
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 详情头部（全宽，不留白） */}
      <div className="shrink-0 border-b border-border-subtle">
        <div className="flex w-full items-center gap-2.5 px-6 py-3">
          <button
            onClick={onBack}
            className="flex h-7 items-center gap-1 rounded-btn px-2 text-caption text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
          >
            <ChevronLeft size={15} />
            {t('internal.back')}
          </button>
          <span className="min-w-0 flex-1 truncate text-body font-medium text-fg-primary">
            {active?.title || ''}
          </span>
          <span className="shrink-0 text-caption tabular-nums text-fg-muted/70">
            {t('internal.messages', { count: active?.messages.length ?? 0 })}
          </span>
        </div>
      </div>

      {/* 消息列表：全宽，不留白 */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full space-y-2 px-6 py-4">
        {(active?.messages ?? []).map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            onDelete={() => void removeMessage(m.id)}
            onSave={(content) => void saveMessage(m.id, content)}
          />
        ))}
        </div>
      </div>

      {/* 新增消息（全宽，不留白） */}
      <div className="shrink-0 border-t border-border-subtle">
        <div className="w-full px-6 py-3">
          <div className="flex items-center gap-2.5">
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as InternalMessage['role'])}
              className="rounded-btn border border-border-subtle bg-bg-elevated px-2 py-1.5 text-caption text-fg-secondary outline-none focus:border-accent/40"
            >
              <option value="user">{t('internal.role.user')}</option>
              <option value="assistant">{t('internal.role.assistant')}</option>
              <option value="note">{t('internal.role.note')}</option>
            </select>
            <input
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addMessage() }}
              className="flex-1 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary outline-none focus:border-accent/40"
              placeholder={t('internal.contentPlaceholder')}
            />
            <button
              disabled={busy || !newContent.trim()}
              onClick={() => void addMessage()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-accent/15 px-3 text-caption font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-40"
            >
              <Plus size={14} />
              {t('internal.addMessage')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

