/**
 * @category 安全
 * @summary 唯一 policy 检查点：所有受控动作（执行器/路由转发/迁移/采集/改配置）经此裁决
 *
 * 为什么存在：交接单 §0 要求「所有动作经同一层裁决」，并规定 T0 = 拒绝 + 审计、
 * T1 未授予 = 拒绝 + 提示如何授予。若各能力调用方各自判断，分级不变量（T0 永不可开、
 * T1 逐项可撤回、越界即拒）会在多处被写歪。本模块是这条要求的**唯一实现**：
 * 输入一个 PolicyRequest，输出一个 PolicyDecision，并落一条审计。
 *
 * 什么作用：`evaluatePolicy` 按分级目录（shared/security/tiers.ts）裁决；纯逻辑、依赖注入
 * （授予表读取 / 时钟 / 审计 / id 生成），因此可脱离 Electron 单测。
 *
 * 不删理由：删掉即分级语义退回各调用方硬编码；且 T0 的「无开关可开」不变量失去单点保证。
 *
 * 判定纪律（写进测试）：
 * - 未登记能力 fail-closed 拒绝（不得默认放行）；
 * - T0 拒绝**与授予表无关**——即使授予表被塞入 T0 键仍拒绝；
 * - `actor` 只进审计，不参与放行判定（AI 自决无法自我放宽）；
 * - 每次裁决（含放行）都落审计；审计写入异常被吞掉，不改变裁决结果。
 */
import { randomUUID } from 'crypto'
import type {
  AuditEntry,
  AuditSink,
  GrantScope,
  PolicyDecision,
  PolicyDenyCode,
  PolicyRequest,
  SecurityGrants
} from '@shared/types/permission'
import { resolveCapability } from '@shared/security/tiers'

/** 裁决依赖（全部注入，便于单测与装配解耦）。 */
export interface PolicyDeps {
  /** 读取当前授予表（运行时实时读，授予/撤回即时生效） */
  getGrants: () => SecurityGrants
  /** 时钟（epoch ms） */
  now: () => number
  /** 审计落点；缺省不落（测试可注入内存 sink） */
  audit?: AuditSink
  /** 审计 id 生成器；缺省 randomUUID */
  nextId?: () => string
}

/** 范围字段口径（与 GrantScope 的三字段一致）。 */
const SCOPE_FIELDS = ['targets', 'nodes', 'endpoints'] as const

/** 授予表为空的安全默认。 */
export const EMPTY_GRANTS: SecurityGrants = { grants: {} }

/**
 * 范围包含判定：动作携带的 scope 必须是授予 scope 的子集。
 * scoped 能力下：动作未携带范围、授予无范围、或任一字段有值不在授予集合内 → 拒绝。
 */
export function scopeWithin(
  scope: GrantScope | undefined,
  granted: GrantScope | undefined
): { ok: true } | { ok: false; reason: string } {
  const hasNeed = scope != null && SCOPE_FIELDS.some((f) => (scope[f]?.length ?? 0) > 0)
  if (!hasNeed) {
    return { ok: false, reason: '该能力要求动作携带授权范围，本次动作未携带' }
  }
  if (!granted) {
    return { ok: false, reason: '该能力要求授予时提供授权范围，当前授予无范围' }
  }
  for (const field of SCOPE_FIELDS) {
    const needVals = scope![field]
    if (!needVals || needVals.length === 0) continue
    const gotVals = granted[field] ?? []
    const missing = needVals.filter((v) => !gotVals.includes(v))
    if (missing.length > 0) {
      return { ok: false, reason: `越界：${field} 中的 ${missing.join('、')} 不在授权范围内` }
    }
  }
  return { ok: true }
}

/**
 * 唯一裁决入口。见文件头的判定纪律。
 */
export function evaluatePolicy(req: PolicyRequest, deps: PolicyDeps): PolicyDecision {
  const auditId = (deps.nextId ?? randomUUID)()
  const now = deps.now()
  const cap = resolveCapability(req.capability)

  const settle = (
    allowed: boolean,
    tier: PolicyDecision['tier'],
    code: PolicyDenyCode,
    reason: string,
    grantHint?: string
  ): PolicyDecision => {
    const entry: AuditEntry = {
      id: auditId,
      ts: now,
      capability: req.capability,
      action: req.action,
      actor: req.actor,
      tier,
      decision: allowed ? 'allow' : 'deny',
      code,
      reason,
      ...(req.scope ? { scope: req.scope } : {})
    }
    // 审计失败不得改变裁决（审计是旁路，不是闸门）
    try {
      deps.audit?.(entry)
    } catch {
      /* 审计写入失败已吞掉：裁决结果不受影响 */
    }
    return { allowed, tier, code, reason, ...(grantHint ? { grantHint } : {}), auditId }
  }

  if (!cap) {
    return settle(
      false,
      'unknown',
      'unknown_capability',
      `未登记的能力「${req.capability}」：权限层只认分级目录内的能力，未登记一律拒绝`
    )
  }

  if (cap.tier === 'T0') {
    // 硬禁止：不接受任何配置/同意，也不看授予表
    return settle(false, 'T0', 't0_denied', `${cap.title} 属硬禁止能力，任何配置或同意都不能开启`)
  }

  if (cap.tier === 'T2') {
    return settle(true, 'T2', 'allowed', `${cap.title} 默认放行（低风险）`)
  }

  // ===== T1：显式授予 =====
  const grant = deps.getGrants().grants[req.capability]
  const grantHint = `授予方式：在设置页权限面板授予「${cap.title}」（键 ${cap.key}）`
  if (!grant) {
    return settle(false, 'T1', 't1_not_granted', `${cap.title} 需用户显式授予，当前未授予`, grantHint)
  }
  if (grant.expiresAt != null && grant.expiresAt <= now) {
    return settle(
      false,
      'T1',
      't1_expired',
      `${cap.title} 的授予已于 ${new Date(grant.expiresAt).toISOString()} 过期`,
      grantHint
    )
  }
  if (cap.scoped) {
    const sc = scopeWithin(req.scope, grant.scope)
    if (!sc.ok) {
      return settle(false, 'T1', 't1_out_of_scope', `${cap.title}：${sc.reason}`, grantHint)
    }
  }
  return settle(true, 'T1', 'allowed', `${cap.title} 已授予且在授权范围内`)
}

/**
 * 组装便利：把一个依赖集包装成可复用的裁决器。
 * 各能力调用方（B1/B4/B5/B6/B7）在动作入口 `gate.evaluate({...})`，
 * 拿到 `decision.allowed === false` 时直接拒绝并回传 `reason`。
 */
export function createPolicyGate(deps: PolicyDeps): { evaluate: (req: PolicyRequest) => PolicyDecision } {
  return { evaluate: (req) => evaluatePolicy(req, deps) }
}
