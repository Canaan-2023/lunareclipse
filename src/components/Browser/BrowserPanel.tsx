/**
 * 为什么存在：浏览器面板是原生 WebContentsView 的前端控制层——WebContentsView 盖在
 * React DOM 之上，必须在 panel 侧提供全部交互控件并桥接主进程。
 * 作用：渲染浏览器面板——URL 工具栏/导航/刷新/截图、页面缩放控制、
 * 操作历史侧栏与追踪特效开关，状态经 browserSlice 同步。
 */
import { useState, useEffect, useRef, useLayoutEffect } from 'react'
import {
  Globe, X, ArrowLeft, ArrowRight, RefreshCw, Search,
  Camera, ArrowUp, ArrowDown, Code, History, ChevronDown, ChevronUp, Loader2,
  Share2, ZoomIn, ZoomOut, RotateCcw, AlertTriangle
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { BrowserHistoryEntry } from '../../../electron/main/tools/browser-view-manager'
import { formatDateTime } from '../../utils/time'

/**
 * 浏览器面板：
 * - 浏览器视图由 Electron WebContentsView 嵌入主窗口右侧（默认 50%，可拖拽调整）
 * - App.tsx 主容器动态 paddingRight，让 ChatArea 自然收缩
 * - 本组件渲染控件层（URL 工具栏 + 操作历史侧栏），全部定位在右侧面板区域内

 * 追踪特效（4 种）：
 * 1. 元素高亮框：由注入页面的 SVG 红色闪烁边框实现（在 webContents 内绘制）
 * 2. 鼠标轨迹动画：注入页面内的虚拟指针（在 webContents 内绘制）
 * 3. 动作标签：注入页面顶部状态条（在 webContents 内绘制）
 * 4. 操作历史侧栏：本组件渲染（React 层），从 IPC 事件流订阅
 */
export function BrowserPanel() {
  const open = useAppStore((s) => s.activeRightPanel === 'browser' && !s.vizPanelOpen && !s.settingsOpen)
  const url = useAppStore((s) => s.browserUrl)
  const loading = useAppStore((s) => s.browserLoading)
  const currentAction = useAppStore((s) => s.browserCurrentAction)
  const history = useAppStore((s) => s.browserHistory)
  const navigate = useAppStore((s) => s.browserNavigate)
  const back = useAppStore((s) => s.browserBack)
  const forward = useAppStore((s) => s.browserForward)
  const canGoBack = useAppStore((s) => s.browserCanGoBack)
  const canGoForward = useAppStore((s) => s.browserCanGoForward)
  const closeTab = useAppStore((s) => s.closeRightPanelTab)
  const scroll = useAppStore((s) => s.browserScroll)
  const screenshot = useAppStore((s) => s.browserScreenshot)
  const addAttachment = useAppStore((s) => s.addAttachment)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const setActiveRightPanel = useAppStore((s) => s.setActiveRightPanel)
  const browserTitle = useAppStore((s) => s.browserTitle)
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const activeDrawer = useAppStore((s) => s.activeDrawer)

  const [urlInput, setUrlInput] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [evalScript, setEvalScript] = useState('')
  const [showEval, setShowEval] = useState(false)
  const [evalResult, setEvalResult] = useState<string | null>(null)
  const [evalError, setEvalError] = useState<string | null>(null)
  const [evalRunning, setEvalRunning] = useState(false)
  // 截图发送 busy/error 态：browserScreenshot 可能失败（视图未显示/页面销毁），
  // 若没有 busy 与错误反馈，用户点击按钮会毫无反应且无法重试；
  // 不删的理由：错误横幅高度需计入下方布局预留，保证渲染在 WebContentsView 之上可见。
  const [shotBusy, setShotBusy] = useState(false)
  const [shotError, setShotError] = useState<string | null>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)
  const historyPanelRef = useRef<HTMLDivElement>(null)
  const [historyPanelHeight, setHistoryPanelHeight] = useState(0)

  // URL 变化时同步输入框
  useEffect(() => {
    if (url && urlInputRef.current && document.activeElement !== urlInputRef.current) {
      setUrlInput(url)
    }
  }, [url])

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      setTimeout(() => urlInputRef.current?.focus(), 100)
    }
  }, [open])

  // 文档 15.3：前端浮层变化时通知主进程预留空间，避免原生 WebContentsView 盖住浮层
  // 顶部：标题栏36 + 标签栏32 + 工具栏44 = 112；showEval +60；currentAction +36
  // 底部：showHistory 时按实际面板高度预留（ResizeObserver 实时测量，消除底部空白）
  useLayoutEffect(() => {
    if (!showHistory || !historyPanelRef.current) {
      setHistoryPanelHeight(0)
      return
    }
    const el = historyPanelRef.current
    const measure = () => setHistoryPanelHeight(el.offsetHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [showHistory, history.length])

  useEffect(() => {
    if (!open) return
    // 标题栏40 + 标签栏32 + 工具栏44 = 116
    const topBase = 116
    const evalExtra = showEval ? 60 : 0
    const actionExtra = currentAction ? 36 : 0
    const shotExtra = shotError ? 26 : 0 // 截图失败横幅高度，避免原生视图盖住反馈
    const top = topBase + evalExtra + actionExtra + shotExtra
    const bottom = showHistory ? historyPanelHeight : 0
    // Sidebar 始终可见：浏览器视图需偏移侧栏宽度避免覆盖
    const left = sidebarCollapsed ? 48 : sidebarWidth
    // 抽屉面板内联展开时，浏览器视图需从右侧收缩 340px
    const right = activeDrawer ? 340 : 0
    void window.lunareclipse?.browserSetLayout?.({ top, bottom, left, right })
  }, [open, showEval, shotError, currentAction, historyPanelHeight, sidebarWidth, sidebarCollapsed, activeDrawer])

  // ===== 网页缩放（主进程统一管理：自动=分辨率自适应 / 手动=用户覆盖，快捷键 Ctrl+=/-/0 在浏览器焦点下同样生效） =====
  // 注意：本组件始终挂载（App.tsx 用 CSS hidden 切换），hooks 必须声明在 early return 之前，
  // 否则 open 由 false→true 时 hooks 数量突变，React 抛 "Rendered more hooks" 导致全局渲染崩溃。
  const [browserZoomMode, setBrowserZoomMode] = useState<'auto' | 'manual'>('auto')
  const [browserZoom, setBrowserZoom] = useState(1)

  useEffect(() => {
    void window.lunareclipse?.browserZoomGet?.().then((s) => {
      setBrowserZoomMode(s.mode)
      setBrowserZoom(s.zoom)
    })
    const unsubscribe = window.lunareclipse?.onBrowserZoomChange?.((s) => {
      setBrowserZoomMode(s.mode)
      setBrowserZoom(s.zoom)
    })
    return () => unsubscribe?.()
  }, [])

  if (!open) return null

  const handleNavigate = (e: React.FormEvent) => {
    e.preventDefault()
    const target = urlInput.trim()
    if (!target) return
    // 非 URL 时按百度搜索处理（给用户一个默认搜索引擎）
    const isUrl = /^https?:\/\//i.test(target) || /^[\w-]+(\.[\w-]+)+/.test(target)
    const finalUrl = isUrl
      ? (/^https?:\/\//i.test(target) ? target : `https://${target}`)
      : `https://www.baidu.com/s?wd=${encodeURIComponent(target)}`
    void navigate(finalUrl)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeTab('browser')
    }
  }

  /** 一键截图发送到当前会话 */
  const handleScreenshotSend = async () => {
    if (shotBusy) return // 截图进行中禁止重复触发，防止同一张图被插入两次
    setShotBusy(true)
    setShotError(null)
    try {
      const res = await screenshot(false)
      if (!res?.ok) {
        // 截图失败（视图未显示/页面销毁/主进程异常）时提示具体原因，避免按钮点后无任何反应。
        // 作用：失败横幅高度计入顶部布局预留（shotExtra），保证渲染在 WebContentsView 之上可见。
        // 不删的理由：无此反馈用户只能盲点，无法判断是视图还是主进程问题。
        setShotError(res?.error || '截图失败，请重试')
        return
      }
      // 走到这说明 ok=true（screenshot 返回类型为准联合：ok 分支必带 data），
      // 用显式非空断言收窄：不解构则 TS 无法在联合上取 path/dataUrl/size。
      const data = res.data!
      const { path, dataUrl, size } = data
      addAttachment({
        name: path.split(/[\\/]/).pop() ?? 'screenshot.png',
        path,
        size,
        type: 'image/png',
        dataUrl
      })
      // 切回聊天视图并发送（空文本，仅附件）
      setActiveRightPanel('chat')
      await sendMessage('')
    } catch (err) {
      setShotError((err as Error).message || '截图失败，请重试')
    } finally {
      setShotBusy(false)
    }
  }

  /** 一键分享当前网页到会话（标题 + URL 文本） */
  const handleSharePage = async () => {
    if (!url) return
    const text = browserTitle
      ? `网页分享：${browserTitle}
${url}`
      : `网页分享：${url}`
    setActiveRightPanel('chat')
    await sendMessage(text)
  }

  /** 在页面执行 JS 并展示结果 */
  const runEval = async () => {
    const script = evalScript.trim()
    if (!script || evalRunning) return
    setEvalRunning(true)
    setEvalError(null)
    setEvalResult(null)
    try {
      const res = await useAppStore.getState().browserEvaluate(script)
      if (res?.ok) {
        const result = res.data?.result
        const text = result === undefined
          ? '(无返回值)'
          : typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        setEvalResult(text)
      } else {
        setEvalError(res?.error ?? '执行失败')
      }
    } catch (err) {
      setEvalError((err as Error).message)
    } finally {
      setEvalRunning(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg-base">
      {/* 顶部工具栏 */}
      <div
        className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-surface px-3 py-2 overflow-hidden"
      >
        {/* 关闭标签 */}
        <button
          onClick={() => closeTab('browser')}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title="关闭浏览器标签（Esc）"
          aria-label="关闭浏览器标签"
        >
          <X size={14} />
        </button>

        {/* 后退/前进/刷新 */}
        <button
          onClick={() => void back()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30"
          title="后退"
          aria-label="后退"
          disabled={!canGoBack}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          onClick={() => void forward()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30"
          title="前进"
          aria-label="前进"
          disabled={!canGoForward}
        >
          <ArrowRight size={14} />
        </button>
        <button
          onClick={() => void window.lunareclipse?.browserReload?.()}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title="刷新当前页"
          aria-label="刷新当前页"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>

        {/* 默认搜索引擎：点击直接导航到百度首页，给用户一个默认起点 */}
        <button
          onClick={() => void navigate('https://www.baidu.com')}
          className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title="打开百度搜索"
          aria-label="打开百度搜索"
        >
          <Search size={14} />
        </button>

        {/* URL 输入框 */}
        <form onSubmit={handleNavigate} className="flex-1 flex items-center gap-1.5">
          <div className="relative flex-1">
            <Globe
              size={11}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none"
            />
            {loading && (
              <Loader2
                size={11}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-accent animate-spin pointer-events-none"
              />
            )}
            <input
              ref={urlInputRef}
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入 URL 或搜索关键词..."
              className="w-full rounded-btn border border-border bg-bg-elevated pl-7 pr-7 py-1.5 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="rounded-btn bg-accent px-3 py-1.5 text-caption text-accent-fg hover:bg-accent/90"
          >
            访问
          </button>
        </form>

        {/* 网页缩放：− / 百分比 / +；点击百分比=固定当前比例或恢复自适应 */}
        <div className="flex items-center gap-0.5 rounded-btn border border-border bg-bg-elevated px-1 py-0.5">
          <button
            onClick={() => void window.lunareclipse?.browserZoomStep?.(-0.1)}
            className="flex h-5 w-5 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title="网页缩小（Ctrl+-）"
            aria-label="网页缩小"
          >
            <ZoomOut size={12} />
          </button>
          <button
            onClick={() =>
              void (browserZoomMode === 'auto'
                ? window.lunareclipse?.browserZoomSet?.(browserZoom)
                : window.lunareclipse?.browserZoomReset?.())
            }
            className="flex h-5 min-w-10 items-center justify-center gap-0.5 rounded-md px-1 text-[11px] tabular-nums text-fg-secondary transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title={
              browserZoomMode === 'auto'
                ? `网页分辨率自适应（${Math.round(browserZoom * 100)}%），点击固定当前比例`
                : `网页手动 ${Math.round(browserZoom * 100)}%，点击恢复自适应`
            }
            aria-label="网页缩放比例，点击切换自适应与手动"
          >
            {browserZoomMode === 'auto' && <RotateCcw size={9} />}
            {Math.round(browserZoom * 100)}%
          </button>
          <button
            onClick={() => void window.lunareclipse?.browserZoomStep?.(0.1)}
            className="flex h-5 w-5 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title="网页放大（Ctrl+=）"
            aria-label="网页放大"
          >
            <ZoomIn size={12} />
          </button>
        </div>

        {/* 工具按钮 */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => void scroll('up', 500)}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="向上滚动 500px"
            aria-label="向上滚动 500px"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={() => void scroll('down', 500)}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="向下滚动 500px"
            aria-label="向下滚动 500px"
          >
            <ArrowDown size={13} />
          </button>
          <button
            onClick={() => void handleScreenshotSend()}
            disabled={shotBusy}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30 disabled:cursor-not-allowed"
            title="截图并发送到当前会话"
            aria-label="截图并发送到当前会话"
          >
            {shotBusy ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
          </button>
          <button
            onClick={() => void handleSharePage()}
            disabled={!url}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary disabled:opacity-30 disabled:cursor-not-allowed"
            title="分享当前网页到会话"
            aria-label="分享当前网页到会话"
          >
            <Share2 size={13} />
          </button>
          <button
            onClick={() => setShowEval(!showEval)}
            className={`flex h-7 w-7 items-center justify-center rounded-btn ${
              showEval ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
            }`}
            title="执行 JavaScript"
            aria-label="执行 JavaScript"
          >
            <Code size={13} />
          </button>
          <button
            onClick={() => setShowHistory(!showHistory)}
            className={`flex h-7 w-7 items-center justify-center rounded-btn ${
              showHistory ? 'bg-accent/10 text-accent' : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
            }`}
            title="操作历史"
            aria-label="操作历史"
          >
            <History size={13} />
          </button>
        </div>
      </div>

      {/* 截图失败横幅：位于工具栏正下方，高度计入 browserSetLayout 的 shotExtra，
          保证原生 WebContentsView 预留出本行空间，横幅始终可见可点击。 */}
      {shotError && (
        <div className="flex items-center gap-2 border-b border-red-500/20 bg-red-500/10 px-3 py-1 text-caption text-red-400">
          <AlertTriangle size={12} className="shrink-0" />
          <span className="flex-1 truncate">{shotError}</span>
          <button
            onClick={() => void handleScreenshotSend()}
            disabled={shotBusy}
            className="shrink-0 rounded-btn bg-red-500/15 px-2 py-0.5 text-[11px] text-red-400 transition-colors hover:bg-red-500/25 disabled:opacity-40"
          >
            重试
          </button>
          <button
            onClick={() => setShotError(null)}
            className="shrink-0 rounded p-0.5 text-red-400/70 transition-colors hover:bg-red-500/15 hover:text-red-400"
            title="关闭提示"
            aria-label="关闭截图失败提示"
          >
            <X size={11} />
          </button>
        </div>
      )}

      {/* JS 执行输入框（工具栏下方，折叠式） */}
      {showEval && (
        <div
          className="border-b border-border-subtle bg-bg-surface px-3 py-2"
        >
          <div className="text-caption text-fg-muted mb-1">在浏览器页面执行 JavaScript：</div>
          <div className="flex gap-2">
            <input
              type="text"
              value={evalScript}
              onChange={(e) => setEvalScript(e.target.value)}
              placeholder="例如：document.title 或 location.href"
              className="flex-1 rounded-btn border border-border bg-bg-elevated px-3 py-1.5 text-caption font-mono text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void runEval()
                }
              }}
            />
            <button
              onClick={() => void runEval()}
              disabled={!evalScript.trim() || evalRunning}
              className="rounded-btn bg-accent px-3 py-1.5 text-caption text-accent-fg hover:bg-accent/90 disabled:opacity-40"
            >
              {evalRunning ? '...' : '执行'}
            </button>
          </div>
          {evalError && (
            <div className="mt-1.5 rounded bg-red-500/10 px-2 py-1 text-caption text-red-400 font-mono break-all max-h-32 overflow-y-auto">
              {evalError}
            </div>
          )}
          {evalResult !== null && !evalError && (
            <div className="mt-1.5 rounded bg-bg-muted/50 px-2 py-1 text-caption text-fg-secondary font-mono break-all max-h-32 overflow-y-auto whitespace-pre-wrap">
              {evalResult}
            </div>
          )}
        </div>
      )}

      {/* 当前动作标签（工具栏下方，AI 操作时显示） */}
      {currentAction && (
        <div
          className="bg-accent/10 border-b border-accent/30 px-3 py-1.5 text-caption text-accent flex items-center gap-2"
        >
          <Loader2 size={11} className="animate-spin" />
          <span className="font-medium">AI 正在{actionLabel(currentAction.action)}:</span>
          <span className="text-fg-secondary truncate flex-1">{currentAction.detail}</span>
        </div>
      )}

      {/* 操作历史侧栏（底部，可折叠，高度随内容自适应） */}
      {showHistory && (
        <div
          ref={historyPanelRef}
          className="border-t border-border-subtle bg-bg-surface"
          style={{ maxHeight: '50vh' }}
        >
          <div className="sticky top-0 bg-bg-surface px-3 py-2 border-b border-border-subtle flex items-center justify-between">
            <div className="text-caption font-medium text-fg-primary flex items-center gap-1.5">
              <History size={11} />
              操作历史
              <span className="text-fg-muted">({history.length})</span>
            </div>
            <button
              onClick={() => setShowHistory(false)}
              className="text-fg-muted hover:text-fg-primary"
            >
              <ChevronDown size={12} />
            </button>
          </div>
          <div className="max-h-[40vh] overflow-y-auto">
            {history.length === 0 ? (
              <div className="px-3 py-6 text-center text-caption text-fg-muted">
                <Globe size={20} className="mx-auto mb-1.5 opacity-40" />
                还没有操作记录
                <div className="mt-1 text-[10px]">让 AI 调用浏览器工具，或输入 URL 导航</div>
              </div>
            ) : (
              history.map((entry) => <HistoryItem key={entry.id} entry={entry} />)
            )}
          </div>
        </div>
      )}

      {/* 折叠时显示展开按钮 */}
      {!showHistory && history.length > 0 && (
        <button
          onClick={() => setShowHistory(true)}
          className="mt-auto border-t border-border-subtle bg-bg-surface px-3 py-1.5 text-caption text-fg-muted hover:text-fg-primary flex items-center justify-center gap-1"
        >
          <ChevronUp size={11} />
          <History size={11} />
          {history.length} 条操作历史
        </button>
      )}
    </div>
  )
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    navigate: '导航',
    click: '点击',
    type: '输入',
    scroll: '滚动',
    snapshot: '获取页面结构',
    screenshot: '截图',
    evaluate: '执行 JS',
    close: '关闭'
  }
  return labels[action] ?? action
}

function HistoryItem({ entry }: { entry: BrowserHistoryEntry }) {
  const time = formatDateTime(entry.timestamp)
  const isOk = entry.result === 'success'

  return (
    <div
      className={`px-3 py-1.5 border-b border-border-subtle/50 hover:bg-bg-muted/30 ${
        isOk ? '' : 'bg-red-500/5'
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
            isOk ? 'bg-emerald-400' : 'bg-red-400'
          }`}
        />
        <span className="text-[10px] text-fg-muted font-mono shrink-0">{time}</span>
        <span className="text-caption font-medium text-fg-primary shrink-0">
          {actionLabel(entry.action)}
        </span>
        <span className="text-[10px] text-fg-muted ml-auto shrink-0">{entry.durationMs}ms</span>
      </div>
      <div className="text-caption text-fg-secondary mt-0.5 truncate font-mono">
        {entry.detail || '(无参数)'}
      </div>
      {!isOk && entry.errorMessage && (
        <div className="text-[11px] text-red-400 mt-0.5 truncate">{entry.errorMessage}</div>
      )}
    </div>
  )
}
