/**
 * @category ROOM
 * @summary 任务迁移/接续：把任务迁到**授权节点白名单内**的目标节点
 *
 * 为什么存在：交接单 §0 T1-5「跨节点迁移/接续/复制自身：限用户可见可编辑可撤回的**授权节点白名单**内」，
 * 且 §6② 的路由层提供了多跳传输能力。本模块是「迁移」这条能力的**唯一执行入口**：
 * 先过 `evaluatePolicy({capability:'t1.migrate', scope:{nodes:[目标]}})`——**越界即拒**。
 *
 * 不删理由：删掉即迁移要么无门控（破 §0），要么散落各处自行判断白名单（口径漂移）。
 *
 * 与路由层的关系：本模块只产出「迁移计划 + 授权裁决」，实际传输由 `deps.send` 接到 LAN 路由
 * （`route.*` / 既有 relay），不在本模块内做网络调用。
 */
import type { PolicyDecision, PolicyRequest } from '@shared/types/permission'

export interface MigrationPlan {
  /** 任务标识（同一任务跨节点保持） */
  taskId: string
  /** 源节点 uid */
  fromNode: number
  /** 目标节点 uid（必须在授权节点白名单内） */
  toNode: number
  /** 迁移内容（任务状态 / 记忆 / 工具产物——具体形状由调用方决定） */
  payload: unknown
  /** 是否接续（迁移后在目标节点继续执行；false = 仅复制） */
  resume?: boolean
}

export interface MigrationDeps {
  /** 唯一 policy 检查点（ADR-11） */
  evaluate: (req: PolicyRequest) => PolicyDecision
  /** 实际传输（接到 LAN 路由 / 既有 relay） */
  send: (plan: MigrationPlan) => Promise<{ ok: boolean; error?: string }>
}

export interface MigrationResult {
  ok: boolean
  /** 裁决结论（被拒时 reason/grantHint 说明原因；越界时 reason 含具体节点） */
  decision: PolicyDecision
  error?: string
}

/**
 * 迁移一个任务。**授权范围 = 目标节点**（scoped 能力，见 tiers.ts 的 `t1.migrate`）。
 * 未授予 / 授予无节点白名单 / 目标不在白名单 → 拒绝，且**不发送**。
 */
export async function migrateTask(plan: MigrationPlan, deps: MigrationDeps): Promise<MigrationResult> {
  const decision = deps.evaluate({
    capability: 't1.migrate',
    action: `migrate:${plan.taskId}->${plan.toNode}`,
    actor: 'ai',
    scope: { nodes: [String(plan.toNode)] }
  })
  if (!decision.allowed) return { ok: false, decision }

  try {
    const sent = await deps.send(plan)
    return sent.ok ? { ok: true, decision } : { ok: false, decision, error: sent.error ?? '迁移传输失败' }
  } catch (err) {
    return { ok: false, decision, error: `迁移失败：${(err as Error).message}` }
  }
}
