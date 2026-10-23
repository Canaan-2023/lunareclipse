/**
 * @category 核心
 * @summary ROOM 运行面 IPC：状态读取 / 手动一轮 / 启停 / 承载会话上报 / 唤醒上报
 *
 * 为什么只剩这些（B-F 物理删除窗口分支后）：ADR-29 把 ROOM 的承载面定为**会话页原位视图**，
 * 独立 `BrowserWindow` 分支（`?room=1` + `RoomApp` + `room.viewMode` 灰度回滚 flag）已按
 * 「灰度观察期结束」物理删除——ROOM **不再有任何窗口面**，故本文件只保留渲染侧读写运行态
 * 所必需的通道。
 *
 * 生命周期口径（勿回退）：
 * - 循环 owner = 主进程 `RoomLoopSupervisor`（按 (uid,aiId) 引用计数）；渲染进程只表达「要 / 不要」；
 * - 主窗口 `closed` 时由 `bootstrap/room-runtime.ts` 兜底 `stopAll()`（不留常驻定时器）；
 * - **主窗口渲染进程崩溃不在此处停循环**——视图不持生命周期，reload 后应当看到循环仍在跑
 *   （这是设计，不是缺陷）；连续崩溃超阈值时 `restartApp` 走退出链。
 *
 * 不删理由：删掉即渲染侧无法读写房间运行态（状态栏 / 事件流 / 三主区 / 逆生树视角全部无数据源）。
 */
import { ipcMain } from 'electron'
import type { ConfigStore } from '../../api/config-store'
import { DEFAULT_AI_ID } from '@shared/types'
import { ensureRoomRuntime, peekRoomRuntime, listRoomRuntimeAiIds } from '../../room/runtime'
import { getRoomLoopSupervisor } from '../../room/loop-supervisor'
import { reportRoomWake } from '../../room/wake'

export function registerRoomIpc(configStore: ConfigStore): void {
  // 所有通道都带 `aiId`（缺省月蚀）——房间按 AI 分实例，各自独立会话与配置。
  const scopeOf = (aiId: unknown): number =>
    typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID
  const unavailable = (aiId: number): { ok: false; error: string } => ({
    ok: false,
    error: `自主运行时不可用（AI${aiId}）：未登录 / 该 AI 已下线 / 未装配`
  })

  // **无副作用读取**（P2-8）：绝不能用 `ensureRoomRuntime`（会持续创建实例）
  ipcMain.handle('room:runtime-state', (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    const rt = peekRoomRuntime(id)
    return rt
      ? { ok: true, state: { ...rt.getState(), aiId: id } }
      : { ok: true, state: { running: false, phase: 'stopped', events: [], aiId: id } }
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
        aiIds: listRoomRuntimeAiIds(),
        // 房间自持会话 id（ADR-30 R3）：逆生树视角据此切到**房间树**；无实例 = null（该 AI 还没跑过自主）
        sessionId: rt?.getState().sessionId ?? null
      }
    }
  })

  ipcMain.handle('room:tick', async (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    const rt = ensureRoomRuntime(id)
    if (!rt) return unavailable(id)
    try {
      return { ok: true, result: await rt.tick() }
    } catch (err) {
      // 不把 rejected invoke 抛给渲染进程：给结构化原因，界面能显示
      return { ok: false, error: `手动执行失败：${(err as Error).message}` }
    }
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

  /**
   * 用户侧回收路径：把 AI 的感知策略复位为默认（0.53.3）。
   * 为什么用 `peek`：没实例就没有策略可复位，不为一次复位去创建运行时。
   */
  ipcMain.handle('room:sensor-policy-reset', (_e, aiId?: unknown) => {
    const id = scopeOf(aiId)
    const rt = peekRoomRuntime(id)
    if (!rt) return unavailable(id)
    return rt.resetSensorPolicy()
  })

  /**
   * 用户在房间视图里发消息：交给运行时的**第一类输入**队列（不依赖采集器/授予）。
   * `stopped` 返回 false，渲染侧据此退回普通会话发送。
   */
  ipcMain.handle('room:user-message', (_e, payload?: unknown) => {
    const p = (payload ?? {}) as { aiId?: unknown; sessionId?: unknown; content?: unknown }
    const id = scopeOf(p.aiId)
    const rt = peekRoomRuntime(id)
    if (!rt) return { ok: false, error: `自主运行时不可用（AI${id}）` }
    const content = typeof p.content === 'string' ? p.content : ''
    const sessionId = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined
    return rt.onUserMessage(content, sessionId)
  })

  // 视图上报「房间正承载在哪个会话」：仅在 AI 选了 contextMode='session' 时参与选路。
  // 用 peek（无副作用）：没实例就没有上下文可选，不为了上报而创建运行时。
  ipcMain.handle('room:host-session', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { aiId?: unknown; sessionId?: unknown }
    const rt = peekRoomRuntime(scopeOf(p.aiId))
    if (!rt) return { ok: true, accepted: false }
    rt.setHostSession(typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : null)
    return { ok: true, accepted: true }
  })

  // ===== 唤醒上报（ADR-29 裁决3：「用户来了」）=====
  // 渲染进程只**上报**（房间视图变为可见/聚焦）；是否真的唤醒由 `room/wake.ts` 的仲裁器去抖后决定。
  // 只接受 user-present——渲染进程不得伪造 monitor 源（那是监控侧的上报）。
  ipcMain.handle('room:wake', (_e, aiId?: unknown) => ({
    ok: true,
    fired: reportRoomWake('user-present', scopeOf(aiId))
  }))
}
