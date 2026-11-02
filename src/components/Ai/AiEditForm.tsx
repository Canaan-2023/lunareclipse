/**
 * 为什么存在：编辑表单的表单态（名称/描述/头像草稿/校验错误）只服务于编辑视图，
 * 留在主组件会让主组件的列表、代理开关等无关状态一起参与重渲染；独立成文件后
 * 表单态就近下放，且关闭编辑视图即卸载、草稿不会跨视图残留。
 * 作用：渲染编辑 AI 表单并向上提交更新字段。
 */
import { useState } from 'react'
import { Loader2, Save } from 'lucide-react'
import type { AiRecord } from '../../../electron/main/models/ai-registry'
import { useT } from '../../i18n/useT'
import { AvatarPicker } from './AiAvatar'

interface Props {
  ai: AiRecord
  busy: boolean
  onCancel: () => void
  onSubmit: (name: string, description: string | undefined, avatar: string | undefined) => void
}

/** 编辑表单 */
export function AiEditForm({ ai, busy, onCancel, onSubmit }: Props) {
  const t = useT()
  const [name, setName] = useState(ai.name)
  const [description, setDescription] = useState(ai.description ?? '')
  const [avatar, setAvatar] = useState<string | undefined>(ai.avatar)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 16) {
      setLocalErr(t('ai.nameInvalid'))
      return
    }
    setLocalErr(null)
    onSubmit(trimmed, description.trim() || undefined, avatar?.trim() ? avatar : undefined)
  }

  return (
    <div className="px-3 py-3">
      <div className="mb-3 space-y-2">
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.name')} *</div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            maxLength={16}
            className="w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.description')}</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={200}
            rows={3}
            className="w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.avatar')}</div>
          <AvatarPicker
            avatar={avatar}
            onChange={setAvatar}
            label="🤖"
            saveImage={async (dataUrl) => {
              const r = await window.lunareclipse.aiSaveAvatarImage(ai.id, dataUrl)
              return r?.ok ? (r.ref ?? null) : null
            }}
          />
        </div>
      </div>
      {localErr && <div className="mb-2 text-caption text-danger">{localErr}</div>}
      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={busy}
          className="flex h-7 flex-1 items-center justify-center gap-1 rounded-btn bg-accent px-3 text-caption font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
          {t('ai.save')}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="flex h-7 items-center rounded-btn border border-border-subtle px-3 text-caption text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
        >
          {t('ai.cancel')}
        </button>
      </div>
    </div>
  )
}
