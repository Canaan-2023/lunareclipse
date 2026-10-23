/**
 * @category API
 * @summary `api/llm` 目录的公共 barrel：对外导出面与原 `api/llm.ts` 逐符号等价
 *
 * 为什么存在：ADR-03 把 1676 行的 `api/llm.ts` 目录化后，全部 22 个消费方的
 * `from './llm'` / `from '../api/llm'` 必须**逐字节不变**——`./llm` 解析到本文件（目录 index），
 * 消费方零改动。任何新增导出都要先确认有消费方，避免把内部实现细节透出。
 *
 * 什么作用：re-export `LLMClient`（壳）、`buildTurnPairsIntent`（蒸馏意图组装）、
 * `getCurrentToolCallId`（工具调用异步上下文）与 5 个契约类型。
 *
 * 不删理由：删掉即 `./llm` 失去解析目标（原 `api/llm.ts` 已删除），22 处 import 全部断裂。
 */
export { LLMClient } from './llm-client'
export { attachContextRatio } from './context-ratio'
export { buildTurnPairsIntent } from './turn-pairs'
export { getCurrentToolCallId } from '../llm-types'
export type {
  ApiMessage,
  ChatWithToolsResult,
  ToolCallResult,
  ToolDef,
  ToolExecutor
} from '../llm-types'
