/**
 * @category 工具
 * @summary 子代理：委托执行、预算控制与审批
 * @note 为什么存在：主对话需要把可拆分/可并行的子任务委托给独立上下文的子 agent 执行，
 * 避免长任务阻塞主对话；本模块是子 agent 能力的统一出口。
 */
export { SubAgentManager } from './manager'
export type {
  NamedTool,
  SubAgentLaunchOptions,
  SubAgentResult,
  ConcurrencyConfig,
  SubAgentExecuteFn,
  SubAgentEvent
} from './types'
