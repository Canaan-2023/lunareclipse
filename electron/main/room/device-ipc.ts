/**
 * @category ROOM
 * @summary 设备管理区 IPC：`room:device-scan`（发现）/ `room:device-call`（调用）
 *
 * 为什么存在：ADR-29 裁决6 把「设备管理区」列为 ROOM 三主区之一，且**复用**既有
 * `electron/main/device/*`（`DefaultDeviceManager.scan/register/call`，单例 `deviceManager`）——
 * 不再像 B-B1 那样拿局域网地图当设备区。
 *
 * 权限边界（两路，勿混）：
 * - **发现 = 只读**：`scan()` 只枚举（本机 / 局域网 / 蓝牙 / 已注册），不触碰控制面；
 * - **交互路径（本文件）**：控制类动作走 `ctx.requestPermission`（**fail-closed**，弹用户授权框，
 *   拒绝即不执行）——授权判定在 `DefaultDeviceManager.call` 内部，本文件只把 `requestPermission` 传进去；
 * - **自主路径（另一处）**：AI 自己调设备走 `device_call` 工具 → 执行器 `t1.executor-high-risk`，
 *   **不经过本文件的 UI 通道**（否则要么卡弹窗、要么绕过授权）。
 *
 * 不删理由：删掉即设备管理区退回「复用局域网地图」，诉求 9 落空。
 */
import { ipcMain } from 'electron'
import { deviceManager } from '../device/device-manager'
import type { AbyssDevice, DeviceCallParamsShape } from '../device/types'
import type { ToolContext, PermissionRequest, PermissionResponse } from '../tools/base-tool'

export interface RoomDeviceIpcDeps {
  /** 用户授权桥（主进程唯一入口）：控制类动作经此弹框，fail-closed */
  requestPermission: (req: PermissionRequest) => Promise<PermissionResponse>
}

/** 从 IPC 入参里取出设备调用请求（形状非法即拒，不猜）。 */
export function parseDeviceCall(raw: unknown): { ok: true; req: DeviceCallParamsShape } | { ok: false; error: string } {
  const r = (raw ?? {}) as { deviceId?: unknown; actionId?: unknown; params?: unknown }
  const deviceId = typeof r.deviceId === 'string' ? r.deviceId.trim() : ''
  const actionId = typeof r.actionId === 'string' ? r.actionId.trim() : ''
  if (!deviceId || !actionId) return { ok: false, error: '缺少 deviceId / actionId' }
  return {
    ok: true,
    req: {
      deviceId,
      actionId,
      params: (r.params && typeof r.params === 'object' ? r.params : {}) as Record<string, unknown>
    }
  }
}

export function registerRoomDeviceIpc(deps: RoomDeviceIpcDeps): void {
  ipcMain.handle('room:device-scan', async () => {
    try {
      const devices: AbyssDevice[] = await deviceManager.scan()
      return { ok: true, devices }
    } catch (err) {
      return { ok: false, devices: [], error: `设备发现失败：${(err as Error).message}` }
    }
  })

  ipcMain.handle('room:device-call', async (_e, raw: unknown) => {
    const parsed = parseDeviceCall(raw)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    // 只构造设备管理器真正会读的那一个字段（`call` 内部只用 `ctx.requestPermission`）；
    // 其余 ToolContext 字段与设备调用无关，故此处不强造完整上下文。
    const ctx = { requestPermission: deps.requestPermission } as unknown as ToolContext
    try {
      return await deviceManager.call(parsed.req, ctx)
    } catch (err) {
      return { ok: false, error: `设备调用失败：${(err as Error).message}` }
    }
  })
}
