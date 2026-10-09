/**
 * @category 核心
 * @summary UI 缩放：分辨率自动适配（人眼最佳）+ 手动缩放（控件/快捷键/持久化）

 * 设计：
 * - 自动模式：以「主窗口所在显示器工作区的逻辑高度 / 1080」为缩放基准（1080p 为 1.0），
 * 逻辑高度越大（2K/4K 屏）UI 越小，需要放大到人眼舒适尺寸；clamp 到 [0.9, 1.6] 防极端。
 * display-metrics-changed（显示器插拔/DPI 变化）时自动重算。
 * - 手动模式：config.uiZoom 为 number 时覆盖自动值，通过控件/Ctrl 快捷键 +/-/0 调整（步进 0.1），
 * 写回 config.json 持久化；重置（Ctrl+0 / 重置按钮）恢复自动。
 * - 快捷键监听挂在主窗口 webContents 的 before-input-event：只作用于应用 UI，
 * 不影响内置浏览器视图（独立 WebContentsView）内部页面的自带缩放。
 */
import { BrowserWindow, screen, ipcMain } from 'electron'
import type { ConfigStore } from './api/config-store'

const MIN_ZOOM = 0.7
const MAX_ZOOM = 2.0
const ZOOM_STEP = 0.1

let win: BrowserWindow | null = null
/** 手动覆盖值（null = 自动模式） */
let manual: number | null = null
/** 全局级监听（screen / configStore）只绑定一次，窗口重建时复用 */
let globalListenersBound = false

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 归一化手动缩放值：非法输入/出界一律 clamp 到 [MIN_ZOOM, MAX_ZOOM]（null = 自动） */
function clampZoom(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v)
    ? round2(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v)))
    : null
}

/** 当前生效的缩放值（手动优先，否则自动） */
function effectiveZoom(): number {
  return manual ?? computeAutoZoom()
}

/** 人眼最佳自动缩放：以 1080p 逻辑工作区高度为 1.0，大屏线性放大，clamp 防极端。
 * 可传入指定窗口（浏览器视图等复用同一公式）；缺省用 ui-zoom 绑定窗口 */
export function computeAutoZoom(targetWin?: BrowserWindow): number {
  const w = targetWin ?? win
  // 窗口销毁期间（关闭/重建）显示器事件可能触发，防御返回 1
  if (!w || w.isDestroyed()) return 1
  const display = screen.getDisplayMatching(w.getBounds())
  const h = display.workArea.height || 1080
  return round2(Math.min(1.6, Math.max(0.9, h / 1080)))
}

function apply(): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  const zoom = effectiveZoom()
  try {
    win.webContents.setZoomFactor(zoom)
    // 推送当前状态：前端标题栏缩放控件显示百分比/自适应
    win.webContents.send('ui:zoomChanged', {
      mode: manual != null ? 'manual' : 'auto',
      zoom
    })
  } catch { /* 窗口正在销毁等瞬时异常忽略 */ }
}

/** 手动设置缩放（null = 恢复自动），写回 config 持久化 */
function setZoom(value: number | null): void {
  manual = clampZoom(value)
  if (win && !win.isDestroyed()) {
    apply()
  }
}

function stepZoom(delta: number): void {
  const base = effectiveZoom()
  setZoom(round2(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, base + delta))))
}

/** 显示器变化（DPI/分辨率/插拔）：自动模式跟随，手动模式不受影响 */
function onDisplayMetricsChanged(): void {
  if (manual == null && win && !win.isDestroyed()) apply()
}

/**
 * 初始化（主窗口创建后调用）：注册 IPC、快捷键、显示器变化监听、config 跟随。
 * 幂等：窗口重建（macOS activate 等）后可重复调用，IPC 会先移除再注册，
 * 全局级监听（screen / configStore）仅首次绑定。
 */
export function initUiZoom(mainWin: BrowserWindow, configStore: ConfigStore): void {
  win = mainWin

  // 读取持久化的手动值（undefined/null 均为自动）
  const saved = configStore.get().uiZoom
  manual = clampZoom(saved)
  apply()

  // Ctrl+= / Ctrl+- / Ctrl+0（含主键盘区与数字键盘），仅作用于主窗口 UI
  // （挂在新的 webContents 实例上，重建后自动跟随新窗口）
  mainWin.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return
    const key = input.key.toLowerCase()
    if (key === '=' || key === '+') {
      stepZoom(ZOOM_STEP)
      event.preventDefault()
    } else if (key === '-' || key === '_') {
      stepZoom(-ZOOM_STEP)
      event.preventDefault()
    } else if (key === '0') {
      setZoom(null)
      event.preventDefault()
    }
  })

  // 窗口移动到另一显示器（无 metrics 变化时 display-metrics-changed 不触发）：
  // 自动模式按新显示器工作区高度重算；手动模式不受影响
  let lastDisplayId = screen.getDisplayMatching(mainWin.getBounds()).id
  mainWin.on('moved', () => {
    if (manual != null || mainWin.isDestroyed()) return
    const id = screen.getDisplayMatching(mainWin.getBounds()).id
    if (id !== lastDisplayId) {
      lastDisplayId = id
      apply()
    }
  })

  if (!globalListenersBound) {
    globalListenersBound = true
    screen.on('display-metrics-changed', onDisplayMetricsChanged)

    // config 变化：uiZoom 被外部（如设置面板整体保存）修改时跟随
    configStore.subscribe((next) => {
      const nextManual = clampZoom(next.uiZoom)
      if (nextManual !== manual) {
        manual = nextManual
        apply()
      }
    })
  }

  // ===== IPC（幂等注册：重建时先移除旧 handler 再注册） =====
  ipcMain.removeHandler('ui:zoomGet')
  ipcMain.removeHandler('ui:zoomSet')
  ipcMain.removeHandler('ui:zoomStep')
  ipcMain.removeHandler('ui:zoomReset')

  ipcMain.handle('ui:zoomGet', () => ({
    mode: manual != null ? 'manual' : 'auto',
    zoom: effectiveZoom(),
    manual: manual
  }))

  // 手动设置缩放（value=null 恢复自动），持久化到 config
  ipcMain.handle('ui:zoomSet', (_e, value: unknown) => {
    const v = clampZoom(value)
    setZoom(v)
    // 写回 config.json（手动 null = 移除覆盖，回到自动）
    const cfg = configStore.get()
    cfg.uiZoom = manual
    configStore.save(cfg)
    return { mode: manual != null ? 'manual' : 'auto', zoom: effectiveZoom() }
  })

  // 步进缩放（delta = ±0.1），同步持久化
  ipcMain.handle('ui:zoomStep', (_e, delta: unknown) => {
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      return { mode: manual != null ? 'manual' : 'auto', zoom: effectiveZoom() }
    }
    stepZoom(delta)
    const cfg = configStore.get()
    cfg.uiZoom = manual
    configStore.save(cfg)
    return { mode: manual != null ? 'manual' : 'auto', zoom: effectiveZoom() }
  })

  // 重置为自动缩放，持久化（移除 uiZoom 覆盖）
  ipcMain.handle('ui:zoomReset', () => {
    setZoom(null)
    const cfg = configStore.get()
    cfg.uiZoom = null
    configStore.save(cfg)
    return { mode: 'auto', zoom: computeAutoZoom() }
  })
}