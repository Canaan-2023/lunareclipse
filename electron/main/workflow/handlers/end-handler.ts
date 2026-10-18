/**
 * L8 工作流引擎：end 节点处理器（仅 Workflow）
 *
 *
 *
 * 职责：终止工作流，输出最终结果
 *
 * 行为：
 * - 解析 output 模板变量
 * - 发 wf:completed 事件（前端显示工作流完成 + 最终输出）
 * - 返回 output 作为最终结果
 * - 引擎在 handler 返回后检查 node.type === 'end'，标记实例 completed，停止循环
 *
 * 与 answer 节点的区别：
 * - end：Workflow 专用，输出后终止整个工作流
 * - answer：Chatflow 专用，回复后暂停等用户继续对话
 *
 * raw_memory：
 * - Workflow 模式的 end 节点输出不直接走 stream，但前面的 llm 节点（stream=true）已经写过 raw_memory
 * - 如果 end 节点需要写 raw_memory，由上层 manager 在实例完成时按需补写（可选）
 * 为什么存在：Workflow 需要显式终止节点来产出最终结果并触发完成事件，故独立 end 处理器与 answer 区分语义。
 */
import type { NodeHandler, NodeHandlerContext, EndConfig } from '@shared/workflow/types'
import { validateConfig } from './validate'

export class EndHandler implements NodeHandler {
  async handle(ctx: NodeHandlerContext): Promise<{ output: string }> {
    const config = validateConfig<EndConfig>(ctx.node, ['output'])
    const instance = ctx.instance

    // 仅 Workflow 模式允许 end 节点
    if (instance.mode !== 'workflow') {
      throw new Error('end 节点仅 Workflow 模式可用，Chatflow 模式请用 answer 节点')
    }

    // 解析 output 模板变量
    const output = ctx.resolveTemplate(config.output)

    // 发 wf:completed 事件
    ctx.emit({ type: 'wf:completed', instanceId: instance.id, output })

    return { output }
  }
}
