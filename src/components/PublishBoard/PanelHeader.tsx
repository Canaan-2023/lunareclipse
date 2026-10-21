/**
 * 为什么存在：发布板多个视图（板块/发布/详情）需要一致的面板头结构，
 * 抽成通用组件保证返回/刷新/关闭行为统一（批次 E-5b 拆分产物）。
 * 作用：渲染发布板通用面板头——标题 + 图标 + 返回/刷新/关闭按钮（可隐藏关闭）。
 */
import type { ReactNode } from 'react'
import { ArrowLeft, X, RefreshCw } from 'lucide-react'
import type { TFunc } from '../../i18n/useT'

interface PanelHeaderProps {
  title: string
  icon: ReactNode
  onBack?: () => void
  extra?: ReactNode
  onRefresh: () => void
  /** embedded 模式下关闭按钮由外层容器提供，隐藏避免重复 */
  showClose: boolean
  onClose: () => void
  t: TFunc
}

/** 发布板通用面板头（受控组件，状态不下放） */
export function PanelHeader({ title, icon, onBack, extra, onRefresh, showClose, onClose, t }: PanelHeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
        {onBack && (
          <button
            onClick={onBack}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('publishBoard.back')}
            aria-label={t('publishBoard.back')}
          >
            <ArrowLeft size={12} />
          </button>
        )}
        {icon}
        <span className="truncate">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        {extra}
        <button
          onClick={() => void onRefresh()}
          className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title={t('view.refresh')}
          aria-label={t('view.refresh')}
        >
          <RefreshCw size={11} />
        </button>
        {showClose && (
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={12} />
          </button>
        )}
      </div>
    </div>
  )
}