/**
 * 为什么存在：复杂任务需要子代理与主 DMN 隔离执行（排除 dmn_ask_user 等交互工具），且结果要按任务明细可追溯。
 * 作用：构造子 AGENT 会话并派发任务，管理体系，返回子任务输出。
 * 子 agent 输出由 SubAgentManager 完整返回（不折叠不截断），上下文压缩由主链路工具结果蒸馏统一负责。
 */

import type { AnyTool, ToolContext, SubAgentTask, DmnSupervisor } from '../tools/base-tool'
import type { ApiMessage } from '../api/llm'
import type { DmnRunner } from './dmn-runner'
import type { BaseDataPaths, DataPaths } from '../models/paths'
import { SubAgentManager } from '../sub-agent'
import { SUBAGENT_GUARDRAIL_KEY } from '../api/message-guardrail'

/** 蒸馏回调工厂签名（与 server.ts makeDistillCallbacks 同构；由 Supervisor 注入） */
export type MakeDistillCallbacks = () => {
  distillToolResult?: (
    toolName: string,
    toolCallId: string,
    result: string,
    intent?: string
  ) => Promise<string | undefined>
  distillIntentTurnPairs?: number
}

/** 交互工具：子 agent 中禁用（子 agent 不应自行询问用户） */
const EXCLUDED_TOOLS = ['dmn_ask_user']

/**
 * 子 Agent 启动器：从 Supervisor 构造函数中抽出的独立逻辑。

 * 隔离层：内部委托给 SubAgentManager，保留 DMN 专属工具过滤与 dmnRunner 执行引擎。
 * 并发限制 / 超时 / 嵌套深度控制由 SubAgentManager 统一处理。

 * 行为修正（相对原实现）：交互工具黑名单现在**总是应用**（原逻辑是白名单存在时跳过黑名单）。
 * 这更安全——子 agent 不应在任何情况下调用 dmn_ask_user。
 */
export class SubAgentLauncher {
  private manager: SubAgentManager<AnyTool>

  constructor(
    private tools: AnyTool[],
    private runner: DmnRunner,
    private baseCtx: ToolContext,
    private paths: BaseDataPaths,
    private supervisor: DmnSupervisor,
    private getToolTimeoutSeconds: () => number,
    private makeDistillCallbacks?: MakeDistillCallbacks
  ) {
    this.manager = new SubAgentManager<AnyTool>(
      // executeFn：包装 dmnRunner.run（DMN 执行引擎）
      async (messages, subTools, opts) => {
        const subDmnId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
        const apiMessages: ApiMessage[] = messages.map((m) => ({ role: m.role, content: m.content }))
        const distillCbs = this.makeDistillCallbacks?.()
        const result = await this.runner.run({
          dmnId: subDmnId,
          messages: apiMessages,
          tools: subTools,
          ctx: { ...this.baseCtx, dmnId: subDmnId, supervisor: this.supervisor, paths: this.paths as DataPaths },
          maxIterations: opts.maxTurns,
          toolTimeoutSeconds: this.getToolTimeoutSeconds(),
          // 子 agent 上下文与父 DMN 会话隔离：独立护栏作用域键（来源分类为被调方法时仍按工具名细分）
          guardrailSessionId: SUBAGENT_GUARDRAIL_KEY,
          // 子 agent 内部工具结果同样蒸馏（与主会话/父 DMN 一视同仁）；意图对话对数随配置透传
          distillToolResult: distillCbs?.distillToolResult,
          distillIntentTurnPairs: distillCbs?.distillIntentTurnPairs
        })
        return result.lastContent ?? ''
      },
      tools,
      baseCtx,
      { maxConcurrent: 'auto', maxSpawnDepth: 1 }
    )
  }

  async launch(tasks: SubAgentTask[], mode: 'serial' | 'parallel'): Promise<string[]> {
    const options = tasks.map((t) => ({
      systemPrompt: t.prompt,
      userMessage: '开始执行子任务。',
      allowedTools: t.tools,
      disallowedTools: [...EXCLUDED_TOOLS, ...(t.disallowedTools ?? [])],
      maxTurns: t.maxTurns,
      timeoutMs: t.timeoutMs
    }))
    // 读 AsyncLocalStorage 中的当前深度：主对话=0，子 agent 内部=currentDepth+1
    const depth = SubAgentManager.getCurrentDepth()
    const results = await this.manager.launchBatch(options, mode, depth)
    return results.map((r) => r.output)
  }
}