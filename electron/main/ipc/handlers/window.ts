/**
 * 窗口控制 IPC：最小化/最大化/关闭/检查最大化等窗口操作通道；
 * 单向事件用 ipc.on 且显式 try/catch 记录错误，避免 uncaughtException。
 */
import { ipcMain, BrowserWindow } from 'electron'
import { logError } from '../../services/crash-logger'
import { safeHandle } from './safe-handle'

export function registerWindowHandlers(
  ipc: typeof ipcMain,
  mainWindow: BrowserWindow | null
): void {
  // ipc.on 是单向通信（前端 fire-and-forget），错误不会 reject 给前端，
  // 必须手动 try/catch 并记录，否则变 uncaughtException（虽被全局兜底但无上下文日志）
  ipc.on('window:minimize', () => {
    try {
      mainWindow?.minimize()
    } catch (err) {
      logError('ipc:window:minimize', err)
    }
  })
  ipc.on('window:maximize', () => {
    try {
      if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow?.maximize()
      }
    } catch (err) {
      logError('ipc:window:maximize', err)
    }
  })
  ipc.on('window:close', () => {
    try {
      mainWindow?.close()
    } catch (err) {
      logError('ipc:window:close', err)
    }
  })

  safeHandle<boolean>(
    ipc, 'window:isMaximized',
    () => mainWindow?.isMaximized() ?? false,
    false
  )
}
