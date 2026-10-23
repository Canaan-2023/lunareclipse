/**
 * ROOM 自主模式 preload 域：运行面（状态读取 / 手动一轮 / 启停 / 承载会话 / 唤醒 / 感知策略复位）。
 * 为什么存在：ROOM 的承载面是**会话页原位视图**，渲染侧读写房间运行态必须经 IPC。
 * 独立窗口面（`roomOpen`/`roomClose`/`roomToggle`/`roomIsOpen`/`onRoomClosed`）已随
 * ADR-29 的窗口分支在 B-F **物理删除**——ROOM 不再有任何窗口。
 */
import { ipcRenderer } from 'electron'

export const api = {
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
  /** 一次性读取当前运行态（挂载时用）。**不是轮询**——此后靠 `onRoomState` 推送 */
  roomRuntimeState: (aiId?: number) =>
    ipcRenderer.invoke('room:runtime-state', aiId) as Promise<{ ok: boolean; state: unknown }>,
  /**
   * 订阅主进程推送的**房间运行态**（取代渲染端 3s 轮询）。
   * 为什么是推送：房间大部分时间是安静的（待机 / 空闲），轮询在「什么都没发生」时也在消耗；
   * 状态变了才推 → 安静期零流量，有事时立即到界面（轮询还多一个周期的延迟）。
   * `payload.aiId` 用于多房间过滤（同一主窗口可能承载不同 AI 的房间视图）。
   */
  onRoomState: (callback: (payload: { aiId: number; state: unknown }) => void) => {
    const handler = (_e: unknown, payload: unknown) =>
      callback(payload as Parameters<typeof callback>[0])
    ipcRenderer.on('room:state-changed', handler)
    return () => void ipcRenderer.removeListener('room:state-changed', handler)
  },
  roomTick: (aiId?: number) =>
    ipcRenderer.invoke('room:tick', aiId) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  roomStartLoop: (aiId?: number) =>
    ipcRenderer.invoke('room:start-loop', aiId) as Promise<{ ok: boolean; running: boolean; error?: string }>,
  roomStopLoop: (aiId?: number) =>
    ipcRenderer.invoke('room:stop-loop', aiId) as Promise<{ ok: boolean; running: boolean }>,
  /** 用户侧回收：把 AI 的感知策略复位为默认（不经过 AI；0.53.3） */
  roomSensorPolicyReset: (aiId?: number) =>
    ipcRenderer.invoke('room:sensor-policy-reset', aiId) as Promise<{
      ok: boolean
      policy?: unknown
      error?: string
    }>,
  /**
   * 在房间视图里发一条消息：进入该 AI 房间的**第一类输入**队列
   * （与采集器是否开启/授权无关；`stopped` 返回 ok:false，渲染侧退回普通会话）。
   */
  roomUserMessage: (payload: { aiId?: number; sessionId?: string; content: string }) =>
    ipcRenderer.invoke('room:user-message', payload) as Promise<{ ok: boolean; error?: string }>,
  /** 上报「房间正承载在哪个会话」（仅在 AI 选了 contextMode='session' 时影响选路；配置不随会话变） */
  roomSetHostSession: (payload: { aiId?: number; sessionId: string }) =>
    ipcRenderer.invoke('room:host-session', payload) as Promise<{ ok: boolean; accepted: boolean }>,

  // ===== ROOM 工具区（B9）：AI 自造工具（声明式组合）=====
  roomToolZoneList: () => ipcRenderer.invoke('room:tool-zone-list') as Promise<{ ok: boolean; entries: unknown[] }>,
  roomToolZoneUpsert: (entry: unknown) =>
    ipcRenderer.invoke('room:tool-zone-upsert', entry) as Promise<{ ok: boolean; entries?: unknown[]; error?: string }>,
  roomToolZoneRemove: (id: string) =>
    ipcRenderer.invoke('room:tool-zone-remove', id) as Promise<{ ok: boolean; entries?: unknown[]; error?: string }>,
  roomToolZoneToggle: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('room:tool-zone-toggle', { id, enabled }) as Promise<{ ok: boolean; entries?: unknown[]; error?: string }>,

  // ===== ROOM 像素形象（P2）：AI 拟人化像素规格（只读；按 AI 分层）=====
  roomAvatarGet: (aiId?: number) =>
    ipcRenderer.invoke('room:avatar-get', aiId) as Promise<{ ok: boolean; spec: unknown }>,

  /**
   * **外观配置**（用户侧独立配置，AI 不可写；按 AI 分层）：
   * 人物位置/大小 + 背景来源 + 分区场景。
   * `background` / `scenes` 是 `room-asset://` 只读 URL（不再传 base64）。
   */
  roomAppearanceGet: (aiId?: number) =>
    ipcRenderer.invoke('room:appearance-get', aiId) as Promise<{
      ok: boolean
      appearance: unknown
      background: string | null
      scenes: Record<string, string>
      live2d: {
        modelUrl: string
        coreUrl: string
        model: string
        motions: string[]
        expressions: Array<{ name: string; file: string }>
      } | null
      dir: string | null
      scenesDir: string | null
      error?: string
    }>,
  roomAppearanceSet: (aiId: number, raw: unknown) =>
    ipcRenderer.invoke('room:appearance-set', aiId, raw) as Promise<{
      ok: boolean
      appearance?: unknown
      error?: string
    }>,

  /**
   * 图片看板娘（ADR-34；按 AI 分层）：读 `<data>/room/AI{aiId}/mascot/<帧名>.png`，
   * 当前 AI 缺失的帧用全局 `<data>/room/mascot/` 补齐。
   * `skipped` 是「放了但没生效的那几张 + 原因」，`dir` 是当前 AI 的目录。
   */
  roomMascotGet: (aiId?: number) =>
    ipcRenderer.invoke('room:mascot-get', aiId) as Promise<{
      ok: boolean
      sheet: { version: 1; frames: Record<string, string> }
      skipped: Array<{ file: string; reason: string }>
      dir: string | null
    }>,

  /**
   * **后处理**：当前 AI 的 `<数据目录>/room/AI{aiId}/mascot/raw/*.png` → 去背 / 裁切 / 命名。
   * 用户路径、按钮触发；只写用户自己的数据目录。
   */
  roomMascotProcess: (aiId?: number) =>
    ipcRenderer.invoke('room:mascot-process', aiId) as Promise<{
      ok: boolean
      processed: Array<{
        file: string
        frame: string
        w: number
        h: number
        alreadyTransparent: boolean
        removed: number
      }>
      skipped: Array<{ file: string; reason: string }>
      dir: string | null
      error?: string
    }>,

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
      status: {
        armed: boolean
        running: boolean
        phase: string
        aiIds: number[]
        /** 房间自持会话 id（ADR-30 R3：逆生树视角据此切到房间树）；无实例 = null */
        sessionId: string | null
      }
    }>
}
