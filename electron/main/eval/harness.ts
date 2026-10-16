/**
 * 评测执行框架（EvalHarness）：评测子系统的调度核心，
 * 统一承担任务的多次试验（trial）运行、独立环境隔离、轨迹记录、
 * 评分器调用与结果聚合（Pass@k/Pass^k、通过率、成本统计），
 * 供 IPC 调用与 CI 脚本直接驱动。
 */
import { isAbsolute, join } from 'node:path'
import type { LLMClient, ApiMessage, ToolDef, ToolCallResult } from '../api/llm'
import type { ConfigStore } from '../api/config-store'
import type { EvalTask, Transcript, TrialResult, SuiteResult, GradeResult } from './types'
import type { ToolContext } from '../tools/base-tool'
import type { ToolRegistry } from '../tools'
import { executeTool } from '../tools'
import { CodeGrader, createDefaultFsChecker } from './graders/code-grader'
import { ModelGrader } from './graders/model-grader'
import { estimateTokens } from '@shared/utils/token-estimate'

/**
 * 评测 Harness（evaluation harness）

 * 职责：
 * - 环境隔离（每个 task 独立 ToolRegistry + 独立 session）
 * - 任务调度（串行运行 task）
 * - 轨迹记录（Transcript 格式）
 * - 评分器调用（代码型 + 模型型）
 * - 结果聚合（Pass@k / Pass^k、通过率、成本）

 * 5 步框架的 step 4 实现：
 * - 运行 suite
 * - 每次提交可跑（CI 集成）
 * - 失败即阻断
 */
export class EvalHarness {
  private modelGrader: ModelGrader

  constructor(
    private llmClient: LLMClient,
    private configStore: ConfigStore,
    private createToolRegistry: (ctx: ToolContext) => ToolRegistry,
    /** 独立 judge LLMClient（不同 provider 时传入，真正防 SPB） */
    private judgeLlmClient?: LLMClient
  ) {
    // judge 模型配置（从 config 读取）
    // judge 独立 provider（baseURL+apiKey）配置时才允许不同模型（防 SPB 的前提是真正不同 provider）；
    // 未配置独立 provider 时 judge 走主 LLM client → model 必须用主 LLM 的 model，
    // 否则会拿 deepseek client 请求其他厂商模型 → 必然失败（修复）
    const evalConfig = this.configStore.get().eval
    const judgeConfig = evalConfig?.judge
    const mainModel = this.configStore.get().llm?.model
    const hasIndependentJudge = Boolean(judgeConfig?.baseURL && judgeConfig?.apiKey)
    const judgeModel = hasIndependentJudge
      ? (judgeConfig!.model ?? mainModel)
      : mainModel
    // 优先用独立 judgeLlmClient（不同 provider 防 SPB）；
    // 未配置独立 provider 时回退到 generator 的 llmClient（仅 model 名不同）
    this.modelGrader = new ModelGrader(this.judgeLlmClient ?? this.llmClient, judgeModel)
  }

  /**
   * 运行单个 task 的多次 trial

   * Pass@k：k 次中至少 1 次 pass → 任务 pass
   * Pass^k：k 次全部 pass → 任务 pass

   * 返回全部 trial 结果（按 passMode 聚合在 runSuite 中完成）
   */
  async runTask(task: EvalTask): Promise<TrialResult[]> {
    const k = task.k ?? 1
    const trials: TrialResult[] = []
    for (let i = 0; i < k; i++) {
      try {
        const transcript = await this.executeTrial(task, i + 1)
        const grades = await this.gradeTrial(task, transcript)
        const passed = grades.every((g) => g.pass)
        trials.push({
          taskId: task.id,
          trial: i + 1,
          transcript,
          grades,
          passed
        })
      } catch (err) {
        // 单个 trial 失败不中断整个 task/suite（LLM 未配置/超时/网络错误等）
        // 记录为失败 trial，继续执行后续 trial
        const errorMsg = (err as Error).message
        const failedTranscript: Transcript = {
          taskId: task.id,
          trial: i + 1,
          steps: [
            {
              role: 'user',
              content: task.input,
              timestamp: Date.now()
            },
            {
              role: 'assistant',
              content: `[trial 执行失败] ${errorMsg}`,
              timestamp: Date.now()
            }
          ],
          totalTokens: 0,
          totalDurationMs: 0,
          estimatedCost: 0
        }
        trials.push({
          taskId: task.id,
          trial: i + 1,
          transcript: failedTranscript,
          grades: [
            {
              axis: 'task_completion',
              grader: 'code',
              pass: false,
              score: 0,
              reason: `trial 执行失败: ${errorMsg}`,
              durationMs: 0
            }
          ],
          passed: false
        })
      }
    }
    return trials
  }

  /** 执行一次 trial，记录完整轨迹 */
  private async executeTrial(task: EvalTask, trialNum: number): Promise<Transcript> {
    const steps: Transcript['steps'] = []
    const startTime = Date.now()
    let totalTokens = 0

    // 构造独立 ToolRegistry（环境隔离）
    // 注：ToolContext 不含 cwd 字段，工作区路径通过 resolvePath 注入（让工具按工作区解析相对路径）
    const workspacePath = task.initialContext?.workspacePath
    const ctx: ToolContext = {
      sessionId: `eval-${task.id}-t${trialNum}`,
      ...(workspacePath
        ? {
            resolvePath: (input: string) =>
              input && !isAbsolute(input) ? join(workspacePath, input) : input
          }
        : {})
    }
    const registry = this.createToolRegistry(ctx)

    // 初始用户消息
    steps.push({
      role: 'user',
      content: task.input,
      timestamp: startTime
    })

    // Agent 循环（最多 10 轮，避免无限循环）
    const MAX_TURNS = 10
    // tool_call_id 关联：保证 assistant tool_calls.id 与 tool 步骤的 tool_call_id 一致
    // 之前用 steps.indexOf(s) 生成 tool_call_id 会导致与 assistant 的 id 不匹配（多 toolCalls 时错位）
    // 记录当前 turn 中每个 toolCall 的 id，供 tool 步骤关联
    let currentTurnToolCallIds: string[] = []
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // 构造 ApiMessage 序列
      const messages: ApiMessage[] = steps.map((s) => {
        if (s.role === 'assistant' && s.toolCalls && s.toolCalls.length > 0) {
          // assistant 步骤带 tool_calls，id 用步骤内存储的 id（生成时已写入，保证跨 turn 一致）
          return {
            role: s.role,
            content: s.content,
            tool_calls: s.toolCalls.map((tc) => ({
              id: tc.id!,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
            }))
          }
        }
        if (s.role === 'tool') {
          // tool 步骤带 tool_call_id（与 assistant 的 tool_calls.id 关联）
          return {
            role: s.role,
            content: s.content,
            tool_call_id: s.toolCallId!
          }
        }
        return { role: s.role, content: s.content }
      })

      // 构造 ToolDef 数组
      const tools: ToolDef[] = Array.from(registry.tools.values()).map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: this.toolParamsToJsonSchema(t.parameters)
        }
      }))

const response = await this.llmClient.chatWithTools(messages, tools)

      // 估算 token（chatWithTools 无 usage 字段，需手动估算）
      const inputText = messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('')
      totalTokens += estimateTokens(inputText) + estimateTokens(response.content ?? '')

      // 解析 toolCalls（ToolCallResult 的 arguments 是 string，需 parse）
      // 直接用 LLM 返回的 id（如 OpenAI 的 call_xxx），保证与 tool 步骤的 tool_call_id 一致
      // LLM 未返回 id 时 fallback 到 tc-${turn}-${idx}
      currentTurnToolCallIds = (response.toolCalls ?? []).map((tc, idx) => tc.id ?? `tc-${turn}-${idx}`)
      const parsedToolCalls = (response.toolCalls ?? []).map((tc, idx) => ({
        name: tc.function.name,
        arguments: this.parseToolArgs(tc),
        id: currentTurnToolCallIds[idx]
      }))

      steps.push({
        role: 'assistant',
        content: response.content ?? '',
        toolCalls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
        timestamp: Date.now()
      })

      // 无工具调用，结束
      if (parsedToolCalls.length === 0) {
        break
      }

      // 执行工具调用，每个 tool 步骤带对应 toolCallId
      for (let i = 0; i < parsedToolCalls.length; i++) {
        const tc = parsedToolCalls[i]
        const result = await executeTool(registry, tc.name, tc.arguments)
        steps.push({
          role: 'tool',
          content: JSON.stringify(result),
          toolResult: result,
          toolCallId: currentTurnToolCallIds[i],
          timestamp: Date.now()
        })
      }
    }

    return {
      taskId: task.id,
      trial: trialNum,
      steps,
      totalTokens,
      totalDurationMs: Date.now() - startTime,
      estimatedCost: this.estimateCost(totalTokens)
    }
  }

  /** 对一次 trial 调用所有评分器 */
  private async gradeTrial(task: EvalTask, transcript: Transcript): Promise<GradeResult[]> {
    const grades: GradeResult[] = []

    // 代码型：task_completion + tool_selection + cost_latency
    // 注入 fsChecker（基于 task 的工作区路径）用于 fileExists/fileContentMatches 检查
    const codeGrader = new CodeGrader(createDefaultFsChecker(task.initialContext?.workspacePath))
    grades.push(codeGrader.gradeTaskCompletion(task, transcript))
    grades.push(codeGrader.gradeToolSelection(task, transcript))
    const evalConfig = this.configStore.get().eval
    const costThresholds = evalConfig?.costThresholds ?? {
      maxTokens: 50000,
      maxMs: 60000,
      maxCost: 0.5
    }
    grades.push(codeGrader.gradeCostLatency(transcript, costThresholds))

    // 模型型：trajectory_quality（异步，不阻塞主流程）
    grades.push(await this.modelGrader.gradeTrajectoryQuality(transcript))

    return grades
  }

  /** 运行整个套件 */
  async runSuite(suite: string, tasks: EvalTask[]): Promise<SuiteResult> {
    const allTrials: TrialResult[] = []
    for (const task of tasks) {
      const trials = await this.runTask(task)
      allTrials.push(...trials)
    }

    // 按任务聚合 Pass@k / Pass^k
    const taskGroups = new Map<string, TrialResult[]>()
    for (const t of allTrials) {
      const arr = taskGroups.get(t.taskId) ?? []
      arr.push(t)
      taskGroups.set(t.taskId, arr)
    }

    let taskPassed = 0
    for (const [taskId, trials] of taskGroups) {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) continue
      const passMode = task.passMode ?? 'any'
      const anyPass = trials.some((t) => t.passed)
      const allPass = trials.every((t) => t.passed)
      if ((passMode === 'any' && anyPass) || (passMode === 'all' && allPass)) {
        taskPassed++
      }
    }

    const trialPassRate = allTrials.length > 0 ? allTrials.filter((t) => t.passed).length / allTrials.length : 0
    const taskPassRate = tasks.length > 0 ? taskPassed / tasks.length : 0

    return {
      suite,
      kind: tasks[0]?.kind ?? 'quality',
      results: allTrials,
      passRate: trialPassRate,
      taskPassRate,
      totalCost: allTrials.reduce((sum, t) => sum + t.transcript.estimatedCost, 0),
      totalDurationMs: allTrials.reduce((sum, t) => sum + t.transcript.totalDurationMs, 0),
      runAt: new Date().toISOString()
    }
  }

  /** 解析 ToolCallResult 的 arguments（string → Record） */
  private parseToolArgs(tc: ToolCallResult): Record<string, unknown> {
    return JSON.parse(tc.function.arguments) as Record<string, unknown>
  }

  /** 工具参数数组转 JSON Schema */
  private toolParamsToJsonSchema(params: unknown): Record<string, unknown> {
    const arr = params as Array<{ name: string; type: string; description: string; required?: boolean }>
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const p of arr) {
      properties[p.name] = { type: p.type, description: p.description }
      if (p.required) required.push(p.name)
    }
    return { type: 'object', properties, required: required.length > 0 ? required : undefined }
  }

  /** 成本估算（简化：$0.003 / 1K tokens 混合 input/output 平均） */
  private estimateCost(tokens: number): number {
    return (tokens / 1000) * 0.003
  }
}
