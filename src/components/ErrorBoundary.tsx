/**
 * 为什么存在：渲染异常会导致整窗白屏且无法交互，需要 class 组件错误边界
 * 兜底（函数组件无法捕获自身渲染错误）。
 * 作用：定义错误边界——捕获子组件渲染异常，默认展示全局错误页（含重试按钮）；
 * 传入 `fallback` 时可渲染面板级错误卡片，把故障限制在单个面板内。
 */
import { Component, type ReactNode } from 'react'
import { useT } from '../i18n/useT'

/** 自定义 fallback 渲染时拿到的上下文：错误信息 + 重置入口 */
export interface ErrorBoundaryFallbackProps {
  error: Error
  componentStack?: string
  /** 重置边界状态，让子树重新渲染（面板级“重试”按钮用这个） */
  reset: () => void
}

interface Props {
  children: ReactNode
  /** 自定义错误 UI；不传则使用全局错误页（保持原有整屏兜底行为） */
  fallback?: (info: ErrorBoundaryFallbackProps) => ReactNode
  /** 重置时回调：让外部同步收尾（例如关闭出错的面板） */
  onReset?: () => void
}

interface State {
  hasError: boolean
  error: Error | null
  componentStack?: string
}

/**
 * 错误边界：捕获子组件渲染异常，避免整个应用白屏
 * 默认显示错误信息 + 重新加载按钮；传入 fallback 时改为渲染调用方给的错误 UI
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: { componentStack: string }) {
    console.error('[ErrorBoundary]', error, info)
    // 把组件栈存进 state，错误页展示——只有 message 无法定位崩溃组件
    this.setState((s) => ({ ...s, componentStack: info.componentStack }))
  }

  /** 重置边界（面板级“重试”）：清空错误态，交给子树重新渲染 */
  handleReset = () => {
    this.setState({ hasError: false, error: null, componentStack: undefined })
    this.props.onReset?.()
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children
    const err = this.state.error
    const { fallback } = this.props
    if (fallback && err) {
      return fallback({
        error: err,
        componentStack: this.state.componentStack,
        reset: this.handleReset
      })
    }
    return (
      <ErrorFallbackUI error={err} componentStack={this.state.componentStack} onReload={this.handleReload} />
    )
  }
}

/** 默认全局错误页：函数组件以便使用 useT（class 的 render 内不能调用 hook） */
function ErrorFallbackUI({ error: err, componentStack, onReload }: { error: Error | null; componentStack?: string; onReload: () => void }) {
  const t = useT()
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg-base p-8 text-center">
      <div className="text-heading text-fg-primary">{t('panelui.error.title')}</div>
      <div className="max-w-md text-body text-fg-secondary">
        {t('panelui.error.desc')}
      </div>
      {err && (
        <pre className="max-w-md overflow-auto rounded-card border border-border-subtle bg-bg-surface p-3 text-left text-caption text-danger">
          {err.name}: {err.message}
          {err.stack && (
            <div className="mt-2 whitespace-pre-wrap border-t border-border-subtle pt-2 text-fg-muted">
              {err.stack}
            </div>
          )}
          {componentStack && (
            <div className="mt-2 whitespace-pre-wrap border-t border-border-subtle pt-2 text-fg-muted">
              {componentStack}
            </div>
          )}
        </pre>
      )}
      <button
        onClick={onReload}
        className="rounded-btn bg-accent px-4 py-2 text-body text-accent-fg hover:bg-accent/80"
      >
        {t('panelui.error.reload')}
      </button>
    </div>
  )
}
