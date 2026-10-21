/**
 * L8 工作流引擎：节点处理器注册表



 * 7 种节点类型 → 7 个处理器的映射
 * 引擎调度时按 node.type 查找对应 handler
 * 为什么存在：引擎调度按 node.type 找处理器，集中注册 7 类映射可避免在调度主流程里散落 switch 分发。
 */
import type { NodeHandler, NodeType } from '@shared/workflow/types'
import { LlmHandler } from './llm-handler'
import { ToolHandler } from './tool-handler'
import { SkillHandler } from './skill-handler'
import { ConditionHandler } from './condition-handler'
import { HumanHandler } from './human-handler'
import { AnswerHandler } from './answer-handler'
import { EndHandler } from './end-handler'

export { LlmHandler, ToolHandler, SkillHandler, ConditionHandler, HumanHandler, AnswerHandler, EndHandler }

/** 节点类型 → 处理器实例映射 */
export const NODE_HANDLERS: Record<NodeType, NodeHandler> = {
  llm: new LlmHandler(),
  tool: new ToolHandler(),
  skill: new SkillHandler(),
  condition: new ConditionHandler(),
  human: new HumanHandler(),
  answer: new AnswerHandler(),
  end: new EndHandler()
}

/** 按节点类型获取处理器 */
export function getNodeHandler(type: NodeType): NodeHandler {
  const handler = NODE_HANDLERS[type]
  if (!handler) {
    throw new Error(`未知的节点类型: ${type}`)
  }
  return handler
}
