/**
 * 为什么存在：AI 管理面板的列表在流式/代理开关等状态变化时会随父组件整体重渲染，
 * 单行组件本身与父组件其他状态无关，独立成文件并 memo 后可跳过无关重渲染。
 * 作用：渲染单个 AI 列表行（头像 / 名称 / 描述 / 状态 / 操作按钮）。
 * 注意：回调统一传「行数据」而非闭包——父层用 useCallback 保持引用稳定，memo 才生效。
 */
import { memo } from 'react'
import { FileText, Pencil, Power, RotateCcw, Trash2 } from 'lucide-react'
import type { AiRecord } from '../../../electron/main/models/ai-registry'
import { useT } from '../../i18n/useT'
import { AiAvatar, aiAvatarFallback } from './AiAvatar'

interface Props {
  ai: AiRecord
  onEdit?: (ai: AiRecord) => void
  onPrompt?: (ai: AiRecord) => void
  onToggle?: (ai: AiRecord) => void
  onRemove?: (ai: AiRecord) => void
}

/** 列表行：avatar + 名称 + 描述 + 操作 */
export const AiListItem = memo(function AiListItem({ ai, onEdit, onPrompt, onToggle, onRemove }: Props) {
  const t = useT()
  const isSystem = ai.kind === 'system'
  return (
    <div className={`group mb-1 flex items-start gap-2 rounded-btn px-3 py-2 transition-all duration-150 hover:bg-bg-muted/70 ${ai.deactivated ? 'opacity-50' : ''}`}>
      <AiAvatar
        avatar={ai.avatar}
        fallback={aiAvatarFallback(ai.id)}
        className="mt-0.5 h-6 w-6 text-sm"
        title={ai.name}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-body ${ai.deactivated ? 'text-fg-muted' : 'text-fg-primary'}`}>{ai.name}</span>
          {ai.deactivated && (
            <span className="shrink-0 rounded-full bg-fg-muted/15 px-1.5 py-0.5 text-[10px] text-fg-muted">{t('ai.statusDeactivated')}</span>
          )}
          {!ai.deactivated && (
            <span className="shrink-0 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] text-success">{t('ai.statusActive')}</span>
          )}
        </div>
        {ai.description && (
          <div className="mt-0.5 line-clamp-2 text-caption text-fg-secondary">{ai.description}</div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1 text-micro text-fg-muted">
          <span className="rounded bg-bg-muted px-1 py-px font-mono">#{ai.id}</span>
          <span className="rounded bg-bg-muted px-1 py-px font-mono">{ai.agent}</span>
          {ai.parentAiId != null && <span>· {t('ai.fromAi', { id: ai.parentAiId })}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* 提示词 */}
        <button
          onClick={() => onPrompt?.(ai)}
          aria-label={t('ai.prompt')}
          className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent"
          title={t('ai.prompt')}
        >
          <FileText size={12} />
        </button>
        {!isSystem && onEdit && (
          <button
            onClick={() => onEdit(ai)}
            aria-label={t('ai.edit')}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent"
            title={t('ai.edit')}
          >
            <Pencil size={12} />
          </button>
        )}
        {!isSystem && onToggle && (
          <button
            onClick={() => onToggle(ai)}
            aria-label={ai.deactivated ? t('ai.reactivate') : t('ai.deactivate')}
            className={`flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-bg-muted ${ai.deactivated ? 'text-accent hover:text-accent' : 'text-fg-muted hover:text-danger'}`}
            title={ai.deactivated ? t('ai.reactivate') : t('ai.deactivate')}
          >
            {ai.deactivated ? <RotateCcw size={12} /> : <Power size={12} />}
          </button>
        )}
        {!isSystem && onRemove && (
          <button
            onClick={() => onRemove(ai)}
            aria-label={t('ai.delete')}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger"
            title={t('ai.delete')}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  )
})
