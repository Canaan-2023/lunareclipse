/**
 * @category ROOM
 * @summary 前置规划轮执行与历史环落笔（两段式第一段——主AI影子的编排逻辑，ADR-40）
 *
 * 为什么存在（从 runtime.ts 拆出）：主循环装配文件触 800 行体量棘轮（assert-max-lines 门禁），
 * 而前置规划的两段式编排自含——提示词构建 / 影子调用 / 三类故障回落事件 / 历史环落笔，
 * 与 runtime 其余装配无耦合。拆出后 runtime 只剩两个调用点。行为与拆出前逐字等价。
 *
 * 不删理由：删掉即前置规划功能的两段式循环不复存在（ADR-40 §2.1），回落纪律与可观测事件随之丢失。
 */
import type { LoopTickResult, PlanDecision } from './loop'
import type { RoomEvent } from './runtime-types'
import { buildPreplanPrompt, summarizeExecutions } from './plan-preplan-prompt'
import type { PreplanHistoryEntry } from './preplan-store'

/** 前置规划编排所需的最小依赖面（`RoomRuntimeDeps` 前置规划相关字段的子集，结构化匹配）。 */
export interface PreplanTurnDeps {
  /** 前置规划轮调用；缺省 = 能力未接线，`preplan` 路由直接回落 self */
  runPreplan?: (prompt: string) => Promise<string | null>
  /** 主AI名字（前置规划提示词 identity 段用） */
  preplanAiName?: string
  /** 读前置规划滚动历史环（旧→新） */
  loadPreplanHistory?: () => PreplanHistoryEntry[]
  /** 前置规划本轮可用来查证的只读工具名清单（真源 = 注册表元数据，不采信 AI 自述） */
  preplanReadonlyTools?: () => readonly string[]
  /** 追加一条前置规划历史（指令 + 执行结果摘要） */
  appendPreplanHistory?: (entry: PreplanHistoryEntry) => void
}

/**
 * 两段式第一段：前置规划看**同一轮采集输入**给出方向性指令。
 * 失败 / 空回复 / 未接线 = 返回 null、本轮回落主AI自规划——前置规划的故障不许弄停主AI
 * （不传播 llmFailed）。三类回落都在事件环留痕（`planner: 'preplan'`）。
 */
export async function runPreplanTurn(
  deps: PreplanTurnDeps,
  text: string,
  pushEvent: (ev: RoomEvent) => void,
  now: () => number
): Promise<string | null> {
  if (!deps.runPreplan) {
    pushEvent({ phase: 'plan', ts: now(), detail: '前置规划已启用但未接线，本轮回落自规划', planner: 'preplan' })
    return null
  }
  try {
    const prompt = buildPreplanPrompt({
      aiName: deps.preplanAiName ?? 'AI',
      text,
      history: deps.loadPreplanHistory?.() ?? [],
      readonlyTools: deps.preplanReadonlyTools?.() ?? []
    })
    const instruction = (await deps.runPreplan(prompt))?.trim() || null
    if (instruction) {
      pushEvent({ phase: 'plan', ts: now(), detail: `前置规划：${instruction.slice(0, 120)}`, planner: 'preplan' })
    }
    return instruction
  } catch (err) {
    pushEvent({ phase: 'plan', ts: now(), detail: `前置规划轮失败，本轮回落自规划：${(err as Error).message}`, planner: 'preplan' })
    return null
  }
}

/**
 * 前置规划历史环落笔：一轮 tick 收尾时把「指令 + 执行结果摘要」写入滚动环。
 * 历史写不进不阻断循环（与事件落盘同口径），但必须留痕。
 */
export function recordPreplanTickToHistory(
  deps: PreplanTurnDeps,
  instruction: string,
  r: LoopTickResult,
  decisions: PlanDecision['decisions'] | undefined,
  now: () => number
): void {
  try {
    // 工具名按序配对本轮计划（执行器按 decisions 顺序逐个执行）——裁决结论本身不带工具名
    deps.appendPreplanHistory?.({
      ts: now(),
      instruction,
      results: summarizeExecutions(r.executions, decisions)
    })
  } catch (err) {
    console.error('[room] 前置规划历史写入失败:', (err as Error).message)
  }
}
