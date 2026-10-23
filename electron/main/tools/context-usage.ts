/**
 * 上下文用量查询工具：为什么存在——长任务中 AI 需要主动感知上下文占用，避免无意识
 * 塞爆窗口导致截断；用量估算依赖主进程侧的会话状态。
 * 作用：context_usage 经 ctx.getContextUsage() 回调返回当前会话上下文快照。
 */
import type { AnyTool, ToolResult, ToolContext, ContextUsageSnapshot } from './base-tool'

/**
 * context_usage 工具：AI 主动查询当前会话的上下文用量。

 * 让 AI 在长任务中主动感知用量：通过 ctx.getContextUsage() 回调（由 server.ts 注入，
 * 能访问 sessionStore + token 估算）。
 */
export class ContextUsageTool implements AnyTool {
  name = 'context_usage'
  description = `查询当前会话上下文用量（token 估算/预算/剩余/消息数）。返回：estimatedTokens（当前对话估算 token）、effectiveBudget（有效预算，未配置时系统软预算兜底）、usagePercent（0-100）、remainingTokens（剩余估算）、messageCount/conversationCount（消息数）。

何时用：长任务中不确定上下文是否快满 / 大量工具调用或长输出前确认剩余空间 / 收到上下文预算警告后。

注意：估算基于字符近似，非精确 token 计数，实际以模型窗口为准。`
  parameters = []

  async execute(_params: Record<string, unknown>, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.getContextUsage) {
      return { ok: false, error: '上下文用量查询不可用（当前环境未注入 getContextUsage）' }
    }
    const usage = ctx.getContextUsage()
    if (!usage) {
      return { ok: false, error: '无法获取上下文用量（会话不存在或未就绪）' }
    }
    return { ok: true, data: usage }
  }
}

/** 引用类型防未使用告警（类型仅用于文档） */
export type { ContextUsageSnapshot }
