/**
 * 为什么存在：记忆工作流/记忆等系统内部运转状态需要可视化面板统一观测与排障，
 * 按域拆成多个 Tab 便于聚焦，独立于业务面板。
 * 作用：渲染监控面板——Tab 切换（工作流/记忆/日志/模块/健康）、周期轮询拉取
 * visualizationData、事件驱动刷新与 loading 态。
 */
import { useEffect, useState } from 'react'
import { X, RefreshCw, Activity, Terminal, Database, ShieldCheck, Boxes } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useVisibleInterval } from '../../hooks/useVisibleInterval'
import { useT } from '../../i18n/useT'
import { MemoryWorkflowTab } from './MemoryWorkflowTab'
import { MemoryTab } from './memoryTab'
import { LogTab } from './logTab'
import { HealthTab } from './healthTab'
import { ModulesTab } from './modulesTab'

type Tab = 'workflow' | 'memory' | 'log' | 'health' | 'modules'

export function VisualizationPanel() {
  const open = useAppStore((s) => s.vizPanelOpen)
  const close = () => useAppStore.getState().setVizPanelOpen(false)
  const data = useAppStore((s) => s.visualization)
  const loading = useAppStore((s) => s.visualizationLoading)
  const refresh = useAppStore((s) => s.refreshVisualization)
  const workflowLog = useAppStore((s) => s.workflowLog)
  const [tab, setTab] = useState<Tab>('workflow')
  const t = useT()

  // 打开时立即刷新一次；轮询交给 useVisibleInterval（窗口隐藏时暂停，恢复可见立即补刷）
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])
  useVisibleInterval(() => void refresh(), 5000, open)

  // 浏览器 view 显隐已由 appStore.syncBrowserVisibility 统一控制（setVizPanelOpen 时调用）：
  // 监控面板打开 → overlay=true + browserHide()；关闭 → 恢复浏览器标签显隐。
  // 这里不再重复处理，避免与 store 逻辑产生竞态。

  // workflowLog 由实时事件推送，有新日志说明工作流在活动，此时自动刷新可视化数据
  const workflowLogLen = workflowLog.length
  useEffect(() => {
    if (!open) return
    if (workflowLogLen === 0) return
    void refresh()
  }, [workflowLogLen, open, refresh])

  // Esc 关闭：监控面板是遮罩 + 侧滑层，应支持键盘关闭（与其他面板 Esc 惯例一致）。
  // 焦点在面板内按钮时同样要生效，因此挂 window 级 keydown；用 getState 避免
  // close 箭头函数每次渲染变化导致 effect 反复重挂。
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useAppStore.getState().setVizPanelOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!open) return null

  return (
    // 遮罩：z-50 确保盖住右侧标签栏(z-50)和所有面板；绑定 onClick 关闭面板
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={close}>
      <div
        // 响应式：窄屏占满宽度，sm 及以上固定 640px；阻止点击冒泡到遮罩
        className="flex h-full w-full max-w-[640px] flex-col border-l border-border bg-bg-surface shadow-2xl sm:w-[640px]"
        style={{ animation: 'viz-slide-in 0.25s ease-out' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
          <h2 className="text-title font-medium text-fg-primary">{t('vizui.panel.title')}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50"
              title={t('vizui.panel.refresh')}
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={close}
              aria-label={t('vizui.panel.closeAria')}
              title={t('vizui.panel.close')}
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Tab 栏 */}
        <nav className="flex border-b border-border-subtle">
          {([{
            id: 'workflow' as Tab, labelKey: 'vizui.panel.tab.workflow', icon: Activity
          }, {
            id: 'memory' as Tab, labelKey: 'vizui.panel.tab.memory', icon: Database
          }, {
            id: 'log' as Tab, labelKey: 'vizui.panel.tab.log', icon: Terminal
          }, {
            id: 'health' as Tab, labelKey: 'vizui.health.title', icon: ShieldCheck
          }, {
            id: 'modules' as Tab, labelKey: 'vizui.modules.title', icon: Boxes
          }]).map(({ id, labelKey, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-3 py-2.5 text-caption transition-colors ${
                tab === id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary'
              }`}
            >
              <Icon size={12} />
              {t(labelKey)}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === 'workflow' && <MemoryWorkflowTab data={data} loading={loading} />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'log' && <LogTab workflowLog={workflowLog} />}
          {tab === 'health' && <HealthTab data={data} />}
          {tab === 'modules' && <ModulesTab data={data} />}
        </div>
      </div>

      <style>{`
        @keyframes viz-slide-in {
          0% { transform: translateX(40px); opacity: 0.5 }
          100% { transform: translateX(0); opacity: 1 }
        }
      `}</style>
    </div>
  )
}