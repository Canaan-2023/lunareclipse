/**
 * 为什么存在：根错误边界只能兜住整窗，任一面板渲染抛错就会白屏并连带让其他面板失效；
 * 面板级隔离需要一层薄封装，把 ErrorBoundary 的 fallback 渲染成“只坏这一块”的错误卡片。
 * 作用：包裹单个面板——出错时只显示该面板的错误卡片（重试 / 复制错误信息 / 可选关闭），
 * 其余区域继续可用。
 */
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Copy, Check, RotateCcw, X } from 'lucide-react'
import { ErrorBoundary, type ErrorBoundaryFallbackProps } from './ErrorBoundary'
import { useT } from '../i18n/useT'
import { copyText } from '../utils/clipboard'
import { useTransientTimer } from '../hooks/useTransientTimer'

interface Props {
  /** 面板显示名（已翻译），用于错误标题 */
  label: string
  /** overlay：面板本体是 fixed 全屏遮罩；inline：填充所在容器 */
  variant?: 'inline' | 'overlay'
  /** 可选：关闭面板。覆盖层面板渲染失败时自身关闭按钮已消失，需要这个出口 */
  onDismiss?: () => void
  /**
   * 面板当前是否处于打开态（默认 true）。出错后面板被关闭时，错误卡片随之隐藏，
   * 避免“已关闭的面板仍占位显示错误卡片”；再次打开会重新显示（错误状态仍在）。
   */
  active?: boolean
  children: ReactNode
}

function PanelErrorCard({
  error,
  componentStack,
  reset,
  label,
  variant,
  onDismiss
}: ErrorBoundaryFallbackProps & Pick<Props, 'label' | 'variant' | 'onDismiss'>) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const { schedule } = useTransientTimer()

  const details = [
    `${error.name}: ${error.message}`,
    error.stack,
    componentStack
  ].filter(Boolean).join('\n\n')

  const handleCopy = async () => {
    if (await copyText(details)) {
      setCopied(true)
      schedule(() => setCopied(false), 2000)
    }
  }

  return (
    <div
      className={
        variant === 'overlay'
          ? 'fixed inset-0 z-50 flex items-center justify-center bg-bg-base p-8'
          : 'flex h-full w-full items-center justify-center bg-bg-base p-4'
      }
    >
      <div
        role="alert"
        aria-live="assertive"
        className="flex w-full max-w-md flex-col gap-3 rounded-card border border-border-subtle bg-bg-surface p-4 text-center"
      >
        <AlertTriangle size={18} className="mx-auto text-fg-secondary" aria-hidden="true" />
        <div className="text-body font-medium text-fg-primary">
          {t('error.panel.title', { panel: label })}
        </div>
        <div className="text-caption text-fg-secondary">{t('error.panel.desc')}</div>
        <pre className="max-h-40 overflow-auto rounded-btn border border-border-subtle bg-bg-muted p-2 text-left text-[11px] text-fg-muted">
          {details}
        </pre>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={reset}
            className="flex items-center gap-1 rounded-btn bg-accent px-3 py-1.5 text-caption text-accent-fg hover:bg-accent/80"
          >
            <RotateCcw size={12} aria-hidden="true" />
            {t('error.panel.retry')}
          </button>
          <button
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 rounded-btn border border-border-subtle px-3 py-1.5 text-caption text-fg-secondary hover:bg-bg-muted hover:text-fg-primary"
          >
            {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
            {copied ? t('error.panel.copied') : t('error.panel.copy')}
          </button>
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="flex items-center gap-1 rounded-btn border border-border-subtle px-3 py-1.5 text-caption text-fg-secondary hover:bg-bg-muted hover:text-fg-primary"
            >
              <X size={12} aria-hidden="true" />
              {t('common.close')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * 面板级错误边界：渲染异常只影响被包裹的面板，其余区域继续可用。
 * 不在这里重复错误态实现——复用 ErrorBoundary 的捕获与重置逻辑。
 */
export function PanelErrorBoundary({ label, variant = 'inline', onDismiss, active = true, children }: Props) {
  return (
    <ErrorBoundary
      fallback={(info) =>
        active
          ? <PanelErrorCard {...info} label={label} variant={variant} onDismiss={onDismiss} />
          : null
      }
    >
      {children}
    </ErrorBoundary>
  )
}
