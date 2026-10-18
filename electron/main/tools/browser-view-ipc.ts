/**
 * 浏览器视图 IPC 桥：为什么存在——渲染进程不能直接操控主进程的 BrowserView（导航/截图/
 * 历史等），必须经 IPC 转发；本模块是这条桥的主进程侧。
 * 作用：注册 BrowserView 相关 IPC handlers（registerBrowserIpcHandlers），
 * 并入 browserViewManager 与配置读取。
 */
import { app, ipcMain } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { browserManager } from './browser-manager'
import { browserViewManager } from './browser-view-manager'
import type { ConfigStore } from '../api/config-store'

// IPC 注册（在主进程入口调用）
export function registerBrowserIpcHandlers(ipc: typeof ipcMain, configStore: ConfigStore): void {
  // 启动时恢复持久化的浏览器网页缩放（null/undefined=自动，无需显式设置）
  const savedZoom = configStore.get().browserZoom
  if (savedZoom != null) browserViewManager.setBrowserZoom(savedZoom)
  ipc.handle('browser:show', async () => {
    await browserViewManager.show()
    return { ok: true }
  })

  ipc.handle('browser:hide', () => {
    browserViewManager.hide()
    return { ok: true }
  })

  ipc.handle('browser:resize', (_e, widthPct: number) => {
    browserViewManager.setWidthPct(widthPct)
    return { ok: true }
  })

  // 文档 15.3：前端浮层（操作历史侧栏、JS 执行面板）变化时通知后端预留空间
  // 避免原生 WebContentsView 盖住前端元素导致手动操作失效
  ipc.handle('browser:setLayout', (_e, opts: { top?: number; bottom?: number; left?: number; right?: number }) => {
    browserViewManager.setLayout(opts)
    return { ok: true }
  })

  // 全屏浮层遮挡：监控面板/设置面板打开时前端通知主进程抑制 view 显示
  ipc.handle('browser:setOverlay', (_e, open: boolean) => {
    browserViewManager.setOverlay(open === true)
    return { ok: true }
  })

  ipc.handle('browser:isVisible', () => {
    return { visible: browserViewManager.isVisible() }
  })

  ipc.handle('browser:getHistory', () => {
    return { history: browserViewManager.getHistory() }
  })

  ipc.handle('browser:navigate', async (_e, url: string) => {
    try {
      // navigate 内部 view 未创建时会 throw——先 show()（懒创建 view）再导航
      if (!browserViewManager.isVisible()) {
        await browserViewManager.show()
      }
      const r = await browserViewManager.navigate(url)
      return { ok: true, data: r }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipc.handle('browser:click', async (_e, selector: string) => {
    try {
      await browserViewManager.click(selector)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipc.handle('browser:type', async (_e, selector: string, text: string, clear?: boolean) => {
    try {
      await browserViewManager.type(selector, text, clear)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipc.handle('browser:scroll', async (_e, direction: 'up' | 'down', amount?: number) => {
    try {
      await browserViewManager.scroll(direction, amount)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipc.handle('browser:snapshot', async () => {
    try {
      const text = await browserViewManager.snapshot()
      return { ok: true, data: { snapshot: text } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipc.handle('browser:screenshot', async (_e, fullPage?: boolean) => {
    try {
      const path = await browserViewManager.screenshot(fullPage)
      const buf = await readFile(path)
      const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
      return { ok: true, data: { path, dataUrl, size: buf.length } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipc.handle('browser:evaluate', async (_e, script: string) => {
    try {
      const result = await browserViewManager.evaluate(script)
      return { ok: true, data: { result: result ?? null } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
// ===== 本地浏览器桥（浏览器登录态持久化 storageState） =====
  // 模式 A：CDP 连接用户调试模式浏览器（--remote-debugging-port）
  ipc.handle('browser:cdp-status', async (_e, port?: number) => {
    return await browserManager.checkCdp(port ?? 9222)
  })
  ipc.handle('browser:cdp-connect', async (_e, port?: number) => {
    return await browserManager.connectOverCDP(port ?? 9222)
  })
  // 一键接管默认浏览器：检测默认浏览器 → 调试端口启动（独立 profile）→ CDP 接管
  ipc.handle('browser:cdp-launch', async (_e, port?: number) => {
    try {
      const p = port ?? 9222
      const profileDir = join(app.getPath('userData'), 'browser-profiles', 'cdp')
      return await browserManager.launchUserBrowser(p, profileDir)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  // 模式 B：保存/清除持久化登录态（storageState）
  ipc.handle('browser:save-login-state', async () => {
    return await browserManager.saveStorageState()
  })
  ipc.handle('browser:clear-login-state', async () => {
    browserManager.clearStorageState()
    return { ok: true }
  })
  ipc.handle('browser:cdp-mode', async () => {
    return { cdpMode: browserManager.isCdpMode() }
  })
  // 后退/前进（用户像真浏览器一样直接操作）
  ipc.handle('browser:back', async () => {
    try {
      return { ok: true, data: await browserViewManager.back() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  ipc.handle('browser:forward', async () => {
    try {
      return { ok: true, data: await browserViewManager.forward() }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  // 刷新当前页（webContents.reload，比 navigate 同 URL 更符合浏览器语义）
  ipc.handle('browser:reload', async () => {
    try {
      browserViewManager.reload()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
// 停止加载
  ipc.handle('browser:stop', async () => {
    try {
      browserViewManager.stop()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ===== 浏览器网页缩放（自动/手动，持久化到 config.browserZoom） =====
  ipc.handle('browser:zoomGet', () => browserViewManager.getBrowserZoomState())

  // 手动设置缩放（value=null 恢复自动），写回 config.browserZoom
  ipc.handle('browser:zoomSet', (_e, value: unknown) => {
    const manual = typeof value === 'number' && Number.isFinite(value) ? value : null
    browserViewManager.setBrowserZoom(manual)
    const cfg = configStore.get()
    cfg.browserZoom = manual
    configStore.save(cfg)
    return browserViewManager.getBrowserZoomState()
  })

  // 步进缩放（delta = ±0.1），同步持久化
  ipc.handle('browser:zoomStep', (_e, delta: unknown) => {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      return browserViewManager.getBrowserZoomState()
    }
    browserViewManager.stepBrowserZoom(delta)
    const cfg = configStore.get()
    cfg.browserZoom = browserViewManager.getBrowserZoomState().manual
    configStore.save(cfg)
    return browserViewManager.getBrowserZoomState()
  })

  // 重置为自动缩放（移除 browserZoom 覆盖）
  ipc.handle('browser:zoomReset', () => {
    browserViewManager.setBrowserZoom(null)
    const cfg = configStore.get()
    cfg.browserZoom = null
    configStore.save(cfg)
    return browserViewManager.getBrowserZoomState()
  })
}
