/**
 * 为什么存在：好友分组/备注编辑是轻交互，用就地浮层完成（批次 E-5a 拆出），
 * 避免打断列表浏览。
 * 作用：渲染好友编辑浮层——分组选择/新建与备注编辑，确定后回调保存。
 */
import type { RefObject } from 'react'
import type { TFunc } from '../../i18n/useT'
import { FOCUS } from './types'

interface FriendEditDialogProps {
  group: string
  note: string
  onGroupChange: (v: string) => void
  onNoteChange: (v: string) => void
  groupRef: RefObject<HTMLInputElement | null>
  /** 保存请求进行中（防重复提交，期间禁用确定按钮） */
  saving: boolean
  onClose: () => void
  onSave: () => void
  t: TFunc
}

/** 好友面板 · 编辑分组/备注浮层（列表页内联；受控组件，状态不下放） */
export function FriendEditDialog({
  group,
  note,
  onGroupChange,
  onNoteChange,
  groupRef,
  saving,
  onClose,
  onSave,
  t,
}: FriendEditDialogProps) {
  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="friend-edit-title"
        className="w-64 rounded-card border border-border bg-bg-elevated p-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div id="friend-edit-title" className="mb-2 text-caption font-medium text-fg-primary">{t('friend.editTitle')}</div>
        <label htmlFor="friend-edit-group" className="mb-1 block text-[10px] text-fg-muted">{t('friend.editGroup')}</label>
        <input
          id="friend-edit-group"
          ref={groupRef}
          value={group}
          onChange={(e) => onGroupChange(e.target.value)}
          className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <label htmlFor="friend-edit-note" className="mb-1 block text-[10px] text-fg-muted">{t('friend.editNote')}</label>
        <input
          id="friend-edit-note"
          value={note}
          onChange={(e) => onNoteChange(e.target.value)}
          className="mb-3 w-full rounded-btn border border-border-subtle bg-bg-base px-2 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-1.5">
          <button
            onClick={onClose}
            className={`rounded-btn bg-bg-muted px-3 py-1 text-caption text-fg-secondary hover:bg-bg-muted/70 ${FOCUS}`}
          >
            {t('friend.cancel')}
          </button>
          <button
            onClick={() => void onSave()}
            disabled={saving}
            className={`rounded-btn bg-accent px-3 py-1 text-caption text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
          >
            {t('friend.save')}
          </button>
        </div>
      </div>
    </div>
  )
}