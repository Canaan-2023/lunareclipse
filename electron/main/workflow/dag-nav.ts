/**
 * L8 工作流引擎：DAG 图导航（纯函数）
 *
 * 从 engine.ts 拆分出来的图导航职责：
 * - findStartNode：确定起始节点（优先 template.startNode，否则无入边第一个节点）
 * - findNextNode：从当前节点找下一节点（condition 节点按边条件评估分支）
 *
 * 纯函数，无实例状态，便于单测。
 * 不删理由：engine.runLoop 的每步推进都依赖它定位下一节点；
 * 若内联回 engine.ts，图导航逻辑无法独立单测，且 condition 分支评估会与调度耦合。
 */
import type { WorkflowTemplate, WorkflowNode } from '@shared/workflow/types'
import { evaluateCondition } from './template-var'

/**
 * 找起始节点
 * 优先用 template.startNode，否则取无入边的第一个节点
 */
export function findStartNode(template: WorkflowTemplate): WorkflowNode | null {
  if (template.startNode) {
    const node = template.nodes.find((n) => n.id === template.startNode)
    if (node) return node
  }
  // 找无入边的节点
  const hasIncoming = new Set(template.edges.map((e) => e.to))
  for (const node of template.nodes) {
    if (!hasIncoming.has(node.id)) return node
  }
  return null
}

/**
 * 找下一节点
 *
 * - 普通节点：找 from=currentNodeId 的第一条边
 * - condition 节点：按 edges 顺序评估出边 condition，走第一个满足的
 * - 若所有条件都不满足，走 'default' 边
 * - 若无 default 边且无条件满足，返回 null（隐式结束）
 */
export function findNextNode(
  template: WorkflowTemplate,
  currentNodeId: string,
  context: Record<string, unknown>
): string | null {
  const currentNode = template.nodes.find((n) => n.id === currentNodeId)
  if (!currentNode) return null

  // 从当前节点出发的所有边
  const outgoingEdges = template.edges.filter((e) => e.from === currentNodeId)
  if (outgoingEdges.length === 0) return null

  // condition 节点：评估条件
  if (currentNode.type === 'condition') {
    // 先找满足条件的边
    for (const edge of outgoingEdges) {
      if (!edge.condition || edge.condition === 'default') continue
      if (evaluateCondition(edge.condition, context)) {
        return edge.to
      }
    }
    // 再找 default 边
    const defaultEdge = outgoingEdges.find((e) => !e.condition || e.condition === 'default')
    if (defaultEdge) return defaultEdge.to
    // 无满足条件且无 default
    return null
  }

  // 普通节点：走第一条边（若有多个出边，取第一个）
  // 注：普通节点多出边通常无意义，但允许（取第一条）
  return outgoingEdges[0].to
}