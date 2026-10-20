/**
 * @category 核心
 * @summary AUTO 模型热切换 IPC：配置读写 / 切换审计 / 余额探测
 *
 * 为什么存在：交接单 §8.5 要求 ROOM 的模型配置管理区能看到「当前策略 + 切换历史 + 成本视图」。
 * 渲染进程不能直连主进程模块，必须经 IPC。
 *
 * 不删理由：删掉即模型池只能手改 config.json，ROOM 模型配置区没有数据源。
 *
 * 权限口径：本通道是**用户**路径（设置页/ROOM 面板）。AI **不得**改模型池/上限/钉死模型
 * （§0 T1-11 属授予项；AI 只能在池内选择）——所以 `modelRouter` 的写入**不暴露为工具**，
 * 且 AI 侧仅由 `model-switch` 在池内选择，不碰配置。
 */
import type { ipcMain as IpcMainType } from 'electron'
import type { AppConfig, ModelPoolEntry, ModelRouterConfig } from '@shared/types'
import type { ConfigStore } from '../../api/config-store'
import { listModelSwitches } from '../../api/llm/model-switch-log'
import { probeBalance } from '../../api/llm/balance'
import { safeHandle, errorFallback } from './safe-handle'

export interface ModelRouterHandlerDeps {
  configStore: ConfigStore
}

/** 池条目清洗：只保留 id 非空、tier 合法的条目。 */
function sanitizePool(raw: unknown): ModelPoolEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ModelPoolEntry[] = []
  for (const item of raw) {
    const e = item as { id?: unknown; tier?: unknown; enabled?: unknown }
    const id = typeof e?.id === 'string' ? e.id.trim() : ''
    const tier = e?.tier
    if (!id) continue
    if (tier !== 'fast' && tier !== 'strong' && tier !== 'reasoning') continue
    out.push({ id, tier, enabled: e.enabled === true })
  }
  return out
}

export function registerModelRouterHandlers(ipc: typeof IpcMainType, deps: ModelRouterHandlerDeps): void {
  /** 读配置（缺省返回默认：关 + 空池） */
  safeHandle<{ ok: boolean; config: ModelRouterConfig }>(
    ipc,
    'modelRouter:getConfig',
    () => ({ ok: true, config: deps.configStore.get().modelRouter ?? { enabled: false, pool: [] } }),
    { ok: false, config: { enabled: false, pool: [] } }
  )

  /** 写配置（用户路径）：只接受白名单字段，池条目清洗 */
  safeHandle<{ ok: boolean; config?: ModelRouterConfig; error?: string }>(
    ipc,
    'modelRouter:setConfig',
    (_event, raw: unknown) => {
      const r = (raw ?? {}) as { enabled?: unknown; pool?: unknown; pinModel?: unknown; minDwellRounds?: unknown }
      const cfg: ModelRouterConfig = {
        enabled: r.enabled === true,
        pool: sanitizePool(r.pool),
        ...(typeof r.pinModel === 'string' && r.pinModel.trim() ? { pinModel: r.pinModel.trim() } : {}),
        ...(typeof r.minDwellRounds === 'number' && Number.isFinite(r.minDwellRounds)
          ? { minDwellRounds: Math.max(0, Math.floor(r.minDwellRounds)) }
          : {})
      }
      const current = deps.configStore.get()
      deps.configStore.save({ ...current, modelRouter: cfg } as AppConfig)
      return { ok: true, config: cfg }
    },
    errorFallback('模型配置保存失败')
  )

  /** 切换审计（ROOM 模型配置区展示「为什么切」） */
  safeHandle<{ ok: boolean; entries: unknown[] }>(
    ipc,
    'modelRouter:getSwitchLog',
    () => ({ ok: true, entries: [...listModelSwitches()] }),
    { ok: false, entries: [] }
  )

  /** 余额探测（用户裁决：不加成本上限，改为可查余额） */
  safeHandle<{ ok: boolean; known: boolean; balances?: unknown[]; isAvailable?: boolean; error?: string }>(
    ipc,
    'modelRouter:probeBalance',
    async () => {
      const llm = deps.configStore.get().llm
      return probeBalance(llm?.baseURL ?? '', llm?.apiKey ?? '')
    },
    { ok: false, known: false, error: '余额查询失败' }
  )
}
