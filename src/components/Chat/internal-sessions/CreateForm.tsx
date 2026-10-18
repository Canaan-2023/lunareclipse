/**
 * @category 前端组件
 * @summary 新建内部会话表单（固定宽度居中）
 * @note 为什么存在：原 `InternalSessionsView.tsx` 1408 行破 800 硬红线（ADR-27 拆分）；表单与画布渲染无关，独立成文件降低宿主体积。
 * @note 不删理由：新建入口是面板的必备交互，内联回宿主会让宿主重新长回巨石。
 */

import { useState } from 'react'
import {
  Plus,
  Check
} from 'lucide-react'
import { useT } from '../../../i18n/useT'


/** 新建内部会话表单：固定宽度居中，不再占满面板 */
export function CreateForm({
  onCancel,
  onSubmit
}: {
  onCancel: () => void
  onSubmit: (title: string, content: string) => Promise<void>
}) {
  const t = useT()
  const [title, setTitle] = useState(t('internal.createTitle'))
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <div className="space-y-2.5 rounded-card border border-accent/25 bg-bg-surface/60 p-3.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
        <Plus size={13} />
        {t('internal.new')}
      </div>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary outline-none focus:border-accent/40"
        placeholder={t('internal.createTitle')}
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="w-full resize-none rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary outline-none focus:border-accent/40"
        placeholder={t('internal.contentPlaceholder')}
      />
      <div className="flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-btn px-3 py-1.5 text-caption text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
        >
          {t('internal.createCancel')}
        </button>
        <button
          disabled={busy || !title.trim()}
          onClick={async () => {
            setBusy(true)
            await onSubmit(title.trim(), content)
          }}
          className="flex items-center gap-1.5 rounded-btn bg-accent/15 px-3 py-1.5 text-caption font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-40"
        >
          <Check size={13} />
          {t('internal.createConfirm')}
        </button>
      </div>
    </div>
  )
}

