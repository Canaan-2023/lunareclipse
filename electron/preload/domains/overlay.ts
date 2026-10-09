/**
 * 聊天悬浮小窗 preload 域（独立置顶 BrowserWindow）。
 * 为什么存在：小窗由主进程创建为独立窗口，主窗与小窗的状态同步、消息转发都走 IPC，渲染
 * 进程不能跨窗口直接通信。
 * 作用：暴露 overlay:open/close/toggle/is-open、overlay:send 等命令及 overlayOnState 状态订阅。
 */
import { ipcRenderer } from 'electron'

export const api = {
  // ===== 聊天悬浮小窗（独立置顶 BrowserWindow） =====
  /** 打开（或聚焦）悬浮小窗 */
  overlayOpen: () => ipcRenderer.invoke('overlay:open') as Promise<{ ok: boolean }>,
  /** 关闭悬浮小窗 */
  overlayClose: () => ipcRenderer.invoke('overlay:close') as Promise<{ ok: boolean }>,
  /** 切换悬浮小窗开关 */
  overlayToggle: () => ipcRenderer.invoke('overlay:toggle') as Promise<{ ok: boolean; open: boolean }>,
  /** 查询悬浮小窗是否已打开 */
  overlayIsOpen: () => ipcRenderer.invoke('overlay:is-open') as Promise<{ ok: boolean; open: boolean }>,
  /** 小窗订阅主窗口推送的会话状态 */
  overlayOnState: (callback: (state: {
    messages: unknown[]
    status: string
    streamingMessageId: string | null
    aiName: string
    theme: string
    webSearchEnabled: boolean
    pendingAttachments: Array<{ name: string; type: string; size: number }>
  }) => void) => {
    const handler = (_e: unknown, state: unknown) => callback(state as Parameters<typeof callback>[0])
    ipcRenderer.on('overlay:state', handler)
    return () => void ipcRenderer.removeListener('overlay:state', handler)
  },
  /** 小窗向主窗口请求发送消息 */
  overlaySend: (text: string) =>
    ipcRenderer.invoke('overlay:send', text) as Promise<{ ok: boolean }>,
  /** 小窗向主窗口请求停止流式输出 */
  overlayAbort: () =>
    ipcRenderer.invoke('overlay:abort') as Promise<{ ok: boolean }>,
  /** 主窗口推送会话状态（主进程转发给小窗） */
  overlayPushState: (state: {
    messages: unknown[]
    status: string
    streamingMessageId: string | null
    aiName: string
    theme: string
    webSearchEnabled: boolean
    pendingAttachments: Array<{ name: string; type: string; size: number }>
  }) =>
    ipcRenderer.invoke('overlay:push-state', state) as Promise<{ ok: boolean }>,
  /** 主窗口订阅小窗的发送消息请求 */
  onOverlaySendRequest: (callback: (text: string) => void) => {
    const handler = (_e: unknown, text: string) => callback(text)
    ipcRenderer.on('overlay:send-request', handler)
    return () => void ipcRenderer.removeListener('overlay:send-request', handler)
  },
  /** 主窗口订阅小窗的停止流请求 */
  onOverlayAbortRequest: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('overlay:abort-request', handler)
    return () => void ipcRenderer.removeListener('overlay:abort-request', handler)
  },
  /** 主窗口订阅小窗关闭事件 */
  onOverlayClosed: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('overlay:closed', handler)
    return () => void ipcRenderer.removeListener('overlay:closed', handler)
  },
  /** 小窗加载完成后请求主窗口推送一次当前状态 */
  overlayRequestState: () =>
    ipcRenderer.invoke('overlay:request-state') as Promise<{ ok: boolean }>,
  /** 主窗口订阅小窗的初始状态请求 */
  onOverlayStateRequested: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('overlay:state-requested', handler)
    return () => void ipcRenderer.removeListener('overlay:state-requested', handler)
  },
  /** 小窗添加附件（文件已在小窗侧读成 dataUrl） */
  overlayAddAttachment: (att: {
    name: string
    path: string
    size: number
    type: string
    dataUrl?: string
  }) =>
    ipcRenderer.invoke('overlay:add-attachment', att) as Promise<{ ok: boolean }>,
  /** 小窗移除待发附件 */
  overlayRemoveAttachment: (index: number) =>
    ipcRenderer.invoke('overlay:remove-attachment', index) as Promise<{ ok: boolean }>,
  /** 小窗切换联网搜索开关 */
  overlayToggleWebSearch: () =>
    ipcRenderer.invoke('overlay:toggle-websearch') as Promise<{ ok: boolean }>,
  /** 主窗口订阅小窗的添加附件请求 */
  onOverlayAddAttachmentRequest: (callback: (att: {
    name: string
    path: string
    size: number
    type: string
    dataUrl?: string
  }) => void) => {
    const handler = (_e: unknown, att: unknown) => callback(att as Parameters<typeof callback>[0])
    ipcRenderer.on('overlay:add-attachment-request', handler)
    return () => void ipcRenderer.removeListener('overlay:add-attachment-request', handler)
  },
  /** 主窗口订阅小窗的移除附件请求 */
  onOverlayRemoveAttachmentRequest: (callback: (index: number) => void) => {
    const handler = (_e: unknown, index: number) => callback(index)
    ipcRenderer.on('overlay:remove-attachment-request', handler)
    return () => void ipcRenderer.removeListener('overlay:remove-attachment-request', handler)
  },
  /** 主窗口订阅小窗的切换联网搜索请求 */
  onOverlayToggleWebSearchRequest: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('overlay:toggle-websearch-request', handler)
    return () => void ipcRenderer.removeListener('overlay:toggle-websearch-request', handler)
  },
}