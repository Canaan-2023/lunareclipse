/**
 * 为什么存在：渲染异常会导致整窗白屏且无法交互，需要 class 组件错误边界
 * 兜底（函数组件无法捕获自身渲染错误）。
 * 作用：定义全局错误边界——捕获子组件渲染异常，展示错误信息与重试按钮。
 */
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  componentStack?: string
}

/**
 * 全局错误边界：捕获子组件渲染异常，避免整个应用白屏
 * 显示错误信息 + 重试按钮，便于诊断
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

  handleReload = () => {
    this.setState({ hasError: false, error: null })
    window.location.reload()
  }

  render() {
    if (!this.state.hasError) return this.props.children
    const err = this.state.error
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-bg-base p-8 text-center">
        <div className="text-heading text-fg-primary">月蚀遇到问题</div>
        <div className="max-w-md text-body text-fg-secondary">
          应用渲染时发生错误。可以尝试重新加载，或检查控制台日志。
        </div>
        {err && (
          <pre className="max-w-md overflow-auto rounded-card border border-border-subtle bg-bg-surface p-3 text-left text-caption text-red-400">
            {err.name}: {err.message}
            {err.stack && (
              <div className="mt-2 whitespace-pre-wrap border-t border-border-subtle pt-2 text-fg-muted">
                {err.stack}
              </div>
            )}
            {this.state.componentStack && (
              <div className="mt-2 whitespace-pre-wrap border-t border-border-subtle pt-2 text-fg-muted">
                {this.state.componentStack}
              </div>
            )}
          </pre>
        )}
        <button
          onClick={this.handleReload}
          className="rounded-btn bg-accent px-4 py-2 text-body text-accent-fg hover:bg-accent/80"
        >
          重新加载
        </button>
      </div>
    )
  }
}
