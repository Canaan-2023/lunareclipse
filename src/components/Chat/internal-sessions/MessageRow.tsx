/**
 * @category 前端组件
 * @summary 单条内部消息行（就地编辑 + 删除）
 * @note 为什么存在：原 `InternalSessionsView.tsx` 1408 行破 800 硬红线（ADR-27 拆分）；消息行是详情视图的独立渲染单元。
 * @note 不删理由：详情视图的每条消息都渲染本组件，是消息编辑面的最小单元。
 */

import {
  useEffect,
  useRef,
  useState
} from 'react'
import {
  Pencil,
  Trash2,
  Check,
  X
} from 'lucide-react'
import { InternalMessage } from '@shared/types'
import { useT } from '../../../i18n/useT'
import { formatTime } from './shared'


/** 单条消息：就地编辑 + 删除 */
export function MessageRow({
  msg,
  onDelete,
  onSave
}: {
  msg: InternalMessage
  onDelete: () => void
  onSave: (content: string) => void
}) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) areaRef.current?.focus()
  }, [editing])

  const roleLabel = t(`internal.role.${msg.role}` as const)
  const roleColor =
    msg.role === 'user' ? 'bg-accent/15 text-accent'
    : msg.role === 'assistant' ? 'bg-emerald-500/15 text-emerald-400'
    : 'bg-amber-500/15 text-amber-400'

  return (
    <div className="group rounded-card border border-border-subtle bg-bg-surface/30 p-3">
      <div className="mb-1.5 flex items-center gap-2.5">
        <span className={`rounded-full px-2 py-0.5 text-caption font-medium ${roleColor}`}>
          {roleLabel}
        </span>
        <span className="text-caption tabular-nums text-fg-muted/60">
          {formatTime(msg.createdAt)}
        </span>
        <div className="ml-auto flex items-center gap-1 opacity-0 transition-all group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted/40 transition-all hover:bg-bg-muted hover:text-accent"
            title={t('internal.editTitle')}
            aria-label={t('internal.editTitle')}
            onClick={() => { setEditing(true); setDraft(msg.content) }}
          >
            <Pencil size={13} />
          </button>
          <button
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted/40 transition-all hover:bg-red-500/10 hover:text-red-400"
            title={t('internal.delete')}
            aria-label={t('internal.delete')}
            onClick={() => {
              // 删除内部消息即时覆盖落盘，无撤销路径，先确认再删
              if (!window.confirm('删除该内部消息将永久移除且无法恢复。确定删除？')) return
              onDelete()
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            ref={areaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-btn border border-accent/40 bg-bg-elevated px-3 py-2 text-body leading-relaxed text-fg-primary outline-none"
          />
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => { setEditing(false); setDraft(msg.content) }}
              className="flex items-center gap-1.5 rounded-btn px-3 py-1.5 text-caption text-fg-muted transition-all hover:bg-bg-muted"
            >
              <X size={13} />
              {t('internal.createCancel')}
            </button>
            <button
              onClick={() => { setEditing(false); onSave(draft) }}
              className="flex items-center gap-1.5 rounded-btn bg-accent/15 px-3 py-1.5 text-caption font-medium text-accent transition-all hover:bg-accent/25"
            >
              <Check size={13} />
              {t('internal.createConfirm')}
            </button>
          </div>
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-body leading-relaxed text-fg-secondary">
          {msg.content || <span className="text-fg-muted/40">—</span>}
        </div>
      )}
    </div>
  )
}