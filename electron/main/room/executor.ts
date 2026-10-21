/**
 * @category ROOM
 * @summary ROOM 执行器：把「AI 决策」变成受 policy 门控的实际动作，并结构化回传结果
 *
 * 为什么存在：交接单 §7 的执行器职责是「执行 AI 决策并回传结果（动作过 §0 policy；高风险 = T1-2）」。
 * 它与交互式工具链（`executeTool` 的既有审批链）**不是一回事**——自主循环里没有「逐次弹窗」，
 * 授权只能来自 §0 的**逐项授予**。因此执行器必须自己先过 `evaluatePolicy`，再交给实际执行体。
 *
 * 不删理由：删掉即自主循环的动作要么无门控（破 §0），要么退回逐次弹窗（破「自主」）。
 *
 * 门控口径（§0）：
 * - 只读动作 → `t2.readonly-tools`（默认开，无需授予）；
 * - 高风险动作（写文件 / 执行命令 / 操作设备 / 调用外部服务）→ `t1.executor-high-risk`（默认关，需授予）；
 * - **来自工具区（AI 自造工具）的动作**：额外要求 `t1.tool-zone-enable`（先过这一层，再过上面那层）。
 *
 * **只读由谁判定（P0-2 修复）**：一律由 `deps.isReadOnly`（工具注册表元数据，见 `./tool-risk`）判定，
 * `ExecutorDecision` **不含** `readOnly` 字段——AI 自述无法参与分流（曾采信 AI 输出里的 `readOnly`，
 * 使高风险动作可冒充只读走 T2 免授予）。
 */
import type { SecurityGrants, PolicyDecision, PolicyRequest } from '@shared/types/permission'
import type { ToolResult } from '../tools/base-tool'
import type { ToolReadOnlyResolver } from './tool-risk'

/** 决策形态（自主循环产出）。 */
export interface ExecutorDecision {
  /** 动作类别 */
  kind: 'tool' | 'device' | 'command' | 'external'
  /** 工具名（kind='tool' 时） */
  toolName?: string
  /** 动作参数 */
  params?: Record<string, unknown>
  /** 是否来自「工具区」（AI 自造工具）→ 额外要求 t1.tool-zone-enable */
  fromToolZone?: boolean
  /** 面向审计的自然语言描述 */
  description: string
}

export interface ExecutorDeps {
  /** 授予表读取（实时） */
  getGrants: () => SecurityGrants
  /** 唯一 policy 检查点（ADR-11） */
  evaluate: (req: PolicyRequest) => PolicyDecision
  /** 只读判定（工具注册表元数据；fail-closed，见 ./tool-risk）——**不读决策自述** */
  isReadOnly: ToolReadOnlyResolver
  /** 实际执行体（由调用方接到既有 executeTool / 设备 / 系统输入） */
  run: (decision: ExecutorDecision) => Promise<ToolResult>
}

export interface ExecutorResult {
  ok: boolean
  /** 裁决结论（被拒时 reason/grantHint 说明原因） */
  decision: PolicyDecision
  /** 执行结果（仅放行时有） */
  result?: ToolResult
  /** 被拒的层级：'tool-zone' 表示卡在工具区授权，'action' 表示卡在动作授权 */
  rejectedAt?: 'tool-zone' | 'action'
}

export interface Executor {
  execute: (decision: ExecutorDecision) => Promise<ExecutorResult>
}

/** 动作 → 能力键映射（只读走 T2；其余走 T1-2）。入参是**已由元数据判定**的只读性。 */
export function capabilityForReadOnly(readOnly: boolean): 't2.readonly-tools' | 't1.executor-high-risk' {
  return readOnly ? 't2.readonly-tools' : 't1.executor-high-risk'
}

/** 解析本次动作的只读性：只有 `kind='tool'` 且工具名命中只读元数据才算只读，其余一律高风险（fail-closed）。 */
function isReadOnlyDecision(decision: ExecutorDecision, isReadOnly: ToolReadOnlyResolver): boolean {
  if (decision.kind !== 'tool' || !decision.toolName) return false
  return isReadOnly(decision.toolName)
}

/**
 * 构造执行器。见文件头「门控口径」。
 * 顺序纪律：**先工具区授权、再动作授权**——工具区产物是「AI 自造的东西」，必须先被允许投入使用，
 * 其动作才谈得上是否允许执行；反过来会让未启用的自造工具先触发动作授权提示。
 */
export function createExecutor(deps: ExecutorDeps): Executor {
  return {
    async execute(decision: ExecutorDecision): Promise<ExecutorResult> {
      const action = decision.description || `${decision.kind}:${decision.toolName ?? 'unknown'}`

      if (decision.fromToolZone === true) {
        const zoneDecision = deps.evaluate({
          capability: 't1.tool-zone-enable',
          action: `tool-zone:${decision.toolName ?? decision.kind}`,
          actor: 'ai'
        })
        if (!zoneDecision.allowed) {
          return { ok: false, decision: zoneDecision, rejectedAt: 'tool-zone' }
        }
      }

      const decisionResult = deps.evaluate({
        capability: capabilityForReadOnly(isReadOnlyDecision(decision, deps.isReadOnly)),
        action,
        actor: 'ai'
      })
      if (!decisionResult.allowed) {
        return { ok: false, decision: decisionResult, rejectedAt: 'action' }
      }

      try {
        const result = await deps.run(decision)
        return { ok: result.ok === true, decision: decisionResult, result }
      } catch (err) {
        // 执行体抛错不改变「已放行」的裁决语义，但结果标记失败并回传原因
        return {
          ok: false,
          decision: decisionResult,
          result: { ok: false, error: `执行失败：${(err as Error).message}` }
        }
      }
    }
  }
}
