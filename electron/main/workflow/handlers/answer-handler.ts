/**
 * L8 工作流引擎：answer 节点处理器（仅 Chatflow）
 *
 *
 *
 * 职责：回复用户消息，暂停工作流等用户下一条消息
 *
 * 行为：
 * - 解析 content 模板变量
 * - 发 wf:answer 事件（前端把 content 作为 AI 回复显示）
 * - 返回 content 作为 output（写进 context）
 * - 引擎在 handler 返回后检查 node.type === 'answer' && mode === 'chatflow'，
 * 将 content 追加到 instance.messages（作为 assistant 消息），暂停实例（pauseReason='await_user'）
 * - 用户下一条消息到达时（通过 IPC workflow:continueChatflow），追加到 messages，引擎从下一节点继续
 *
 * 与 end 节点的区别：
 * - answer：Chatflow 专用，回复后暂停等用户继续对话
 * - end：Workflow 专用，输出后终止
 * 为什么存在：Chatflow 需要"回复后暂停、等用户下一条消息再续跑"的回合制语义，必须由独立 answer 节点处理器承载。
 */
import type { NodeHandler, NodeHandlerContext, AnswerConfig } from '@shared/workflow/types'
import { validateConfig } from './validate'

export class AnswerHandler implements NodeHandler {
  async handle(ctx: NodeHandlerContext): Promise<{ output: string }> {
    const config = validateConfig<AnswerConfig>(ctx.node, ['content'])
    const instance = ctx.instance

    // 仅 Chatflow 模式允许 answer 节点
    if (instance.mode !== 'chatflow') {
      throw new Error('answer 节点仅 Chatflow 模式可用，Workflow 模式请用 end 节点')
    }

    // 解析 content 模板变量
    const content = ctx.resolveTemplate(config.content)

    // 发 wf:answer 事件（前端把 content 作为 AI 回复显示）
    ctx.emit({ type: 'wf:answer', instanceId: instance.id, content, nodeId: ctx.node.id })

    // content 作为 output（引擎会把 content 追加到 instance.messages 作为 assistant 消息）
    return { output: content }
  }
}
