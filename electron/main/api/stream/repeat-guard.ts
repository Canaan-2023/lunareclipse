/**
 * @category 核心
 * @summary 跨轮输出复读判定（纯函数）：正文/思考流任一与上一轮 assistant 近似重复即判复读轮
 *
 * 为什么独立成文件：这段判定原内联在 `stream-runner.ts` 的 `onDone`（1356 行闭包）里，
 * 是「复读轮不写 RAW / 不落盘 / 不喂评论家 / 不续接」这条治理策略的唯一入口，
 * 零直测覆盖。ADR-04 把它外移为纯函数（无 ws/timer/store 依赖），可脱离 electron 逐条断言。
 *
 * 什么作用：`detectCrossTurnRepeat` 比较本轮 fullOutput/fullReasoning 与 messages 中
 * 上一条 assistant 消息（**排除 `partial_` 前缀的续接锚消息**），返回是否复读轮 + 两个分区命中位（供日志）。
 *
 * 不删理由：复读轮若被当正常轮落盘，历史里留下复读文本 → 自回归强化复读（模型下一轮看到自己
 * 上一轮的复读原话）。这条判定是「历史断链」的唯一实现。
 *
 * ⚠️ `partial_` 排除不可去掉（2026-09-27 评审确认的 MAJOR）：续接轮的 messages 尾部必含
 * partial（续接前全文），而本轮 fullOutput 是「续接前全文 + 新增」，天然互为子串；
 * 若 partial 参与比较，新增占比 ≤20% 即被判复读 → 续接轮整轮不落盘、有效新增内容丢失。
 */
import type { ChatMessage } from '@shared/types'

/** 参与复读比较的最小长度（太短无判别力，避免系统片段误判） */
export const REPEAT_MIN_CHARS = 50
/** 相似度阈值：归一化后 short/long ≥ 该比例且互为子串 → 判复读轮 */
export const REPEAT_SIMILAR_RATIO = 0.8

export interface RepeatVerdict {
  /** 是否复读轮（正文或思考流任一命中） */
  isRepeat: boolean
  bodySimilar: boolean
  thinkSimilar: boolean
}

const norm = (s: string): string => s.replace(/\s+/g, '')

function similar(cur: string, prev: string): boolean {
  if (cur.length < REPEAT_MIN_CHARS || prev.length < REPEAT_MIN_CHARS) return false
  const shorter = Math.min(cur.length, prev.length)
  const longer = Math.max(cur.length, prev.length)
  return (cur.includes(prev) || prev.includes(cur)) && longer > 0 && shorter / longer >= REPEAT_SIMILAR_RATIO
}

/**
 * 跨轮复读判定。
 * @param messages 本轮请求消息（用于取上一条 assistant 消息作为比较基准）
 * @param fullOutput 本轮正文全文
 * @param fullReasoning 本轮思考流全文
 */
export function detectCrossTurnRepeat(params: {
  messages: ChatMessage[]
  fullOutput: string
  fullReasoning: string
}): RepeatVerdict {
  const curText = norm(params.fullOutput || '')
  const curThink = norm(params.fullReasoning || '')
  // 上一轮 assistant 取尾部第一条——排除 partial_ 前缀的续接锚消息（见文件头警示）
  const prevAiMsg = [...params.messages]
    .reverse()
    .find(
      (m) => m.role === 'assistant' && !(typeof m.id === 'string' && m.id.startsWith('partial_'))
    )
  const prevContent = typeof prevAiMsg?.content === 'string' ? norm(prevAiMsg.content) : ''
  const prevThink = typeof prevAiMsg?.reasoning === 'string' ? norm(prevAiMsg.reasoning) : ''
  const bodySimilar = similar(curText, prevContent)
  const thinkSimilar = similar(curThink, prevThink)
  return { isRepeat: bodySimilar || thinkSimilar, bodySimilar, thinkSimilar }
}
