/**
 * 局域网管理 preload 域：状态 / 启停 / 拓扑 / 路径记录。
 * 为什么存在：渲染进程不能直连主进程服务；B2 的局域网地图 UI 需要这四个通道的数据。
 * 作用：把 `lan:*` 通道暴露为 `window.lunareclipse.lanXxx()`。
 */
import { ipcRenderer } from 'electron'

export interface LanNodeView {
  uid: number
  role: 'master' | 'satellite'
  online: boolean
  lastSeen: number | null
  latencyMs: number | null
  forwardWilling: boolean
}

export interface LanTraceView {
  pathId: string
  from: number
  to: number
  path: number[]
  perHopStatus: Array<{ uid: number; state: 'pending' | 'forwarded' | 'delivered' | 'rejected' | 'failed' }>
  failureReason?: string
  rejectedBy?: number
  createdAt: number
}

export const api = {
  lanGetStatus: () =>
    ipcRenderer.invoke('lan:getStatus') as Promise<{
      ok: boolean
      enabled: boolean
      running: boolean
      role: string
      nodeCount: number
    }>,
  lanSetEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('lan:setEnabled', enabled) as Promise<{ ok: boolean; error?: string }>,
  lanGetTopology: () =>
    ipcRenderer.invoke('lan:getTopology') as Promise<{
      ok: boolean
      nodes: LanNodeView[]
      links: Array<{ from: number; to: number }>
    }>,
  lanGetTraces: () =>
    ipcRenderer.invoke('lan:getTraces') as Promise<{ ok: boolean; traces: LanTraceView[] }>
}
