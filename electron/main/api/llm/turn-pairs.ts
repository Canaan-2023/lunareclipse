/**
 * @category API
 * @summary 蒸馏意图组装：把「该工具调用前最近 N 对历史对话」按完整消息形态快照成文本
 *
 * 为什么独立成模块：`buildTurnPairsIntent` 是**纯函数**（无类状态、无 IO），却被工具循环
 * （`llm.ts` 的 `streamWithTools`）与单测同时消费；留在 1676 行的 `llm.ts` 里会让
 * 「按对话对取历史」这条语义规则与类实现耦合（ADR-03 阶段 1 的首次外移）。
 *
 * 什么作用：给定消息数组、tool 消息下标与回溯对数，返回拼接好的历史文本；`pairs <= 0` 返回空串。
 *
 * 不删理由：蒸馏器的相关性判定完全依赖这份上下文——删掉即蒸馏退化为「无背景摘要」。
 */
import type { ToolCallResult } from '../llm-types'

/**
 * 组装蒸馏意图：该工具调用前最近 N 对历史对话的**完整消息形态**快照。
 * 为什么按对话对而非字符数（用户要求，2026-10-07）：蒸馏 LLM 判断「这段结果对
 * 当前任务有没有用」的依据是「工具是在哪个对话背景下被调用的」——这是一个
 * 语义单元（一问一答）层面的信息；按字符硬切会把完整的一问一答割裂成残句，
 * 蒸馏器看到半句话无法判断相关性。按「对」取既保证每个上下文单元自洽，
 * 长度也随对话自然增长，与对话轮次节奏一致，且不再是魔法数字。
 * 为什么呈现完整形态而非只取 user/assistant 的 content（用户要求，2026-10-07 升级）：
 * 蒸馏 AI 看到的必须和调取工具的那个 AI 看到的一致——包括它当时的思考
 * （reasoning_content / reasoning）与输出（tool_calls 声明），以及此前轮次的工具
 * 消息链。旧实现只摘 content 文本，而调用侧 AI 的决策链恰恰在思考与工具声明里
 * （DeepSeek 系 content 常为空、正文在思考），蒸馏器看不到"为什么调、打算怎么用"，
 * 蒸馏结果自然偏离任务语义。升级后蒸馏器与调用者在同一视角上评估结果相关性，
 * 唯一差异是最终只保留蒸馏输出本身。
 * @param messages 完整会话（openai 消息格式；wire 副本含 reasoning/tool_calls/tool 消息）
 * @param upToIndex 该 tool 消息在会话中的下标（取它之前的历史，不含自身）
 * @param pairs 最多回溯的对话对数；<=0 返回空串（等同旧行为：不带历史上下文）
 */
export function buildTurnPairsIntent(
  messages: Array<{
    role: string
    content: string | null
    reasoning_content?: string
    reasoning?: string
    tool_call_id?: string
    tool_calls?: ToolCallResult[]
  }>,
  upToIndex: number,
  pairs: number
): string {
  if (pairs <= 0) return ''
  // 从后往前定位第 N 个 user 消息作为窗口起点（最近 N 个问答轮）；
  // 历史不足 N 对时从 0 开始尽量携带（宁多勿空）。窗口内每条消息按完整形态呈现：
  // system/协议段也保留（与调用者同视角），本 tool 原文（upToIndex 自身）除外。
  let userSeen = 0
  let start = 0
  for (let i = upToIndex - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    userSeen++
    if (userSeen === pairs) {
      start = i
      break
    }
  }
  const lines: string[] = []
  // system 消息始终携带（窗口起点按 user 回溯、可能跳过它们）：护栏协议段/角色设定
  // 是调用者 AI 恒定可见的上下文，蒸馏器缺了它就读不懂被包裹消息的语义；system 体量
  // 小、位置恒在对话最前，拼在最前与调用者视角一致。窗口内遍历时跳过已收集的 system。
  for (let i = 0; i < upToIndex; i++) {
    const m = messages[i]
    if (m.role !== 'system') continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (text.trim()) lines.push(`system: ${text}`)
  }
  for (let i = start; i < upToIndex; i++) {
    const m = messages[i]
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : ''
      if (text.trim()) lines.push(`tool${m.tool_call_id ? `(${m.tool_call_id})` : ''}: ${text}`)
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (text.trim()) lines.push(`${m.role}: ${text}`)
    // 思考：调用者 AI 决策链的主体（DeepSeek 系正文空、决策全在思考里），必须可见
    const thought = m.reasoning_content ?? m.reasoning
    if (thought && thought.trim()) lines.push(`assistant 思考: ${thought}`)
    // 工具调用声明：调用者 AI 当时的输出（决定调什么工具、传什么参数）
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        lines.push(`assistant 调用工具: ${tc.function.name}(${tc.function.arguments})`)
      }
    }
  }
  return lines.join('\n')
}
