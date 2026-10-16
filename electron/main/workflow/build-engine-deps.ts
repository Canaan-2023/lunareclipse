/**
 * L8 工作流引擎依赖装配：WorkflowEngine 的 EngineDeps 构建（纯函数）

 * 从 manager.ts 拆出：构造函数中「构建 LLM 接口 / 工具执行器 / 工具池 / SKILL 加载器 /
 * human 输入回调 / abort 回调」的装配逻辑独立成模块，便于单独测试与复用。
 * 行为与拆分前完全一致（manager 构造函数只是把这段逻辑委托给本模块）。
 */
import type { BaseDataPaths } from '../models/paths'
import type { LLMClient, ToolDef, ApiMessage, ChatWithToolsResult } from '../api/llm'
import { buildTurnPairsIntent } from '../api/llm'
import type { ToolExecutor as LlmToolExecutor } from '../api/llm'
import type { SkillLoader } from '../skills/loader'
import type { McpClientManager } from '../mcp/client-manager'
import type { ToolRegistry, AnyTool, ToolResult } from '../tools'
import { executeTool } from '../tools'
import type { WorkflowEngineEvent } from '@shared/workflow/types'
import type { EngineDeps } from './engine'
import type { WorkflowInstanceStore } from './persister'
import type { WorkflowHookRunner } from './hook-runner'
import { WORKFLOW_GUARDRAIL_KEY, wrapGuardrail, classifyToolSource } from '../api/message-guardrail'
import { DEFAULT_TOOL_RESULT_DISTILL } from '@shared/types'

/** 蒸馏回调工厂签名（与 server.ts 的 makeDistillCallbacks 同构；由上层注入） */
export type MakeDistillCallbacks = () => {
  distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
  distillIntentTurnPairs?: number
}

/** pending human input 的 Promise resolver（human 节点等用户响应） */
export interface PendingHumanInput {
  resolve: (response: string) => void
  reject: (err: Error) => void
  /** 弹窗信息（用于崩溃恢复时重新发 wf:paused 事件） */
  prompt: string
  inputType: 'confirm' | 'text' | 'choice'
  options?: string[]
  /** 超时 timer（有 timeoutMs 时创建，响应/取消/清理时 clearTimeout） */
  timer?: NodeJS.Timeout
}

/**
 * buildEngineDeps 的输入：store 实例 + 上层能力（LLM/工具/SKILL/MCP/事件）+ pending 容器。
 * 与 manager 的 WorkflowManagerDeps 同构但去耦，避免模块循环依赖。
 */
export interface BuildEngineDepsInput {
  paths: BaseDataPaths
  llmClient: LLMClient
  toolRegistry: ToolRegistry
  skillLoader: SkillLoader
  mcpClientManager?: McpClientManager
  /** 事件推送器（推给前端 WS） */
  emit: (event: WorkflowEngineEvent) => void
  instanceStore: WorkflowInstanceStore
  hookRunner: WorkflowHookRunner
  /** pending human input resolvers：instanceId → resolver（由 manager 持有，供 respond/cancel 使用） */
  pendingHumanInputs: Map<string, PendingHumanInput>
  /**
   * 工具结果蒸馏回调工厂（可选）：上层注入后，工作流 LLM 节点的工具结果与主会话一致，
   * 大体积工具结果先经 LLM 提炼摘要再进上下文（失败重试一次仍失败保留原文）。
   * 必须用 workflow 专用 distiller 实例（独立于 server 的 llmClientRef，避免递归/串扰），
   * 由 index.ts 装配时注入。
   */
  makeDistillCallbacks?: MakeDistillCallbacks
  /**
   * 工作流实例级并发闸门（可选， 动态性能优化）：
   * 注入后每个实例执行前后 acquire/release，实现多工作流实例并行度随运行时
   * 设备参数（核数/内存/负载）动态调节。不注入 = 无限制（旧行为）。
   */
  concurrencyGate?: { acquire(signal?: AbortSignal): Promise<boolean>; release(): void }
}

/**
 * 把 AnyTool 转换为 LlmToolExecutor（LLM 工具调用格式）

 * 参考 dmn-runner.ts 的 toToolDef：把 ToolParameter[] 转为 JSON schema object。
 * execute 方法包装 executeTool，返回字符串（LLM 工具结果消息格式）。
 */
function toLlmToolExecutor(tool: AnyTool, registry: ToolRegistry): LlmToolExecutor {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const param of tool.parameters) {
    properties[param.name] = {
      type: param.type,
      description: param.description
    }
    if (param.required) {
      required.push(param.name)
    }
  }
  const schema: Record<string, unknown> = { type: 'object', properties }
  if (required.length > 0) {
    schema.required = required
  }
  return {
    name: tool.name,
    description: tool.description,
    parameters: schema,
    execute: async (args) => {
      const result: ToolResult = await executeTool(registry, tool.name, args)
      if (!result.ok) {
        return `工具执行失败: ${result.error ?? '未知错误'}`
      }
      // data 通常是字符串（多数工具返回字符串），否则 JSON 序列化
      if (typeof result.data === 'string') return result.data
      return JSON.stringify(result.data ?? '')
    }
  }
}

/**
 * 构建 WorkflowEngine 全部依赖（EngineDeps）。
 *
 * 纯函数：不持有状态、不读写磁盘，所有外部能力通过 input 注入。
 * requestHumanInput / onCleanHumanInput 通过共享的 pendingHumanInputs Map
 * 与上层（manager）的 respondHumanInput / cancelHumanInput 协作。
 */
export function buildEngineDeps(input: BuildEngineDepsInput): EngineDeps {
  const {
    paths,
    llmClient,
    toolRegistry,
    skillLoader,
    mcpClientManager,
    emit,
    instanceStore,
    hookRunner,
    pendingHumanInputs,
    makeDistillCallbacks,
    concurrencyGate
  } = input

  // 构建 LLM stream 接口（包装 LLMClient.streamWithTools）
  const llmInterface: EngineDeps['llm'] = {
    streamWithTools: async (messages, tools, callbacks, options) => {
      // 把 messages 转成 ChatMessage 格式（streamWithTools 需要 ChatMessage[]）
      const chatMessages = messages.map((m, i) => ({
        id: `wf_msg_${i}`,
        role: m.role,
        content: m.content,
        createdAt: Date.now()
      }))
      // 转 ToolExecutor 格式
      const toolExecutors: LlmToolExecutor[] = tools as LlmToolExecutor[]
      // 工作流 LLM 节点与主会话一视同仁：工具结果同样走蒸馏回调（成功置换原文、失败保原文），
      // 伺服护栏用固定作用域键（llm-handler 已在 options.guardrailSessionId 注入 __workflow__）。
      await llmClient.streamWithTools(chatMessages, toolExecutors, {
        onToken: callbacks.onToken,
        onDone: callbacks.onDone,
        onError: callbacks.onError,
        onToolStart: callbacks.onToolStart,
        onToolEnd: callbacks.onToolEnd,
        onReasoning: callbacks.onReasoning,
        ...(makeDistillCallbacks ? makeDistillCallbacks() : {})
      }, options)
    },
    chatWithTools: async (messages, tools, options) => {
      const executors = tools as LlmToolExecutor[]
      const apiMessages: ApiMessage[] = messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
      const toolDefs: ToolDef[] = executors.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))
      // ⚠️ 2026-09-12 修复：非流式路径（stream=false）原实现只发一次请求、直接返回 content。
      // 但配了 tools 的节点（如 dispatcher 调 create_memory / rename_raw_memory）会被模型
      // 回以 tool_calls、content 为空（实测 deepseek-flash：调用工具那轮 content=""）。
      // 原实现忽略 toolCalls → 工具从不执行（记忆永不落盘），且拿不到最终 <json> →
      // outputVars 提取失败 → 节点判失败重跑 → 死循环。
      // 修复：在此补工具执行循环（与流式 streamWithTools 语义对齐）。
      // 2026-10-02 取消轮次上限：默认不再限制（避免工作流节点跑满 maxRounds 中断）；
      // 防失控由工程层 DAG 迭代护栏（engine.ts maxIterations）与超时兜底。
      const maxRounds = options?.maxRounds && options.maxRounds > 0 ? options.maxRounds : Number.POSITIVE_INFINITY
      // 蒸馏回调（与流式路径一致）：工作流非流式节点的工具结果同样提炼后再进上下文
      const distillCbs = makeDistillCallbacks?.()
      let result: ChatWithToolsResult = { content: null, toolCalls: [], finishReason: 'stop' }
      for (let round = 0; round < maxRounds; round++) {
        // 消息来源护栏：工作流节点统一固定键（与 llm-handler 注入的 streamOptions 同键）。
        // 工具消息已在下方按工具名细分类包裹，llm.ts chatWithTools 会识别"已包裹"跳过兜底分类。
        result = await llmClient.chatWithTools(apiMessages, toolDefs, options?.modelOverride, {
          guardrailSessionId: WORKFLOW_GUARDRAIL_KEY
        })
        // 无工具调用 → 本轮内容即最终输出
        if (!result.toolCalls || result.toolCalls.length === 0) {
          return { content: result.content, toolCalls: [], finishReason: result.finishReason }
        }
        // assistant 的 tool_calls 写回上下文（思考模式带 reasoning，避免多轮 400）
        apiMessages.push({
          role: 'assistant',
          content: result.content ?? '',
          tool_calls: result.toolCalls,
          ...(result.reasoning ? { reasoning: result.reasoning } : {})
        })
        // 逐个执行工具，结果作为 tool 消息写回
        for (const tc of result.toolCalls) {
          const exec = executors.find((t) => t.name === tc.function.name)
          let toolOutput: string
          if (!exec) {
            toolOutput = `工具未找到: ${tc.function.name}`
          } else {
            try {
              const args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
              toolOutput = await exec.execute(args as Record<string, unknown>)
            } catch (err) {
              toolOutput = `工具执行失败: ${(err as Error).message}`
            }
          }
          // 蒸馏：成功摘要替换原文，失败重试一次仍失败保留原文（与主会话同规）。
          // intent = 该工具调用前完整对话形态（窗口宽由 distillIntentTurnPairs 控制，
          // 含调用者思考/工具声明/此前工具消息链——与调取工具的那个 AI 同视角；
          // 蒸馏 LLM 靠"工具在什么对话背景下被调用"判断相关性）
          if (distillCbs?.distillToolResult && toolOutput) {
            const intentPairs = distillCbs.distillIntentTurnPairs ?? DEFAULT_TOOL_RESULT_DISTILL.intentTurnPairs
            const intent = buildTurnPairsIntent(apiMessages, apiMessages.length, intentPairs)
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const distilled = await distillCbs.distillToolResult(tc.function.name, tc.id, toolOutput, intent)
                if (distilled) {
                  toolOutput = distilled
                  break
                }
              } catch {
                // 蒸馏抛错按失败处理，重试一次
              }
            }
          }
          // 消息来源护栏：工具结果按工具名细分类包裹（网页搜索/文件读取/子AGENT/普通工具）
          apiMessages.push({
            role: 'tool',
            content: wrapGuardrail(toolOutput, classifyToolSource(tc.function.name), WORKFLOW_GUARDRAIL_KEY),
            tool_call_id: tc.id
          })
        }
      }
      // 轮次用尽：返回最后一次模型输出（可能仍是仅含 tool_calls 的空文本）
      console.warn(
        `[workflow] chatWithTools 工具循环达上限 ${maxRounds} 轮，返回当前输出`
      )
      return { content: result.content, toolCalls: [], finishReason: result.finishReason }
    }
  }

  // 构建工具执行器（包装 ToolRegistry）
  const toolExecutor: EngineDeps['toolExecutor'] = {
    execute: async (toolId, args) => {
      // MCP 工具：toolId 以 mcp_ 开头
      if (toolId.startsWith('mcp_')) {
        if (!mcpClientManager) {
          return { ok: false, error: 'MCP 未配置' }
        }
        // 解析 mcp_{serverName}.{toolName} 格式
        const rest = toolId.slice(4)  // 去掉 mcp_ 前缀
        const dotIdx = rest.indexOf('.')
        if (dotIdx < 0) {
          return { ok: false, error: `MCP 工具 ID 格式无效: ${toolId}` }
        }
        const serverName = rest.slice(0, dotIdx)
        const toolName = rest.slice(dotIdx + 1)
        try {
          const result = await mcpClientManager.callTool(serverName, toolName, args)
          return { ok: true, data: result }
        } catch (err) {
          return { ok: false, error: (err as Error).message }
        }
      }
      // 内置工具
      try {
        const result = await executeTool(toolRegistry, toolId, args)
        return { ok: result.ok, data: result.data, error: result.error }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  }

  // 构建 LLM 工具池（llm 节点用）：按 config.tools 过滤出可用工具子集
  // toolIds 为空或不传 → 空数组（纯文本生成）
  // toolIds 中的工具名在 registry 中查找，找不到则跳过（不报错，容错模板笔误）
  const toolPool: EngineDeps['toolPool'] = {
    filter: (toolIds?: string[]): LlmToolExecutor[] => {
      if (!toolIds || toolIds.length === 0) return []
      const result: LlmToolExecutor[] = []
      for (const id of toolIds) {
        const tool = toolRegistry.tools.get(id)
        if (tool) {
          result.push(toLlmToolExecutor(tool, toolRegistry))
        } else {
          console.warn(`[workflow] 工具池过滤：工具 "${id}" 未注册或未启用，已跳过（检查 toolsPolicy 配置）`)
        }
      }
      return result
    }
  }

  // 构建 SKILL 加载器
  const skillLoaderDeps: EngineDeps['skillLoader'] = {
    load: (skillId) => {
      const meta = skillLoader.findMetadata(skillId)
      if (!meta) {
        return { ok: false, error: `skill "${skillId}" 不存在` }
      }
      const skill = skillLoader.loadBody(skillId)
      if (!skill) {
        return { ok: false, error: `加载 skill "${skillId}" 正文失败` }
      }
      return { ok: true, body: skill.body }
    }
  }

  // 构建请求用户输入回调（human 节点用）
  const requestHumanInput: EngineDeps['requestHumanInput'] = async (
    instanceId, prompt, inputType, options, timeoutMs
  ) => {
    return new Promise<string>((resolve, reject) => {
      // 创建超时 timer（若有 timeoutMs）
      // 超时后 reject，handler 抛错，引擎标记节点 failed
      const timer = timeoutMs
        ? setTimeout(() => {
            const pending = pendingHumanInputs.get(instanceId)
            if (pending) {
              pendingHumanInputs.delete(instanceId)
              pending.reject(new Error(`human 节点超时（${timeoutMs}ms 未响应）`))
            }
          }, timeoutMs)
        : undefined

      pendingHumanInputs.set(instanceId, { resolve, reject, prompt, inputType, options, timer })
      // 发 wf:paused 事件（前端弹窗，有 timeoutMs 时显示倒计时）
      emit({
        type: 'wf:paused',
        instanceId,
        reason: 'human',
        prompt,
        inputType,
        options,
        timeoutMs
      })
    })
  }

  // C3 修复：cancelInstance 时清理 pendingHumanInputs，reject 对应 Promise + 清理 timer
  // 让 human-handler 的 await 抛错，runLoop catch 识别"用户取消"标记为 cancelled
  const onCleanHumanInput: EngineDeps['onCleanHumanInput'] = (instanceId) => {
    const pending = pendingHumanInputs.get(instanceId)
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer)
      pendingHumanInputs.delete(instanceId)
      pending.reject(new Error('用户取消了输入'))
    }
  }

  // M6 修复：cancelInstance 时取消正在进行的 LLM stream
  const onAbortLlm: EngineDeps['onAbortLlm'] = () => {
    // llmInterface 的 streamWithTools 内部使用 LLMClient，abort 方法暴露在 client 上
    // 通过 input 注入的 llmClient.abort() 取消当前请求
    const client = llmClient as LLMClient & { abort?: () => void }
    if (client.abort) {
      client.abort()
    }
  }

  return {
    instanceStore,
    hookRunner,
    emit,
    llm: llmInterface,
    toolPool,
    toolExecutor,
    skillLoader: skillLoaderDeps,
    requestHumanInput,
    onCleanHumanInput,
    onAbortLlm,
    concurrencyGate,
    workflowsRoot: paths.workflows
  }
}