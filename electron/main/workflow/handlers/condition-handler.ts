/**
 * L8 工作流引擎：condition 节点处理器
 *
 *
 *
 * 职责：条件分支节点本身不执行任何操作，引擎在调度层评估出边条件决定走哪条边
 *
 * 行为：
 * - 节点本身是 no-op，返回空 output
 * - 引擎在 executeNode 返回后，检查节点类型：
 * - 若是 condition 节点，按 edges 顺序评估出边的 condition 表达式，走第一个满足的
 * - 若所有条件都不满足，走 'default' 边，若无 default 边则报错
 *
 * 条件评估逻辑在 template-var.ts 的 evaluateCondition 实现，引擎调用
 * 为什么存在：条件分支的判定在引擎调度层统一进行，节点处理器保持 no-op 可让引擎对 7 类节点走同一执行路径。
 */
import type { NodeHandler, NodeHandlerContext } from '@shared/workflow/types'

export class ConditionHandler implements NodeHandler {
  async handle(_ctx: NodeHandlerContext): Promise<{ output: string }> {
    // condition 节点本身不执行任何操作，引擎调度层负责评估出边条件
    return { output: '' }
  }
}
