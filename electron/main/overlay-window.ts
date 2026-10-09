/**
 * @category 核心
 * @summary 聊天悬浮小窗：独立置顶 BrowserWindow，可拖到桌面任意位置

 * 背景：浏览器面板是原生 WebContentsView，会盖住一切 React DOM，且 DOM 无法穿出主窗口。
 * 因此小卡片直接做成独立 BrowserWindow。

 * 置顶策略（一劳永逸、零轮询）：
 * - 构造即 alwaysOnTop，ready-to-show 后用最高档 'screen-saver' 再设一次并 showInactive
 * （不抢焦点，也绝不 focus 主窗口——那会让 Windows 把主窗口抬起把小窗压底）
 * - 主窗口 'focus' 事件里 moveTop() 兜底同进程 z-order 抖动（纯事件驱动，无定时器）

 * 数据桥接：
 * - 主窗口 → 小窗：overlay:state（messages/status/streamingMessageId/aiName/theme/附件/联网开关）
 * - 小窗 → 主窗口：overlay:send-request / abort-request / add-attachment / remove-attachment / toggle-websearch
 */
import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { resolveWindowIcon } from './app-icon'

let overlayWin: BrowserWindow | null = null
/** 主窗口引用（由 index.ts 注入，用于转发 IPC） */
let mainWin: BrowserWindow | null = null
/** 主窗口 focus 兜底处理器引用，便于去重注册 */
let mainFocusHandler: (() => void) | null = null

function getPreloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js')
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('preload script not found in candidates: ' + candidates.join(', '))
  return found
}

/** 注入主窗口引用（主窗口创建后调用一次；崩溃重建后需再调一次） */
export function setOverlayMainWindow(win: BrowserWindow): void {
  // 先从旧窗口摘除监听，再绑到新窗口
  if (mainFocusHandler && mainWin && !mainWin.isDestroyed()) {
    mainWin.removeListener('focus', mainFocusHandler)
  }
  mainWin = win
  // 主窗口被激活时，把置顶小窗重新压到最前（事件驱动兜底，无定时器、无轮询）
  mainFocusHandler = () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setAlwaysOnTop(true, 'screen-saver')
      overlayWin.moveTop()
    }
  }
  win.on('focus', mainFocusHandler)
}

/** 当前是否已打开 */
export function isOverlayOpen(): boolean {
  return overlayWin !== null && !overlayWin.isDestroyed()
}

/** 打开（或浮现）悬浮小窗 */
export function openOverlayWindow(): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setAlwaysOnTop(true, 'screen-saver')
    overlayWin.showInactive()
    overlayWin.moveTop()
    return overlayWin
  }

  // 默认放在主窗口右下角内侧；取不到主窗口位置时退到当前屏幕右下角
  const width = 380
  const height = 540
  let x: number
  let y: number
  if (mainWin && !mainWin.isDestroyed()) {
    const bounds = mainWin.getBounds()
    x = bounds.x + bounds.width - width - 24
    y = bounds.y + bounds.height - height - 40
  } else {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const { workArea } = display
    x = workArea.x + workArea.width - width - 24
    y = workArea.y + workArea.height - height - 24
  }

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: 300,
    minHeight: 340,
    show: false,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    icon: resolveWindowIcon(),
    backgroundColor: '#0D0F18',
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => {
    // show 后再设一次最高档置顶，规避首窗 HWND 标志未生效的时序问题；
    // showInactive 不抢焦点，浏览器里的输入不中断；绝不 focus 主窗口。
    win.setAlwaysOnTop(true, 'screen-saver')
    win.showInactive()
    win.moveTop()
  })

  win.on('closed', () => {
    overlayWin = null
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send('overlay:closed')
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    const base = new URL(process.env['ELECTRON_RENDERER_URL'])
    base.searchParams.set('overlay', '1')
    void win.loadURL(base.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { overlay: '1' }
    })
  }

  overlayWin = win
  return win
}

/** 关闭悬浮小窗 */
export function closeOverlayWindow(): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.close()
  }
}

/** 切换开关 */
export function toggleOverlayWindow(): void {
  if (isOverlayOpen()) {
    closeOverlayWindow()
  } else {
    openOverlayWindow()
  }
}

/** 主窗口 → overlay 推送状态 */
export function pushOverlayState(state: unknown): void {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send('overlay:state', state)
  }
}

/** 向主窗口转发事件的小工具 */
function sendToMain(channel: string, payload?: unknown): void {
  if (mainWin && !mainWin.isDestroyed()) {
    if (payload === undefined) {
      mainWin.webContents.send(channel)
    } else {
      mainWin.webContents.send(channel, payload)
    }
  }
}

/** 注册 IPC */
export function registerOverlayIpc(): void {
  ipcMain.handle('overlay:open', () => {
    openOverlayWindow()
    return { ok: true }
  })
  ipcMain.handle('overlay:close', () => {
    closeOverlayWindow()
    return { ok: true }
  })
  ipcMain.handle('overlay:toggle', () => {
    toggleOverlayWindow()
    return { ok: true, open: isOverlayOpen() }
  })
  ipcMain.handle('overlay:is-open', () => {
    return { ok: true, open: isOverlayOpen() }
  })
  // overlay → 主窗口：发送消息
  ipcMain.handle('overlay:send', (_e, text: string) => {
    sendToMain('overlay:send-request', text)
    return { ok: true }
  })
  // overlay → 主窗口：停止流
  ipcMain.handle('overlay:abort', () => {
    sendToMain('overlay:abort-request')
    return { ok: true }
  })
  // 主窗口 → 主进程：推送状态（转发给 overlay）
  ipcMain.handle('overlay:push-state', (_e, state: unknown) => {
    pushOverlayState(state)
    return { ok: true }
  })
  // overlay 加载完成后请求初始状态
  ipcMain.handle('overlay:request-state', () => {
    sendToMain('overlay:state-requested')
    return { ok: true }
  })
  // overlay → 主窗口：添加附件
  ipcMain.handle('overlay:add-attachment', (_e, att: unknown) => {
    sendToMain('overlay:add-attachment-request', att)
    return { ok: true }
  })
  // overlay → 主窗口：移除待发附件
  ipcMain.handle('overlay:remove-attachment', (_e, index: number) => {
    sendToMain('overlay:remove-attachment-request', index)
    return { ok: true }
  })
  // overlay → 主窗口：切换联网搜索
  ipcMain.handle('overlay:toggle-websearch', () => {
    sendToMain('overlay:toggle-websearch-request')
    return { ok: true }
  })
}
