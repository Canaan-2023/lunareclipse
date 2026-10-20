/**
 * AUTO 模型热切换共享类型。
 * 为什么存在：交接单 §8 要求「AI 按复杂度热切换模型」，且 §8.5 明确「配置形状 → shared/types（双端可达）」——
 * 设置页与主进程策略引擎必须共享同一形状，避免字段漂移。
 * 作用：定义模型池条目、AUTO 配置、判定特征与裁决结论。
 *
 * 硬约束（§8.2，逐条对应实现）：
 * - 粒度 = **工具轮 / 续接轮**（SSE 流一旦开始不能换模型）——决策点只在「每轮建流前」；
 * - 最小驻留轮数（换模型打断前缀缓存）；
 * - **模型池必须按回传口径分组**（DeepSeek 要求回传 `reasoning_content`，其他网关不认该字段），
 *   禁止在同一会话历史里跨口径切换——分组键见 `resolveReasoningProfile(baseURL).id`；
 * - 目标模型不可用 → 回落默认并记日志。
 */

/** 模型定位标签：决定「什么场景选它」。 */
export type ModelTier = 'fast' | 'strong' | 'reasoning'

/** 模型池条目（候选来自提供商 `/v1/models`，由用户勾选成池）。 */
export interface ModelPoolEntry {
  /** 模型 id（须在提供商模型列表中存在） */
  id: string
  /** 定位标签：fast=执行/工具轮；strong=规划/检验/收尾；reasoning=深推理 */
  tier: ModelTier
  /** 是否参与 AUTO 选择（未勾选不进池） */
  enabled: boolean
}

/** AUTO 模型热切换配置（AppConfig.modelRouter）。 */
export interface ModelRouterConfig {
  /** AUTO 总开关；false 时恒用 `config.llm.model` */
  enabled: boolean
  /** 模型池（同一提供商内勾选的子集） */
  pool: ModelPoolEntry[]
  /** 钉死模型：非空则 AUTO 不生效（用户显式指定） */
  pinModel?: string
  /** 最小驻留轮数：换模型会打断前缀缓存，至少连续 N 轮不切（默认 2） */
  minDwellRounds?: number
}

/**
 * 判定输入（§8.3）。**只列「决策点（每轮建流前）真实可得」的特征**——
 * 不可得的（如上下文 token 占比，需从 server 侧穿透）标为可选，缺省即不参与判定。
 */
export interface RouterFeatures {
  /** 当前轮序号（从 1 起） */
  round: number
  /** 上一轮的工具调用数 */
  prevToolCalls: number
  /** 上一轮工具失败数 */
  prevToolFailures: number
  /** 护栏是否已触发（同工具连续失败 / 无进展等） */
  guardrailActive: boolean
  /** 用户消息长度（字符） */
  userMessageLength: number
  /** 上下文 token 占比 0~1；null = 不可得（当前未穿透，见 ADR-15） */
  contextRatio: number | null
}

/** 裁决结论（可观测：进切换审计）。 */
export interface RouterDecision {
  /** 本轮使用的模型 id */
  model: string
  /** 是否发生了切换 */
  switched: boolean
  /** 判定理由（进审计视图） */
  reason: string
  /** 目标定位（switched=false 时等于当前模型的定位或 'unknown'） */
  targetTier: ModelTier | 'unknown'
}
