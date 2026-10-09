/**
 * 为什么存在：DMN/记忆等系统内部运转状态需要可视化面板统一观测与排障，
 * 按域拆成多个 Tab 便于聚焦，独立于业务面板。
 * 作用：渲染监控面板——Tab 切换（DMN/记忆/日志/模块/健康）、周期轮询拉取
 * visualizationData、事件驱动刷新与 loading 态。
 */
import { useEffect, useState } from 'react'
import { X, RefreshCw, Activity, Terminal, Database, ShieldCheck, Boxes } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { DmnTab } from './dmnTab'
import { MemoryTab } from './memoryTab'
import { LogTab } from './logTab'
import { HealthTab } from './healthTab'
import { ModulesTab } from './modulesTab'

type Tab = 'dmn' | 'memory' | 'log' | 'health' | 'modules'

export function VisualizationPanel() {
  const open = useAppStore((s) => s.vizPanelOpen)
  const close = () => useAppStore.getState().setVizPanelOpen(false)
  const data = useAppStore((s) => s.visualization)
  const loading = useAppStore((s) => s.visualizationLoading)
  const refresh = useAppStore((s) => s.refreshVisualization)
  const dmnLog = useAppStore((s) => s.dmnLog)
  const [tab, setTab] = useState<Tab>('dmn')

  // 打开时启动 5s 轮询，关闭时停止
  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [open, refresh])

  // 浏览器 view 显隐已由 appStore.syncBrowserVisibility 统一控制（setVizPanelOpen 时调用）：
  // 监控面板打开 → overlay=true + browserHide()；关闭 → 恢复浏览器标签显隐。
  // 这里不再重复处理，避免与 store 逻辑产生竞态。

  // dmnLog 由实时事件推送，有新日志说明工作流在活动，此时自动刷新可视化数据
  const dmnLogLen = dmnLog.length
  useEffect(() => {
    if (!open) return
    if (dmnLogLen === 0) return
    void refresh()
  }, [dmnLogLen, open, refresh])

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
          <h2 className="text-title font-medium text-fg-primary">监控可视化</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void refresh()}
              disabled={loading}
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-50"
              title="刷新"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={close}
              aria-label="关闭可视化"
              title="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Tab 栏 */}
        <nav className="flex border-b border-border-subtle">
          {([{
            id: 'dmn' as Tab, label: 'DMN 监控', icon: Activity
          }, {
            id: 'memory' as Tab, label: '记忆系统', icon: Database
          }, {
            id: 'log' as Tab, label: '运行日志', icon: Terminal
          }, {
            id: 'health' as Tab, label: '健康检查', icon: ShieldCheck
          }, {
            id: 'modules' as Tab, label: '模块监控', icon: Boxes
          }]).map(({ id, label, icon: Icon }) => (
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
              {label}
            </button>
          ))}
        </nav>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === 'dmn' && <DmnTab data={data} loading={loading} />}
          {tab === 'memory' && <MemoryTab />}
          {tab === 'log' && <LogTab dmnLog={dmnLog} />}
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