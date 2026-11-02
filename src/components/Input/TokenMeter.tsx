/**
 * 为什么存在：上下文 token 计数胶囊在流式期间需要每 500ms 读一次全部消息做估算，
 * 若留在 InputArea 里，输入框会随每条流式 token 重渲染。独立成组件后，只有这一小块
 * 订阅 streamingMessageId 并读取消息（getState 快照，不订阅 currentMessages），
 * 输入框主体不再被流式链路牵连。
 * 作用：渲染 token 预算胶囊 + hover 详情（用量 / 缓存 / 上下文警告）。
 */
import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'
import { useT } from '../../i18n/useT'

export function TokenMeter() {
  const t = useT()
  const streamingMessageId = useAppStore((s) => s.streamingMessageId)
  const lastTokenCount = useAppStore((s) => s.lastTokenCount)
  const lastTokenBudget = useAppStore((s) => s.lastTokenBudget)
  const configTokenBudget = useAppStore((s) => s.config.tokenBudget)
  const lastUsage = useAppStore((s) => s.lastUsage)
  const contextWarning = useAppStore((s) => s.contextWarning)

  // 流式输出时每 500ms 前端实时估算 token（WS token 消息只在请求发起时刷新一次）。
  // 用 getState() 取快照而非订阅 currentMessages——组件不因每条 token 重渲染。
  const [streamingTokenEstimate, setStreamingTokenEstimate] = useState<number | null>(null)
  useEffect(() => {
    if (!streamingMessageId) {
      setStreamingTokenEstimate(null)
      return
    }
    setStreamingTokenEstimate(estimateMessagesTokens(useAppStore.getState().currentMessages))
    const timer = setInterval(() => {
      setStreamingTokenEstimate(estimateMessagesTokens(useAppStore.getState().currentMessages))
    }, 500)
    return () => clearInterval(timer)
  }, [streamingMessageId])

  // 上下文计数：流式时优先前端估算，否则回退 WS 推送
  const displayTokenCount = streamingTokenEstimate ?? lastTokenCount
  // 有效预算：lastTokenBudget ?? config.tokenBudget ?? 软预算兜底（与后端 SOFT_BUDGET_TOKENS 一致）
  const SOFT_BUDGET_TOKENS = 16000
  const effectiveBudget =
    lastTokenBudget !== null && lastTokenBudget > 0
      ? lastTokenBudget
      : configTokenBudget !== null && configTokenBudget > 0
        ? configTokenBudget
        : SOFT_BUDGET_TOKENS
  const showTokenBar = displayTokenCount !== null
  const tokenPercent = showTokenBar ? Math.min(100, (displayTokenCount! / effectiveBudget) * 100) : 0
  const tokenWarn = showTokenBar && tokenPercent > 80
  const tokenMid = showTokenBar && tokenPercent > 60 && !tokenWarn

  if (!showTokenBar) return null

  return (
    <div
      className={`group relative ml-auto flex h-7 shrink-0 cursor-default items-center gap-1.5 rounded-full px-2.5 transition-all duration-150 ${
        tokenWarn
          ? 'bg-danger/10 ring-1 ring-danger/40'
          : tokenMid
            ? 'bg-warning/10 ring-1 ring-warning/30'
            : 'bg-bg-muted'
      }`}
      title={lastTokenBudget !== null && lastTokenBudget > 0 ? 'Token budget' : 'Soft budget estimate'}
    >
      <span
        className={`tabular-nums text-micro font-medium ${
          tokenWarn ? 'text-danger' : tokenMid ? 'text-warning' : 'text-fg-muted'
        }`}
      >
        {(displayTokenCount! / 1000).toFixed(1)}k/{(effectiveBudget / 1000).toFixed(0)}k
        {lastTokenBudget === null && configTokenBudget === null && <span className="ml-0.5 opacity-60">*</span>}
      </span>
      {/* hover 展开详情 */}
      <div className="invisible absolute bottom-full right-0 z-30 mb-1.5 whitespace-nowrap rounded-btn border border-border bg-bg-elevated px-3 py-2 shadow-lg opacity-0 transition-all duration-150 group-hover:visible group-hover:opacity-100">
        <div className="flex items-center gap-3 text-micro text-fg-muted">
          <span className="tabular-nums">
            {displayTokenCount} / {effectiveBudget} token
          </span>
          <span className="tabular-nums">{tokenPercent.toFixed(0)}%</span>
        </div>
        {lastUsage && (
          <div className="mt-1 flex items-center gap-2 text-micro text-fg-muted">
            <span
              title={`Input ${lastUsage.inputTokens} / Output ${lastUsage.outputTokens}${lastUsage.cacheReadTokens !== undefined ? ` / Cache ${lastUsage.cacheReadTokens}` : ''}`}
            >
              ↑{lastUsage.inputTokens} ↓{lastUsage.outputTokens}
            </span>
            {lastUsage.cacheReadTokens !== undefined && (
              <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-success">
                {t('token.cache')} {lastUsage.cacheReadTokens}
              </span>
            )}
          </div>
        )}
        {contextWarning && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-warning">
            <span className="max-w-60 truncate">{contextWarning}</span>
            <button
              onClick={() => useAppStore.setState({ contextWarning: null })}
              className="shrink-0 text-warning/70 hover:text-warning"
              title={t('common.close')}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
