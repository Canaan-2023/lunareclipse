/**
 * 评测配置共享类型。
 * 为什么存在：评测（judge 模型/成本阈值/人工评分）由主进程 Harness 执行、前端面板展示与
 * 配置，judge 与成本参数需两端共用同一契约（详见下方原注释）。
 * 作用：导出 EvalJudgeConfig、EvalCostThresholds、EvalConfig、DmnAgent。
 */
import type { LLMProvider } from './llm'
import type { ToolPolicy } from './tool-policy'

// ===== 评测配置 =====
// 纯数据类型，供前端 UI 和主进程共享。
// Harness 读取 AppConfig.eval 配置 judge 模型和成本阈值。

/** judge 模型配置（建议与 generator 不同家族，防 SPB） */
export interface EvalJudgeConfig {
  /** judge 模型名（建议与被评测 Agent 不同家族，规避评分自偏好） */
  model?: string
  /**
   * 独立 provider 配置（可选）：配置后 judge 使用独立的 LLMClient 实例，
   * 真正实现"不同模型家族防 SPB"（Self-Preference Bias）。
   * 未配置时复用 generator 的 LLMClient（仅 model 名不同，provider 相同）。

   * 注：judge 评分始终强制 temperature=0（ModelGrader 硬编码），
   * 不接受用户配置，保证评测可复现（文档 4.3 / 7.1 防偏见措施）。
   */
  provider?: LLMProvider
  baseURL?: string
  apiKey?: string
}

/** 成本/延迟阈值（cost_latency 轴） */
export interface EvalCostThresholds {
  /** 最大 token 数（input + output 总和） */
  maxTokens?: number
  /** 最大耗时（毫秒） */
  maxMs?: number
  /** 最大成本（USD） */
  maxCost?: number
}

/** 评测配置 */
export interface EvalConfig {
  /** judge 模型配置（默认 'claude-sonnet-4-5'，建议与 generator 不同家族） */
  judge?: EvalJudgeConfig
  /** 成本/延迟阈值（cost_latency 轴，未配置则用默认值） */
  costThresholds?: EvalCostThresholds
  /** 是否在 CI 中自动运行：PR 提交时执行评测并计入回归门禁 */
  ciEnabled?: boolean
  /** 回归套件通过率门禁（0-1，低于此值阻断合并。默认 0.95） */
  regressionGate?: number
}

/** 单个 DMN agent 配置
 *
 * description 仅用于 UI 显示。*/
export interface DmnAgent {
  description: string
  toolPolicy: Record<string, ToolPolicy>
}