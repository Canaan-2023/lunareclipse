/**
 * @category 核心
 * @summary ROOM 自主模式：**旧独立窗口分支**（灰度回滚用，默认不达）
 *
 * 为什么还在：ADR-29 把 ROOM 的承载面改为**会话页原位视图**（`RoomView`），独立窗口被驳回——
 * 用户诉求「不想单独弹出一个窗口」「一点击自主模式，直接会话界面就变成自主界面」。
 * 但 SRE 要求保留一个发布周期的**一键回滚**能力（无需发版），故本文件降级为
 * `config.room.viewMode === 'window'` 才可达的回滚分支：**代码保留、默认路径不达**，
 * 灰度稳定后由 B-F 物理删除。
 *
 * ⚠️ 回滚目标必须达标：本分支已含 P0-3 修复（`closed` / `render-process-gone` 均主进程兜底
 * 停循环并写回 `config.room.enabled=false`）——删掉它会让回滚带回幽灵循环。
 *
 * 不删理由（限时）：作为 `viewMode='window'` 的回滚目标存在；B-F 观察期零回滚后删除。
 */
import { BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { resolveWindowIcon } from './app-icon'
import type { ConfigStore } from './api/config-store'
import type { AppConfig } from '@shared/types'
import { DEFAULT_AI_ID } from '@shared/types'
import { ensureRoomRuntime, peekRoomRuntime, listRoomRuntimeAiIds } from './room/runtime'
import { getRoomLoopSupervisor } from './room/loop-supervisor'
import { reportRoomWake } from './room/wake'

let roomWin: BrowserWindow | null = null
/** 主窗口引用（用于转发 ROOM 事件；由组合根注入） */
let mainWin: BrowserWindow | null = null
/** 配置存储（registerRoomIpc 注入）：窗口事件里要写回 `config.room.enabled=false` */
let roomConfigStore: ConfigStore | null = null

/**
 * 主进程侧的「停循环 + 关开关」兜底（P0-3）。
 * 为什么必须在主进程做：渲染进程的 React 卸载清理在窗口销毁/崩溃时**不会执行**，
 * 只靠它就会留下幽灵循环（定时器仍在跑，配置却显示已关）。
 * 幂等：重复调用无副作用。
 */
function stopLoopAndPersistOff(): void {
  getRoomLoopSupervisor()?.stopAll()
  try {
    const cfg = roomConfigStore?.get()
    if (cfg && cfg.room?.enabled === true) {
      roomConfigStore?.save({ ...cfg, room: { ...(cfg.room ?? {}), enabled: false } } as AppConfig)
    }
  } catch {
    /* 写配置失败不阻断关闭流程（状态以运行时为准，见 loop-supervisor） */
  }
}

function getPreloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js')
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('preload script not found in candidates: ' + candidates.join(', '))
  return found
}

/**
 * ROOM 窗口要加载的 URL（纯函数，便于单测）：
 * dev 用 `ELECTRON_RENDERER_URL` 并附加 `room=1`；打包态由调用方用 `loadFile` 的 query 传入。
 */
export function buildRoomUrl(rendererUrl: string | undefined): { kind: 'url'; url: string } | { kind: 'file' } {
  if (rendererUrl) {
    const base = new URL(rendererUrl)
    base.searchParams.set('room', '1')
    return { kind: 'url', url: base.toString() }
  }
  return { kind: 'file' }
}

export function setRoomMainWindow(win: BrowserWindow): void {
  mainWin = win
}

/**
 * 承载面判定（**纯函数**，便于单测）：只有显式配置 `room.viewMode === 'window'` 才可达旧窗口分支；
 * 其余一切（含 undefined / 老配置）都判为 `inline`——「默认不达独立窗口」是硬约束（ADR-29 裁决①）。
 */
export function resolveRoomViewMode(config: unknown): 'inline' | 'window' {
  const c = config as { room?: { viewMode?: unknown } } | null | undefined
  return c?.room?.viewMode === 'window' ? 'window' : 'inline'
}

/**
 * 把主窗口推来的聊天状态也送给 ROOM 窗口。
 * 为什么复用悬浮窗那条桥：交接单 §7 要求「用户仍可与 AI 对话」，而 ROOM 与悬浮小窗
 * 同属「副窗口」——状态由主窗口（唯一持有会话 store 的渲染进程）推送。复用同一条桥
 * 避免为 ROOM 再造一套会话状态同步（B6 引入自主会话时再评估是否分叉）。
 */
export function sendOverlayStateToRoom(state: unknown): void {
  if (roomWin && !roomWin.isDestroyed()) roomWin.webContents.send('overlay:state', state)
}

export function isRoomOpen(): boolean {
  return roomWin !== null && !roomWin.isDestroyed()
}

/** 打开（或浮现）ROOM 窗口；已存在则聚焦返回。 */
export function openRoomWindow(): BrowserWindow {
  if (roomWin && !roomWin.isDestroyed()) {
    roomWin.show()
    roomWin.focus()
    return roomWin
  }

  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    show: false,
    frame: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    alwaysOnTop: false,
    backgroundColor: '#0B0D14',
    icon: resolveWindowIcon(),
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    roomWin = null
    // 主进程侧兜底：窗口没了 → 循环必须停、开关必须关（不依赖渲染进程 cleanup，见 stopLoopAndPersistOff）
    stopLoopAndPersistOff()
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('room:closed')
  })
  // 渲染进程崩溃（未走 closed）：同样兜底，否则定时器会随崩溃静默存活
  win.webContents.on('render-process-gone', () => {
    roomWin = null
    stopLoopAndPersistOff()
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('room:closed')
  })
  // 外链走系统浏览器（与主窗口同一安全取向：不在应用内开新窗口）
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const target = buildRoomUrl(process.env['ELECTRON_RENDERER_URL'])
  if (target.kind === 'url') {
    void win.loadURL(target.url)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { room: '1' } })
  }

  roomWin = win
  return win
}

/** 关闭 ROOM 窗口（幂等）。 */
export function closeRoomWindow(): void {
  if (roomWin && !roomWin.isDestroyed()) roomWin.close()
  roomWin = null
}

/** 开关切换；返回切换后的状态。 */
export function toggleRoomWindow(): boolean {
  if (isRoomOpen()) {
    closeRoomWindow()
    return false
  }
  openRoomWindow()
  return true
}

/**
 * 注册 ROOM IPC：**运行面**（状态 / 手动一轮 / 启停，原位视图在用）+ **旧窗口面**（灰度回滚）。
 * 窗口面（`room:open` / `room:toggle`）仅在 `config.room.viewMode === 'window'` 时可达——默认
 * `inline` 下直接拒绝，保证「默认不达独立窗口」；`room:close` 幂等，任何时候都安全。
 */
export function registerRoomIpc(configStore: ConfigStore): void {
  roomConfigStore = configStore
  const persist = (enabled: boolean): void => {
    const cfg = configStore.get()
    configStore.save({ ...cfg, room: { ...(cfg.room ?? {}), enabled } } as AppConfig)
  }
  /** 承载面（ADR-29 裁决①）：默认 inline —— 窗口分支只在显式配置为 window 时可达。 */
  const viewMode = (): 'inline' | 'window' => resolveRoomViewMode(configStore.get())
  const windowGone = (): { ok: false; open: boolean; error: string } => ({
    ok: false,
    open: false,
    error: '独立窗口已下线（ROOM 现为会话页原位视图）。确需回滚请把 config.room.viewMode 设为 "window"。'
  })

  ipcMain.handle('room:open', () => {
    if (viewMode() !== 'window') return windowGone()
    openRoomWindow()
    persist(true)
    return { ok: true, open: true }
  })
  ipcMain.handle('room:close', () => {
    // 关闭总是安全（幂等）：停循环 + 关窗 + 写回意图（不依赖渲染进程 cleanup，见 stopLoopAndPersistOff）
    getRoomLoopSupervisor()?.stopAll()
    closeRoomWindow()
    persist(false)
    return { ok: true, open: false }
  })
  ipcMain.handle('room:toggle', () => {
    if (viewMode() !== 'window') return windowGone()
    const open = toggleRoomWindow()
    persist(open)
    if (!open) getRoomLoopSupervisor()?.stopAll()
    return { ok: true, open }
  })
  ipcMain.handle('room:is-open', () => ({ ok: true, open: isRoomOpen() }))

  // ===== 自主循环运行时（B8 接线 / ADR-25 L3 每 AI 一实例）：状态 / 手动一轮 / 启停 =====
  // 所有通道都带 `aiId`（缺省月蚀）——ROOM 侧选「哪个 AI 的房间」，各自独立实例与会话。
  // **生命周期 owner = 主进程 `RoomLoopSupervisor`**（P0-3）：渲染进程只表达「要 / 不要」，
  // 不再自己持有定时器；acquire/release 引用计数，避免同一 AI 多消费者互相误停。
  const scopeOf = (aiId: unknown): number =>
    typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID
  const unavailable = (aiId: number): { ok: false; error: string } => ({
    ok: false,
    error: `自主运行时不可用（AI${aiId}）：未登录 / 该 AI 已下线 / 未装配`
  })
  ipcMain.handle('room:runtime-state', (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    // **无副作用读取**（P2-8）：原位视图每 3s 轮询本通道，绝不能用 `ensureRoomRuntime`（会持续创建实例）
    const rt = peekRoomRuntime(id)
    return rt ? { ok: true, state: { ...rt.getState(), aiId: id } } : { ok: true, state: { running: false, phase: 'stopped', events: [], aiId: id } }
  })
  // 房间状态（B-D1）：**状态以运行时为准**——`armed` 只是用户意图，`running`/`phase` 才是真值
  ipcMain.handle('room:status', (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    const rt = peekRoomRuntime(id)
    return {
      ok: true,
      status: {
        armed: configStore.get().room?.enabled === true,
        running: rt?.isRunning() ?? false,
        phase: rt?.getState().phase ?? 'stopped',
        windowOpen: isRoomOpen(),
        aiIds: listRoomRuntimeAiIds()
      }
    }
  })
  ipcMain.handle('room:tick', async (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    const rt = ensureRoomRuntime(id)
    if (!rt) return unavailable(id)
    return { ok: true, result: await rt.tick() }
  })
  ipcMain.handle('room:start-loop', (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    const supervisor = getRoomLoopSupervisor()
    if (!supervisor) return unavailable(id)
    const r = supervisor.acquire(id)
    return r.ok ? { ok: true, running: r.running } : { ok: false, error: r.error ?? unavailable(id).error }
  })
  ipcMain.handle('room:stop-loop', (_e, aiId?: unknown) => {
    getRoomLoopSupervisor()?.stopAi(scopeOf(aiId))
    return { ok: true, running: false }
  })

  // ===== 唤醒上报（ADR-29 裁决3：「用户来了」）=====
  // 渲染进程只**上报**（ROOM 视图变为可见/聚焦）；是否真的唤醒由 `room/wake.ts` 的仲裁器去抖后决定。
  // 只接受 user-present——渲染进程不得伪造 monitor 源（那是监控侧的上报）。
  ipcMain.handle('room:wake', (_e, aiId?: unknown) => ({ ok: true, fired: reportRoomWake('user-present', scopeOf(aiId)) }))
}
