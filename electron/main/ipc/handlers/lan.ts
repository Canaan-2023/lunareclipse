/**
 * @category 核心
 * @summary 局域网管理 IPC：状态 / 启停 / 拓扑 / 路径记录
 *
 * 为什么存在：交接单 §6⑤ 与 B2 要求「局域网节点管理 UI：启停 + 链接可视化 + 路径与被拒原因」。
 * 渲染进程不能直连主进程服务，必须经 IPC；本模块是这条链路的唯一入口。
 *
 * 不删理由：删掉即 LAN 管理面没有数据源，UI 只能显示静态文案。
 *
 * 权限口径：**启停**是用户操作（用户直连此通道）；AI 走 `lan_control` 工具，**必须先过
 * `t1.lan-control` 授予裁决**（ADR-11 唯一检查点）——两条路径共用 `MultiInstanceService.setLanEnabled`。
 */
import type { ipcMain as IpcMainType } from 'electron'
import type { AppConfig } from '@shared/types'
import type { ConfigStore } from '../../api/config-store'
import type { UserStore } from '../../models/user-store'
import type { MultiInstanceService } from '../../multi-instance'
import { safeHandle, errorFallback } from './safe-handle'

export interface LanHandlerDeps {
  configStore: ConfigStore
  getUserStore: () => UserStore | null
  getMultiInstance: () => MultiInstanceService | null
}

/** 可序列化的节点视图（Map 不过 IPC；同时只暴露 UI 需要的字段）。 */
interface NodeView {
  uid: number
  role: 'master' | 'satellite'
  online: boolean
  lastSeen: number | null
  latencyMs: number | null
  forwardWilling: boolean
}

export function registerLanHandlers(ipc: typeof IpcMainType, deps: LanHandlerDeps): void {
  /** 状态：配置开关 + 实际运行态 + 角色 + 节点数 */
  safeHandle<{ ok: boolean; enabled: boolean; running: boolean; role: string; nodeCount: number }>(
    ipc,
    'lan:getStatus',
    () => {
      const mi = deps.getMultiInstance()
      const stack = mi?.getRoutingStack() ?? null
      return {
        ok: true,
        enabled: deps.configStore.get().lan?.enabled === true,
        running: stack != null,
        role: mi?.getRole() ?? 'standalone',
        nodeCount: stack ? stack.routing.getGraph().nodes.size : 0
      }
    },
    { ok: false, enabled: false, running: false, role: 'standalone', nodeCount: 0 }
  )

  /** 启停（用户路径）：只写配置——实际起停由 bootstrap 的配置变更订阅统一落地（与 AI 路径同一处） */
  safeHandle<{ ok: boolean; error?: string }>(
    ipc,
    'lan:setEnabled',
    (_event, enabledRaw: unknown) => {
      const mi = deps.getMultiInstance()
      if (!mi) return { ok: false, error: '多实例服务不可用' }
      const cfg = deps.configStore.get()
      deps.configStore.save({ ...cfg, lan: { ...(cfg.lan ?? {}), enabled: enabledRaw === true } } as AppConfig)
      return { ok: true }
    },
    errorFallback('局域网启停失败')
  )

  /** 拓扑：节点 + 直连边（地图渲染用） */
  safeHandle<{ ok: boolean; nodes: NodeView[]; links: Array<{ from: number; to: number }> }>(
    ipc,
    'lan:getTopology',
    () => {
      const stack = deps.getMultiInstance()?.getRoutingStack() ?? null
      if (!stack) return { ok: true, nodes: [], links: [] }
      const graph = stack.routing.getGraph()
      const nodes: NodeView[] = []
      const links: Array<{ from: number; to: number }> = []
      for (const n of graph.nodes.values()) {
        nodes.push({
          uid: n.uid,
          role: n.role,
          online: n.online,
          lastSeen: n.lastSeen,
          latencyMs: n.latencyMs,
          forwardWilling: n.forwardWilling
        })
        for (const to of n.links) links.push({ from: n.uid, to })
      }
      return { ok: true, nodes, links }
    },
    { ok: false, nodes: [], links: [] }
  )

  /** 路径记录（含被拒原因与每跳状态，§6④） */
  safeHandle<{ ok: boolean; traces: unknown[] }>(
    ipc,
    'lan:getTraces',
    () => {
      const stack = deps.getMultiInstance()?.getRoutingStack() ?? null
      return { ok: true, traces: stack ? [...stack.routing.listTraces()] : [] }
    },
    { ok: false, traces: [] }
  )
}
