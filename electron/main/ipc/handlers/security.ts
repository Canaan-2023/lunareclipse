/**
 * @category 核心
 * @summary 权限层 IPC：能力目录查询 / 告知义务确认 / T1 授予 / 撤回 / 审计读取
 *
 * 为什么存在：交接单 §0 要求「授予只能来自用户操作；AI 不得改自己的权限」。授予/撤回因此必须是
 * **渲染进程（用户）专属的 IPC 通道**——不注册为工具、不暴露给 AI，也不经通用 `config:set`
 * 白名单（`securityGrants` 不在 ALLOWED_CONFIG_KEYS 内），从结构上堵死「AI 自我授权」。
 *
 * 什么作用：`security:listCapabilities` 返回分级目录、当前授予与告知义务确认态；
 * `security:acknowledge` 记录「用户已阅读并自担损失」；`security:grant` / `security:revoke`
 * 增删 T1 授予（写 AppConfig.securityGrants）；`security:listAudit` 读审计尾部。
 *
 * 不删理由：删掉即授予退回「改 config 文件」，既无用户可见入口，也失去「AI 不可达」的结构约束。
 *
 * 校验纪律：只接受 T1 键（T0 永不可授予、T2 无需授予）；scoped 能力必须带范围，
 * 否则授予即失效（动作侧会被 t1_out_of_scope 拒），此处前置拦下并回传原因。
 *
 * 告知义务（2026-10-19 用户裁决）：**授予前必须先确认条款**（`needsAcknowledgement`）。
 * 这是**结构性**的——没确认就授不出去，而不是「弹个提示但照样能点」。**撤回永不设门**：
 * 收紧权限的方向永远畅通（安全默认：拒绝需要理由，放开需要代价，收回不需要）。
 */
import type { ipcMain as IpcMainType, IpcMainInvokeEvent } from 'electron'
import type { ConfigStore } from '../../api/config-store'
import type { AppConfig, AuditEntry, CapabilityDef, GrantScope, SecurityGrant } from '@shared/types'
import { ALL_CAPABILITIES, GRANT_SCOPE_ENTRY_MAX, GRANT_SCOPE_MAX_ENTRIES, isGrantable, resolveCapability } from '@shared/security/tiers'
import { SECURITY_NOTICE_VERSION, needsAcknowledgement } from '@shared/security/notice'
import { readAuditTail } from '../../tools/security-engine/audit-log'
import { reportRoomWake } from '../../room/wake'
import { safeHandle, errorFallback } from './safe-handle'

export interface SecurityHandlerDeps {
  configStore: ConfigStore
  /** 审计文件路径 getter；返回 null 表示审计未接线（读取返回空数组） */
  getAuditFilePath: () => string | null
  /**
   * 审计写入（授予/撤回这类**权限状态变更**也进审计，不只裁决）。
   * 可选：未接线时授予/撤回照常生效，只是不留痕（不因为审计不可用而阻断用户操作）。
   */
  appendAudit?: (entry: AuditEntry) => void
}

interface GrantPayload {
  key?: unknown
  scope?: unknown
  expiresAt?: unknown
  note?: unknown
}

/** 范围字段名（提示文案用；字段真源是 `CapabilityDef.scopeField`） */
const SCOPE_FIELD_HINT = 'targets/nodes/endpoints'

/** 范围字段白名单：只保留 targets/nodes/endpoints 三个已知字段的字符串数组 */
function sanitizeScope(raw: unknown): GrantScope | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const out: GrantScope = {}
  for (const field of ['targets', 'nodes', 'endpoints'] as const) {
    const v = src[field]
    if (Array.isArray(v)) {
      // **trim + 去重 + 截断**（与渲染侧 scope-input 同口径；主进程才是真正的关口）。
      // 不 trim 会出现「授权 ' x'、动作带 'x'」→ fail-closed 拒绝，用户以为授权生效了。
      const list = [
        ...new Set(
          v
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim().slice(0, GRANT_SCOPE_ENTRY_MAX))
            .filter((x) => x.length > 0)
        )
      ].slice(0, GRANT_SCOPE_MAX_ENTRIES)
      if (list.length > 0) out[field] = list
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 记一条权限状态变更审计。
 * `capability` 填被授予/撤回的能力 key；`code` 固定 `allowed`（本条记录的是「用户做了这个动作」，
 * 不是一次裁决的放行/拒绝）。id 用「动作 + 时间 + key」拼，不引入随机源（审计可复现、可 grep）。
 */
function auditGrantChange(
  deps: SecurityHandlerDeps,
  action: 'security:grant' | 'security:revoke',
  key: string,
  reason: string,
  scope?: GrantScope
): void {
  if (!deps.appendAudit) return
  const ts = Date.now()
  deps.appendAudit({
    id: `${action}:${ts}:${key}`,
    ts,
    capability: key,
    action,
    actor: 'user',
    tier: resolveCapability(key)?.tier ?? 'unknown',
    decision: 'allow',
    code: 'allowed',
    reason,
    ...(scope ? { scope } : {})
  })
}

export function registerSecurityHandlers(ipc: typeof IpcMainType, deps: SecurityHandlerDeps): void {
  /** 能力目录 + 当前授予 + 告知义务确认态：权限面板的数据源 */
  safeHandle<{
    ok: boolean
    capabilities: readonly CapabilityDef[]
    grants: Record<string, SecurityGrant>
    acknowledged: boolean
    acknowledgedAt: number | null
    noticeVersion: number
  }>(
    ipc,
    'security:listCapabilities',
    () => {
      const stored = deps.configStore.get().securityGrants
      const acked = !needsAcknowledgement(stored)
      return {
        ok: true,
        capabilities: ALL_CAPABILITIES,
        grants: stored?.grants ?? {},
        acknowledged: acked,
        acknowledgedAt: acked ? (stored?.acknowledged?.at ?? null) : null,
        noticeVersion: SECURITY_NOTICE_VERSION
      }
    },
    {
      ok: false,
      capabilities: [],
      grants: {},
      acknowledged: false,
      acknowledgedAt: null,
      noticeVersion: SECURITY_NOTICE_VERSION
    }
  )

  /**
   * 告知义务确认：记录「用户已阅读并理解，授予造成的损失自担」。
   * 只写确认记录，**不动任何授予**——确认与授予是两步，用户可以先读条款再逐项决定。
   */
  safeHandle<{ ok: boolean; acknowledged?: boolean; noticeVersion?: number; error?: string }>(
    ipc,
    'security:acknowledge',
    () => {
      const cfg = deps.configStore.get()
      const stored = cfg.securityGrants ?? { grants: {} }
      deps.configStore.save({
        ...cfg,
        securityGrants: {
          grants: stored.grants,
          acknowledged: { at: Date.now(), version: SECURITY_NOTICE_VERSION }
        }
      } as AppConfig)
      return { ok: true, acknowledged: true, noticeVersion: SECURITY_NOTICE_VERSION }
    },
    errorFallback('确认失败，请查看日志')
  )

  /** 授予：只接受 T1 键；**先过告知义务门**；scoped 能力必须带范围 */
  safeHandle<{ ok: boolean; grants?: Record<string, SecurityGrant>; error?: string }>(
    ipc,
    'security:grant',
    (_event: IpcMainInvokeEvent, payload: unknown) => {
      const p = (payload ?? {}) as GrantPayload
      const key = typeof p.key === 'string' ? p.key : ''
      if (!key) return { ok: false, error: '缺少能力 key' }
      // 顺序：先把明显非法的键挡掉，再谈风险告知——错误信息才对得上用户的操作。
      if (!isGrantable(key)) {
        const cap = resolveCapability(key)
        const why = !cap ? '未登记的能力' : cap.tier === 'T0' ? '硬禁止能力不可授予' : '默认开放能力无需授予'
        return { ok: false, error: `不可授予「${key}」：${why}` }
      }
      // 告知义务门：没确认过（或条款已升版）就授不出去。
      if (needsAcknowledgement(deps.configStore.get().securityGrants)) {
        return { ok: false, error: '请先阅读并确认「权限授予告知」条款（授予后的损失由你承担）' }
      }
      const cap = resolveCapability(key)!
      const scope = sanitizeScope(p.scope)
      if (cap.scoped && !scope) {
        return { ok: false, error: `「${cap.title}」必须提供授权范围（${SCOPE_FIELD_HINT} 至少一项）` }
      }
      // scoped 能力还要求**填对字段**：范围字段由能力目录自述（`scopeField`）。
      // 只填了别的字段等于「圈了一个动作侧根本不看的范围」——授予看似成功、动作全被拒，
      // 那是比直接拒绝更坏的失败（用户以为授权生效了）。
      if (cap.scopeField && !scope?.[cap.scopeField]) {
        return { ok: false, error: `「${cap.title}」的范围必须填在 ${cap.scopeField} 字段` }
      }
      const expiresAt = typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt) ? p.expiresAt : undefined
      const cfg = deps.configStore.get()
      const stored = cfg.securityGrants ?? { grants: {} }
      const grants: Record<string, SecurityGrant> = { ...stored.grants }
      grants[key] = {
        key,
        grantedAt: Date.now(),
        ...(scope ? { scope } : {}),
        ...(expiresAt != null ? { expiresAt } : {}),
        ...(typeof p.note === 'string' && p.note ? { note: p.note } : {})
      }
      // 保留 confirmed 的确认记录（授予不改确认态）
      deps.configStore.save({ ...cfg, securityGrants: { ...stored, grants } } as AppConfig)
      auditGrantChange(deps, 'security:grant', key, `用户授予（已确认告知义务 v${SECURITY_NOTICE_VERSION}）`, scope)
      // 0.53.1：授予是**用户刚做的一件事**，正在等授权的房间应立刻醒来试一次。
      // 只在「这个授予真的解锁了采集」时唤醒（开关也必须已打开），否则只是白烧一次模型调用；
      // 也不广播给所有房间——用户动作只与采集闸门有关（架构评审 P1：惊群）。
      if (key === 't1.collector' && cfg.collector?.enabled === true) {
        reportRoomWake('user-action', undefined, undefined, '已授予 t1.collector')
      }
      return { ok: true, grants }
    },
    errorFallback('授予失败，请查看日志')
  )

  /** 撤回：删除授予即生效（裁决层实时读授予表）。**不设告知义务门**——收回权限永远畅通 */
  safeHandle<{ ok: boolean; grants?: Record<string, SecurityGrant>; error?: string }>(
    ipc,
    'security:revoke',
    (_event: IpcMainInvokeEvent, key: unknown) => {
      const k = typeof key === 'string' ? key : ''
      if (!k) return { ok: false, error: '缺少能力 key' }
      const cfg = deps.configStore.get()
      const stored = cfg.securityGrants ?? { grants: {} }
      const grants: Record<string, SecurityGrant> = { ...stored.grants }
      const existed = grants[k] !== undefined
      delete grants[k]
      deps.configStore.save({ ...cfg, securityGrants: { ...stored, grants } } as AppConfig)
      if (existed) auditGrantChange(deps, 'security:revoke', k, '用户撤回授予')
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
