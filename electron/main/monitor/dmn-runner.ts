/**
 * 为什么存在：记忆工作流、子代理、监控杂务等自驱任务需要在会话外独立执行"消息→LLM→工具"多轮循环，必须有一个可复用运行器。
 * 作用：run() 执行带工具调用的迭代，支持迭代上限、LLM 重试退避、中断恢复，产出迭代次数与最终消息。
 */

import type { AnyTool, ToolContext, ToolResult } from '../tools/base-tool'
import type { ToolDef, ApiMessage, ChatWithToolsResult } from '../api/llm'
import { buildTurnPairsIntent } from '../api/llm'
import type { ToolRegistry } from '../tools'
import { executeTool } from '../tools'
import { DEFAULT_TOOL_RESULT_DISTILL } from '@shared/types'
import {
  DMN_GUARDRAIL_KEY,
  wrapGuardrail,
  classifyToolSource
} from '../api/message-guardrail'

import { computeBackoffDelay, sleep } from '@shared/utils/backoff'

export interface DmnRunOptions {
  dmnId: string
  messages: ApiMessage[]
  tools: AnyTool[]
  ctx: ToolContext
  model?: string
  maxIterations?: number
  /** 单个工具调用超时秒数，超时后强制中断该工具调用，DMN 继续下一步（文档 14.5/16.11.1） */
  toolTimeoutSeconds?: number
  /** LLM 调用失败重试保留入参（默认不设次数上限；2026-10-02 按用户要求取消与前端 MAX_STREAM_RETRIES 对齐的上限）。
   * 重试时保留 messages 上下文，让 DMN 续接而非重新开始。 */
  maxLlmRetries?: number
  /** 中断恢复回调（保留兼容：取消重试上限后不再由"重试耗尽"触发） */
  onInterruptRecovery?: (dmnId: string, reason: string) => void
  onOutput?: (dmnId: string, text: string) => void
  onToolCall?: (dmnId: string, toolName: string, params: Record<string, unknown>) => void
  onToolResult?: (dmnId: string, toolName: string, ok: boolean, data?: unknown, error?: string) => void
  /**
   * 消息来源护栏作用域键：传入即启用护栏（与主会话/工作流同规）。DMN 默认用 DMN_GUARDRAIL_KEY，
   * 子 agent 上下文传 SUBAGENT_GUARDRAIL_KEY（由调用方 sub-agent-launcher 指定）。
   */
  guardrailSessionId?: string
  /**
   * 工具结果蒸馏回调（可选）：大体积工具结果先经 LLM 提炼摘要再进上下文（与主会话一致）。
   * intent 由 run() 用 buildTurnPairsIntent 组装（该工具调用前的完整对话形态：
   * 窗口内含调用者思考/工具调用声明/此前工具消息链，与调用者 AI 同视角）；
   * 失败重试一次仍失败保留原文。
   */
  distillToolResult?: (
    toolName: string,
    toolCallId: string,
    result: string,
    intent?: string
  ) => Promise<string | undefined>
  /** 意图上下文对话对数量：缺省回退 shared 单源默认（与主会话/工作流同规） */
  distillIntentTurnPairs?: number
}

export interface DmnRunResult {
  iterations: number
  lastContent: string | null
  messages: ApiMessage[]
  /** 是否因 LLM 错误中断（重试上限后） */
  interrupted: boolean
  /** 中断原因 */
  interruptReason?: string
}

function toToolDef(tool: AnyTool): ToolDef {
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
  const schema: Record<string, unknown> = {
    type: 'object',
    properties
  }
  if (required.length > 0) {
    schema.required = required
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: schema
    }
  }
}

/** 指数退避基础延迟（ms） */
const BASE_RETRY_DELAY_MS = 1500
/** 指数退避上限（ms） */
const MAX_RETRY_DELAY_MS = 30_000

export class DmnRunner {
  private aborted = new Set<string>()
  private running = new Set<string>()
  private activeMessages = new Map<string, ApiMessage[]>()
  private lastActivityAt = new Map<string, number>()
  private currentModels = new Map<string, string | undefined>()

  constructor(private llm: LLM) {}

  isRunning(dmnId: string): boolean {
    return this.running.has(dmnId)
  }

  isAborted(dmnId: string): boolean {
    return this.aborted.has(dmnId)
  }

  getLastActivityAt(dmnId: string): number | null {
    return this.lastActivityAt.get(dmnId) ?? null
  }

  /**
   * 获取 DMN 运行时的 LLM messages 上下文快照（用于监控面板可视化）。
   * 返回浅拷贝，避免外部修改污染内部状态。
   * 未运行时返回 undefined。
   */
  getActiveMessages(dmnId: string): ApiMessage[] | undefined {
    const msgs = this.activeMessages.get(dmnId)
    return msgs ? [...msgs] : undefined
  }

  kill(dmnId: string): void {
    this.aborted.add(dmnId)
    this.activeMessages.delete(dmnId)
  }

  switchModel(dmnId: string, model: string | undefined): void {
    this.currentModels.set(dmnId, model)
  }

  getCurrentModel(dmnId: string): string | undefined {
    return this.currentModels.get(dmnId)
  }

  injectSystemMessage(dmnId: string, text: string): boolean {
    const messages = this.activeMessages.get(dmnId)
    if (!messages) return false
    messages.push({ role: 'system', content: text })
    this.lastActivityAt.set(dmnId, Date.now())
    return true
  }

  async run(options: DmnRunOptions): Promise<DmnRunResult> {
    // DMN 迭代上限取消（2026-10-02 按用户要求）：默认不设轮次上限，
    // 不再因跑满 maxIterations 中断任务；防死循环靠 aborted 标志 + 护栏兜底。
    const { dmnId, messages, tools, ctx, maxIterations = Number.POSITIVE_INFINITY } = options
    // 重试不设次数上限（2026-10-02 按用户要求取消；maxLlmRetries 入参保留兼容，不再参与判定）
    const model = options.model ?? this.currentModels.get(dmnId)
    this.aborted.delete(dmnId)
    this.running.add(dmnId)
    this.activeMessages.set(dmnId, messages)
    this.lastActivityAt.set(dmnId, Date.now())
    if (options.model !== undefined) {
      this.currentModels.set(dmnId, options.model)
    }

    const toolDefs = tools.map(toToolDef)
    // 构造 ToolRegistry，工具执行改走 executeTool（接入 PreToolUse/PostToolUse hooks）
    // 保留 toolPolicy 过滤（调用方传入已过滤的 tools 数组）
    const registry: ToolRegistry = {
      tools: new Map(tools.map((t) => [t.name, t])),
      ctx,
      queriedTools: new Set()
    }

    let lastContent: string | null = null
    let iterations = 0
    // LLM 调用重试不设上限（2026-10-02 取消），不再存在"重试耗尽 → interrupted"路径；
    // DmnRunResult.interrupted 恒为 false，保留字段兼容既有调用方

    try {
      for (let i = 0; i < maxIterations; i++) {
        iterations = i + 1
        if (this.aborted.has(dmnId)) break

        // 消息来源护栏作用域键：显式传入优先，缺省 DMN 固定键
        const guardrailKey = options.guardrailSessionId?.trim() || DMN_GUARDRAIL_KEY

        // LLM 调用加重试 + 指数退避（与前端 AI 的 runStream 重试机制对齐）
        // 重试时保留 messages（已 push 的 assistant/tool 消息不丢），让 DMN 续接而非重新开始
        let result: ChatWithToolsResult | null = null
        let retryCount = 0
        // 重试不设次数上限（2026-10-02 按用户要求取消，与前端 MAX_STREAM_RETRIES 同步）；
        // while 恒真，唯一退出是成功 / aborted 中止
        while (true) {
          if (this.aborted.has(dmnId)) break
          try {
            // 护栏：DMN 消息也带来源声明（协议置顶 + 逐条包裹由 chatWithTools 内完成，
            // 工具消息已按工具名细分类包裹则跳过兜底分类）
            result = await this.llm.chatWithTools(messages, toolDefs, model, {
              guardrailSessionId: guardrailKey
            })
            break
          } catch (err) {
            const errMsg = (err as Error).message ?? 'unknown'
            // 用户主动中止（kill 调用）不重试
            if (this.aborted.has(dmnId)) break
            const delay = computeBackoffDelay({
              attempt: retryCount,
              baseDelayMs: BASE_RETRY_DELAY_MS,
              maxDelayMs: MAX_RETRY_DELAY_MS
            })
            console.warn(
              `[dmn-runner] DMN ${dmnId} LLM 调用失败（${errMsg}），${delay}ms 后重试（第 ${retryCount + 1} 次）`
            )
            this.lastActivityAt.set(dmnId, Date.now())
            await sleep(delay)
            retryCount++
          }
        }
        if (result === null || this.aborted.has(dmnId)) break

        // assistantContent 显式声明为 string（result.content 为 null 时用空串，避免后续 null 污染）
        const assistantContent: string = result.content ?? ''

        messages.push({
          role: 'assistant',
          content: assistantContent,
          tool_calls: result.toolCalls.length > 0 ? result.toolCalls : undefined
        })

        if (result.content) {
          lastContent = assistantContent
          options.onOutput?.(dmnId, assistantContent)
        }
        this.lastActivityAt.set(dmnId, Date.now())

        if (result.toolCalls.length === 0) {
          break
        }

        // 并行执行工具：独立 tool_calls 并发跑，结果按原顺序写回。
        // DMN 的多个工具调用通常是独立操作（读文件/查记忆/建索引），串行会浪费数倍时间。
        const timeoutMs = (options.toolTimeoutSeconds ?? 30) * 1000
        const execResults = await Promise.all(
          result.toolCalls.map(async (call) => {
            if (this.aborted.has(dmnId)) return null

            const toolName = call.function.name
            let params: Record<string, unknown> = {}
            try {
              params = JSON.parse(call.function.arguments || '{}')
            } catch {
              params = {}
            }

            options.onToolCall?.(dmnId, toolName, params)

            let tr: ToolResult
            const abortCtrl = new AbortController()
            let timeoutTimer: ReturnType<typeof setTimeout> | undefined
            try {
              timeoutTimer = setTimeout(() => abortCtrl.abort(), timeoutMs)
              tr = await Promise.race([
                executeTool(registry, toolName, params, abortCtrl.signal),
                new Promise<ToolResult>((resolve) => {
                  abortCtrl.signal.addEventListener('abort', () =>
                    resolve({ ok: false, error: `工具调用超时（${timeoutMs / 1000}s），已强制中断` }),
                    { once: true }
                  )
                })
              ])
            } catch (err) {
              tr = { ok: false, error: (err as Error).message }
            } finally {
              if (timeoutTimer) clearTimeout(timeoutTimer)
            }

            options.onToolResult?.(dmnId, toolName, tr.ok, tr.data, tr.error)
            this.lastActivityAt.set(dmnId, Date.now())
            return { call, toolName, tr }
          })
        )

        // 按原顺序写回 messages（tool_calls 顺序与结果一一对应）
        for (const r of execResults) {
          if (!r) continue
          const { call, tr } = r
          const toolResultStr = JSON.stringify(tr)
          // 工具结果蒸馏（与主会话/工作流同规）：大体积工具结果先经 LLM 提炼「有用信息」，
          // 成功则摘要替换原文，失败重试一次仍失败保留原文
          let toolMsgContent = toolResultStr
          if (options.distillToolResult && toolMsgContent) {
            // 意图 = 该工具调用前的完整对话形态（窗口宽由 distillIntentTurnPairs 控制，
            // 含调用者思考/工具声明/此前工具消息链——与调取工具的那个 AI 同视角）：
            // 蒸馏 LLM 靠"工具是在什么对话背景下被调用的"判断相关性，不能传空串裸摘要）
            const intentPairs = options.distillIntentTurnPairs ?? DEFAULT_TOOL_RESULT_DISTILL.intentTurnPairs
            const intent = buildTurnPairsIntent(messages, messages.length, intentPairs)
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const distilled = await options.distillToolResult(
                  call.function.name,
                  call.id,
                  toolMsgContent,
                  intent
                )
                if (distilled) {
                  toolMsgContent = distilled
                  break
                }
              } catch {
                // 蒸馏抛错按失败处理，重试一次
              }
            }
          }
          // 消息来源护栏：工具结果按工具名细分类包裹（网页搜索/文件读取/子AGENT/普通工具）
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: wrapGuardrail(
              toolMsgContent,
              classifyToolSource(call.function.name),
              guardrailKey
            )
          })
        }
      }
    } catch (err) {
      console.error(`[dmn-runner] DMN ${dmnId} 执行异常:`, err)
      throw err
    } finally {
      this.running.delete(dmnId)
      this.aborted.delete(dmnId)
      this.activeMessages.delete(dmnId)
      this.lastActivityAt.delete(dmnId)
    }

    // 重试不设上限后不存在"重试耗尽中断"：interrupted 恒 false、interruptReason 恒 undefined
    return { iterations, lastContent, messages, interrupted: false, interruptReason: undefined }
  }

  }

export interface LLM {
  chatWithTools(
    messages: ApiMessage[],
    tools: ToolDef[],
    model?: string,
    options?: {
      /** 消息来源护栏作用域键：传入即启用护栏（与 chatWithTools 同规） */
      guardrailSessionId?: string
    }
  ): Promise<ChatWithToolsResult>
}
