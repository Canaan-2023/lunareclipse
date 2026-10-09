/**
 * 为什么存在：hook 是治理 AI 行为的安全机制，需要检视实际生效清单并定位
 * 来源（全局/项目/内核），独立检视面板承载。
 * 作用：渲染 Hook 检视面板——从三源（全局 hooks.json/workspace hooks.json/内核）
 * 合并展示事件 × matcher 列表，标识类型与来源，支持刷新。
 */
import { useCallback, useEffect, useState } from 'react'
import { Webhook, RefreshCw, ShieldCheck, Puzzle, FileCode, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

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

const EVENT_LABELS: Record<string, string> = {
  PreToolUse: '工具调用前',
  PostToolUse: '工具调用后',
  UserPromptSubmit: '用户提交消息',
  PreLLMCall: 'LLM 调用前',
  Stop: 'AI 完成响应',
  SubagentStop: '子 Agent 完成',
  Notification: '通知'
}

function SourceBadge({ source }: { source: string }) {
  if (source === 'kernel') {
    return (
      <span className="flex items-center gap-1 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
        <ShieldCheck size={9} />
        内核治理
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
      config 配置
    </span>
  )
}

export function HookPanel() {
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
      else setError(res.error ?? '加载失败')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

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
          Hook 机制
          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">{rows.length}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50"
            title="刷新"
            aria-label="刷新 Hook 列表"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => closeDrawer()}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="关闭"
            aria-label="关闭 Hook 面板"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        <p className="mb-2 px-1 text-[10px] leading-relaxed text-fg-muted">
          真实生效的 hook（三源）：<span className="text-accent">内核治理</span> = 空转抑制/查证提醒/收尾反思/失败止损；
          config = 配置文件注册；plugin = 插件 hooks.js。停用单个治理机制用 config_patch 写 governance.机制名=false。
        </p>
        {error && <div className="mb-2 rounded bg-danger-soft/50 px-2 py-1 text-[10px] text-danger">{error}</div>}
        {grouped.length === 0 && !error && (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            暂无生效 hook
            <div className="mt-2 text-[11px]">内核治理机制在重启后注册，若无显示请刷新</div>
          </div>
        )}
        {grouped.map((g) => (
          <div key={g.event} className="mb-3">
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
              <span className="h-1 w-1 rounded-full bg-accent" />
              {EVENT_LABELS[g.event] ?? g.event}
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
