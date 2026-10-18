/**
 * @category 核心
 * @summary 权限层 IPC：能力目录查询 / T1 授予 / 撤回 / 审计读取
 *
 * 为什么存在：交接单 §0 要求「授予只能来自用户操作；AI 不得改自己的权限」。授予/撤回因此必须是
 * **渲染进程（用户）专属的 IPC 通道**——不注册为工具、不暴露给 AI，也不经通用 `config:set`
 * 白名单（`securityGrants` 不在 ALLOWED_CONFIG_KEYS 内），从结构上堵死「AI 自我授权」。
 *
 * 什么作用：`security:listCapabilities` 返回分级目录与当前授予；`security:grant` / `security:revoke`
 * 增删 T1 授予（写 AppConfig.securityGrants）；`security:listAudit` 读审计尾部。
 *
 * 不删理由：删掉即授予退回「改 config 文件」，既无用户可见入口，也失去「AI 不可达」的结构约束。
 *
 * 校验纪律：只接受 T1 键（T0 永不可授予、T2 无需授予）；scoped 能力必须带范围，
 * 否则授予即失效（动作侧会被 t1_out_of_scope 拒），此处前置拦下并回传原因。
 */
import type { ipcMain as IpcMainType, IpcMainInvokeEvent } from 'electron'
import type { ConfigStore } from '../../api/config-store'
import type { AppConfig, CapabilityDef, GrantScope, SecurityGrant } from '@shared/types'
import { ALL_CAPABILITIES, isGrantable, resolveCapability } from '@shared/security/tiers'
import { readAuditTail } from '../../tools/security-engine/audit-log'
import { safeHandle, errorFallback } from './safe-handle'

export interface SecurityHandlerDeps {
  configStore: ConfigStore
  /** 审计文件路径 getter；返回 null 表示审计未接线（读取返回空数组） */
  getAuditFilePath: () => string | null
}

interface GrantPayload {
  key?: unknown
  scope?: unknown
  expiresAt?: unknown
  note?: unknown
}

/** 范围字段白名单：只保留 targets/nodes/endpoints 三个已知字段的字符串数组 */
function sanitizeScope(raw: unknown): GrantScope | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const out: GrantScope = {}
  for (const field of ['targets', 'nodes', 'endpoints'] as const) {
    const v = src[field]
    if (Array.isArray(v)) {
      const list = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      if (list.length > 0) out[field] = list
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function registerSecurityHandlers(ipc: typeof IpcMainType, deps: SecurityHandlerDeps): void {
  /** 能力目录 + 当前授予：设置页权限面板的数据源 */
  safeHandle<{ ok: boolean; capabilities: readonly CapabilityDef[]; grants: Record<string, SecurityGrant> }>(
    ipc,
    'security:listCapabilities',
    () => ({
      ok: true,
      capabilities: ALL_CAPABILITIES,
      grants: deps.configStore.get().securityGrants?.grants ?? {}
    }),
    { ok: false, capabilities: [], grants: {} }
  )

  /** 授予：只接受 T1 键；scoped 能力必须带范围 */
  safeHandle<{ ok: boolean; grants?: Record<string, SecurityGrant>; error?: string }>(
    ipc,
    'security:grant',
    (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = (payload ?? {}) as GrantPayload
      const key = typeof p.key === 'string' ? p.key : ''
      if (!key) return { ok: false, error: '缺少能力 key' }
      if (!isGrantable(key)) {
        const cap = resolveCapability(key)
        const why = !cap ? '未登记的能力' : cap.tier === 'T0' ? '硬禁止能力不可授予' : '默认开放能力无需授予'
        return { ok: false, error: `不可授予「${key}」：${why}` }
      }
      const cap = resolveCapability(key)!
      const scope = sanitizeScope(p.scope)
      if (cap.scoped && !scope) {
        return { ok: false, error: `「${cap.title}」必须提供授权范围（targets/nodes/endpoints 至少一项）` }
      }
      const expiresAt = typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt) ? p.expiresAt : undefined
      const cfg = deps.configStore.get()
      const grants: Record<string, SecurityGrant> = { ...(cfg.securityGrants?.grants ?? {}) }
      grants[key] = {
        key,
        grantedAt: Date.now(),
        ...(scope ? { scope } : {}),
        ...(expiresAt != null ? { expiresAt } : {}),
        ...(typeof p.note === 'string' && p.note ? { note: p.note } : {})
      }
      deps.configStore.save({ ...cfg, securityGrants: { grants } } as AppConfig)
      return { ok: true, grants }
    },
    errorFallback('授予失败，请查看日志')
  )

  /** 撤回：删除授予即生效（裁决层实时读授予表） */
  safeHandle<{ ok: boolean; grants?: Record<string, SecurityGrant>; error?: string }>(
    ipc,
    'security:revoke',
    (_event: IpcMainInvokeEvent, key: unknown) => {
      const k = typeof key === 'string' ? key : ''
      if (!k) return { ok: false, error: '缺少能力 key' }
      const cfg = deps.configStore.get()
      const grants: Record<string, SecurityGrant> = { ...(cfg.securityGrants?.grants ?? {}) }
      delete grants[k]
      deps.configStore.save({ ...cfg, securityGrants: { grants } } as AppConfig)
      return { ok: true, grants }
    },
    errorFallback('撤回失败，请查看日志')
  )

  /** 审计尾部读取（UI 审计视图用） */
  safeHandle<{ ok: boolean; entries: unknown[] }>(
    ipc,
    'security:listAudit',
    (_event: IpcMainInvokeEvent, limit: unknown) => {
      const path = deps.getAuditFilePath()
      if (!path) return { ok: true, entries: [] }
      const n = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(Math.max(1, limit), 1000) : 200
      return { ok: true, entries: readAuditTail(path, n) }
    },
    { ok: false, entries: [] }
  )
}
