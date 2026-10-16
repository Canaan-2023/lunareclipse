/**
 * DMN 提问工具：为什么存在——DMN（对话数字体）流程中需要向用户提问取数，先冻结当前
 * 流程等待回答，是 DMN 交互闭环的必要一环。
 * 作用：dmn_ask_user 发起问题并冻结 DMN（freeze），获答后解冻继续流程。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface DmnAskUserParams {
  question: string
  context?: string
}

export class DmnAskUserTool implements Tool<DmnAskUserParams> {
  name = 'dmn_ask_user'
  description =
    'DMN 向用户提问，获取用户输入。参数：question（必填，问题内容）/ context（选填，问题上下文说明）。返回 { answer }，answer 是用户回答文本。问题显示在前端聊天界面，调用后进入冻结状态（心跳循环跳过该 DMN），用户回答后解冻继续。使用时机：DMN 遇到无法自主决策的情况时调用——如找不到合适 NNG 归档记忆（孤立记忆无归属）、无法判断两条记忆是否真的矛盾（证据不充分）、冲突不可逆需用户确认（如归档会丢失历史）、字段验证失败无法自动修正。能够自主判断时继续执行，不询问用户。'
  parameters = [
    { name: 'question', type: 'string' as const, description: '问题内容', required: true },
    { name: 'context', type: 'string' as const, description: '问题上下文说明（选填）', required: false }
  ]

  async execute(params: DmnAskUserParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.supervisor) {
      return { ok: false, error: 'ToolContext.supervisor 未初始化' }
    }
    if (!ctx.dmnId) {
      return { ok: false, error: 'ToolContext.dmnId 未初始化' }
    }
    if (!params.question || params.question.trim().length === 0) {
      return { ok: false, error: 'question 不能为空' }
    }
    try {
      const answer = await ctx.supervisor.freeze_manager.freeze(
        ctx.dmnId,
        params.question,
        params.context,
        ctx.sessionId ?? null
      )
      return { ok: true, data: { answer } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}
