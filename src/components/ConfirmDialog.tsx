/**
 * 为什么存在：删除/清空等不可逆操作此前使用浏览器原生 confirm()，样式与月蚀多主题
 * 语义色体系割裂、无焦点管理（回车会直接命中"确定"），也不支持双层 i18n。统一抽象
 * 确认弹窗组件承载「确认 / 取消」二态，危险操作默认红色主按钮，打开时自动聚焦取消，
 * 防止不可逆操作被误触发。
 * 作用：渲染居中确认弹窗——遮罩点击 / Esc / 取消按钮均走 onCancel，确认走 onConfirm；
 * 支持 danger 语义切换主按钮颜色（danger=红 / 常规=accent）。
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useT } from '../i18n/useT'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** 弹窗正文：可传字符串或带高亮的 ReactNode */
  message: ReactNode
  /** 标题栏图标（如 Trash2 / AlertTriangle），不传则显示语义色圆点 */
  icon?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 危险操作（删除等）→ 红色主按钮；常规操作 → accent 主按钮 */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  icon,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const t = useT()
  const cancelRef = useRef<HTMLButtonElement>(null)

  // 打开时聚焦取消按钮：删除不可逆，回车落到"取消"更安全（防误触删除）
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  // Esc = 取消
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-[400px] max-w-[90vw] overflow-hidden rounded-card border border-border bg-bg-elevated shadow-2xl">
        {/* 标题栏 */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          {icon ? (
            <span className={`shrink-0 ${danger ? 'text-red-400' : 'text-accent'}`}>{icon}</span>
          ) : (
            <span className={`h-2 w-2 shrink-0 rounded-full ${danger ? 'bg-red-400' : 'bg-accent'}`} />
          )}
          <span className="flex-1 truncate text-caption font-medium text-fg-primary">{title}</span>
          <button
            onClick={onCancel}
            aria-label={cancelLabel ?? t('common.close')}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title={cancelLabel ?? t('common.close')}
          >
            <X size={13} />
          </button>
        </div>

        {/* 内容 */}
        <div className="px-4 py-4">
          <div className="text-body text-fg-primary">{message}</div>
        </div>

        {/* 按钮 */}
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded-btn px-3 py-1.5 text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={`rounded-btn px-3 py-1.5 text-caption font-medium transition-colors ${
              danger
                ? 'bg-red-500/90 text-white hover:bg-red-500'
                : 'bg-accent text-accent-fg hover:bg-accent-hover'
            }`}
          >
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}