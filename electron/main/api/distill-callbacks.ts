/**
 * @category 核心
 * @summary 工具结果 LLM 蒸馏回调工厂（主会话流式 / 无头会话 / 子 agent 三处共用）
 * @note 为什么存在：蒸馏口径（成功替换原文、失败重试一次仍失败保留原文）必须三路径一致，
 * 且只依赖「当前 LLM 客户端 + 配置」两个注入点，故从宿主 `server.ts` 外移（ADR-02 第二轮）。
 * @note 不删理由：三处调用点若各自实现，行为漂移不会报错、只会静默让某条链路的上下文膨胀。
 */
import type { ConfigStore } from './config-store'
import type { LLMClient } from './llm'
import {
  ToolResultDistiller,
  DEFAULT_DISTILL_CONFIG,
  type DistillConfig
} from '../services/tool-result-distiller'

/** 蒸馏回调（注入 llm.ts 的 streamWithTools 选项） */
export interface DistillCallbacks {
  distillToolResult?: (
    toolName: string,
    toolCallId: string,
    result: string,
    intent?: string
  ) => Promise<string | undefined>
  distillIntentTurnPairs?: number
}

export interface DistillCallbacksDeps {
  llmClientRef: { current: LLMClient }
  configStore: ConfigStore
}

/**
 * 构造蒸馏回调工厂。
 * 蒸馏成功则摘要直接替换 conversation 中 tool 消息原文，失败重试一次仍失败保留原文，两路径行为一致。
 * distillIntentTurnPairs：意图上下文「对话对数量」随配置注入 —— llm.ts 依此组装
 * 该工具调用前最近 N 对历史会话作为蒸馏 LLM 的相关性判定上下文（0 = 不携带）。
 */
export function createDistillCallbacksFactory(deps: DistillCallbacksDeps): () => DistillCallbacks {
  const { llmClientRef, configStore } = deps
  const toolResultDistiller = new ToolResultDistiller(
    () => llmClientRef.current,
    (): DistillConfig => ({ ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) })
  )

  return (): DistillCallbacks => {
    // 与 distiller 构造处同一合并形态：用户配置优先、缺省回退单源默认
    const distillCfg: DistillConfig = { ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) }
    return {
      // intent（该工具调用前最近 N 对历史会话，由 llm.ts 组装后透传）用于蒸馏器评估相关性；
      // 意图参与缓存指纹，同一结果在不同任务背景下各得其所，不复用错配摘要
      distillToolResult: async (toolName: string, _toolCallId: string, result: string, intent?: string) =>
        (await toolResultDistiller.distill(toolName, result, intent)) ?? undefined,
      distillIntentTurnPairs: distillCfg.intentTurnPairs
    }
  }
}
