/**
 * 为什么存在：无边框窗口（frame:false）需要自绘标题栏承载窗口控制与品牌展示。
 * 作用：渲染应用字标 + 快捷入口（设置/登出）+ 窗口三键 + 缩放切换。
 */
import { useState, useEffect } from 'react'
import { Minus, Square, X, Copy, Settings, LogOut, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

/** TitleBar：应用字标 + 快捷入口（设置/登出）+ 窗口三键
 * 设置和登出始终可见，不依赖 Sidebar 展开状态 */
export function TitleBar() {
  const aiName = useAppStore((s) => s.config.aiName) || '月蚀'
  const openSettings = useAppStore((s) => s.openSettings)
  const logout = useAppStore((s) => s.confirmLogout)
  const [maximized, setMaximized] = useState(false)
  const [zoomMode, setZoomMode] = useState<'auto' | 'manual'>('auto')
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    window.lunareclipse.getWindowMaximized().then(setMaximized)
    const unsubscribe = window.lunareclipse.onWindowStateChange(setMaximized)
    return () => {
      unsubscribe()
    }
  }, [])

  // 缩放状态：启动读取 + 订阅主进程推送（快捷键/显示器变化/手动调整）
  useEffect(() => {
    void window.lunareclipse.uiZoomGet().then((s) => {
      setZoomMode(s.mode)
      setZoom(s.zoom)
    })
    const unsubscribe = window.lunareclipse.onUiZoomChange((s) => {
      setZoomMode(s.mode)
      setZoom(s.zoom)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  return (
    <div
      className="flex h-10 shrink-0 items-center justify-between bg-bg-surface px-3"
      style={{
        WebkitAppRegion: 'drag',
        // 去掉主题给 bg-bg-surface 加的 1px 全周描边：顶部栏与内容区之间不再有分割线
        boxShadow: 'none'
      } as React.CSSProperties}
    >
{/* 应用字标：中文名 + 大号分隔点 + 小字英文（对齐登录界面 LunarEclipse 字体与字距） */}
      <div className="flex items-center gap-1.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* 月蚀：华文细黑（STXihei），笔画纤细、富艺术感；无该字体时降级等线 Light / 微软雅黑 Light */}
        <span
          className="text-title font-normal leading-none text-fg-primary"
          style={{
            fontFamily:
              "'STXihei', 'DengXian Light', 'Microsoft YaHei Light', sans-serif",
            letterSpacing: '0.06em'
          } as React.CSSProperties}
        >
          {aiName}
        </span>
        <span className="text-xl font-light leading-none text-accent">·</span>
        <span className="text-[10px] uppercase leading-none tracking-[0.3em] text-fg-muted">
          LunarEclipse
        </span>
      </div>

{/* 右侧：缩放 + 设置 + 登出 + 窗口三键 */}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* 缩放控件：− / 百分比 / +；点击百分比=重置为自适应 */}
        <div className="flex items-center gap-0.5 rounded-btn bg-bg-muted px-1 py-0.5">
          <button
            onClick={() => void window.lunareclipse.uiZoomStep(-0.1)}
            className="flex h-5 w-5 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-elevated hover:text-fg-primary"
            title="缩小（Ctrl+-）"
            aria-label="缩小"
          >
            <ZoomOut size={12} />
          </button>
          <button
            onClick={() =>
              void (zoomMode === 'auto'
                ? window.lunareclipse.uiZoomSet(zoom)
                : window.lunareclipse.uiZoomReset())
            }
            className="flex h-5 min-w-10 items-center justify-center gap-0.5 rounded-md px-1 text-[11px] tabular-nums text-fg-secondary transition-colors hover:bg-bg-elevated hover:text-fg-primary"
            title={
              zoomMode === 'auto'
                ? `分辨率自适应（${Math.round(zoom * 100)}%），点击固定当前比例`
                : `手动 ${Math.round(zoom * 100)}%，点击恢复自适应`
            }
            aria-label="缩放比例，点击切换自适应与手动"
          >
            {zoomMode === 'auto' && <RotateCcw size={9} />}
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => void window.lunareclipse.uiZoomStep(0.1)}
            className="flex h-5 w-5 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-elevated hover:text-fg-primary"
            title="放大（Ctrl+=）"
            aria-label="放大"
          >
            <ZoomIn size={12} />
          </button>
        </div>
        <div className="mx-1 h-4 w-px bg-border-subtle" />
        <button
          onClick={() => openSettings()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
          title="设置"
          aria-label="设置"
        >
          <Settings size={14} />
        </button>
        <button
          onClick={() => void logout()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
          title="登出"
          aria-label="登出"
        >
          <LogOut size={14} />
        </button>
        <div className="mx-1 h-4 w-px bg-border-subtle" />
        <div role="group" aria-label="窗口控制" className="inline-flex items-center">
          <button
            onClick={() => window.lunareclipse.windowMinimize()}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="最小化"
            aria-label="最小化"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={() => window.lunareclipse.windowMaximize()}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={maximized ? '恢复窗口' : '最大化'}
            aria-label={maximized ? '恢复窗口' : '最大化'}
          >
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </button>
          <button
            onClick={() => window.lunareclipse.windowClose()}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-red-500/80 hover:text-white"
            title="关闭"
            aria-label="关闭"
          >
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
