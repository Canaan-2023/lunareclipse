/**
 * 为什么存在：hook 是治理 AI 行为的安全机制，需要检视实际生效清单并定位
 * 来源（全局/项目/内核），独立检视面板承载。
 * 作用：渲染 Hook 检视面板——从三源（全局 hooks.json/workspace hooks.json/内核）
 * 合并展示事件 × matcher 列表，标识类型与来源，支持刷新。
 */
import { useCallback, useEffect, useState } from 'react'
import { Webhook, RefreshCw, ShieldCheck, Puzzle, FileCode, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'

/**
 * Hook 检视面板（右侧栏 tab）：
 * 显示全部真实生效 hook（三源合并）——config 文件配置 + 内核治理机制（builtin）+ 插件 hooks.js。
 * 与 hook_list 工具同源（主进程 hooks:effective IPC）。
 */
interface HookRow {
  event: string
  matcher: string
  type: string
  source: string
}

const EVENT_LABEL_KEYS: Record<string, string> = {
  PreToolUse: 'hookui.event.preToolUse',
  PostToolUse: 'hookui.event.postToolUse',
  UserPromptSubmit: 'hookui.event.userPromptSubmit',
  PreLLMCall: 'hookui.event.preLLMCall',
  Stop: 'hookui.event.stop',
  SubagentStop: 'hookui.event.subagentStop',
  Notification: 'hookui.event.notification'
}

function SourceBadge({ source }: { source: string }) {
  const t = useT()
  if (source === 'kernel') {
    return (
      <span className="flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
        <ShieldCheck size={9} />
        {t('hookui.source.kernel')}
      </span>
    )
  }
  if (source.startsWith('plugin:')) {
    return (
      <span className="flex items-center gap-1 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-400">
        <Puzzle size={9} />
        {source}
      </span>
    )
  }
  if (source.startsWith('config:')) {
    return (
      <span className="flex items-center gap-1 rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary">
        <FileCode size={9} />
        {source}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary">
      <FileCode size={9} />
      {t('hookui.source.config')}
    </span>
  )
}

export function HookPanel() {
  const t = useT()
  const open = useAppStore((s) => s.activeDrawer === 'hook' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const [rows, setRows] = useState<HookRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await window.lunareclipse.hooksEffective()
      if (res.ok && res.rows) setRows(res.rows)
      else setError(res.error ?? t('hookui.loadFailed'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  if (!open) return null

  // 按事件分组（保持固定事件顺序）
  const eventOrder = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PreLLMCall', 'Stop', 'SubagentStop', 'Notification']
  const grouped = eventOrder
    .map((ev) => ({ event: ev, hooks: rows.filter((r) => r.event === ev) }))
    .filter((g) => g.hooks.length > 0)

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <Webhook size={13} className="text-accent" />
          {t('hookui.title')}
          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">{rows.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50"
            title={t('hookui.refresh')}
            aria-label={t('hookui.refreshAria')}
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => closeDrawer()}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('hookui.close')}
            aria-label={t('hookui.closeAria')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <p className="mb-2 px-1 text-[10px] leading-relaxed text-fg-muted">
          {t('hookui.descPrefix')}<span className="text-accent">{t('hookui.source.kernel')}</span>{t('hookui.descSuffix')}
        </p>
        {error && <div className="mb-2 rounded bg-danger-soft/50 px-2 py-1 text-[10px] text-danger">{error}</div>}
        {grouped.length === 0 && !error && (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            {t('hookui.empty')}
            <div className="mt-2 text-[11px]">{t('hookui.emptyHint')}</div>
          </div>
        )}
        {grouped.map((g) => (
          <div key={g.event} className="mb-3">
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
              <span className="h-1 w-1 rounded-full bg-accent" />
              {EVENT_LABEL_KEYS[g.event] ? t(EVENT_LABEL_KEYS[g.event]) : g.event}
            </div>
            <div className="space-y-1">
              {g.hooks.map((h, i) => (
                <div key={i} className="rounded-btn border border-border-subtle bg-bg-base/50 px-2.5 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <SourceBadge source={h.source} />
                    <span className="font-mono text-[10px] text-fg-muted">{h.type}</span>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-fg-secondary">
                    matcher: <span className="text-accent">{h.matcher}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
