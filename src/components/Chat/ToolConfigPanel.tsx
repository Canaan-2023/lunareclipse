/**
 * 为什么存在：前端 AI 工具启停是低频配置操作，独立弹层避免与聊天区混排，
 * 且草稿式提交可防止误操作直接落盘。
 * 作用：分类级 + per-tool 启用/禁用前端 AI 工具（直接注入模式），点"应用"才写入 config。
 */
import { useState, useMemo } from 'react'
import { X, Wrench, RotateCcw, Check, Loader2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { getFrontendTools, CATEGORY_LABELS, CATEGORY_ICONS } from '@shared/tools/registry'
import type { ToolCategory, FrontendToolPolicy, ToolPolicy, AppConfig } from '@shared/types'

interface Props {
  onClose: () => void
}

/** 前端 AI 工具配置面板：分类级 + per-tool 启用/禁用（直接注入模式，onDemand 已退役） */
export function ToolConfigPanel({ onClose }: Props) {
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)

  // 本地草稿状态，点"应用"才写入 config
  const [draft, setDraft] = useState<FrontendToolPolicy>(() => ({
    tools: { ...config.frontendToolPolicy.tools }
  }))
  // 应用落盘中/失败提示：setConfig IPC 失败时必须让用户可见，不能无声吞掉
  const [saving, setSaving] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)

  const frontendTools = useMemo(() => getFrontendTools(), [])

  // 按分类分组（排除机制入口，单独显示）
  const byCategory = useMemo(() => {
    const map = new Map<ToolCategory, typeof frontendTools>()
    for (const t of frontendTools) {
      if (t.isMechanism) continue
      const arr = map.get(t.category) ?? []
      arr.push(t)
      map.set(t.category, arr)
    }
    return map
  }, [frontendTools])

  const setToolEnabled = (toolId: string, enabled: boolean) => {
    setDraft((d) => ({
      ...d,
      tools: { ...d.tools, [toolId]: { enabled } }
    }))
  }

  const setCategoryEnabled = (cat: ToolCategory, enabled: boolean) => {
    const toolsInCat = byCategory.get(cat) ?? []
    const newTools = { ...draft.tools }
    for (const t of toolsInCat) {
      newTools[t.id] = { enabled }
    }
    setDraft((d) => ({ ...d, tools: newTools }))
  }

  const selectAll = () => {
    const newTools: Record<string, ToolPolicy> = {}
    for (const t of frontendTools) {
      if (!t.isMechanism) newTools[t.id] = { enabled: true }
    }
    setDraft((d) => ({ ...d, tools: newTools }))
  }

  const clearAll = () => {
    const newTools: Record<string, ToolPolicy> = {}
    for (const t of frontendTools) {
      if (!t.isMechanism) newTools[t.id] = { enabled: false }
    }
    setDraft((d) => ({ ...d, tools: newTools }))
  }

  const resetDefaults = () => {
    const newTools: Record<string, ToolPolicy> = {}
    for (const t of frontendTools) {
      if (!t.isMechanism) newTools[t.id] = { enabled: t.defaultEnabled }
    }
    setDraft({ tools: newTools })
  }

  const isToolOn = (toolId: string, defaultEnabled: boolean): boolean => {
    const entry = draft.tools[toolId]
    return entry ? entry.enabled : defaultEnabled
  }

  const isCategoryAllOn = (cat: ToolCategory): boolean => {
    const toolsInCat = byCategory.get(cat) ?? []
    return toolsInCat.every((t) => isToolOn(t.id, t.defaultEnabled))
  }

  const apply = async () => {
    if (saving) return
    setSaving(true)
    setApplyError(null)
    try {
      const newConfig: AppConfig = {
        ...config,
        frontendToolPolicy: draft
      }
      await saveConfig(newConfig)
      onClose()
    } catch (err) {
      // setConfig IPC 失败时给用户可见错误而非无声失败，应用按钮保持可用以便修正后重试
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="overflow-hidden rounded-card bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Wrench size={14} className="text-accent" />
          <span className="text-title font-medium text-fg-primary">工具配置</span>
        </div>
        <button onClick={onClose} aria-label="关闭工具配置" title="关闭" className="text-fg-muted transition-all duration-150 hover:text-fg-primary active:scale-95">
          <X size={16} />
        </button>
      </div>

      <div className="max-h-[400px] overflow-y-auto px-4 py-3">
        {/* 全选/全清 */}
        <div className="mb-3 flex gap-2">
          <button onClick={selectAll} className="rounded-btn bg-bg-muted px-2.5 py-1 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted/70 hover:text-fg-primary active:scale-95">
            全选
          </button>
          <button onClick={clearAll} className="rounded-btn bg-bg-muted px-2.5 py-1 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted/70 hover:text-fg-primary active:scale-95">
            全清
          </button>
        </div>

        {/* 按分类组织 */}
        {Array.from(byCategory.entries()).map(([cat, tools]) => (
          <div key={cat} className="mb-3">
            {/* 分类级 toggle */}
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span>{CATEGORY_ICONS[cat]}</span>
                <span className="text-body font-medium text-fg-primary">{CATEGORY_LABELS[cat]}</span>
                <span className="text-caption text-fg-muted">({tools.length})</span>
              </div>
              <Toggle
                on={isCategoryAllOn(cat)}
                onChange={(v) => setCategoryEnabled(cat, v)}
                ariaLabel={CATEGORY_LABELS[cat]}
              />
            </div>
            {/* per-tool toggles */}
            <div className="space-y-1 pl-5">
              {tools.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-btn px-2 py-1 hover:bg-bg-muted/30">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-caption text-fg-primary">{t.name}</span>
                    <span className="text-[10px] text-fg-muted">{t.id}</span>
                    {t.riskLevel === 'high' && (
                      <span className="rounded bg-danger-soft px-1 text-[10px] text-danger">高风险</span>
                    )}
                  </div>
                  <Toggle
                    on={isToolOn(t.id, t.defaultEnabled)}
                    onChange={(v) => setToolEnabled(t.id, v)}
                    ariaLabel={t.name}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* 保存失败提示条：setConfig 异常时展示错误，避免应用按钮失效无反馈 */}
      {applyError && (
        <div className="flex items-center gap-2 border-t border-red-500/20 bg-red-500/10 px-4 py-2 text-caption text-red-400">
          <span className="flex-1">{applyError}</span>
          <button onClick={() => setApplyError(null)} className="text-red-400/70 hover:text-red-400" title="关闭" aria-label="关闭">
            <X size={10} />
          </button>
        </div>
      )}

      {/* 底部操作 */}
      <div className="flex items-center justify-between border-t border-border-subtle px-4 py-2.5">
        <button
          onClick={() => {
            // 恢复默认会覆盖草稿中全部开关，误点后继续「应用」会让已保存的自定义配置整体丢失，先确认
            if (!window.confirm('恢复默认将覆盖当前所有工具开关设置，点击「应用」后生效且无法撤销。确定恢复默认？')) return
            resetDefaults()
          }}
          className="flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-caption text-fg-muted transition-all duration-150 hover:text-fg-secondary active:scale-95"
        >
          <RotateCcw size={12} />
          重置默认
        </button>
        <button
          onClick={apply}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-btn bg-accent px-4 py-1.5 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          应用
        </button>
      </div>
    </div>
  )
}

/** 开关组件：圆点固定 left+top，用 translate-x 滑动，确保不跑出容器且动画流畅 */
function Toggle({ on, onChange, ariaLabel }: { on: boolean; onChange: (v: boolean) => void; ariaLabel?: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-all duration-150 active:scale-95 ${
        on ? 'bg-accent' : 'bg-bg-muted'
      }`}
    >
      <span
        className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
          on ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}
