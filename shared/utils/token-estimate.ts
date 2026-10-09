/**
 * token 快速估算工具（shared）。
 * 为什么存在：上下文窗口截断、摘要阈值与 token 预算判断需要低成本估算，前后端共用同一算法
 * 避免口径分叉。
 * 作用：导出 estimateTokens / estimateTokensByLength / estimateMessagesTokens 与 FIFO 截断
 * truncateByFifo 及 TruncateResult。
 */
const AVG_CHARS_PER_TOKEN_EN = 4
const AVG_CHARS_PER_TOKEN_ZH = 1.6
const AVG_CHARS_PER_TOKEN_BLEND = (AVG_CHARS_PER_TOKEN_EN + AVG_CHARS_PER_TOKEN_ZH) / 2

/**
 * 估算文本 token 数。
 * 接受 string | null | undefined——null/空串返回 0（ApiMessage.content 可为 null）。
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0
  let asciiChars = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) asciiChars++
  }
  const nonAsciiChars = text.length - asciiChars
  return Math.ceil(asciiChars / AVG_CHARS_PER_TOKEN_EN + nonAsciiChars / AVG_CHARS_PER_TOKEN_ZH)
}

/**
 * 基于字符串长度的快速 token 估算（无字符扫描）。
 * 用于大拼接字符串的阈值判断——足够精确以决定是否需要精确估算。
 */
export function estimateTokensByLength(text: string | null | undefined): number {
  if (!text) return 0
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN_BLEND)
}

export function estimateMessagesTokens(messages: { content: string | null }[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

/**
 * FIFO 截断结果
 * - messages: 保留的消息（system + 部分 non-system，正序）
 * - droppedCount: 被截断的消息数
 * - droppedMessages: 被截断的消息列表（扫描这些消息的折叠标记，递归删除 detail 文件）
 *
 * content 类型为 string | null，对齐 ApiMessage（LLM 返回的 assistant 消息 content 可为 null）。
 */
export interface TruncateResult {
  messages: { role: string; content: string | null }[]
  droppedCount: number
  droppedMessages: { role: string; content: string | null }[]
}

export function truncateByFifo(
  messages: { role: string; content: string | null }[],
  budgetTokens: number,
  reservedForReply = 1024
): TruncateResult {
  if (budgetTokens <= 0) return { messages, droppedCount: 0, droppedMessages: [] }
  const available = budgetTokens - reservedForReply
  if (available <= 0) return { messages: [], droppedCount: messages.length, droppedMessages: messages }

  const systemMsgs: { role: string; content: string | null }[] = []
  const nonSystem: { role: string; content: string | null }[] = []
  for (const m of messages) {
    if (m.role === 'system') systemMsgs.push(m)
    else nonSystem.push(m)
  }

  const systemTokens = systemMsgs.reduce((s, m) => s + estimateTokens(m.content), 0)
  let remaining = available - systemTokens

  const keptNonSystem: { role: string; content: string | null }[] = []
  const droppedMsgs: { role: string; content: string | null }[] = []
  let budgetExceeded = false

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msg = nonSystem[i]
    const t = estimateTokens(msg.content)
    if (remaining - t < 0) {
      budgetExceeded = true
      for (let j = i; j >= 0; j--) {
        droppedMsgs.unshift(nonSystem[j])
      }
      break
    }
    remaining -= t
    keptNonSystem.unshift(msg)
  }

  const ordered = [...systemMsgs, ...keptNonSystem]
  return {
    messages: ordered,
    droppedCount: budgetExceeded ? droppedMsgs.length : 0,
    droppedMessages: droppedMsgs
  }
}
