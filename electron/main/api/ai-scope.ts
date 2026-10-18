/**
 * @category 核心
 * @summary 会话 → AI 作用域解析（唯一入口）：会话 aiId 合法则用之，缺失回落月蚀并**记审计**
 *
 * 为什么存在（ADR-25 §4.5 对 L2 的复核结论）：`resolveSessionAiId` 在会话缺 `aiId` 时回落
 * `DEFAULT_AI_ID`——**这不是 bug**：主会话（悬浮小窗 / 前端主链路）本就属月蚀 AI1，删掉回落会断主链路。
 * 但它同时是「多 AI 串味」的**信号**：会话确实存在却拿不到合法 aiId，说明有链路没把 aiId 带下来。
 * 故按 §4.5 的处置——**不删回落，加审计**：回落发生时留一条可观测记录。
 *
 * 为什么独立成模块而不是写在 `server.ts` 里：`api/server.ts` 在体量棘轮台账内（不得增行）；
 * 抽出来让宿主从 9 行内联函数降为 1 行委托，既补上审计又**净减行数**。
 *
 * 噪音口径（重要）：`sessionId` **缺省**（主会话）是最常见的正常调用，**不记**——否则每轮刷屏，
 * 审计信号被稀释。只有「会话 id 存在但取不到合法 aiId」与「读取抛错」两种情况才记。
 */
import type { SessionStore } from './session-store'
import { DEFAULT_AI_ID } from '@shared/types'

/**
 * 解析会话所属 AI 编号（多 AI P2）。
 * @param sessionId 会话 id；缺省（主会话）直接回落月蚀，不记审计
 * @param sessionStore 会话存储（读 meta 里的 aiId）
 * @returns 合法正整数 aiId；否则 `DEFAULT_AI_ID`
 */
export function resolveSessionAiIdWithAudit(sessionId: string | undefined, sessionStore: SessionStore): number {
  if (!sessionId) return DEFAULT_AI_ID
  try {
    const aiId = sessionStore.get(sessionId)?.aiId
    if (typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1) return aiId
    console.warn(
      `[ai-scope] 会话 ${sessionId} 无合法 aiId（${String(aiId)}），回落 AI${DEFAULT_AI_ID}（ADR-25 L2 审计：该链路未把 aiId 带下来）`
    )
    return DEFAULT_AI_ID
  } catch (err) {
    console.warn(`[ai-scope] 解析会话 ${sessionId} 的 aiId 失败，回落 AI${DEFAULT_AI_ID}：`, err)
    return DEFAULT_AI_ID
  }
}
