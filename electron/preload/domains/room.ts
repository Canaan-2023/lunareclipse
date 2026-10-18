/**
 * ROOM 自主模式 preload 域：独立窗口的开关与查询。
 * 为什么存在：ROOM 是独立 BrowserWindow，渲染侧（主窗口的设置页）需要能开关它。
 * 作用：把 `room:*` 通道暴露为 `window.lunareclipse.roomXxx()`。
 */
import { ipcRenderer } from 'electron'

export const api = {
  roomOpen: () => ipcRenderer.invoke('room:open') as Promise<{ ok: boolean; open: boolean }>,
  roomClose: () => ipcRenderer.invoke('room:close') as Promise<{ ok: boolean; open: boolean }>,
  roomToggle: () => ipcRenderer.invoke('room:toggle') as Promise<{ ok: boolean; open: boolean }>,
  roomIsOpen: () => ipcRenderer.invoke('room:is-open') as Promise<{ ok: boolean; open: boolean }>,
  /** 订阅 ROOM 窗口被关闭（主窗口据此同步开关状态） */
  onRoomClosed: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('room:closed', handler)
    return () => void ipcRenderer.removeListener('room:closed', handler)
  },

  // ===== ROOM 模型配置区（B7b）：AUTO 配置 / 切换审计 / 余额 =====
  modelRouterGetConfig: () =>
    ipcRenderer.invoke('modelRouter:getConfig') as Promise<{ ok: boolean; config: unknown }>,
  modelRouterSetConfig: (config: unknown) =>
    ipcRenderer.invoke('modelRouter:setConfig', config) as Promise<{ ok: boolean; config?: unknown; error?: string }>,
  modelRouterGetSwitchLog: () =>
    ipcRenderer.invoke('modelRouter:getSwitchLog') as Promise<{ ok: boolean; entries: unknown[] }>,
  modelRouterProbeBalance: () =>
    ipcRenderer.invoke('modelRouter:probeBalance') as Promise<{
      ok: boolean
      known: boolean
      balances?: Array<{ currency: string; total: string }>
      isAvailable?: boolean
      error?: string
    }>,

  // ===== ROOM 自主循环运行时（B8 / ADR-25 L3：每个 AI 一个实例，通道带 aiId）=====
  roomRuntimeState: (aiId?: number) =>
    ipcRenderer.invoke('room:runtime-state', aiId) as Promise<{ ok: boolean; state: unknown }>,
  roomTick: (aiId?: number) =>
    ipcRenderer.invoke('room:tick', aiId) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  roomStartLoop: (aiId?: number) =>
    ipcRenderer.invoke('room:start-loop', aiId) as Promise<{ ok: boolean; running: boolean; error?: string }>,
  roomStopLoop: (aiId?: number) =>
    ipcRenderer.invoke('room:stop-loop', aiId) as Promise<{ ok: boolean; running: boolean }>,

  // ===== ROOM 工具区（B9）：AI 自造工具（声明式组合）=====
  roomToolZoneList: () => ipcRenderer.invoke('room:tool-zone-list') as Promise<{ ok: boolean; entries: unknown[] }>,
  roomToolZoneUpsert: (entry: unknown) =>
    ipcRenderer.invoke('room:tool-zone-upsert', entry) as Promise<{ ok: boolean; entries?: unknown[]; error?: string }>,
  roomToolZoneRemove: (id: string) =>
    ipcRenderer.invoke('room:tool-zone-remove', id) as Promise<{ ok: boolean; entries?: unknown[]; error?: string }>,
  roomToolZoneToggle: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('room:tool-zone-toggle', { id, enabled }) as Promise<{ ok: boolean; entries?: unknown[]; error?: string }>,

  // ===== ROOM 像素形象（P2）：AI 拟人化像素规格（只读；单一真源在主进程）=====
  roomAvatarGet: () => ipcRenderer.invoke('room:avatar-get') as Promise<{ ok: boolean; spec: unknown }>,

  // ===== ROOM 唤醒上报（ADR-29 裁决3）：「用户来了」——只上报，去抖与激活在主进程仲裁器 =====
  roomWake: (aiId?: number) =>
    ipcRenderer.invoke('room:wake', aiId) as Promise<{ ok: boolean; fired: boolean }>,

  // ===== ROOM 设备管理区（B-B2）：发现（只读）+ 调用（控制走 requestPermission，fail-closed）=====
  roomDeviceScan: () =>
    ipcRenderer.invoke('room:device-scan') as Promise<{ ok: boolean; devices: unknown[]; error?: string }>,
  roomDeviceCall: (req: { deviceId: string; actionId: string; params?: Record<string, unknown> }) =>
    ipcRenderer.invoke('room:device-call', req) as Promise<{ ok: boolean; data?: unknown; error?: string }>,

  // ===== ROOM 状态（B-D1）：状态以运行时为准（armed=用户意图；running/phase=真值）=====
  roomStatus: (aiId?: number) =>
    ipcRenderer.invoke('room:status', aiId) as Promise<{
      ok: boolean
      status: { armed: boolean; running: boolean; phase: string; windowOpen: boolean; aiIds: number[] }
    }>
}
