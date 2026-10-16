/**
 * 为什么存在：会话可在默认模型基础上临时指定模型，需要免配置的会话级切换入口，
 * 独立组件挂在侧栏避免挤占配置面板。
 * 作用：渲染会话级模型切换下拉——列出模型池（默认 + 自定义），
 * 切换写回当前会话，未指定时回退默认模型。
 */
import { useState, useRef, useEffect, useMemo } from 'react'
import { ChevronDown, Check, Cpu } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

export function ModelSwitcher() {
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const currentSessionModel = useAppStore((s) => s.currentSessionModel)
  const defaultModel = useAppStore((s) => s.config.llm.model)
  const availableModels = useAppStore((s) => s.config.availableModels)
  const setSessionModel = useAppStore((s) => s.setSessionModel)

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const models = useMemo(() => {
    const set = new Set<string>()
    if (defaultModel) set.add(defaultModel)
    for (const m of availableModels) {
      if (m && m.trim()) set.add(m.trim())
    }
    return Array.from(set)
  }, [defaultModel, availableModels])

  // 默认模型为空（未配置）时不回退显示「（默认）」，选中显示为空
  const displayLabel = currentSessionModel ?? (defaultModel ? `${defaultModel}（默认）` : '')

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const handleSelect = async (model: string | null) => {
    setOpen(false)
    if (!currentSessionId) return
    await setSessionModel(model)
  }

  const disabled = !currentSessionId

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-btn border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-caption text-fg-secondary transition-all duration-150 hover:border-border active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        title="切换当前会话模型"
      >
        <Cpu size={11} className="shrink-0 text-fg-muted" />
        <span className="flex-1 truncate text-left">{displayLabel}</span>
        <ChevronDown
          size={11}
          className={`shrink-0 text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 max-h-60 w-full overflow-y-auto rounded-btn border border-border bg-bg-surface py-1 shadow-lg">
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption transition-colors ${
              currentSessionModel === null ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
            }`}
          >
            <Check
              size={11}
              className={currentSessionModel === null ? 'opacity-100' : 'opacity-0'}
            />
            <span className="flex-1 truncate">{defaultModel ? `${defaultModel}（默认）` : ''}</span>
          </button>
          {models
            .filter((m) => m !== defaultModel)
            .map((m) => {
              const active = currentSessionModel === m
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleSelect(m)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption transition-colors ${
                    active ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
                  }`}
                >
                  <Check size={11} className={active ? 'opacity-100' : 'opacity-0'} />
                  <span className="flex-1 truncate">{m}</span>
                </button>
              )
            })}
          {models.length === 0 && (
            <div className="px-2.5 py-2 text-center text-caption text-fg-muted">
              请先在设置中配置可用模型
            </div>
          )}
        </div>
      )}
    </div>
  )
}
