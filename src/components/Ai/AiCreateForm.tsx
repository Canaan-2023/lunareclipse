/**
 * 为什么存在：创建表单的表单态（名称/描述/头像/提示词/本地校验错误）与面板的列表态、
 * 删除弹层等状态无关，留在主组件会让主组件每次输入都整体重渲染；独立成文件后
 * 这些 useState 就近下放，只重渲染表单自身。
 * 作用：渲染新建 AI 表单并向上提交创建载荷（头像图片落盘由面板层负责）。
 */
import { useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useT } from '../../i18n/useT'
import { AvatarPicker } from './AiAvatar'

interface Props {
  busy: boolean
  onCancel: () => void
  onSubmit: (payload: {
    name: string
    description?: string
    avatar?: string
    avatarImageDataUrl?: string
    systemPrompt?: string
  }) => void
}

/** 创建表单 */
export function AiCreateForm({ busy, onCancel, onSubmit }: Props) {
  const t = useT()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [avatar, setAvatar] = useState<string | undefined>(undefined)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [localErr, setLocalErr] = useState<string | null>(null)

  const submit = () => {
    const trimmed = name.trim()
    if (trimmed.length < 1 || trimmed.length > 16) {
      setLocalErr(t('ai.nameInvalid'))
      return
    }
    setLocalErr(null)
    // 本地图片（data: 前缀）尚未落盘：拆分交付，由面板层在创建成功后调 ai:saveAvatarImage 落盘再回写
    const isImageData = avatar?.startsWith('data:')
    onSubmit({
      name: trimmed,
      description: description.trim() || undefined,
      avatar: isImageData ? undefined : avatar,
      avatarImageDataUrl: isImageData ? avatar : undefined,
      systemPrompt: systemPrompt.trim() || undefined
    })
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
            placeholder={t('ai.namePlaceholder')}
            maxLength={16}
            className="w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.description')}</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('ai.descriptionPlaceholder')}
            maxLength={200}
            rows={2}
            className="w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
          />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.avatar')}</div>
          <AvatarPicker avatar={avatar} onChange={setAvatar} label="🤖" />
        </div>
        <div>
          <div className="mb-1 text-caption text-fg-secondary">{t('ai.promptCreate')}</div>
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t('ai.promptCreatePlaceholder')}
            maxLength={50000}
            rows={5}
            className="w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 font-mono text-caption text-fg-primary outline-none focus:border-accent"
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
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
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
