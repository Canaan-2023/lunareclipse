/**
 * LLM 层共享类型与异步上下文：流式回调、工具定义/调用结果、API 消息等
 * 契约类型，以及当前工具调用 id 的 AsyncLocalStorage 上下文——
 * 供 llm.ts 与 server / 子代理等调用方共同使用，避免循环依赖与类型重复。
 */
import { AsyncLocalStorage } from 'async_hooks'
import type { TokenUsage } from '@shared/types'

/**
 * 当前工具调用 id 的异步上下文（子 agent 事件关联主对话 Agent 工具卡）。
 * streamWithTools 执行工具前 run(tc.id, ...)，Agent 工具内部触发子 agent 时，
 * server.ts 的 launchSubAgent 闭包在此上下文中读到父工具的 toolCallId，
 * 作为 subagent_* 事件的 parentToolCallId 推给前端挂载。
 */
const toolCallStorage = new AsyncLocalStorage<string | null>()

/** 获取当前正在执行的工具调用 id（工具执行链外为 null） */
export function getCurrentToolCallId(): string | null {
  return toolCallStorage.getStore() ?? null
}

export { toolCallStorage }

/**
 * 当前工具执行的取消信号异步上下文。
 * 为什么存在：llm.ts 工具循环对每个调用设超时，超时后需要让工具本身感知取消；
 * 旧实现只 reject 外层 Promise，底层 tool.execute 仍在后台跑成孤儿（进程/请求泄漏），
 * 工具也无从优雅退出。
 * 作用：llm.ts 超时前 abort 此 signal；execute-tool 读出注入 ToolContext.signal，
 * 工具监听 abort 终止自身工作（当前 run_command 已接入并终止子进程树；
 * 其余长任务工具待接入——未接入者仍只会被外层放弃，不会真正取消）。
 * 留存理由：与 toolCallStorage 同为工具执行链的跨模块契约（一存 id、一存 signal）。
 */
const toolSignalStorage = new AsyncLocalStorage<AbortSignal>()

/** 获取当前工具执行的取消信号（工具执行链外为 undefined） */
export function getToolSignal(): AbortSignal | undefined {
  return toolSignalStorage.getStore()
}

export { toolSignalStorage }

export interface StreamCallbacks {
  onToken: (token: string) => void
  /** 支持 async：会话模式在 onDone 内做语言重试（await chatWithTools）后再推送 done */
  onDone: () => void | Promise<void>
  onError: (err: Error) => void
  onToolStart?: (toolName: string, toolCallId: string, args: Record<string, unknown>) => void
  onToolEnd?: (toolName: string, toolCallId: string, result: string) => void
  /** 深度思考 token（reasoning_content / thinking 字段，DeepSeek/QwQ/GLM-Z1 等） */
  onReasoning?: (token: string) => void
  /** token 用量（需 provider 支持流式 usage；DeepSeek 需 stream_options.include_usage） */
  onUsage?: (usage: TokenUsage) => void
  /**
   * 工具结果 LLM 蒸馏回调：大体积工具结果交给 LLM 提炼「有用信息」。
   * llm.ts 在每个工具轮执行完、下一轮请求构建前对当轮 tool 消息批量调用，
   * 蒸馏成功则用提炼摘要**直接替换** conversation 中对应 tool 消息的 content
   * （不落盘）；失败（返回空或抛错）重试一次，仍失败则保留原文进上下文。
   * - intent：蒸馏 LLM 可见的调用上下文——由 llm.ts 按 distillIntentTurnPairs
   * 从 conversation 组装「该工具调用前的完整对话形态」（窗口内含调用者思考
   * reasoning、工具调用声明 tool_calls 与此前工具消息链，与调取工具的那个 AI
   * 同视角；仅窗口宽受配置限制），蒸馏器据此判断「这段结果里哪些信息服务于
   * 本次调用的目的」，无则空串
   * - 返回提炼后的摘要文本 → 替换 tool 消息 content（重包消息来源护栏）
   * - 返回 undefined 表示未蒸馏（关闭/未达阈值/失败/重试仍失败）→ 保留原文
   */
  distillToolResult?: (
    toolName: string,
    toolCallId: string,
    result: string,
    intent?: string
  ) => Promise<string | undefined>
  /**
   * 蒸馏意图上下文对话对数量（intent 组装参数）：由服务端从 ToolResultDistillConfig
   * 注入（缺省走 DEFAULT_TOOL_RESULT_DISTILL.intentTurnPairs）。语义 = 蒸馏 LLM
   * 能看到该工具调用前最近多少对 user+assistant 历史会话；0 = 不提供历史上下文。
   */
  distillIntentTurnPairs?: number
}

export interface ToolExecutor {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute(args: Record<string, unknown>): Promise<string>
}

export interface ToolFunctionDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolDef {
  type: 'function'
  function: ToolFunctionDef
}

export interface ToolCallResult {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCallResult[]
  tool_call_id?: string
  /** 深度思考内容（内部字段名 reasoning；发往 DeepSeek 思考模式时必须改名 reasoning_content 回传，2026-08-26 修复） */
  reasoning?: string
}

export interface ChatWithToolsResult {
  content: string | null
  toolCalls: ToolCallResult[]
  finishReason: string
  /** 深度思考内容（DeepSeek 思考模式；多轮工具循环回传 assistant 消息时需带上） */
  reasoning?: string
  /** token 用量（provider 报告时才有；inputTokens 不含缓存命中） */
  usage?: TokenUsage
}

/**
 * 映射 provider 的 usage 到月蚀 TokenUsage（disjoint 计数，对齐参考实现 mapUsage）。
 * DeepSeek: prompt_tokens 含缓存命中（prompt_tokens = cache_hit + cache_miss），
 * 所以 inputTokens = prompt_tokens - cacheRead。OpenAI 兼容接口可能用
 * prompt_tokens_details.cached_tokens 或顶层 prompt_cache_hit_tokens 两种字段。
 */
export function mapUsage(
  usage:
    | {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
        prompt_cache_hit_tokens?: number
        completion_tokens_details?: { reasoning_tokens?: number }
      }
    | undefined
): TokenUsage | undefined {
  if (!usage) return undefined
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: (usage.prompt_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {})
  }
}