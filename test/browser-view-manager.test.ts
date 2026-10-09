/**
 * 批次 A3：browser-view-manager 测试网
 *
 * 通过 mock electron（WebContentsView/BrowserWindow/ipcMain/shell）驱动真实 BrowserViewManager，
 * 覆盖：view 懒创建/显示/隐藏/close/销毁、WebContents 生命周期事件回调、
 * 窗口绑定与迁移、setWindowOpenHandler 策略、系统浏览器降级、历史记录上限、IPC 注册。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ===== electron / browser-manager mock（hoisted，供 vi.mock 工厂引用） =====
const mockState = vi.hoisted(() => {
  const views: unknown[] = []
  const windows: unknown[] = []
  const ipcHandles = new Map<string, (...args: unknown[]) => unknown>()
  const shellOpenExternal = vi.fn(async () => {})

  function makeEmitter() {
    const m = new Map<string, Set<(...args: unknown[]) => void>>()
    const api = {
      on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
        if (!m.has(ev)) m.set(ev, new Set())
        m.get(ev)!.add(cb)
        return api
      }),
      once: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
        const tmp = (...args: unknown[]) => {
          cb(...args)
          api.removeListener(ev, tmp)
        }
        api.on(ev, tmp)
        return api
      }),
      removeListener: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
        m.get(ev)?.delete(cb)
        return api
      }),
      listenerCount: (ev: string) => m.get(ev)?.size ?? 0,
      emit: (ev: string, ...args: unknown[]) => {
        const set = m.get(ev)
        if (!set) return
        for (const cb of [...set]) cb(...args)
      }
    }
    return api
  }

class MockWebContents {
    destroyed = false
    isLoadingValue = false
    url = 'about:blank'
    title = ''
    zoomFactor = 1
    windowOpenHandler: ((p: { url: string }) => { action: string }) | null = null
    nav = {
      backDepth: 0,
      fwdDepth: 0,
      canGoBack: () => this.nav.backDepth > 0,
      canGoForward: () => this.nav.fwdDepth > 0,
      goBack: () => { if (this.nav.backDepth > 0) { this.nav.backDepth--; this.nav.fwdDepth++ } },
      goForward: () => { if (this.nav.fwdDepth > 0) { this.nav.fwdDepth--; this.nav.backDepth++ } }
    }
    ee = makeEmitter()
    loadURL = vi.fn(async (u: string) => { this.url = u })
    executeJavaScript = vi.fn(async () => null)
    capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('png') }))
    attach = vi.fn()
    insertCSS = vi.fn(async () => '')
    on = this.ee.on
    once = this.ee.once
    removeListener = this.ee.removeListener
    emit = this.ee.emit
    setWindowOpenHandler = vi.fn((h: (p: { url: string }) => { action: string }) => { this.windowOpenHandler = h })
    isDestroyed = vi.fn(() => this.destroyed)
    isLoading = vi.fn(() => this.isLoadingValue)
    close = vi.fn(() => { this.destroyed = true })
    getURL = vi.fn(() => this.url)
    getTitle = vi.fn(() => this.title)
    reload = vi.fn()
    stop = vi.fn()
send = vi.fn()
    setZoomFactor = vi.fn((zoom: number) => { this.zoomFactor = zoom })
    navigationHistory = this.nav
  }

  class MockWebContentsView {
    webContents: MockWebContents
    bounds: unknown = null
    opts: { webPreferences?: { partition?: string } } | null = null
    constructor(opts: unknown) {
      this.webContents = new MockWebContents()
      this.opts = opts as { webPreferences?: { partition?: string } } | null
      views.push(this)
    }
    setBounds = vi.fn((b: unknown) => { this.bounds = b })
  }

  // 隐私红线（T1）：外部网页独立 partition 的权限 handler 存档，供测试断言 geolocation 一律拒绝
  const externalSessionHandlers: Array<(wc: unknown, permission: string, callback: (grant: boolean) => void) => void> = []
  const sessionFromPartition = vi.fn((_partition: string) => ({
    setPermissionRequestHandler: (h: (wc: unknown, permission: string, callback: (grant: boolean) => void) => void) => {
      externalSessionHandlers.push(h)
    }
  }))

  class MockBrowserWindow {
    webContents: MockWebContents
    contentView: { addChildView: ReturnType<typeof vi.fn>; removeChildView: ReturnType<typeof vi.fn> }
    destroyed = false
    size = [1000, 800]
    ee = makeEmitter()
    constructor() {
      this.webContents = new MockWebContents()
      this.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
      windows.push(this)
    }
    on = this.ee.on
    once = this.ee.once
    removeListener = this.ee.removeListener
    emit = this.ee.emit
isDestroyed = vi.fn(() => this.destroyed)
    getContentSize = vi.fn(() => this.size)
    getBounds = vi.fn(() => ({ x: 0, y: 0, width: this.size[0], height: this.size[1] }))
    close = vi.fn(() => { this.destroyed = true; this.ee.emit('closed') })
  }

  return {
    views,
    windows,
    ipcHandles,
    shellOpenExternal,
    externalSessionHandlers,
    sessionFromPartition,
    MockWebContents,
    MockWebContentsView,
    MockBrowserWindow,
    ipcMain: {
      handle: vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => { ipcHandles.set(channel, fn) }),
      on: vi.fn(),
      removeHandler: vi.fn()
    },
shell: { openExternal: shellOpenExternal },
    app: { getPath: vi.fn(() => '/fake-userdata') },
    screen: {
      getDisplayMatching: vi.fn(() => ({ id: 1, workArea: { height: 1080 } })),
      on: vi.fn()
    },
    configStore: {
      get: vi.fn(() => ({ browserZoom: null })),
      save: vi.fn(),
      subscribe: vi.fn(),
      getEffective: vi.fn(() => ({}))
    },
    // 外部网页会话（独立 partition）：权限 handler 存档可断言，不触真实 session
    session: { fromPartition: sessionFromPartition }
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mockState.MockBrowserWindow,
  WebContentsView: mockState.MockWebContentsView,
  ipcMain: mockState.ipcMain,
  shell: mockState.shell,
  app: mockState.app,
  screen: mockState.screen,
  session: mockState.session
}))

vi.mock('../electron/main/tools/browser-manager', () => ({
  browserManager: {}
}))

import { browserViewManager, registerBrowserIpcHandlers } from '../electron/main/tools/browser-view-manager'
import type { BrowserHistoryEntry } from '../electron/main/tools/browser-view-manager'

const mgr = browserViewManager as unknown as {
  view: unknown
  hostWindow: unknown
  visible: boolean
  history: BrowserHistoryEntry[]
  currentUrl: string
  currentTitle: string
  loading: boolean
  overlayOpen: boolean
  pendingShow: boolean
useSystemBrowserGetter?: () => boolean
  useSystemBrowser(): boolean
  emitState(): void
  setOverlay(open: boolean): void
  show(): Promise<void>
  hide(): void
  close(): void
  destroyView(): void
  zoomManual: number | null
  zoomLastDisplayId: number
}

function resetState() {
  mockState.views.length = 0
  mockState.windows.length = 0
  mockState.ipcHandles.clear()
  mockState.shellOpenExternal.mockClear()
  mockState.externalSessionHandlers.length = 0
  mockState.sessionFromPartition.mockClear()
  mgr.view = null
  mgr.hostWindow = null
  mgr.visible = false
  mgr.history = []
  mgr.currentUrl = ''
  mgr.currentTitle = ''
  mgr.loading = false
mgr.overlayOpen = false
  mgr.pendingShow = false
  mgr.useSystemBrowserGetter = undefined
  mgr.zoomManual = null
  mgr.zoomLastDisplayId = -1
  mockState.configStore.save.mockClear()
}

function makeHostWindow() {
  const win = new mockState.MockBrowserWindow()
  return win
}

beforeEach(() => {
  resetState()
})

afterEach(() => {
  resetState()
})

describe('browser-view-manager：view 懒创建 / 显示 / 隐藏 / 销毁（批次 A3）', () => {
  it('未绑定 host window 时 show() 抛错', async () => {
    await expect(browserViewManager.show()).rejects.toThrow('host window 未绑定')
  })

  it('show() 懒创建 WebContentsView：加载欢迎页 + 挂载 + 同步状态事件', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()

    expect(mockState.views).toHaveLength(1)
    const view = mockState.views[0]
    expect(view.webContents.loadURL).toHaveBeenCalled()
    expect(view.webContents.loadURL.mock.calls[0][0]).toContain('data:text/html')
    expect(win.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(browserViewManager.isVisible()).toBe(true)
    // 状态事件推送（webContents.send('browser:event', browser:state)）
    const sendCalls = win.webContents.send.mock.calls
    const stateEvt = sendCalls.find((c) => c[0] === 'browser:event' && c[1].type === 'browser:state')
    expect(stateEvt).toBeTruthy()
    expect(stateEvt[1]).toMatchObject({ visible: true })
  })

  it('show() 幂等：已可见时再次 show 不重复挂载', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    await browserViewManager.show()
    expect(win.contentView.addChildView).toHaveBeenCalledTimes(1)
    expect(mockState.views).toHaveLength(1)
  })

  it('hide() 隐藏：从 contentView 移除 + 状态事件 visible=false', () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    void browserViewManager.show()
    // show 是 async：先等微任务
    return vi.waitFor(() => expect(browserViewManager.isVisible()).toBe(true)).then(() => {
      browserViewManager.hide()
      expect(win.contentView.removeChildView).toHaveBeenCalled()
      expect(browserViewManager.isVisible()).toBe(false)
    })
  })

  it('hide() 在 view 未创建或已隐藏时为空操作（不抛错）', () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    expect(() => browserViewManager.hide()).not.toThrow()
  })

  it('close()：隐藏 + 广播 browser:closed 给前端（无论 view 是否创建）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    win.webContents.send.mockClear()
    browserViewManager.close()
    expect(browserViewManager.isVisible()).toBe(false)
    const closedEvt = win.webContents.send.mock.calls.find(
      (c) => c[0] === 'browser:event' && c[1].type === 'browser:closed'
    )
    expect(closedEvt).toBeTruthy()

    // view 未创建时 close 也要通知前端清理标签
    win.webContents.send.mockClear()
    mgr.view = null
    browserViewManager.close()
    const closedEvt2 = win.webContents.send.mock.calls.find(
      (c) => c[0] === 'browser:event' && c[1].type === 'browser:closed'
    )
    expect(closedEvt2).toBeTruthy()
  })

  it('destroyView()：关闭 webContents 防泄漏 + 清空 view', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const wc = mockState.views[0].webContents
    browserViewManager.destroyView()
    expect(wc.close).toHaveBeenCalled()
    expect(mgr.view).toBeNull()
    expect(browserViewManager.isVisible()).toBe(false)
    // 幂等：view 为 null 时再次 destroy 不抛
    expect(() => browserViewManager.destroyView()).not.toThrow()
  })

  it('attachWindow：窗口 closed 时自动销毁视图并解绑 host', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    win.emit('closed')
    expect(mgr.view).toBeNull()
    expect(mgr.hostWindow).toBeNull()
    expect(browserViewManager.isVisible()).toBe(false)
  })

  it('attachWindow：窗口 resize 且可见时重新布局（setBounds 收缩预留区）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const view = mockState.views[0]
    view.setBounds.mockClear()
    browserViewManager.setLayout({ top: 100, bottom: 50, left: 210, right: 30 })
    win.size = [1200, 900]
    win.emit('resize')
    expect(view.setBounds).toHaveBeenCalledWith({
      x: 210,
      y: 100,
      width: 1200 - 210 - 30,
      height: 900 - 100 - 50
    })
  })

  it('setLayout 负数预留钳制为 0，且不可见时不重新布局', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const view = mockState.views[0]
    view.setBounds.mockClear()
    browserViewManager.hide()
    browserViewManager.setLayout({ top: -5, left: -10 })
    expect(view.setBounds).not.toHaveBeenCalled()
    // 重新显示后布局使用钳制值
    await browserViewManager.show()
    expect(view.setBounds.mock.calls[0][0].y).toBe(0)
    expect(view.setBounds.mock.calls[0][0].x).toBe(0)
  })
})

describe('browser-view-manager：WebContents 生命周期事件回调（批次 A3）', () => {
  async function shownView() {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    return { win, wc: mockState.views[0].webContents }
  }

  it('did-navigate / did-navigate-in-page 更新 currentUrl 并推送状态', async () => {
    const { win, wc } = await shownView()
    wc.emit('did-navigate', {}, 'https://example.com/')
    expect(mgr.currentUrl).toBe('https://example.com/')
    wc.emit('did-navigate-in-page', {}, 'https://example.com/#sec')
    expect(mgr.currentUrl).toBe('https://example.com/#sec')
    const lastState = win.webContents.send.mock.calls
      .filter((c) => c[0] === 'browser:event')
      .map((c) => c[1])
      .filter((e) => e.type === 'browser:state')
      .at(-1)
    expect(lastState.url).toBe('https://example.com/#sec')
  })

  it('page-title-updated 更新标题', async () => {
    const { wc } = await shownView()
    wc.emit('page-title-updated', {}, '你好，世界')
    expect(mgr.currentTitle).toBe('你好，世界')
    expect(mgr.getStateSummary().title).toBe('你好，世界')
  })

  it('did-start-loading / did-stop-loading 切换 loading 态', async () => {
    const { wc } = await shownView()
    wc.emit('did-start-loading')
    expect(mgr.loading).toBe(true)
    expect(mgr.getStateSummary().loading).toBe(true)
    wc.emit('did-stop-loading')
    expect(mgr.loading).toBe(false)
  })

  it('did-finish-load 触发追踪脚本注入（executeJavaScript）', async () => {
    const { wc } = await shownView()
    wc.executeJavaScript.mockClear()
    wc.emit('did-finish-load')
    await vi.waitFor(() => expect(wc.executeJavaScript).toHaveBeenCalled())
    const script = wc.executeJavaScript.mock.calls[0][0] as string
    expect(script).toContain('__lunareclipseTrackerInstalled')
  })
})

describe('browser-view-manager：setWindowOpenHandler 策略（批次 A3）', () => {
  it('http/https 链接在当前视图内加载并 deny 新窗口', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const wc = mockState.views[0].webContents
    wc.loadURL.mockClear()
    const result = wc.windowOpenHandler!({ url: 'https://example.org/page' })
    expect(result).toEqual({ action: 'deny' })
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.org/page')
  })

  it('非网页协议（mailto:）转系统浏览器处理', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const wc = mockState.views[0].webContents
    const result = wc.windowOpenHandler!({ url: 'mailto:hi@example.com' })
    expect(result).toEqual({ action: 'deny' })
    expect(mockState.shellOpenExternal).toHaveBeenCalledWith('mailto:hi@example.com')
  })

  it('危险协议（file:/ms-settings:/javascript:）一律 deny 且不转系统处理（防本机文件/系统设置被网页触发）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const wc = mockState.views[0].webContents
    for (const url of ['file:///C:/Users/me/secret.txt', 'ms-settings://network', 'javascript:alert(1)', 'custom-proto://x']) {
      wc.loadURL.mockClear()
      mockState.shellOpenExternal.mockClear()
      const result = wc.windowOpenHandler!({ url })
      expect(result).toEqual({ action: 'deny' })
      expect(wc.loadURL).not.toHaveBeenCalled()
      expect(mockState.shellOpenExternal).not.toHaveBeenCalled()
    }
  })
})

describe('browser-view-manager：系统浏览器降级模式（批次 A3）', () => {
  it('useSystemBrowser=true 时 show() 不创建视图、navigate 转系统浏览器并记录历史', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    mgr.useSystemBrowserGetter = () => true
    await browserViewManager.show() // 空操作
    expect(mockState.views).toHaveLength(0)
    expect(browserViewManager.isVisible()).toBe(false)

    const r = await browserViewManager.navigate('example.com')
    expect(mockState.shellOpenExternal).toHaveBeenCalledWith('https://example.com')
    expect(r.url).toBe('https://example.com')
    const hist = browserViewManager.getHistory()
    expect(hist[0]).toMatchObject({ action: 'navigate', detail: 'example.com', result: 'success' })
  })

  it('交互类操作（click/type/scroll/snapshot）在系统浏览器模式明确抛错', async () => {
    mgr.useSystemBrowserGetter = () => true
    await expect(browserViewManager.click('#btn')).rejects.toThrow('系统浏览器模式')
    await expect(browserViewManager.type('#input', 'hi')).rejects.toThrow('系统浏览器模式')
    await expect(browserViewManager.scroll('down')).rejects.toThrow('系统浏览器模式')
    await expect(browserViewManager.snapshot()).rejects.toThrow('系统浏览器模式')
    await expect(browserViewManager.back()).rejects.toThrow('系统浏览器模式')
  })
})

describe('browser-view-manager：导航与历史（批次 A3）', () => {
  async function shownView() {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    return { win, wc: mockState.views[0].webContents }
  }

  it('navigate：规范化 URL + 等待加载 + 记 history + actionEnd 事件', async () => {
    const { win, wc } = await shownView()
    wc.executeJavaScript.mockResolvedValue(50) // bodyReady：>10 直接认为渲染完成
    wc.isLoadingValue = true // 让 waitForLoad 走事件等待分支
    // 先等 waitForLoad 注册 did-finish-load 监听后再触发（防止事件早于监听注册）
    const rPromise = browserViewManager.navigate('baidu.com')
    await vi.waitFor(
      () => expect(wc.once.mock.calls.some((c: string[]) => c[0] === 'did-finish-load')).toBe(true)
    )
    wc.url = 'https://baidu.com/'
    wc.title = '百度'
    wc.emit('did-finish-load')
    const r = await rPromise
    expect(wc.loadURL).toHaveBeenCalledWith('https://baidu.com')
    expect(r).toEqual({ title: '百度', url: 'https://baidu.com/' })
    expect(browserViewManager.getHistory()[0]).toMatchObject({ action: 'navigate', detail: 'baidu.com', result: 'success' })
    const actEnd = win.webContents.send.mock.calls.find(
      (c) => c[0] === 'browser:event' && c[1].type === 'browser:actionEnd'
    )
    expect(actEnd[1]).toMatchObject({ result: 'success' })
  })

  it('navigate 失败：记录 error 历史 + actionEnd error + 向上抛', async () => {
    const { win, wc } = await shownView()
    wc.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'))
    await expect(browserViewManager.navigate('https://bad.test')).rejects.toThrow('ERR_NAME_NOT_RESOLVED')
    expect(browserViewManager.getHistory()[0]).toMatchObject({ action: 'navigate', result: 'error', errorMessage: 'ERR_NAME_NOT_RESOLVED' })
    const actEnd = win.webContents.send.mock.calls.find(
      (c) => c[0] === 'browser:event' && c[1].type === 'browser:actionEnd'
    )
    expect(actEnd[1]).toMatchObject({ result: 'error', errorMessage: 'ERR_NAME_NOT_RESOLVED' })
  })

  it('navigate：file:/javascript: 等危险协议 fail-fast 拒绝且不调用 loadURL（防本机文件读取/任意 JS 执行）', async () => {
    const { wc } = await shownView()
    for (const url of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<script>1</script>', 'ms-settings://network']) {
      wc.loadURL.mockClear()
      await expect(browserViewManager.navigate(url)).rejects.toThrow('不支持的 URL 协议')
      expect(wc.loadURL).not.toHaveBeenCalled()
    }
  })

  it('back：无后退历史时报错并记录 error（不抛给调用方）', async () => {
    await shownView()
    const r = await browserViewManager.back()
    expect(r.canGoBack).toBe(false)
    expect(browserViewManager.getHistory()[0]).toMatchObject({ action: 'navigate', detail: '(后退：无历史)', result: 'error' })
  })

  it('back：有后退历史时真正 goBack + 更新 URL/标题 + success 历史', async () => {
    const { win, wc } = await shownView()
    wc.nav.backDepth = 1
    wc.url = 'https://previous.test/page'
    wc.title = '上一页'
    wc.isLoadingValue = true
    const rP = browserViewManager.back()
    await vi.waitFor(
      () => expect(wc.once.mock.calls.some((c: string[]) => c[0] === 'did-finish-load')).toBe(true)
    )
    wc.emit('did-finish-load')
    const r = await rP
    expect(r.url).toBe('https://previous.test/page')
    expect(browserViewManager.getHistory()[0]).toMatchObject({ action: 'navigate', detail: '(后退)', result: 'success' })
    const actEnd = win.webContents.send.mock.calls.find(
      (c) => c[0] === 'browser:event' && c[1].type === 'browser:actionEnd'
    )
    expect(actEnd[1]).toMatchObject({ result: 'success' })
  })

  it('recordHistory 上限 100 条，超过后丢弃最旧', () => {
    for (let i = 0; i < 105; i++) {
      const id = browserViewManager.recordHistory({
        action: 'scroll',
        detail: `step-${i}`,
        result: 'success',
        durationMs: 1
      })
      expect(id).toMatch(/^bh_/)
    }
    const hist = browserViewManager.getHistory()
    expect(hist).toHaveLength(100)
    expect(hist[0].detail).toBe('step-104')
    expect(hist[99].detail).toBe('step-5')
    // getHistory 返回副本
    hist.push({} as BrowserHistoryEntry)
    expect(browserViewManager.getHistory()).toHaveLength(100)
  })

  it('click：getRect 失败时 fallback 到 querySelector().click()', async () => {
    const { win, wc } = await shownView()
    wc.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__leGetElementRect')) return null
      if (script.includes('__leSimulateClick')) return false
      return null
    })
    await browserViewManager.click('#submit')
    expect(browserViewManager.getHistory()[0]).toMatchObject({ action: 'click', detail: '#submit', result: 'success' })
    const clickScript = wc.executeJavaScript.mock.calls.find((c: string[]) => c[0].includes('__leSimulateClick') || c[0].includes('querySelector'))
    expect(clickScript[0]).toContain('document.querySelector')
    const actEnd = win.webContents.send.mock.calls.find(
      (c) => c[0] === 'browser:event' && c[1].type === 'browser:actionEnd'
    )
    expect(actEnd[1]).toMatchObject({ result: 'success' })
  })

  it('click：元素未找到时记录 error 并抛错', async () => {
    const { wc } = await shownView()
    wc.executeJavaScript.mockImplementation(async (script: string) => {
      if (script.includes('__leGetElementRect')) return { centerX: 10, centerY: 20 }
      if (script.includes('__leSimulateClick')) return false
      return null
    })
    await expect(browserViewManager.click('#missing')).rejects.toThrow('元素未找到')
    expect(browserViewManager.getHistory()[0]).toMatchObject({ action: 'click', result: 'error' })
  })

  it('view 未创建时 navigate/click/snapshot 明确抛错', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await expect(browserViewManager.navigate('https://x.test')).rejects.toThrow('浏览器视图未创建')
    await expect(browserViewManager.click('#a')).rejects.toThrow('浏览器视图未创建')
    await expect(browserViewManager.snapshot()).rejects.toThrow('浏览器视图未创建')
  })
})

describe('browser-view-manager：浮层遮挡 setOverlay（批次 A3）', () => {
  it('opening 浮层且 view 可见时立即隐藏；pendingShow 在浮层关闭后自动补 show', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    // 浮层打开 → 隐藏
    browserViewManager.setOverlay(true)
    expect(browserViewManager.isVisible()).toBe(false)
    // 浮层遮挡期间 AI 请求显示 → pendingShow（show 被抑制）
    const p = browserViewManager.show().then(() => mgr.pendingShow)
    // show() 同步执行到 overlayOpen=true 分支后 return，pendingShow 已置位
    await p
    expect(mgr.pendingShow).toBe(true)
    expect(browserViewManager.isVisible()).toBe(false)
    // 浮层关闭 → 自动补 show
    browserViewManager.setOverlay(false)
    await vi.waitFor(() => expect(browserViewManager.isVisible()).toBe(true))
    expect(mgr.pendingShow).toBe(false)
  })

  it('关闭浮层时无 pendingShow 则不自动恢复（由前端决定）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    browserViewManager.setOverlay(true)
    browserViewManager.setOverlay(false)
    expect(browserViewManager.isVisible()).toBe(false)
  })
})

describe('browser-view-manager：外部网页独立 partition 与权限拒绝（T1 隐私红线）', () => {
  it('创建视图时绑定 external-webview 独立 session，不用 defaultSession', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()

    const view = mockState.views[0]
    expect(mockState.sessionFromPartition).toHaveBeenCalledWith('external-webview')
    expect(view.opts?.webPreferences?.partition).toBe('external-webview')
  })

  it('外部网页 session 的权限 handler：geolocation 等一切权限默认拒绝（不全局放行）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()

    const handler = mockState.externalSessionHandlers[0]
    expect(handler).toBeTruthy()
    const granted: boolean[] = []
    handler({}, 'geolocation', (g) => granted.push(g))
    handler({}, 'clipboard-read', (g) => granted.push(g))
    handler({}, 'notifications', (g) => granted.push(g))
    // 普通网页不能获得系统定位或任何权限
    expect(granted).toEqual([false, false, false])
    // 没有出现「permission === 'geolocation' → 放行」逻辑：任何权限都不回调 true
    expect(granted.every((g) => g === false)).toBe(true)
  })

  it('geolocationPolicy=allow：仅放行 geolocation，其余权限仍拒绝（配置驱动）', async () => {
    // 模拟用户在内置浏览器设置中显式开启「允许外部网页获取系统定位」
    const prevGetter = browserViewManager.geolocationPolicyGetter
    try {
      browserViewManager.geolocationPolicyGetter = () => 'allow'
      const win = makeHostWindow()
      browserViewManager.attachWindow(win)
      await browserViewManager.show()

      const handler = mockState.externalSessionHandlers[0]
      expect(handler).toBeTruthy()
      const granted: string[] = []
      handler({}, 'geolocation', (g) => granted.push(g ? 'geo' : 'no-geo'))
      handler({}, 'clipboard-read', (g) => granted.push(g ? 'clip' : 'no-clip'))
      handler({}, 'notifications', (g) => granted.push(g ? 'notif' : 'no-notif'))
      // allow 模式只影响 geolocation：其余系统能力仍然一律拒绝
      expect(granted).toEqual(['geo', 'no-clip', 'no-notif'])
    } finally {
      // 复位单例注入，避免泄漏到后续用例（默认 deny）
      browserViewManager.geolocationPolicyGetter = prevGetter
    }
  })

  it('geolocationPolicy 未配置（getter 缺失）时按默认 deny 处理', async () => {
    const prevGetter = browserViewManager.geolocationPolicyGetter
    try {
      browserViewManager.geolocationPolicyGetter = undefined
      const win = makeHostWindow()
      browserViewManager.attachWindow(win)
      await browserViewManager.show()

      const handler = mockState.externalSessionHandlers[0]
      const granted: boolean[] = []
      handler({}, 'geolocation', (g) => granted.push(g))
      expect(granted).toEqual([false])
    } finally {
      browserViewManager.geolocationPolicyGetter = prevGetter
    }
  })

  it('多次 show 不重复注册（partition 权限 handler 只设一次）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    await browserViewManager.show()
    await browserViewManager.hide()
    // 同一视图复用：fromPartition 只在视图创建时调用一次
    expect(mockState.sessionFromPartition).toHaveBeenCalledTimes(1)
  })
})

describe('browser-view-manager：IPC 注册（批次 A3）', () => {
it('registerBrowserIpcHandlers 注册主要通道并快速返回 ok', async () => {
    registerBrowserIpcHandlers(mockState.ipcMain as never, mockState.configStore as never)
    const channels = mockState.ipcMain.handle.mock.calls.map((c: string[]) => c[0])
    for (const ch of ['browser:show', 'browser:hide', 'browser:isVisible', 'browser:getHistory', 'browser:navigate', 'browser:snapshot', 'browser:reload', 'browser:stop']) {
      expect(channels).toContain(ch)
    }
    // 直接触发 handler 验证可执行且返回形状正确
    const isVisibleResult = await mockState.ipcHandles.get('browser:isVisible')!()
    expect(isVisibleResult).toEqual({ visible: false })
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    const showResult = await mockState.ipcHandles.get('browser:show')!()
    expect(showResult).toEqual({ ok: true })
    expect(browserViewManager.isVisible()).toBe(true)
  })

it('browser:setOverlay 传递 open 布尔并影响可见性', async () => {
    registerBrowserIpcHandlers(mockState.ipcMain as never, mockState.configStore as never)
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    // 浮层打开 → 隐藏；遮挡期间请求显示 → pendingShow 置位
    const r1 = await mockState.ipcHandles.get('browser:setOverlay')!({}, true)
    expect(r1).toEqual({ ok: true })
    expect(browserViewManager.isVisible()).toBe(false)
    const showP = mockState.ipcHandles.get('browser:show')!()
    expect(mgr.pendingShow).toBe(true)
    expect(browserViewManager.isVisible()).toBe(false)
    await showP
    // 浮层关闭 → pendingShow 自动补 show
    mockState.ipcHandles.get('browser:setOverlay')!({}, false)
    await vi.waitFor(() => expect(browserViewManager.isVisible()).toBe(true))
    expect(mgr.pendingShow).toBe(false)
  })
})

describe('browser-view-manager：moveToWindow 宿主迁移（批次 A3）', () => {
  it('迁移后视图挂到新窗口并重新布局', async () => {
    const win1 = makeHostWindow()
    browserViewManager.attachWindow(win1)
    await browserViewManager.show()
    const view = mockState.views[0]
    win1.contentView.addChildView.mockClear()
    const win2 = makeHostWindow()
    browserViewManager.moveToWindow(win2)
    expect(win2.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(mgr.hostWindow).toBe(win2)
// 新窗口 closed 也触发销毁
    win2.emit('closed')
    expect(mgr.view).toBeNull()
  })
})

describe('browser-view-manager：网页缩放 自动/手动/clamp/持久化 IPC（批次 A3 扩展）', () => {
  it('show 时按显示器自动缩放（mock 工作区 1080 → zoom=1.0）', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const wc = mockState.views[0].webContents
    expect(wc.setZoomFactor).toHaveBeenCalledWith(1)
    expect(browserViewManager.getBrowserZoomState()).toEqual({ mode: 'auto', zoom: 1, manual: null })
  })

  it('手动设置/步进：手动覆盖自动并 clamp 上下界，非法值恢复自动', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const wc = mockState.views[0].webContents
    browserViewManager.setBrowserZoom(1.3)
    expect(wc.setZoomFactor).toHaveBeenLastCalledWith(1.3)
    expect(browserViewManager.getBrowserZoomState()).toEqual({ mode: 'manual', zoom: 1.3, manual: 1.3 })
    browserViewManager.stepBrowserZoom(0.1)
    expect(browserViewManager.getBrowserZoomState().zoom).toBe(1.4)
    // 上界 clamp
    browserViewManager.setBrowserZoom(99)
    expect(browserViewManager.getBrowserZoomState().zoom).toBe(2)
    // 下界 clamp
    browserViewManager.setBrowserZoom(0.01)
    expect(browserViewManager.getBrowserZoomState().zoom).toBe(0.7)
    // 非法值 → 恢复自动
    browserViewManager.setBrowserZoom(Number.NaN)
    expect(browserViewManager.getBrowserZoomState()).toEqual({ mode: 'auto', zoom: 1, manual: null })
  })

  it('重置恢复自动并推送 browser:zoomChanged 事件', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    const send = vi.fn()
    win.webContents.send = send as never
    browserViewManager.setBrowserZoom(1.5)
    browserViewManager.setBrowserZoom(null)
    expect(browserViewManager.getBrowserZoomState().mode).toBe('auto')
    // zoomChanged 走独立频道（对齐主 UI ui:zoomChanged），不走 browser:event 事件流
    const zoomEvents = send.mock.calls.filter((c) => c[0] === 'browser:zoomChanged').map((c) => c[1])
    expect(zoomEvents.at(-1)).toEqual({ mode: 'auto', zoom: 1 })
    const eventStream = send.mock.calls.filter((c) => c[0] === 'browser:event').map((c) => c[1])
    expect(eventStream.some((e) => (e as { type?: string }).type === 'browser:zoomChanged')).toBe(false)
  })

  it('缩放 IPC：zoomGet/zoomSet/zoomStep/zoomReset 注册、生效并持久化', async () => {
    registerBrowserIpcHandlers(mockState.ipcMain as never, mockState.configStore as never)
    const channels = mockState.ipcMain.handle.mock.calls.map((c: string[]) => c[0])
    for (const ch of ['browser:zoomGet', 'browser:zoomSet', 'browser:zoomStep', 'browser:zoomReset']) {
      expect(channels).toContain(ch)
    }
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    expect(await mockState.ipcHandles.get('browser:zoomGet')!()).toEqual({ mode: 'auto', zoom: 1, manual: null })
    // 手动设置 + 持久化
    const r = await mockState.ipcHandles.get('browser:zoomSet')!({}, 1.3)
    expect(r).toEqual({ mode: 'manual', zoom: 1.3, manual: 1.3 })
    expect(mockState.configStore.save).toHaveBeenCalled()
    // 步进
    const r2 = await mockState.ipcHandles.get('browser:zoomStep')!({}, 0.1)
    expect(r2.zoom).toBe(1.4)
    // 非法 delta 不改
    const r3 = await mockState.ipcHandles.get('browser:zoomStep')!({}, 'x')
    expect(r3.zoom).toBe(1.4)
    // 重置 → 自动
    const r4 = await mockState.ipcHandles.get('browser:zoomReset')!()
    expect(r4).toEqual({ mode: 'auto', zoom: 1, manual: null })
  })

  it('注册时恢复 config.browserZoom 持久化手动值', () => {
    mockState.configStore.get.mockReturnValueOnce({ browserZoom: 1.4 })
    registerBrowserIpcHandlers(mockState.ipcMain as never, mockState.configStore as never)
    expect(browserViewManager.getBrowserZoomState()).toEqual({ mode: 'manual', zoom: 1.4, manual: 1.4 })
  })

  it('视图销毁后缩放调用不崩溃', async () => {
    const win = makeHostWindow()
    browserViewManager.attachWindow(win)
    await browserViewManager.show()
    browserViewManager.setBrowserZoom(1.3)
    const wc = mockState.views[0].webContents
    wc.isDestroyed = vi.fn(() => true) as never
    expect(() => browserViewManager.setBrowserZoom(1.4)).not.toThrow()
  })
})