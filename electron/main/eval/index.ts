/**
 * @category 监控
 * @summary 评估：自动化评测套件与基线

 * 评测子系统对外统一入口：把「自动评测 + 通过率门禁」暴露给 IPC 与 CI 脚本，
 * 让能力验收和回归防护有集中出口。本文件汇总导出类型、三类评分器、
 * EvalHarness 工厂与套件注册表（按名加载套件）。
 */
/**
* 验证层：汇总导出

 * 评测机制：Task/Trial/Suite 三层任务模型 + 三类评分器（代码/模型/人工），
 * 与前端 AI 基线与 DMN 回归套件联动，输出通过率门禁供 CI 决策。

 * 导出内容：
 * - 类型：EvalTask / Transcript / TrialResult / SuiteResult / GradeResult 等
 * - 评分器：CodeGrader / ModelGrader / HumanGrader
 * - Harness：EvalHarness + createEvalHarness 工厂
 * - 套件：frontend-ai-baseline（quality）/ dmn-regression（regression）
 */

// 类型
export type {
  EvalAxis,
  GraderType,
  GradeResult,
  TrajectoryStep,
  Transcript,
  EvalTask,
  TrialResult,
  SuiteResult
} from './types'

// 评分器
export { CodeGrader } from './graders/code-grader'
export { ModelGrader } from './graders/model-grader'
export { HumanGrader } from './graders/human-grader'

// Harness
export { EvalHarness } from './harness'

// 套件
export { frontendAiBaselineSuite } from './suites/frontend-ai-baseline'
export { dmnRegressionSuite } from './suites/dmn-regression'

// 套件注册表（IPC 调用方按名查找）
import type { EvalTask } from './types'
import { frontendAiBaselineSuite } from './suites/frontend-ai-baseline'
import { dmnRegressionSuite } from './suites/dmn-regression'

export interface SuiteMeta {
  name: string
  kind: 'quality' | 'regression'
  count: number
}

export const SUITE_REGISTRY: Record<string, () => EvalTask[]> = {
  'frontend-ai-baseline': () => frontendAiBaselineSuite,
  'dmn-regression': () => dmnRegressionSuite
}

export function listSuites(): SuiteMeta[] {
  return [
    {
      name: 'frontend-ai-baseline',
      kind: 'quality',
      count: frontendAiBaselineSuite.length
    },
    {
      name: 'dmn-regression',
      kind: 'regression',
      count: dmnRegressionSuite.length
    }
  ]
}

export function loadSuite(name: string): EvalTask[] {
  const loader = SUITE_REGISTRY[name]
  if (!loader) throw new Error(`未知套件: ${name}`)
  return loader()
}

// ===== 工厂函数 =====
import type { LLMClient } from '../api/llm'
import type { ConfigStore } from '../api/config-store'
import type { ToolContext } from '../tools/base-tool'
import type { ToolRegistry } from '../tools'
import { EvalHarness } from './harness'

export interface EvalHarnessDeps {
  llmClient: LLMClient
  configStore: ConfigStore
  createToolRegistry: (ctx: ToolContext) => ToolRegistry
  /**
   * 独立 judge LLMClient（可选）：配置后 ModelGrader 用独立实例评分，
   * 真正实现"不同模型家族防 SPB"。未配置时复用 llmClient（仅 model 名不同）。
   */
  judgeLlmClient?: LLMClient
}

/**
 * 创建 EvalHarness 实例
 *
 * 主进程用法（在 index.ts / IPC 初始化时）：
 * ```ts
 * const harness = createEvalHarness({
 * llmClient: new LLMClient(config.llm),
 * configStore,
 * createToolRegistry: (ctx) => createToolRegistry(ctx),
 * judgeLlmClient: config.eval?.judge?.baseURL
 * ? new LLMClient({ ...judgeConfig, temperature: 0 })
 * : undefined
 * })
 * ```
 *
 * CI 脚本用法（scripts/run-eval.mjs）：
 * ```js
 * const { createEvalHarness } = await import('./eval/index.js')
 * const harness = createEvalHarness({ llmClient, configStore, createToolRegistry })
 * ```
 */
export function createEvalHarness(deps: EvalHarnessDeps): EvalHarness {
  return new EvalHarness(
    deps.llmClient,
    deps.configStore,
    deps.createToolRegistry,
    deps.judgeLlmClient
  )
}
