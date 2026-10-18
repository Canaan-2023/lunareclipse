/**
 * @category 核心
 * @summary 上下文预算：注入用量估算帧 + 达阈值时向 AI 追加预算/用量提示
 *
 * 为什么独立成文件：预算提示是「AI 对上下文用量有感知」的唯一机制（平时不注入、只在用量达阈值
 * 时给信息性提醒），原先内联在 `stream-runner.ts` 的注入装配段。ADR-04 外移为纯装配步骤。
 *
 * 什么作用：`applyBudgetWarnings(deps)` 计算注入后总 token，写回估算容器、推一条 `token` 估算帧，
 * 并在用量达阈值时把提示消息追加进 `injectedMessages`（就地修改）。
 *
 * 不删理由：删掉即 AI 完全无用量感知（长任务不会提醒用户开新会话），且前端失去上下文占用指示。
 *
 * 阈值口径：配置了 tokenBudget 时按绝对预算（BUDGET_WARN_PERCENT）；未配置时按软预算
 * （SOFT_BUDGET_HINT_PERCENT 起提示、BUDGET_WARN_PERCENT 起警告）。预算 ≠ 任务——
 * 绝不因超预算而截断或拒绝（月蚀不设单次注入上限）。
 */
import { WebSocket } from 'ws'
import type { ChatMessage } from '@shared/types'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'
import type { StreamSession } from '../stream-session'

// 上下文预算警告阈值（tokenBudget 配置可用时按绝对预算、否则按软预算）：
// 使用率达到 BUDGET_WARN_PERCENT 才向 AI 注入警告消息（平时不注入，避免噪音）。
// SOFT_BUDGET_HINT_PERCENT：tokenBudget 未配置时，从该使用率起开始提示用量。
const BUDGET_WARN_PERCENT = 80
const SOFT_BUDGET_HINT_PERCENT = 60

export interface BudgetDeps {
  ws: WebSocket
  messageId: string
  streamSession: StreamSession
  /** 注入后消息数组（达阈值时就地追加提示） */
  injectedMessages: ChatMessage[]
  tokenBudget: number | null | undefined
  resolveSoftBudget: () => number
  lastInjectedEstimateRef: { current: number | null }
  droppedCount: number
}

export function applyBudgetWarnings(deps: BudgetDeps): void {
  const { ws, messageId, streamSession, injectedMessages, tokenBudget, resolveSoftBudget } = deps

  const totalTokens = estimateMessagesTokens(injectedMessages)
  deps.lastInjectedEstimateRef.current = totalTokens
  if (streamSession.isOpen(ws)) {
    streamSession.push(
      ws,
      JSON.stringify({
        type: 'token',
        messageId,
        tokens: totalTokens,
        budget: tokenBudget ?? null,
        dropped: deps.droppedCount
      })
    )
  }

  if (tokenBudget && tokenBudget > 0) {
    const remaining = Math.max(0, tokenBudget - totalTokens)
    const usagePercent = Math.round((totalTokens / tokenBudget) * 100)
    // 预算≠任务——平时不注入预算消息，只在使用率达到 BUDGET_WARN_PERCENT 时给信息性提醒。
    // AI 需要时用 context_usage 自查。
    if (usagePercent >= BUDGET_WARN_PERCENT) {
      injectedMessages.push({
        id: `budget_${Date.now()}`,
        role: 'system',
        content: `【上下文预算警告】已用 ${totalTokens}/${tokenBudget} tokens（${usagePercent}%），剩余 ${remaining}。如需继续当前任务，请提醒用户开新会话。`,
        createdAt: Date.now()
      })
    }
    return
  }

  // tokenBudget 未配置：用软预算兜底提示（防止 AI 对上下文用量完全无感）
  const usagePercent = Math.round((totalTokens / resolveSoftBudget()) * 100)
  if (usagePercent >= SOFT_BUDGET_HINT_PERCENT) {
    const remaining = Math.max(0, resolveSoftBudget() - totalTokens)
    const hint =
      usagePercent >= BUDGET_WARN_PERCENT
        ? `【上下文预算警告（软预算）】当前对话约 ${totalTokens} tokens，软预算 ${resolveSoftBudget()}（${usagePercent}%），剩余 ${remaining}。请提醒用户开新会话。`
        : `【上下文用量】当前对话约 ${totalTokens} tokens（软预算 ${resolveSoftBudget()} 的 ${usagePercent}%）。长任务注意用 context_usage 工具自查用量。`
    injectedMessages.push({
      id: `budget_${Date.now()}`,
      role: 'system',
      content: hint,
      createdAt: Date.now()
    })
  }
}
