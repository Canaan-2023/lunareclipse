/**
 * @category ROOM
 * @summary 上一轮摘要：把「上次看到什么 / 说了什么 / 做了什么 / 为什么停」压成规划提示词的 `previous` 段
 *
 * 为什么存在：没有对比对象时每轮采集都像第一次睁眼——采集器看起来只是个摆设；有上一轮才能看出
 * 「环境变了没有」，采集才真正驱动下一轮决策。0.54.0 从 `runtime.ts` 拆出（体量红线 800 行棘轮），
 * 逻辑本身是纯函数：只读入参，不碰运行时闭包。
 *
 * 不删理由：删掉即规划提示词失去上一轮上下文，回到「每轮失忆」。
 */
import type { LoopTickResult, PlanDecision } from './loop'

export interface PreviousRoundInfo {
  note?: string
  reply?: string
  executions?: string[]
  collect?: string
  idleReason?: string
}

/**
 * 构造上一轮摘要；从未跑过任何一轮时返回 undefined（提示词里就不出现【上一轮】段）。
 *
 * **工具名按下标配对**：`ExecutorResult` 上只有裁决（tier/code/reason），没有工具名；
 * 执行器严格按 `decisions` 顺序执行，所以用 `decisions[i].toolName` 对齐第 i 个结果
 * （与 `summarizeExecutions` 同口径）。对齐不到时给「动作N」占位，不编造名字。
 */
export function buildPreviousRoundInfo(input: {
  lastTick: LoopTickResult | undefined
  lastPlan: PlanDecision | undefined
  lastReply: string | undefined
  /** 上一轮的采集快照（本轮采集前滚存下来的那份） */
  prevCollect: { text: string; at: number } | undefined
}): PreviousRoundInfo | undefined {
  const { lastTick, lastPlan, lastReply, prevCollect } = input
  if (!lastTick) return undefined
  const executions = lastTick.executions.map((e, i) => {
    const name = lastPlan?.decisions?.[i]?.toolName ?? `动作${i + 1}`
    return e.ok
      ? `${name} 成功`
      : `${name} 失败：${(e.result?.error ?? e.decision.reason ?? '未知原因').slice(0, 80)}`
  })
  return {
    ...(lastPlan?.note ? { note: lastPlan.note } : {}),
    ...(lastReply ? { reply: lastReply } : {}),
    ...(executions.length > 0 ? { executions } : {}),
    ...(prevCollect?.text ? { collect: prevCollect.text } : {}),
    ...(lastTick.idleReason ? { idleReason: lastTick.idleReason } : {})
  }
}
