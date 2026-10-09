/**
 * 模型能力解析：从模型名推断上下文窗口与最大输出 token（上下文预算与
 * 软裁剪的依据），三级策略——内置精确表 → 家族模糊推断 → 128k 兜底。
 * 独立成文件以便 llm / server 等多处复用同一口径的窗口估算。
 */
import type { ModelInfo } from '@shared/types'

// ===== 模型能力解析（三级策略）=====
// 一级 registry：内置精确表（主流已发布型号，前缀匹配覆盖带版本后缀的 id）
// 二级 infer：家族模糊推断（迁移自 server-utils.estimateModelWindow，保留旧行为）
// 三级 fallback：兜底 128000（现代模型普遍 128k，与旧行为一致）
//
// 数据说明：registry 窗口值为各厂商公开规格的常见型号数据，精确值以厂商官方文档为准；
// 本地/自建模型（ollama 等）实际窗口可能不同，由供应商探测或保守推断补齐（宁低勿高：
// 低估只是更早截断，高估会触发服务端 context_length_exceeded 报错）。
// 新模型发布后需随版本更新本表（参照 LiteLLM model_prices_and_context_window.json 的维护模式）。

export const FALLBACK_CONTEXT_WINDOW = 128000

/** 能力来源：registry=精确表命中 / infer=家族推断 / fallback=兜底 */
export type CapabilitySource = 'registry' | 'infer' | 'fallback'

export interface ResolvedCapability {
  contextWindow: number
  /** 最大输出 token（官方规格）；未知时省略，clamp 回退到窗口 */
  maxOutputTokens?: number
  source: CapabilitySource
}

interface RegistryRule {
  /** 小写前缀；模型 id 以此前缀开头即命中（覆盖 gpt-4o-2025-01-01 这类带版本后缀 id） */
  prefix: string
  cap: ResolvedCapability
}

/** 内置模型能力表：前缀匹配优先最长命中，顺序即优先级（长前缀需排在同前缀短项之前或由匹配逻辑保证最长命中） */
const MODEL_REGISTRY: RegistryRule[] = [
  // ---- OpenAI ----
  { prefix: 'gpt-4o-mini', cap: { contextWindow: 128000, maxOutputTokens: 16384, source: 'registry' } },
  { prefix: 'gpt-4o', cap: { contextWindow: 128000, maxOutputTokens: 16384, source: 'registry' } },
  { prefix: 'gpt-4.1-mini', cap: { contextWindow: 1047576, maxOutputTokens: 32768, source: 'registry' } },
  { prefix: 'gpt-4.1-nano', cap: { contextWindow: 1047576, source: 'registry' } },
  { prefix: 'gpt-4.1', cap: { contextWindow: 1047576, maxOutputTokens: 32768, source: 'registry' } },
  { prefix: 'gpt-4-turbo', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'gpt-4.5', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'gpt-5-mini', cap: { contextWindow: 400000, source: 'registry' } },
  { prefix: 'gpt-5', cap: { contextWindow: 400000, source: 'registry' } },
  { prefix: 'o4-mini', cap: { contextWindow: 200000, source: 'registry' } },
  { prefix: 'o3-mini', cap: { contextWindow: 200000, source: 'registry' } },
  { prefix: 'o3', cap: { contextWindow: 200000, source: 'registry' } },
  { prefix: 'o1-mini', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'o1', cap: { contextWindow: 200000, maxOutputTokens: 100000, source: 'registry' } },
  { prefix: 'codex', cap: { contextWindow: 128000, source: 'registry' } },
  // ---- Anthropic ----
  { prefix: 'claude-3-7-sonnet', cap: { contextWindow: 200000, maxOutputTokens: 64000, source: 'registry' } },
  { prefix: 'claude-3-5-sonnet', cap: { contextWindow: 200000, maxOutputTokens: 64000, source: 'registry' } },
  { prefix: 'claude-sonnet-4', cap: { contextWindow: 200000, maxOutputTokens: 64000, source: 'registry' } },
  { prefix: 'claude-opus-4', cap: { contextWindow: 200000, source: 'registry' } },
  // ---- Google ----
  { prefix: 'gemini-2.5-flash', cap: { contextWindow: 1000000, source: 'registry' } },
  { prefix: 'gemini-2.5-pro', cap: { contextWindow: 1000000, source: 'registry' } },
  { prefix: 'gemini-2.0-flash', cap: { contextWindow: 1000000, source: 'registry' } },
  { prefix: 'gemini-1.5-flash', cap: { contextWindow: 1000000, source: 'registry' } },
  { prefix: 'gemini-1.5-pro', cap: { contextWindow: 1000000, source: 'registry' } },
  // ---- DeepSeek ----
  // deepseek-v4-flash 上下文极限 1M（实测值——原 128000 导致软预算 6.4 万过早截断丢工具结果；
  // 社区/官方规格标注 1M 窗口，按实际窗口登记才能让 1/4 存储阈值与注入预算对齐）
  { prefix: 'deepseek-v4-flash', cap: { contextWindow: 1000000, source: 'registry' } },
  { prefix: 'deepseek-v4', cap: { contextWindow: 1000000, source: 'registry' } },
  { prefix: 'deepseek-chat', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'deepseek-reasoner', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'deepseek-r1', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'deepseek-v3', cap: { contextWindow: 128000, source: 'registry' } },
  // ---- Qwen / 通义 ----
  { prefix: 'qwen3-max', cap: { contextWindow: 131072, source: 'registry' } },
  { prefix: 'qwen3-235b', cap: { contextWindow: 131072, source: 'registry' } },
  { prefix: 'qwen2.5-72b', cap: { contextWindow: 131072, source: 'registry' } },
  { prefix: 'qwen2.5-32b', cap: { contextWindow: 131072, source: 'registry' } },
  { prefix: 'qwen-max', cap: { contextWindow: 131072, source: 'registry' } },
  { prefix: 'qwen-plus', cap: { contextWindow: 131072, source: 'registry' } },
  { prefix: 'qwen-turbo', cap: { contextWindow: 131072, source: 'registry' } },
  // ---- Kimi / Moonshot ----
  { prefix: 'kimi-k2', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'moonshot-v1-128k', cap: { contextWindow: 128000, source: 'registry' } },
  // ---- GLM / 智谱 ----
  { prefix: 'glm-4.5', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'glm-4', cap: { contextWindow: 128000, source: 'registry' } },
  // ---- Llama / Mistral ----
  { prefix: 'llama-3.3', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'llama-3.2', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'llama-3.1', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'mistral-large', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'mistral-small', cap: { contextWindow: 128000, source: 'registry' } },
  { prefix: 'mixtral', cap: { contextWindow: 32768, source: 'registry' } }
]

/** 最长前缀命中：遍历注册表取前缀长度最大的匹配（gpt-4o-mini 优先于 gpt-4o） */
function lookupRegistry(modelId: string): RegistryRule | null {
  let best: RegistryRule | null = null
  for (const rule of MODEL_REGISTRY) {
    if (modelId.startsWith(rule.prefix)) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule
    }
  }
  return best
}

/** 二级 infer：家族模糊推断（保持 server-utils.estimateModelWindow 的既有行为） */
function inferFamilyWindow(modelId: string): number {
  const m = modelId
  if (m.includes('deepseek')) return 1000000
  if (m.includes('qwen') || m.includes('qwq'))
    return m.includes('72b') || m.includes('32b') || m.includes('max') ? 128000 : 32000
  if (
    m.includes('gpt-4') ||
    m.includes('gpt-5') ||
    m.includes('o1') ||
    m.includes('o3') ||
    m.includes('codex')
  )
    return 128000
  if (m.includes('claude') || m.includes('sonnet') || m.includes('opus') || m.includes('haiku'))
    return 200000
  if (m.includes('glm')) return 128000
  if (m.includes('gemini')) return 1000000
  if (m.includes('kimi') || m.includes('moonshot')) return 128000
  if (m.includes('llama') || m.includes('mistral') || m.includes('mixtral')) return 128000
  return FALLBACK_CONTEXT_WINDOW
}

/**
 * 解析模型能力：registry 精确命中 → 家族推断 → 兜底 128000。
 * 返回的 maxOutputTokens 仅在 registry 有官方规格时存在；clamp 时缺失则回退窗口。
 */
export function resolveModelCapability(model: string | undefined | null): ResolvedCapability {
  const id = (model ?? '').trim().toLowerCase()
  if (!id) return { contextWindow: FALLBACK_CONTEXT_WINDOW, source: 'fallback' }
  const hit = lookupRegistry(id)
  if (hit) return hit.cap
  const window = inferFamilyWindow(id)
  return { contextWindow: window, source: window === FALLBACK_CONTEXT_WINDOW ? 'fallback' : 'infer' }
}

/**
 * 批量解析：把模型 id 列表映射为能力信息（listModels 扩展用）。
 * registry/infer 均无 IO，同步完成；供应商探测（ollama show 等）留给后续探测扩展层。
 */
export function resolveModelCapabilities(ids: string[]): ModelInfo[] {
  return ids.map((id) => {
    const cap = resolveModelCapability(id)
    return {
      id,
      contextWindow: cap.contextWindow,
      ...(cap.maxOutputTokens != null ? { maxOutputTokens: cap.maxOutputTokens } : {}),
      source: cap.source
    } satisfies ModelInfo
  })
}

// ===== clamp 限幅纯函数（config:set 写入侧校验用）=====

/** 上下文预算下限：与 resolveSoftBudget 的 16000 保底一致，避免设到对任何模型都无意义的小值 */
export const MIN_TOKEN_BUDGET = 16000
/** contextWindow.chars（token 模式）下限：与前端 CharacterSection min=500 一致，防止 0 清空上下文 */
export const MIN_CONTEXT_CHARS = 500

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** tokenBudget 限幅：[16000, 模型窗口]；null 保留（未显式配置，走软预算） */
export function clampTokenBudget(value: number | null, window: number): number | null {
  if (value == null) return null
  return clampNumber(value, MIN_TOKEN_BUDGET, Math.max(MIN_TOKEN_BUDGET, window))
}

/** contextWindow.chars（token 模式）限幅：[500, 模型窗口]；null 保留 */
export function clampContextChars(value: number | null, window: number): number | null {
  if (value == null) return null
  return clampNumber(value, MIN_CONTEXT_CHARS, Math.max(MIN_CONTEXT_CHARS, window))
}

/** maxTokens 限幅：[1, min(窗口, 官方输出上限)]；null 保留（不设输出上限） */
export function clampMaxTokens(
  value: number | null,
  window: number,
  maxOutputTokens?: number
): number | null {
  if (value == null) return null
  const upper = maxOutputTokens != null ? Math.min(window, maxOutputTokens) : window
  return clampNumber(value, 1, Math.max(1, upper))
}

/** 按模型解析结果 clamp 单个 LLM 配置里的 maxTokens（会话配置用） */
export function clampLlmMaxTokens(
  maxTokens: number | null,
  model: string | undefined | null
): number | null {
  const cap = resolveModelCapability(model)
  return clampMaxTokens(maxTokens, cap.contextWindow, cap.maxOutputTokens)
}