/**
 * 系统壳层 preload 域（文件/工作区/权限）。
 * 为什么存在：打开文件与外部链接、读取文件内容、粘贴图片落盘、工作区上下文上报及权限
 * 请求弹窗都需要主进程系统能力与用户授权流程。
 * 作用：暴露 openFile/openExternal/fileRead/saveClipboardImage、工作区状态上报与
 * onPermissionRequest 权限回调订阅。
 */
import { ipcRenderer } from 'electron'

export const api = {
  openFile: (path: string) =>
    ipcRenderer.invoke('shell:openFile', path) as Promise<boolean>,
  /** 用系统默认浏览器打开外部链接（仅 http/https，LAN 内容中的 URL 走此通道） */
  openExternal: (url: string) =>
    ipcRenderer.invoke('shell:openExternal', url) as Promise<boolean>,
  /** 文本写入系统剪贴板（file:// 下 navigator.clipboard 不可用，走主进程桥） */
  clipboardWriteText: (text: string) =>
    ipcRenderer.invoke('shell:clipboardWriteText', text) as Promise<boolean>,
  /** 读取文件内容（应用内预览用，只读，返回文本内容+行数） */
  fileRead: (path: string) =>
    ipcRenderer.invoke('file:read', path) as Promise<{ ok: boolean; content?: string; totalLines?: number; error?: string }>,
  /** 粘贴图片落盘：接收 data URL → 写临时文件 → 返回磁盘 path（发送时主进程按 path 读内容） */
  saveClipboardImage: (dataUrl: string) =>
    ipcRenderer.invoke('attachment:saveClipboardImage', dataUrl) as Promise<{ ok: boolean; path?: string; error?: string }>,
  /** 通知主进程当前文件预览状态（供 AI 工作区上下文注入） */
  workspaceSetPreviewFile: (path: string | null) =>
    ipcRenderer.invoke('workspace:setPreviewFile', path) as Promise<{ ok: boolean }>,
  /** 通知主进程当前文件工坊代码执行结果（供 AI 工作区上下文注入） */
  workspaceSetSandboxState: (state: {
    language: string
    code: string
    ok: boolean
    durationMs: number
    timedOut: boolean
    outputSummary: string
  } | null) =>
    ipcRenderer.invoke('workspace:setSandboxState', state) as Promise<{ ok: boolean }>,
  // 权限请求：主进程推送权限请求到渲染进程，渲染进程弹窗用户确认后回传
  onPermissionRequest: (callback: (req: {
    id: string
    type: 'command' | 'setting' | 'clipboard_read' | 'device'
    description: string
    content: string
    risk: 'low' | 'medium' | 'high'
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: {
      id: string
      type: 'command' | 'setting' | 'clipboard_read' | 'device'
      description: string
      content: string
      risk: 'low' | 'medium' | 'high'
    }) => callback(payload)
    ipcRenderer.on('permission:request', listener)
    return () => void ipcRenderer.removeListener('permission:request', listener)
  },
  permissionRespond: (id: string, allowed: boolean, scope?: 'once' | 'session', reason?: string) =>
    ipcRenderer.send('permission:respond', { id, allowed, scope, reason }),
  /** 在系统文件管理器中显示文件（跳转实际路径） */
  showItemInFolder: (path: string) =>
    ipcRenderer.invoke('shell:showItemInFolder', path) as Promise<boolean>,
}