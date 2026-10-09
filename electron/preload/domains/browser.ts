/**
 * 浏览器面板与本地浏览器桥（CDP）preload 域。
 * 为什么存在：浏览器视图（WebContentsView）由主进程创建并管理显隐、导航，AI 元搜索还需
 * 经 CDP 接管本地已登录浏览器；渲染进程只能通过 IPC 下发这些主进程侧操作。
 * 作用：暴露 browser:show/hide/resize 面板控制、CDP 检测/连接/接管/登录态持久化与历史/导航方法。
 */
import { ipcRenderer } from 'electron'
import type { BrowserEvent, BrowserHistoryEntry } from '../../main/tools/browser-view-manager'

export const api = {
  // ===== 浏览器面板（WebContentsView 嵌入主窗口） =====
  browserShow: () => ipcRenderer.invoke('browser:show') as Promise<{ ok: boolean; error?: string }>,
  browserHide: () => ipcRenderer.invoke('browser:hide') as Promise<{ ok: boolean }>,
  browserResize: (widthPct: number) => ipcRenderer.invoke('browser:resize', widthPct) as Promise<{ ok: boolean }>,
  // ===== 本地浏览器桥（AI 元搜索登录态） =====
  /** 检测本地调试端口是否有浏览器（CDP 可用性） */
  browserCdpStatus: (port?: number) =>
    ipcRenderer.invoke('browser:cdp-status', port) as Promise<{ available: boolean; pageCount?: number }>,
  /** 连接本地调试模式浏览器（复用其已登录会话） */
  browserCdpConnect: (port?: number) =>
    ipcRenderer.invoke('browser:cdp-connect', port) as Promise<{ ok: boolean; error?: string; pageCount?: number }>,
  /** 一键接管默认浏览器：检测默认浏览器 → 调试端口启动（独立 profile）→ CDP 接管 */
  browserCdpLaunch: (port?: number) =>
    ipcRenderer.invoke('browser:cdp-launch', port) as Promise<{ ok: boolean; error?: string; launched?: boolean; browserName?: string }>,
  /** 保存当前浏览器登录态（持久化 profile 复用） */
  browserSaveLoginState: () =>
    ipcRenderer.invoke('browser:save-login-state') as Promise<{ ok: boolean; error?: string }>,
  /** 清除持久化登录态 */
  browserClearLoginState: () =>
    ipcRenderer.invoke('browser:clear-login-state') as Promise<{ ok: boolean }>,
  /** 查询当前是否处于 CDP 连接模式 */
  browserCdpMode: () =>
    ipcRenderer.invoke('browser:cdp-mode') as Promise<{ cdpMode: boolean }>,
  /** 通知主进程浏览器视图需预留的顶部/底部/左侧/右侧高度（前端浮层变化时调用） */
  browserSetLayout: (opts: { top?: number; bottom?: number; left?: number; right?: number }) =>
    ipcRenderer.invoke('browser:setLayout', opts) as Promise<{ ok: boolean }>,
  /** 全屏浮层遮挡：监控面板/设置面板打开时置 true，抑制浏览器 view 显示（OS 层 view 盖不住 DOM 浮层） */
  browserSetOverlay: (open: boolean) => ipcRenderer.invoke('browser:setOverlay', open) as Promise<{ ok: boolean }>,
  browserIsVisible: () => ipcRenderer.invoke('browser:isVisible') as Promise<{ visible: boolean }>,
  browserGetHistory: () => ipcRenderer.invoke('browser:getHistory') as Promise<{ history: BrowserHistoryEntry[] }>,
  browserNavigate: (url: string) =>
    ipcRenderer.invoke('browser:navigate', url) as Promise<{ ok: boolean; data?: { title: string; url: string }; error?: string }>,
  /** 后退（像真浏览器一样直接操作） */
  browserBack: () =>
    ipcRenderer.invoke('browser:back') as Promise<{ ok: boolean; data?: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }; error?: string }>,
  /** 前进（像真浏览器一样直接操作） */
  browserForward: () =>
    ipcRenderer.invoke('browser:forward') as Promise<{ ok: boolean; data?: { url: string; title: string; canGoBack: boolean; canGoForward: boolean }; error?: string }>,
  /** 刷新当前页 */
  browserReload: () =>
    ipcRenderer.invoke('browser:reload') as Promise<{ ok: boolean; error?: string }>,
  /** 停止加载 */
  browserStop: () =>
    ipcRenderer.invoke('browser:stop') as Promise<{ ok: boolean; error?: string }>,
  browserClick: (selector: string) =>
    ipcRenderer.invoke('browser:click', selector) as Promise<{ ok: boolean; error?: string }>,
  browserType: (selector: string, text: string, clear?: boolean) =>
    ipcRenderer.invoke('browser:type', selector, text, clear) as Promise<{ ok: boolean; error?: string }>,
  browserScroll: (direction: 'up' | 'down', amount?: number) =>
    ipcRenderer.invoke('browser:scroll', direction, amount) as Promise<{ ok: boolean; error?: string }>,
  browserSnapshot: () =>
    ipcRenderer.invoke('browser:snapshot') as Promise<{ ok: boolean; data?: { snapshot: string }; error?: string }>,
  browserScreenshot: (fullPage?: boolean) =>
    ipcRenderer.invoke('browser:screenshot', fullPage) as Promise<{ ok: boolean; data?: { path: string; dataUrl: string; size: number }; error?: string }>,
  browserEvaluate: (script: string) =>
    ipcRenderer.invoke('browser:evaluate', script) as Promise<{ ok: boolean; data?: { result: unknown }; error?: string }>,
  /** 浏览器事件流：state 变化、操作历史、动作开始/结束 */
  onBrowserEvent: (callback: (event: BrowserEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: BrowserEvent) => callback(payload)
    ipcRenderer.on('browser:event', listener)
    return () => void ipcRenderer.removeListener('browser:event', listener)
  },
  /** 获取浏览器网页缩放状态：mode=auto/manual, zoom=生效值, manual=手动覆盖值(null=自动) */
  browserZoomGet: () =>
    ipcRenderer.invoke('browser:zoomGet') as Promise<{ mode: 'auto' | 'manual'; zoom: number; manual: number | null }>,
  /** 手动设置浏览器网页缩放（null 恢复自动），持久化 */
  browserZoomSet: (value: number | null) =>
    ipcRenderer.invoke('browser:zoomSet', value) as Promise<{ mode: 'auto' | 'manual'; zoom: number; manual: number | null }>,
  /** 步进浏览器网页缩放（delta=±0.1），持久化 */
  browserZoomStep: (delta: number) =>
    ipcRenderer.invoke('browser:zoomStep', delta) as Promise<{ mode: 'auto' | 'manual'; zoom: number; manual: number | null }>,
  /** 重置浏览器网页缩放为自动 */
  browserZoomReset: () =>
    ipcRenderer.invoke('browser:zoomReset') as Promise<{ mode: 'auto'; zoom: number; manual: number | null }>,
  /** 浏览器网页缩放变化推送（控件百分比实时刷新） */
  onBrowserZoomChange: (callback: (state: { mode: 'auto' | 'manual'; zoom: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: { mode: 'auto' | 'manual'; zoom: number }) => callback(state)
    ipcRenderer.on('browser:zoomChanged', listener)
    return () => void ipcRenderer.removeListener('browser:zoomChanged', listener)
  },
}