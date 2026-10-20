/**
 * 浏览器视图管理器：为什么存在——应用需要内嵌"网页面板"（快速拨号/网页浏览/AI 网页工具），
 * 用独立 WebContentsView 承载内容且要能截图、注入脚本、记录历史。
 * 作用：管理 BrowserView 的创建/导航/缩放/历史/截图/脚本注入/销毁，单例导出 browserViewManager。
 */
import { BrowserWindow, WebContentsView, shell, screen, session } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { writeFile } from 'fs/promises'
import { waitForLoad, waitForBodyReady } from './browser-view-wait'
import { HOME_PAGE_URL, TRACKER_SCRIPT, SNAPSHOT_SCRIPT } from './browser-view-scripts'
import { computeAutoZoom } from '../ui-zoom'
import type { BrowserHistoryEntry, BrowserEvent } from './browser-view-types'

// 浏览器网页缩放范围与步进（与主 UI ui-zoom 对齐，见 ui-zoom.ts 的 MIN/MAX/STEP）
const BROWSER_ZOOM_MIN = 0.7
const BROWSER_ZOOM_MAX = 2.0
const BROWSER_ZOOM_STEP = 0.1

// 隐私红线：外部网页专用独立 partition（非持久化）。浏览器面板中的普通网站与此
// session 绑定，与 defaultSession 隔离，不继承主应用任何权限（geolocation 等一律拒绝）。
const EXTERNAL_WEB_PARTITION = 'external-webview'

// ============================================================
// 浏览器视图管理器：基于 Electron WebContentsView 嵌入主窗口侧边面板
// ------------------------------------------------------------
// 设计目标：
// 1. AI 和用户共享同一个浏览器视图（不再 headless）
// 2. AI 操作（navigate/click/type/scroll）时注入 4 种追踪特效：
// a) 元素高亮框（SVG 红色闪烁边框）
// b) 鼠标轨迹动画（虚拟指针滑动到目标位置）
// c) 动作标签（页面顶部状态条 "AI 正在 xxx"）
// d) 操作历史侧栏（通过 IPC 推送到前端）
// 3. 用户可在面板手动操作浏览器（点击/输入/滚动/导航）
// 4. 通过 mainWindow.webContents.send 推送浏览器事件给前端
// ============================================================

class BrowserViewManager {
  private view: WebContentsView | null = null
  private hostWindow: BrowserWindow | null = null
  private visible = false
  private widthPct = 35 // 面板宽度百分比，与前端 sidePanelWidthPct 默认值对齐
  private history: BrowserHistoryEntry[] = []
  private readonly maxHistory = 100
  /** 当前导航URL，避免加载中频繁推送 */
  private currentUrl = ''
  private currentTitle = ''
  private loading = false
  // 文档 15.3：原生 WebContentsView 会盖住前端浮层（操作历史侧栏、JS 执行面板、动作标签），
  // 前端通过 setLayout 通知需要预留的顶部/底部高度，layoutView 据此收缩视图区域
  // 默认 116 = 标题栏 40 + 标签栏 32 + 工具栏 44（与 BrowserPanel 的 topBase 保持一致，避免初次显示错位）
  private topReserved = 116
  private bottomReserved = 0 // 默认：无底部浮层
  /** 左侧预留宽度（Sidebar 始终可见后，浏览器视图需偏移以避免覆盖侧栏） */
  private leftReserved = 210 // 默认：与 sidebarWidth 初始值一致
  /** 右侧预留宽度（抽屉面板内联展开时，浏览器视图需从右侧收缩） */
  private rightReserved = 0
  /** 全屏浮层遮挡标志（监控面板/设置面板打开时置 true，show() 被抑制，避免 OS 层 view 浮在浮层上） */
  private overlayOpen = false
  /** 浮层打开期间 AI 请求过显示：浮层关闭后自动补 show，避免 AI 浏览器操作丢失 */
  private pendingShow = false
  /** 浏览器网页缩放手动覆盖值（null=自动，复用 ui-zoom 同款人眼最佳公式） */
  private zoomManual: number | null = null
  /** 显示器变化监听是否已全局绑定（单例只绑一次） */
  private zoomDisplayListenersBound = false
  /** 上次生效显示器 id（窗口移屏时自动模式重算） */
  private zoomLastDisplayId = -1

  /**
   * useSystemBrowser 模式开关的读取器（由 index.ts 注入，读取 config.browser.useSystemBrowser）。
   * true = 弃用内置浏览器视图，导航一律转系统默认浏览器（shell.openExternal，不注入/不操作）。
   * 独立进程无法注入/executeJavaScript/capturePage，故该模式下 browser_* 交互类操作全部降级报错。
   */
  useSystemBrowserGetter?: () => boolean

  private useSystemBrowser(): boolean {
    try {
      return this.useSystemBrowserGetter?.() ?? false
    } catch {
      return false
    }
  }

  /**
   * 内置浏览器面板对外部网页的系统定位策略（由 index.ts 注入，读取 config.browser.geolocationPolicy）。
   * 'deny'（默认）＝外部网页一律拒绝 geolocation（连同其余一切权限）；
   * 'allow'＝仅放行 geolocation（其余权限仍拒绝），需用户显式开启后才生效，
   * 且精确位置仍不写入日志/记忆/缓存。受信本地窗口各自走视窗级校验，不受此策略影响。
   */
  geolocationPolicyGetter?: () => 'deny' | 'allow'

  private geolocationPolicy(): 'deny' | 'allow' {
    try {
      return this.geolocationPolicyGetter?.() === 'allow' ? 'allow' : 'deny'
    } catch {
      return 'deny'
    }
  }

  /** 交互类操作守卫：useSystemBrowser 模式下外部浏览器进程无法注入/操作，明确报错而非静默失效 */
  private assertViewInteractive(method: string): void {
    if (this.useSystemBrowser()) {
      throw new Error(`系统浏览器模式（config.browser.useSystemBrowser）下不支持 ${method}——外部浏览器进程无法注入/操作，请用系统浏览器手动操作，或关闭该开关使用内置浏览器`)
    }
  }

  /** 绑定主窗口（必须先绑定才能创建视图） */
  attachWindow(win: BrowserWindow): void {
    this.hostWindow = win
    this.bindZoomWindowListeners(win)
    // 窗口关闭时清理
    win.on('closed', () => {
      this.destroyView()
      this.hostWindow = null
    })
    // 窗口尺寸变化时重新布局
    win.on('resize', () => {
      if (this.visible) this.layoutView()
    })
  }

  /**
   * 迁移宿主窗口：浏览器面板从主窗口右侧迁到独立窗口。
   * 从旧宿主移除 view → 绑定新宿主 → 挂载 + 重新布局。
   * pushEvent 走 hostWindow.webContents.send，迁移后自动推送到新窗口前端。
   */
  moveToWindow(win: BrowserWindow): void {
    if (this.hostWindow && this.view && !this.hostWindow.isDestroyed()) {
      try { this.hostWindow.contentView.removeChildView(this.view) } catch { /* 忽略 */ }
    }
    this.hostWindow = win
    this.bindZoomWindowListeners(win)
    // 面板窗口关闭 = 浏览器面板关闭，销毁 view 防泄漏
    win.on('closed', () => {
      this.destroyView()
      this.hostWindow = null
    })
    win.on('resize', () => {
      if (this.visible) this.layoutView()
    })
    if (this.view && this.visible) {
      win.contentView.addChildView(this.view)
      this.layoutView()
    }
  }

  /**
   * 绑定窗口级缩放跟随：窗口移屏（moved）时重算自动缩放。
   * 显示器插拔/DPI 变化用全局单次监听（display-metrics-changed），跨窗口复用。
   */
  private bindZoomWindowListeners(win: BrowserWindow): void {
    // 初始显示器 id：首次 moved 前也保持当前屏幕的基准
    this.zoomLastDisplayId = screen.getDisplayMatching(win.getBounds()).id
    win.on('moved', () => {
      if (this.zoomManual != null || !this.hostWindow || this.hostWindow.isDestroyed()) return
      const id = screen.getDisplayMatching(this.hostWindow.getBounds()).id
      if (id !== this.zoomLastDisplayId) {
        this.zoomLastDisplayId = id
        this.applyBrowserZoom()
      }
    })
    if (!this.zoomDisplayListenersBound) {
      this.zoomDisplayListenersBound = true
      screen.on('display-metrics-changed', () => {
        // 自动模式下显示器分辨率/DPI 变化需重算；手动模式覆盖，不打扰用户设定
        if (this.zoomManual == null) this.applyBrowserZoom()
      })
    }
  }

  /** 显示浏览器面板（懒创建 WebContentsView） */
  async show(): Promise<void> {
    // 系统浏览器模式：不创建/管理内置视图，前端标签页模式由 syncBrowserVisibility 控制可见性
    if (this.useSystemBrowser()) return
    if (!this.hostWindow) throw new Error('host window 未绑定')
    // 浏览器保持右侧分屏：view 挂主窗口右侧，聊天区由前端 App paddingRight 让位
    // 全屏浮层（监控面板/设置面板）打开时抑制显示：OS 层 view 会浮在 DOM 浮层之上，
    // 前端 syncBrowserVisibility 已统一在浮层打开时调 hide()，这里兜底防止 show()
    // （由 browser:show/navigate IPC 或前端标签页激活触发）在浮层打开期间把 view 重新 show 出来。
    if (this.overlayOpen) {
      // 记 pendingShow：浮层关闭后 setOverlay(false) 自动补 show，AI 的浏览器操作不丢
      this.pendingShow = true
      // 不发 visible=true（浮层下前端不显示框），但通知前端"浏览器被请求"，
      // 浮层关闭后前端 syncBrowserVisibility 也会收到状态同步，标签/工具栏随之出现
      let fNavBack = false
      let fNavFwd = false
      try {
        const nav = this.view?.webContents?.navigationHistory
        fNavBack = !!nav?.canGoBack()
        fNavFwd = !!nav?.canGoForward()
      } catch { /* 忽略 */ }
      this.pushEvent({ type: 'browser:state', visible: false, url: this.currentUrl, title: this.currentTitle, loading: this.loading, canGoBack: fNavBack, canGoForward: fNavFwd })
      return
    }
    if (!this.view) {
      await this.createView()
    }
    if (this.view && !this.visible) {
      this.hostWindow.contentView.addChildView(this.view)
      this.visible = true
      this.layoutView()
    }
    // 总是同步前端状态：view 已 visible 时（前端状态可能因刷新/手动关闭标签而丢失），
    // 静默 return 会导致前端永远不知道浏览器开着 → 工具栏框不出现。改为总是 pushEvent。
    this.emitState()
  }

  /** 隐藏浏览器面板（保留 webContents 状态，不销毁） */
  hide(): void {
    // 系统浏览器模式：无内置视图可隐藏
    if (this.useSystemBrowser()) return
    if (!this.view || !this.hostWindow || !this.visible) return
    this.hostWindow.contentView.removeChildView(this.view)
    this.visible = false
    this.emitState()
  }

  /**
   * 显式关闭浏览器面板（真正销毁，区别于浮层遮挡的 hide()）。
   * 与 hide() 的区别：
   * - hide()：浮层遮挡用，保留前端标签，关闭浮层后由 syncBrowserVisibility 恢复显示
   * - close()：真正关闭浏览器，发 browser:closed 事件，前端收到后移除浏览器标签，
   * 避免 view 隐藏了但工具栏/标签框仍残留（体验割裂）。
   * 注意：当前没有调用方（AI 工具面是 headless 插件通道 browser_*，不经过本方法；
   * 前端关闭标签走 closeRightPanelTab → syncBrowserVisibility → browser:hide IPC）。
   * 本方法保留作为"完整销毁视图"的显式入口，供需要回收 webContents 的场景调用。
   */
  close(): void {
    this.pendingShow = false
    if (this.view && this.hostWindow && this.visible) {
      this.hostWindow.contentView.removeChildView(this.view)
      this.visible = false
    }
    // 即使 view 未创建也通知前端清理标签（防状态不同步导致的残留框）
    this.pushEvent({ type: 'browser:closed' })
    this.emitState()
  }

  /**
   * 设置全屏浮层遮挡状态（前端在监控面板/设置面板开关时调用）。
   * - open=true：置遮挡标志 + 若当前可见则立即隐藏（防 OS 层 view 浮在浮层上）
   * - open=false：仅清标志，不自动恢复显示（由前端 syncBrowserVisibility 决定是否重新 show）
   */
  setOverlay(open: boolean): void {
    this.overlayOpen = open
    if (open && this.visible) {
      this.hide()
    } else if (!open && this.pendingShow) {
      // 浮层关闭且浮层期间 AI 请求过显示 → 自动补 show，前端随后收到 visible=true 加标签
      this.pendingShow = false
      void this.show()
    }
  }

  /** 推前端状态事件（统一带导航能力：后退/前进可用性） */
  private emitState(): void {
    let canGoBack = false
    let canGoForward = false
    try {
      const nav = this.view?.webContents?.navigationHistory
      canGoBack = !!nav?.canGoBack()
      canGoForward = !!nav?.canGoForward()
    } catch {
      /* 导航历史不可读时按不可用处理 */
    }
    this.pushEvent({
      type: 'browser:state',
      visible: this.visible,
      url: BrowserViewManager.displayUrl(this.currentUrl),
      title: this.currentTitle,
      loading: this.loading,
      canGoBack,
      canGoForward
    })
  }

  /** 地址栏展示归一化：起始页（内置 data URL）在地址栏显示为空，避免一长串编码；
   * 内部 currentUrl 保留真实值供 AI 快照/历史记录使用 */
  private static displayUrl(url: string): string {
    return url === HOME_PAGE_URL ? '' : url
  }

  /** 后退（像真浏览器一样直接操作） */
  async back(): Promise<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean }> {
    this.assertViewInteractive('back')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'navigate', detail: '(后退)' })
    try {
      const nav = wc.navigationHistory
      if (!nav.canGoBack()) {
        this.recordHistory({ action: 'navigate', detail: '(后退：无历史)', result: 'error', errorMessage: '没有可后退的历史', durationMs: 0 })
        this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: '没有可后退的历史' })
        return { url: BrowserViewManager.displayUrl(wc.getURL()), title: this.currentTitle, canGoBack: false, canGoForward: nav.canGoForward() }
      }
      nav.goBack()
      await waitForLoad(wc)
      this.currentUrl = wc.getURL()
      this.currentTitle = wc.getTitle()
      this.recordHistory({ action: 'navigate', detail: '(后退)', result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
      this.emitState()
      return { url: BrowserViewManager.displayUrl(this.currentUrl), title: this.currentTitle, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() }
    } catch (err) {
      this.recordHistory({ action: 'navigate', detail: '(后退)', result: 'error', errorMessage: (err as Error).message, durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 前进（像真浏览器一样直接操作） */
  async forward(): Promise<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean }> {
    this.assertViewInteractive('forward')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'navigate', detail: '(前进)' })
    try {
      const nav = wc.navigationHistory
      if (!nav.canGoForward()) {
        this.recordHistory({ action: 'navigate', detail: '(前进：无历史)', result: 'error', errorMessage: '没有可前进的历史', durationMs: 0 })
        this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: '没有可前进的历史' })
        return { url: BrowserViewManager.displayUrl(wc.getURL()), title: this.currentTitle, canGoBack: nav.canGoBack(), canGoForward: false }
      }
      nav.goForward()
      await waitForLoad(wc)
      this.currentUrl = wc.getURL()
      this.currentTitle = wc.getTitle()
      this.recordHistory({ action: 'navigate', detail: '(前进)', result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
      this.emitState()
      return { url: BrowserViewManager.displayUrl(this.currentUrl), title: this.currentTitle, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() }
    } catch (err) {
      this.recordHistory({ action: 'navigate', detail: '(前进)', result: 'error', errorMessage: (err as Error).message, durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 刷新当前页 */
  reload(): void {
    this.assertViewInteractive('reload')
    if (!this.view || this.view.webContents.isDestroyed()) throw new Error('浏览器页面已销毁')
    this.pushEvent({ type: 'browser:actionStart', action: 'navigate', detail: '(刷新)' })
    this.view.webContents.reload()
    this.recordHistory({ action: 'navigate', detail: '(刷新)', result: 'success', durationMs: 0 })
    this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
  }

  /** 停止当前加载 */
  stop(): void {
    this.assertViewInteractive('stop')
    if (!this.view || this.view.webContents.isDestroyed()) throw new Error('浏览器页面已销毁')
    this.view.webContents.stop()
  }

  /** 销毁视图（关闭浏览器面板后释放资源） */
  destroyView(): void {
    if (this.view) {
      try {
        this.hostWindow?.contentView.removeChildView(this.view)
        // 关闭 webContents（不调 close 会泄漏）
        if (!this.view.webContents.isDestroyed()) {
          this.view.webContents.close()
        }
      } catch { /* 忽略 */ }
      this.view = null
    }
    this.visible = false
  }

  /** 是否可见 */
  isVisible(): boolean {
    return this.visible
  }

  /**
   * 同步获取浏览器面板状态摘要（轻量，不执行 snapshot 脚本）。
   * 供工作区上下文注入使用，避免阻塞注入流程。
   */
  getStateSummary(): { visible: boolean; url: string; title: string; loading: boolean } {
    return {
      visible: this.visible,
      url: this.currentUrl,
      title: this.currentTitle,
      loading: this.loading
    }
  }

  /** 获取 webContents（工具执行用） */
  getWebContents() {
    if (!this.view) return null
    return this.view.webContents
  }

  /** 创建 WebContentsView */
  private async createView(): Promise<void> {
    if (!this.hostWindow) throw new Error('host window 未绑定')
    // 隐私红线：外部网页托管在独立非持久化 partition，与主应用 defaultSession（及其
    // geolocation 授权）完全隔离。该 session 默认显式拒绝一切权限请求——普通网页不能通过
    // 内置浏览器获得系统定位、摄像头等系统能力；仅当用户在内置浏览器设置中显式开启
    // geolocationPolicy='allow' 时放行 geolocation（仍需网站自身授权流程），其余权限仍一律拒绝。
    // 未设置 handler 时 Electron 默认也拒绝，此处显式声明便于审计。
    try {
      session.fromPartition(EXTERNAL_WEB_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
        callback(this.geolocationPolicy() === 'allow' && permission === 'geolocation')
      })
    } catch {
      // 独立 session 权限 handler 设置失败不阻断浏览器面板创建（默认即拒绝全部权限）
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: EXTERNAL_WEB_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.view = view

    // 注入追踪特效脚本（每次导航完成后注入）
    view.webContents.on('did-finish-load', () => {
      this.injectTrackerScript()
      // 页面导航后 zoomFactor 一般保留，这里幂等兜底确保缩放生效
      this.applyBrowserZoom()
    })

    // Ctrl+=/Ctrl+-/Ctrl+0：缩放网页。焦点在浏览器视图时主窗口的 before-input-event
    // 收不到按键（事件进入子视图 webContents），故挂在 view 上，键位语义与主 UI ui-zoom 一致。
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
      const key = input.key.toLowerCase()
      if (key === '=' || key === '+') {
        this.stepBrowserZoom(BROWSER_ZOOM_STEP)
        event.preventDefault()
      } else if (key === '-' || key === '_') {
        this.stepBrowserZoom(-BROWSER_ZOOM_STEP)
        event.preventDefault()
      } else if (key === '0') {
        this.setBrowserZoom(null)
        event.preventDefault()
      }
    })

    // URL 变化时更新状态
    view.webContents.on('did-navigate', (_e, url) => {
      this.currentUrl = url
      this.emitState()
    })
    view.webContents.on('did-navigate-in-page', (_e, url) => {
      this.currentUrl = url
      this.emitState()
    })
    view.webContents.on('page-title-updated', (_e, title) => {
      this.currentTitle = title
      this.emitState()
    })
    view.webContents.on('did-start-loading', () => {
      this.loading = true
      this.emitState()
    })
    view.webContents.on('did-stop-loading', () => {
      this.loading = false
      this.emitState()
    })

    // 新窗口（target=_blank / window.open）：在当前视图内导航，不跳到外部浏览器
    // 大多数网站（B站、百度等）链接用 target=_blank 打开新窗口，若转外部浏览器会导致
    // "点一下链接就跳出应用"的糟糕体验。改为拦截后在当前 webContents 加载该 URL。
    // 安全红线：非网页协议必须拒绝，不能交给 shell.openExternal——
    // 恶意外链（file:///C:/xxx、ms-settings://、javascript: 等）若放开会被网页内容
    // 用来触发本机任意文件/系统设置打开。mailto:/tel: 属于用户明确点击意图且协议
    // 行为安全（仅拉起邮件/电话客户端），单独放行；其余一律 deny。
    view.webContents.setWindowOpenHandler(({ url }) => {
      // useSystemBrowser 模式：整个浏览器旨在系统浏览器，链接一律转系统默认浏览器
      if (this.useSystemBrowser()) {
        if (url.startsWith('http://') || url.startsWith('https://')) {
          void shell.openExternal(url)
        }
        return { action: 'deny' }
      }
      // 默认模式：仅放行 http/https（页内加载）与 mailto/tel（系统处理），其余协议拒绝
      if (url.startsWith('http://') || url.startsWith('https://')) {
        view.webContents.loadURL(url)
      } else if (url.startsWith('mailto:') || url.startsWith('tel:')) {
        shell.openExternal(url).catch(() => { /* 忽略打开失败 */ })
      }
      return { action: 'deny' }
    })

    // 初始页面：加载月蚀起始页（快速拨号 + 搜索引擎，内置 data URL，避免 about:blank 白屏）
    this.applyBrowserZoom()
    view.webContents.loadURL(HOME_PAGE_URL)
  }

  // ============ 浏览器网页缩放（分辨率自适应 + 手动，独立于主 UI ui-zoom） ============

  /** 归一化手动缩放值：非法输入/出界一律 clamp 到 [MIN, MAX]（null=自动） */
  private clampZoom(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v)
      ? Math.round(Math.min(BROWSER_ZOOM_MAX, Math.max(BROWSER_ZOOM_MIN, v)) * 100) / 100
      : null
  }

  /** 当前生效缩放：手动优先，否则复用 ui-zoom 同步款公式（显示器工作区高度/1080，clamp [0.9,1.6]） */
  private effectiveBrowserZoom(): number {
    return this.zoomManual ?? computeAutoZoom(this.hostWindow ?? undefined)
  }

  /** 应用缩放：无视图/已销毁时静默跳过（视图创建与导航后会补应用） */
  applyBrowserZoom(): void {
    if (!this.view || this.view.webContents.isDestroyed()) return
    try {
      this.view.webContents.setZoomFactor(this.effectiveBrowserZoom())
    } catch {
      // 页面销毁竞态等瞬时异常：缩放非关键路径，忽略
    }
  }

  /** 设置缩放：value=null 恢复自动；写持久化由 IPC 层负责 */
  setBrowserZoom(value: number | null): void {
    this.zoomManual = this.clampZoom(value)
    this.applyBrowserZoom()
    this.emitZoomState()
  }

  /** 步进缩放（delta=±0.1），超出范围自动 clamp */
  stepBrowserZoom(delta: number): void {
    const base = this.effectiveBrowserZoom()
    this.setBrowserZoom(base + (Number.isFinite(delta) ? delta : 0))
  }

  /** 当前缩放状态（IPC 查询用） */
  getBrowserZoomState(): { mode: 'auto' | 'manual'; zoom: number; manual: number | null } {
    return {
      mode: this.zoomManual != null ? 'manual' : 'auto',
      zoom: this.effectiveBrowserZoom(),
      manual: this.zoomManual
    }
  }

  /** 推送缩放状态到前端（独立频道 browser:zoomChanged，与主 UI 的 ui:zoomChanged 对齐；
   * 不走 browser:event 事件流，前端 BrowserPanel 用 onBrowserZoomChange 订阅实时刷新百分比） */
  private emitZoomState(): void {
    const s = this.getBrowserZoomState()
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      this.hostWindow.webContents.send('browser:zoomChanged', { mode: s.mode, zoom: s.zoom })
    }
  }

  /** 布局：浏览器视图填满 Sidebar 右侧的内容区域，顶部/底部按前端通知的预留高度收缩 */
  private layoutView(): void {
    if (!this.view || !this.hostWindow) return
    const [winWidth, winHeight] = this.hostWindow.getContentSize()
    const top = Math.max(0, this.topReserved)
    const bottom = Math.max(0, this.bottomReserved)
    const left = Math.max(0, this.leftReserved)
    const right = Math.max(0, this.rightReserved)
    const viewHeight = Math.max(0, winHeight - top - bottom)
    const viewWidth = Math.max(0, winWidth - left - right)
    this.view.setBounds({
      x: left,
      y: top,
      width: viewWidth,
      height: viewHeight
    })
  }

  /** 设置面板宽度百分比（拖拽分隔条时调用） */
  setWidthPct(_pct: number): void {
    // 全宽模式——忽略宽度百分比，直接重新布局
    this.layoutView()
  }

  /**
   * 设置顶部/底部预留高度（前端浮层变化时调用）
   * - top: 顶部预留像素（标题栏 + 工具栏 + 可选 JS 面板/动作标签）
   * - bottom: 底部预留像素（操作历史侧栏展开时的高度）
   * 传 undefined 表示不修改该维度
   */
  setLayout(opts: { top?: number; bottom?: number; left?: number; right?: number }): void {
    if (typeof opts.top === 'number') this.topReserved = Math.max(0, opts.top)
    if (typeof opts.bottom === 'number') this.bottomReserved = Math.max(0, opts.bottom)
    if (typeof opts.left === 'number') this.leftReserved = Math.max(0, opts.left)
    if (typeof opts.right === 'number') this.rightReserved = Math.max(0, opts.right)
    if (this.visible) this.layoutView()
  }

  /** 注入追踪特效脚本到当前页面（幂等，脚本内容见 browser-view-scripts.ts） */
  private async injectTrackerScript(): Promise<void> {
    if (!this.view) return
    try {
      // 用 IIFE 包裹：executeJavaScript 顶层不能写 return（会抛 SyntaxError:Illegal return statement）
      await this.view.webContents.executeJavaScript(TRACKER_SCRIPT)
    } catch (err) {
      console.warn('[browser-view] 注入追踪脚本失败:', err)
    }
  }

  /** 推送事件到前端 */
  private pushEvent(event: BrowserEvent): void {
    if (this.hostWindow && !this.hostWindow.isDestroyed()) {
      this.hostWindow.webContents.send('browser:event', event)
    }
  }

  /** 记录操作历史并推送 */
  recordHistory(entry: Omit<BrowserHistoryEntry, 'id' | 'timestamp'>): string {
    const id = `bh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    const fullEntry: BrowserHistoryEntry = {
      ...entry,
      id,
      timestamp: Date.now()
    }
    this.history.unshift(fullEntry)
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(0, this.maxHistory)
    }
    this.pushEvent({ type: 'browser:history', entry: fullEntry })
    return id
  }

  /** 获取历史列表（前端初始化时拉取） */
  getHistory(): BrowserHistoryEntry[] {
    return [...this.history]
  }

  // ============ 高层操作 API（供工具调用） ============


  async navigate(url: string): Promise<{ title: string; url: string }> {
    // useSystemBrowser 模式：导航直接转系统默认浏览器（不创建/注入/操作视图）
    if (this.useSystemBrowser()) {
      let target = url
      if (!target.startsWith('http://') && !target.startsWith('https://') && !/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        target = 'https://' + target
      }
      await shell.openExternal(target).catch((err) => {
        throw new Error(`无法用系统默认浏览器打开 ${target}: ${(err as Error).message}`)
      })
      this.currentUrl = target
      this.currentTitle = target
      this.recordHistory({
        action: 'navigate',
        detail: url,
        result: 'success',
        durationMs: 0
      })
      return { title: '已在系统默认浏览器打开', url: target }
    }
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'navigate', detail: url })

    // 规范化 URL：仅放行 http/https；禁止 file:/javascript:/data:/ms-settings: 等协议
    // （否则 file:///C:/... 可被 AI/前端用来读本机文件进页面、javascript: 执行任意 JS）。
    // 无协议输入按 https:// 补全（地址栏习惯），协议非法直接报错（fail-fast，不拼接成废 URL）。
    let target = url.trim()
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      const schemeMatch = target.match(/^([a-z][a-z0-9+.-]*):/i)
      if (schemeMatch) {
        throw new Error(`不支持的 URL 协议: ${schemeMatch[1]}:（浏览器仅支持 http/https）`)
      }
      target = 'https://' + target
    }

    try {
      await wc.loadURL(target)
      // 等待页面加载完成（did-finish-load），再等 SPA 渲染出内容
      await waitForLoad(wc)
      await waitForBodyReady(wc)
      if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
      const title = await wc.getTitle()
      const finalUrl = wc.getURL()
      this.currentTitle = title
      this.currentUrl = finalUrl
      this.recordHistory({
        action: 'navigate',
        detail: url,
        result: 'success',
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
      this.emitState()
      return { title, url: finalUrl }
    } catch (err) {
      this.recordHistory({
        action: 'navigate',
        detail: url,
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 点击元素 */
  async click(selector: string): Promise<void> {
    this.assertViewInteractive('click')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'click', detail: selector, selector })

    try {
      // 先获取元素位置（用于鼠标轨迹）
      const rect = await wc.executeJavaScript(`window.__leGetElementRect(${JSON.stringify(selector)})`)
      if (rect) {
        // 显示动作标签
        await wc.executeJavaScript(`window.__leShowLabel('AI 正在点击: ${selector.replace(/'/g, '')}', 2000)`)
        // 鼠标从屏幕中心滑到目标
        const winSize = this.hostWindow?.getContentSize() ?? [800, 600]
        await wc.executeJavaScript(`window.__leMouseMove(${winSize[0] / 2}, ${winSize[1] / 2}, ${rect.centerX}, ${rect.centerY})`)
        await new Promise((r) => setTimeout(r, 600)) // 等待动画完成
        if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
        // 执行点击
        const ok = await wc.executeJavaScript(`window.__leSimulateClick(${JSON.stringify(selector)})`)
        if (!ok) throw new Error(`元素未找到: ${selector}`)
      } else {
        // fallback: 直接 click()
        await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`)
      }
      this.recordHistory({ action: 'click', detail: selector, result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
    } catch (err) {
      this.recordHistory({
        action: 'click',
        detail: selector,
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 输入文本 */
  async type(selector: string, text: string, clear = true): Promise<void> {
    this.assertViewInteractive('type')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'type', detail: `${selector} ← "${text}"`, selector })

    try {
      await wc.executeJavaScript(`window.__leShowLabel('AI 正在输入: "${text.slice(0, 20)}"', 2500)`)
      const ok = await wc.executeJavaScript(`window.__leSimulateType(${JSON.stringify(selector)}, ${JSON.stringify(text)}, ${clear})`)
      if (!ok) throw new Error(`元素未找到: ${selector}`)
      this.recordHistory({ action: 'type', detail: `${selector} ← "${text}"`, result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
    } catch (err) {
      this.recordHistory({
        action: 'type',
        detail: `${selector} ← "${text}"`,
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 滚动 */
  async scroll(direction: 'up' | 'down' = 'down', amount = 500): Promise<void> {
    this.assertViewInteractive('scroll')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'scroll', detail: `${direction} ${amount}px` })

    try {
      const dy = direction === 'up' ? -amount : amount
      await wc.executeJavaScript(`window.scrollBy(0, ${dy})`)
      await wc.executeJavaScript(`window.__leShowLabel('AI 滚动 ${direction} ${amount}px', 1500)`)
      this.recordHistory({ action: 'scroll', detail: `${direction} ${amount}px`, result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
    } catch (err) {
      this.recordHistory({
        action: 'scroll',
        detail: `${direction} ${amount}px`,
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 截图（保存到临时目录） */
  async screenshot(fullPage = false): Promise<string> {
    this.assertViewInteractive('screenshot')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'screenshot', detail: fullPage ? 'fullPage' : 'viewport' })

    try {
      const dir = join(tmpdir(), 'lunareclipse-screenshots')
      mkdirSync(dir, { recursive: true })
      const filename = `shot-${Date.now()}.png`
      const filepath = join(dir, filename)
      // webContents.capturePage 不支持 fullPage，整页需用 executeJavaScript 滚动拼接（这里先支持可视区域）
      const image = await wc.capturePage()
      await writeFile(filepath, image.toPNG())
      this.recordHistory({ action: 'screenshot', detail: filepath, result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
      return filepath
    } catch (err) {
      this.recordHistory({
        action: 'screenshot',
        detail: fullPage ? 'fullPage' : 'viewport',
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }


  /** 页面快照（可访问性树精简版） */
  async snapshot(): Promise<string> {
    this.assertViewInteractive('snapshot')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'snapshot', detail: '' })

    try {
      // 页面加载中时等待，否则抓到的是空壳
      if (this.loading) {
        await waitForLoad(wc)
        await waitForBodyReady(wc, 3000)
      }
      if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
      const text = await wc.executeJavaScript(
        SNAPSHOT_SCRIPT
      )
      this.recordHistory({ action: 'snapshot', detail: '', result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
      return text || '(空页面，body 无内容)'
    } catch (err) {
      this.recordHistory({
        action: 'snapshot',
        detail: '',
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /** 执行 JS */
  async evaluate(script: string): Promise<unknown> {
    this.assertViewInteractive('evaluate')
    if (!this.view) throw new Error('浏览器视图未创建')
    const wc = this.view.webContents
    if (wc.isDestroyed()) throw new Error('浏览器页面已销毁')
    const start = Date.now()
    this.pushEvent({ type: 'browser:actionStart', action: 'evaluate', detail: script.slice(0, 80) })

    try {
      const result = await wc.executeJavaScript(script)
      this.recordHistory({ action: 'evaluate', detail: script.slice(0, 80), result: 'success', durationMs: Date.now() - start })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'success' })
      return result
    } catch (err) {
      this.recordHistory({
        action: 'evaluate',
        detail: script.slice(0, 80),
        result: 'error',
        errorMessage: (err as Error).message,
        durationMs: Date.now() - start
      })
      this.pushEvent({ type: 'browser:actionEnd', id: '', result: 'error', errorMessage: (err as Error).message })
      throw err
    }
  }

  /**
   * 获取当前页面状态（轻量，不记历史不推事件）
   * 供 AI 在操作后感知页面结果，或主动查询浏览器状态。
   * 返回：是否可见、URL、标题、是否加载中、页面可访问性快照（不截断）。
   */
  async getPageState(): Promise<{
    visible: boolean
    url: string
    title: string
    loading: boolean
    canGoBack: boolean
    canGoForward: boolean
    snapshot: string
  }> {
    // useSystemBrowser 模式：无内置视图，返回明确提示（避免 AI 误以为面板可交互）
    if (this.useSystemBrowser()) {
      return {
        visible: false,
        url: this.currentUrl,
        title: this.currentTitle,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        snapshot: '(系统浏览器模式：已在系统默认浏览器打开；无内置面板，交互类操作不可用)'
      }
    }
    const visible = this.visible
    if (!this.view || !visible) {
      return { visible: false, url: '', title: '', loading: false, canGoBack: false, canGoForward: false, snapshot: '' }
    }
    const wc = this.view.webContents
    if (wc.isDestroyed()) {
      return { visible: false, url: this.currentUrl, title: this.currentTitle, loading: false, canGoBack: false, canGoForward: false, snapshot: '(页面已销毁)' }
    }
    // 页面加载中时等待，避免抓到空壳导致 AI 误判
    if (this.loading) {
      await waitForLoad(wc)
      await waitForBodyReady(wc, 3000)
    }
    if (wc.isDestroyed()) {
      return { visible: false, url: this.currentUrl, title: this.currentTitle, loading: false, canGoBack: false, canGoForward: false, snapshot: '(页面已销毁)' }
    }
    let snapshot = ''
    try {
      snapshot = await wc.executeJavaScript(
        SNAPSHOT_SCRIPT
      )
    } catch (err) {
      // 快照失败时返回可操作信息，引导 AI 用 browser_snapshot 重试或 browser_evaluate 排查
      snapshot = `(快照获取失败: ${(err as Error).message}。可尝试再次调用 browser_snapshot，或用 browser_evaluate 执行 document.title 排查页面状态)`
    }
    let canGoBack = false
    let canGoForward = false
    try {
      const nav = wc.navigationHistory
      canGoBack = nav.canGoBack()
      canGoForward = nav.canGoForward()
    } catch { /* 忽略 */ }
    return {
      visible,
      url: this.currentUrl,
      title: this.currentTitle,
      loading: this.loading,
      canGoBack,
      canGoForward,
      snapshot: snapshot || '(空页面，body 无内容。页面可能还在渲染，可稍后重试 browser_snapshot)'
    }
  }
}

// 单例
export const browserViewManager = new BrowserViewManager()

// 类型与 IPC 注册由子模块提供，入口保持导出面不变（外部引用路径不变）
export type { BrowserHistoryEntry, BrowserEvent } from './browser-view-types'
export { registerBrowserIpcHandlers } from './browser-view-ipc'
