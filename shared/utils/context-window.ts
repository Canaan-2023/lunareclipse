/**
 * 上下文窗口截断（前后端共用）。
 * 为什么存在：LLM 上下文窗口有 token 预算上限，超限会话必须按策略截断；且 AI 实际看到的
 * 消息与 UI 显示的消息必须保持一致（机制见下方原注释）。
 * 作用：导出 truncateConversation 及截断结果类型。
 */
import type { ChatMessage, ContextWindowConfig } from '../types'
import { estimateMessagesTokens, estimateTokens } from './token-estimate'

/**
 * 上下文窗口截断（前后端共用）。

 * 后端 server.ts buildInjectedMessages 用此逻辑决定"AI 实际看到哪些消息"，
 * 前端 ChatArea 用同一函数决定"UI 显示哪些消息"——保证 UI 与 AI 上下文 100% 一致。

 * 调用方应传入"对话消息"（不含 system），本函数只处理 user/assistant；
 * system 消息由调用方自行保留（后端始终注入系统提示，前端 UI 不显示 system）。

 * 逻辑与 server.ts（pairs/chars/off 三模式 + token 双限制）保持一致，修改需两端同步。
 */
export interface TruncateConversationResult {
  /** 截断后保留的对话消息（正序） */
  kept: ChatMessage[]
  /** 被截断的消息数（用户可通过 UI 展开回看全量） */
  droppedCount: number
}

export function truncateConversation(
  convMsgs: ChatMessage[],
  cw: ContextWindowConfig
): TruncateConversationResult {
  if (cw.mode === 'off' || cw.pairs <= 0 && cw.chars <= 0) {
    return { kept: convMsgs, droppedCount: 0 }
  }

  let kept: ChatMessage[]

  if (cw.mode === 'pairs' && cw.pairs > 0) {
    // 保留最后 pairs*2 条对话消息（1 对 = user + assistant）
    const keepCount = Math.min(convMsgs.length, cw.pairs * 2)
    kept = convMsgs.slice(-keepCount)
    // token 双限制：pairs 模式同时受 chars 上限约束（tokensMode 下 chars 含义为 token 数）
    if (cw.chars > 0) {
      const keptTokens = estimateMessagesTokens(kept)
      if (keptTokens > cw.chars) {
        // 从最近消息往前重新截断到 chars 以内（保持最新消息完整）
        const rekept: ChatMessage[] = []
        let totalTokens = 0
        for (let i = kept.length - 1; i >= 0; i--) {
          const msgTokens = estimateTokens(kept[i].content ?? '')
          if (totalTokens + msgTokens > cw.chars) break
          totalTokens += msgTokens
          rekept.unshift(kept[i])
        }
        kept = rekept
      }
    }
  } else if (cw.mode === 'chars' && cw.chars > 0) {
    // chars 模式按 token 估算从后往前收（chars 含义为 token 数）
    const rekept: ChatMessage[] = []
    let totalTokens = 0
    for (let i = convMsgs.length - 1; i >= 0; i--) {
      const msgTokens = estimateTokens(convMsgs[i].content ?? '')
      if (totalTokens + msgTokens > cw.chars) break
      totalTokens += msgTokens
      rekept.unshift(convMsgs[i])
    }
    kept = rekept
  } else {
    // off 或未命中模式：不截断
    kept = convMsgs
  }

  return {
    kept,
    droppedCount: convMsgs.length - kept.length
  }
}
