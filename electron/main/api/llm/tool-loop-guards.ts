/**
 * @category API
 * @summary 工具循环护栏判定链（顺序敏感）：四类检测 → 软提示注入 / 硬 halt 裁决
 *
 * 为什么独立成模块：判定链此前内联在 `llm.ts` 的 `streamWithTools`（1205 行）方法体末尾，
 * 是「AI 空转/死循环」唯一的机械拦截点，却与流解析、工具派发混在同一方法里无法单测。
 *
 * 什么作用：`evaluateToolGuardrails(state, execResults, ctx)` 消费本轮工具执行结果，
 * 就地注入软提示（写 `ctx.conversation`）并返回裁决——调用方据此决定继续/收尾/切断。
 *
 * 不删理由：删掉即 AI 反复失败同一工具、反复读同一结果时无人打断（直到 maxRounds 烧完或用户杀进程）。
 *
 * ⚠️ **判定顺序红线（ADR-03 §4 / §8 风险 1）**：`loop_caps`（计数+软提示）→
 * `exact_failure`/`same_tool_failure`（失败累计）→ `idempotent_no_progress`（读类无进展）→
 * 硬 halt 收尾，先后不得重排；`if (failed) {...} else {...}` 分支与 `break` 语义必须保持。
 * 判据：`test/llm-guardrail-wire.test.ts` + `test/llm-failure-halt.test.ts` 全绿。
 */
import {
  failureFingerprint,
  isFailureResult,
  resultHash,
  isSubAgentish,
  IDEMPOTENT_TOOLS,
  LOOP_CAP,
  TOOL_FAILURE_HALT
} from '../llm-guardrails'
import type { ToolCallResult, WireMessage } from '../llm-types'
import { pushGuardrailHint, type TurnGuardrailState } from './session-state'

/** 单条工具执行结果（工具派发模块产出，本模块消费） */
export interface ToolExecResult {
  tc: ToolCallResult
  toolName: string
  toolCallId: string
  result: string
  /** 是否因外墙超时被中止（强杀路径） */
  timedOut?: boolean
  resultMode: 'full' | 'distill'
}

/** 本轮转入后台托管的任务（软超时：进程不杀，AI 用 tool_watch/tool_stop 接管） */
export interface ManagedHandoff {
  taskId: string
  toolName: string
}

export interface GuardrailContext {
  /** wire 会话副本：软提示以 user 角色追加于此 */
  conversation: WireMessage[]
  /** 本回合因外墙超时被中止的工具名 */
  timedOutTools: string[]
  /** 本回合转入后台托管的任务 */
  managedHandoffs: ManagedHandoff[]
  /** 当前轮次号（仅用于日志与提示文案一致性） */
  round: number
}

/**
 * 裁决结果：
 * - `none`：无 halt 触发，调用方 `rounds++` 后继续下一轮
 * - `continue`：本轮触发 halt 且尚未注入打断指令——已注入并放行一轮收尾，调用方 `rounds++` 后 continue
 * - `break`：收尾轮仍触发循环——硬切断，调用方 `rounds++` 后 break
 *
 * 调用方统一负责 `rounds++`（原实现三条路径各自 `rounds++` 一次，等价）。
 */
export type GuardrailVerdict = 'none' | 'continue' | 'break'

export function evaluateToolGuardrails(
  state: TurnGuardrailState,
  execResults: ToolExecResult[],
  ctx: GuardrailContext
): GuardrailVerdict {
  const { conversation, timedOutTools, managedHandoffs, round } = ctx
  const hint = (code: string, text: string): void =>
    pushGuardrailHint(state, conversation, code, text)

  // 工具超时提示：超时是有代价的等待——注入一次提醒，让 AI 看诊断原因再决策，
  // 而非原样重试（重试=再等一个完整超时周期，正是用户感知「一直等」的来源）。
  // 语义区分：托管工具（run_command/code_run）超时不打断，转后台继续跑——注入
  // 单独提示引导用 tool_watch/tool_stop 接管；强杀工具（文件/查询等）仍按原提示。
  if (!state.halted && timedOutTools.length > 0) {
    hint(
      'tool_timeout',
      `本回合有工具执行超时被中止：${timedOutTools.join('、')}。超时结果里已附原因与耗时，` +
        `请先看清再行动——外层 30s 是对话保护墙，长命令应拆成可分段的小步骤或换方案` +
        `（传更大的 timeoutMs 无效，那是工具内部计时，跨不过外层墙），不要盲目重复同一调用。`
    )
  }
  if (!state.halted && managedHandoffs.length > 0) {
    for (const h of managedHandoffs) {
      hint(
        `tool_handoff_${h.taskId}`,
        `工具「${h.toolName}」已超过外墙阈值转入后台继续运行（未中断，taskId=${h.taskId}）。` +
          `用 tool_watch(taskId="${h.taskId}", waitMs) 设定检查时间取结果：完成即返回最终结果；` +
          `到期仍 running 可再设更长 waitMs 继续检查，或 tool_stop(taskId="${h.taskId}") 主动停止。`
      )
    }
  }

  // ── loop_caps：runaway 上限（先计数，超限软提示；不硬 break，交给 maxRounds 兜底）──
  for (const r of execResults) {
    if (r.toolName === 'web_search') state.turnWebSearchCount++
    else if (isSubAgentish(r.toolName)) state.turnSubAgentCount++
  }
  if (!state.halted && state.turnWebSearchCount >= LOOP_CAP.webSearchPerRound) {
    hint(
      'loop_web_search_cap',
      `本轮 web_search 已达 ${LOOP_CAP.webSearchPerRound} 次上限，疑似搜索风暴。停止再搜，结合已拿到的结果直接推进或回答。`
    )
  }
  if (!state.halted && state.turnSubAgentCount >= LOOP_CAP.subAgentPerRound) {
    hint(
      'loop_subagent_cap',
      `本轮已启动 ${LOOP_CAP.subAgentPerRound} 次子 agent / 团队，疑似委派风暴。停止再启动新成员，基于现有结果汇总或收尾。`
    )
  }

  // ── 失败类：exact_failure（同指纹）+ same_tool_failure（同工具）──
  if (!state.halted) {
    for (const r of execResults) {
      const failed = isFailureResult(r.result)
      const fp = failureFingerprint(r.toolName, r.tc.function.arguments ?? {})
      if (failed) {
        // exact：同工具+同参数失败
        const n = (state.toolFailureCounts.get(fp) ?? 0) + 1
        state.toolFailureCounts.set(fp, n)
        if (n >= TOOL_FAILURE_HALT) {
          state.halted = true
          break
        }
        // same_tool：同工具失败（参数可变也累计），换参数仍失败也要警觉
        const sn = (state.sameToolFailure.get(r.toolName) ?? 0) + 1
        state.sameToolFailure.set(r.toolName, sn)
        if (sn === 2) {
          hint(
            'same_tool_failure_warning',
            `${r.toolName} 已连续 ${sn} 次失败（参数不同也算）。换一种工具或换整体思路，不要继续撞同一堵墙。`
          )
        } else if (sn >= 4) {
          state.halted = true
          break
        }
        state.noProgress.delete(fp)
      } else {
        // 成功：重置失败计数
        state.toolFailureCounts.delete(fp)
        state.sameToolFailure.delete(r.toolName)
        // ── idempotent_no_progress：读类工具结果 hash 相同=无进展 ──
        if (IDEMPOTENT_TOOLS.has(r.toolName)) {
          const h = resultHash(r.result)
          const prev = state.noProgress.get(fp)
          let count = 1
          if (prev && prev.hash === h) count = prev.count + 1
          state.noProgress.set(fp, { hash: h, count })
          if (!state.halted && count >= 3) {
            hint(
              'idempotent_no_progress_warning',
              `${r.toolName} 已返回相同结果 ${count} 次（无进展）。不要再重复同一查询，用已拿到的结果推进，或换一个真正不同的查询/目标。`
            )
          }
          if (count >= 6) {
            state.halted = true
            break
          }
        } else {
          state.noProgress.delete(fp)
        }
      }
    }
  }

  // 硬 halt：先注入打断指令并放行一轮收尾，让模型真正产出最终回答（经 onToken 流式推给前端），
  // 避免「断了但没输出」（原实现注入后立即 break，模型从未读到指令 → 空输出）。
  // 若收尾轮仍触发循环，则硬切断（有界：最多多给一轮）。
  if (state.halted) {
    if (!state.haltInjected) {
      state.haltInjected = true
      console.warn(`[llm] 🔇 检测到工具循环（失败/无进展）已达阈值，注入收尾指令 round=${round}`)
      conversation.push({
        role: 'user',
        content:
          '（系统检测：你已连续多次重复调用工具且无实质进展（失败循环或返回相同结果），陷入死循环。' +
          '不要再重复这些无效调用。结合已掌握的现状输出最终回答结束任务；' +
          '若确实需要用户输入、授权或网络问题，明确向用户说明，不要空转。）'
      })
      // 放行一轮：不立刻 break，让模型下一轮生成最终回答（走 onDone 自然收尾，保留生成文本）
      state.halted = false
      return 'continue'
    }
    console.warn(`[llm] 🔇 收尾轮仍触发工具循环，硬切断 round=${round}`)
    state.hardHalted = true
    return 'break'
  }

  return 'none'
}
