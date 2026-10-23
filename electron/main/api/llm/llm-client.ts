/**
 * @category API
 * @summary LLMClient 壳：月蚀唯一的模型调用通道（provider 差异屏蔽 + 流式 + 非流式带工具 + 并发控制）
 *
 * 为什么存在：`llm.ts`（1676 行）目录化（ADR-03）后，本文件承载类壳——配置、provider 判定、
 * 请求参数组装、并发控制器、复读护栏实例状态，以及三个对外入口（`stream` / `chatWithTools` /
 * `streamWithTools`）。工具循环引擎本身已外移到 `./tool-loop`，本文件不再持有循环实现。
 *
 * 什么作用：屏蔽底层 provider 差异（OpenAI 系 / DeepSeek / 本地推理等），提供流式对话、
 * 工具调用循环、并发请求管理与中止能力，并内置跨请求输出防复读护栏。
 *
 * 不删理由：全部消费方（22 处 `from './llm'` / `from '../api/llm'`）经 barrel 取 `LLMClient`；
 * 删掉即月蚀失去模型调用通道。
 *
 * ⚠️ 护栏判定顺序与软超时托管接线在 `./tool-loop-guards` / `./tool-loop-dispatch`，本文件不参与；
 * 本文件只提供引擎所需的最小壳能力（见 `./tool-loop` 的 `ToolLoopHost`）。
 */
import OpenAI from 'openai'
import {
  type LLMConfig,
  type ChatMessage,
  type ReasoningEffort,
  type TokenUsage,
  type ModelInfo
} from '@shared/types'
import { buildReasoningWireParams, resolveReasoningProfile } from '@shared/reasoning-profiles'
import { mapUsage } from '../llm-types'
import { resolveModelCapabilities } from '../model-capability'
import type {
  StreamCallbacks,
  ToolExecutor,
  ToolDef,
  ToolCallResult,
  ApiMessage,
  ChatWithToolsResult
} from '../llm-types'
import {
  wrapGuardrail,
  buildGuardrailProtocolPrompt,
  parseGuardrail,
  type GuardrailSource
} from '../message-guardrail'
import { runToolLoop, type ToolLoopOptions } from './tool-loop'
import type { RepetitionBaseline } from './tool-loop-finalize'
// 白名单 re-export：仅对外暴露被消费的契约符号，不透出内部实现
// （toolCallStorage / mapUsage / StreamCallbacks / ToolFunctionDef 为 llm 内部实现细节）
export type {
  ApiMessage,
  ChatWithToolsResult,
  ToolCallResult,
  ToolDef,
  ToolExecutor
} from '../llm-types'
export { getCurrentToolCallId } from '../llm-types'
// 蒸馏意图组装已外移（ADR-03 阶段 1），经本文件 re-export 保持对外导出面不变
export { buildTurnPairsIntent } from './turn-pairs'

export class LLMClient {
  private client: OpenAI | null = null
  // 2026-08-16 并发化改造：单字段 currentController → Map<requestId, 请求状态>。
  // 原设计单实例串行（currentController 单例），并行子 agent 同时调 streamWithTools 会
  // 互相覆盖 controller → 一个 abort 全乱 → 并行 2 个以上子任务必失败。
  // 现在每个请求独立 controller + 独立 abortReason，abort() 中止全部活跃请求。
  private controllers = new Map<
    string,
    { ctrl: AbortController; abortReason: string | null; tag: string }
  >()
  // 请求 id 生成（同毫秒并发不冲突）
  private reqIdCounter = 0
  private config: LLMConfig
  // ===== 2026-08-26 跨请求输出重复检测基准（奥卡姆剃刀：请求间复读拦截）=====
  // 原跨轮检测的 roundOutputs 是请求内局部变量——续接轮每轮都是独立请求，
  // prev 恒空 → AI 连续 N 个请求复读同一样的话完全漏网（实录：13:56 连发 7 轮同一句）。
  // 把"上一请求最终输出"提升为实例字段：跨请求比较，连续 ≥2 次近似重复注入打断。
  // 2026-08-26（系统级治本）：思考流跨轮基准——复读主战场在 reasoning（正文空转），
  // 只有 lastFinalOutput（正文基准）时思考流复读跨轮漏网。两者独立比较、任一命中即计数。
  // 由工具循环引擎经 getRepetitionBaseline() 就地读写（ADR-03 §2.3：属类实例状态）。
  private repetitionBaseline: RepetitionBaseline = {
    lastFinalOutput: '',
    lastReasoningOutput: '',
    crossRequestHits: 0
  }

  /** 当前是否有流式/工具调用在跑（消息接入并发保护用：外部消息进来时若 LLM 忙则拒绝/排队） */
  isStreaming(): boolean {
    return this.controllers.size > 0
  }

  constructor(config: LLMConfig) {
    this.config = config
    this.rebuildClient()
  }

  updateConfig(config: LLMConfig): void {
    this.config = config
    this.rebuildClient()
  }

  // ===== ToolLoopHost 实现（供 ./tool-loop 反向取壳能力）=====

  getClient(): OpenAI | null {
    return this.client
  }

  getConfig(): LLMConfig {
    return this.config
  }

  nextReqId(prefix: string): string {
    return `${prefix}_${Date.now()}_${++this.reqIdCounter}`
  }

  registerController(
    reqId: string,
    entry: { ctrl: AbortController; abortReason: string | null; tag: string }
  ): void {
    this.controllers.set(reqId, entry)
  }

  deleteController(reqId: string): void {
    this.controllers.delete(reqId)
  }

  getRepetitionBaseline(): RepetitionBaseline {
    return this.repetitionBaseline
  }

  /** 判断是否为本地推理服务：provider 为 ollama/local，或 baseURL 指向 localhost/127.0.0.1 */
  isLocalProvider(): boolean {
    if (this.config.provider === 'ollama' || this.config.provider === 'local') return true
    const url = this.config.baseURL || ''
    return /\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(url)
  }

  /**
   * 判断是否为 DeepSeek 系 API（官方或 DeepSeek 兼容网关）。
   * 为什么存在：DeepSeek 思考模式要求历史 assistant 消息的 reasoning_content 原样回传
   * （缺失即 400）；而非 DeepSeek 网关（OpenAI 风格聚合网关如 opencode.ai/zen/go 等）
   * 不认识 reasoning_content 字段，携带该字段反而会被服务器拒绝。
   * 因此「是否回传 reasoning_content」必须以 baseURL 判定，不能无条件回传。
   * 判定复用思考挡位能力表（@shared/reasoning-profiles），与挡位归一同一事实源，
   * 避免 baseURL 正则多处漂移。
   */
  isDeepSeekProvider(): boolean {
    return resolveReasoningProfile(this.config.baseURL).id === 'deepseek'
  }

  /**
   * 思考强度 → API 请求参数（产品 7 档）
   * 通用解法（2026-10-08 重构）：不再按 DeepSeek 特化分支写死归一，而是统一查
   * @shared/reasoning-profiles 的 provider 能力契约表——每个接入方（DeepSeek/OpenAI/Gemini/
   * 千问/Claude/自定义网关）声明自己的档位集合与 7 档 → wire 参数组装规则，这里只查表。
   * 新增 provider 只在表里加一行，请求构造与前端挡位下拉自动跟随，无需再改本处。
   * 契约要点（详见能力表内注释）：
   * - DeepSeek 官方认 low/high/max 三档强度（minimal→low、medium/xhigh→high），思考模式需
   *   thinking:{type:'enabled'} 显式开启，off 用 thinking:{type:'disabled'}（不用
   *   reasoning_effort:'none'——部分网关对 none 校验失败返回 400）；
   * - OpenAI 系枚举 minimal/low/medium/high 原样透传，very_high/max 归一 high；
   * - Gemini 3.7 起无 minimal 档（minimal→low）；
   * - 千问仅 enable_thinking 布尔开关（无档位）；
   * - 未命中（自定义/聚合网关）走 OpenAI 兼容语义兜底。
   */
  buildReasoningParams(effortOverride?: ReasoningEffort): Record<string, unknown> {
    const effort = effortOverride ?? this.config.reasoningEffort ?? 'medium'
    return buildReasoningWireParams(this.config.baseURL, effort)
  }

  /**
   * 采样参数（2026-08-24）：补 frequency_penalty 重复惩罚。
   * 此前三个 create 调用只传 temperature，无任何重复惩罚——上下文里重复模式多
   * （续接轮每轮注入相同任务清单、工具调用闭合标签、persona 反复强调的规则）时，
   * 模型无抑制地陷入重复生成，表现为重复一句话或 </invoke> 标签堆叠几十层。
   * frequency_penalty 精准打击：正常闭合一次的标签不受影响，堆叠几十次才被强烈压制。
   * 刻意不设 presence_penalty——它会惩罚一切已出现 token，可能误伤工具调用里
   * 必须重复出现的结构标签（</invoke> 等），反而破坏工具调用格式。

   * 2026-08-24 升级：默认值从 0.3 → 0.6（实测 0.3 对高频短循环压制力不足，
   * 模型仍可连续重复同一句话几十遍）。0.6 对正常输出几乎无副作用（单次出现不受罚），
   * 但对重复 3+ 次的 token 有显著抑制力。用户可通过 config.frequencyPenalty 覆盖。
   */
  buildSamplingParams(): Record<string, unknown> {
    return { frequency_penalty: this.config.frequencyPenalty ?? 0.6 }
  }

  private rebuildClient(): void {
    // 本地/Ollama provider 不强制 apiKey；其他 provider 没 key 则不就绪
    const isLocal = this.isLocalProvider()
    if (!isLocal && !this.config.apiKey) {
      this.client = null
      return
    }
    this.client = new OpenAI({
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey || 'ollama' // Ollama 等本地服务接受任意非空 key
    })
  }

  isReady(): boolean {
    return this.client !== null
  }

  /** 拉取服务端可用模型列表（OpenAI /v1/models 兼容接口），仅返回 id（兼容旧调用方） */
  async listModels(): Promise<string[]> {
    const infos = await this.listModelsWithCapability()
    return infos.map((i) => i.id)
  }

  /**
   * 拉取模型列表并附带本地能力解析（上下文窗口 / 输出上限，registry → infer → 兜底三级）。
   * 前端阶段 C 限幅 UI 消费此字段；旧调用方仍走 listModels 拿 string[]，兼容不动。
   */
  async listModelsWithCapability(): Promise<ModelInfo[]> {
    if (!this.client) return []
    const list = await this.client.models.list()
    return resolveModelCapabilities(list.data.map((m) => m.id).sort())
  }

  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: { modelOverride?: string }
  ): Promise<void> {
    if (!this.client) {
      callbacks.onError(new Error('LLM 未配置：请在设置中填写 API Key'))
      return
    }

    // 并发化：每请求独立 controller（注册进 controllers map，abort() 可中止）
    const reqId = this.nextReqId('st')
    const ctrl = new AbortController()
    this.controllers.set(reqId, { ctrl, abortReason: null, tag: 'main' })

    const apiMessages = messages
      .filter((m) => m.role !== 'system' || m.content)
      .map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        // 2026-08-26 修复：DeepSeek 思考模式要求历史 assistant 消息的 reasoning_content 原样回传
        // （仅 DeepSeek 系 API 需要；非 DeepSeek 网关不认识该字段，回传会被服务器拒绝）
        ...(this.isDeepSeekProvider() && m.role === 'assistant' && m.reasoning
          ? { reasoning_content: m.reasoning }
          : {})
      }))

    const useModel =
      options?.modelOverride && options.modelOverride.trim()
        ? options.modelOverride.trim()
        : this.config.model

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: useModel,
          messages: apiMessages,
          temperature: this.config.temperature ?? 0.7,
          max_tokens: this.config.maxTokens ?? undefined,
          stream: true,
          stream_options: { include_usage: true },
          ...this.buildReasoningParams(),
          ...this.buildSamplingParams()
        },
        { signal: ctrl.signal }
      )

      let streamUsage: TokenUsage | undefined
      for await (const chunk of stream) {
        if (ctrl.signal.aborted) break
        if (chunk.usage) {
          streamUsage = mapUsage(chunk.usage as never)
        }
        const token = chunk.choices[0]?.delta?.content || ''
        if (token) {
          callbacks.onToken(token)
        }
      }

      if (streamUsage) {
        callbacks.onUsage?.(streamUsage)
      }
      if (ctrl.signal.aborted) {
        callbacks.onError(new Error('aborted'))
      } else {
        callbacks.onDone()
      }
    } catch (err) {
      if (ctrl.signal.aborted) {
        callbacks.onError(new Error('aborted'))
      } else {
        callbacks.onError(err as Error)
      }
    } finally {
      this.controllers.delete(reqId)
    }
  }

  async chatWithTools(
    messages: ApiMessage[],
    tools: ToolDef[],
    model?: string,
    options?: {
      temperature?: number
      reasoningEffort?: ReasoningEffort
      /** 消息来源护栏作用域键：传入即启用护栏（与 streamWithTools 同规）。
       * 记忆工作流/工作流非流式路径（chatWithTools）也统一走护栏，消息来源对 AI 可读。 */
      guardrailSessionId?: string
    }
  ): Promise<ChatWithToolsResult> {
    if (!this.client) {
      throw new Error('LLM 未配置：请在设置中填写 API Key')
    }

    // 护栏：按 role 兜底分类（ApiMessage 无 id/activation，只能粗分类 user/ai/tool-return；
    // 工具消息的细分类（web-search/file-read）在调用方知道 toolName 的场景由调用方自行 wrap）
    const guardrailKey = options?.guardrailSessionId?.trim()
    let wireMessages: ApiMessage[] = messages
    if (guardrailKey) {
      // 协议说明段置顶 + 逐条包裹（与 streamWithTools 同规：system 不包裹，其余按 role 分类）。
      // 已包裹消息跳过：调用方自行细分的护栏（如记忆工作流/工作流按工具名 wrap 的 tool 消息）
      // 已带来源声明，再按 role 兜底包一层会破坏细分语义（parseGuardrail 只认最外层）。
      wireMessages = [
        { role: 'system', content: buildGuardrailProtocolPrompt(guardrailKey) },
        ...messages.map((m) => {
          if (m.role === 'system') return m
          if (parseGuardrail(m.content ?? '', guardrailKey).wrapped) return m
          const source: GuardrailSource =
            m.role === 'user' ? 'user' : m.role === 'assistant' ? 'ai' : 'tool-return'
          return { ...m, content: wrapGuardrail(m.content ?? '', source, guardrailKey) }
        })
      ]
    }

    // ⚠️ 2026-08-10 修复：原实现把 controller 存到实例字段 this.currentController——
    // 该字段是全实例共享的（流式 stream 的 abort 语义），chatWithTools 覆盖它会让：
    // ① 并发场景（onDone 重试/滚动摘要/莉莉丝/子 agent）互相清空对方 controller；
    // ② 外层 streamWithTools 的 finally 清掉 chatWithTools 的 controller → 重试失去超时/abort。
    // 非流式请求自带 60/180s 总超时兜底，不需要全局 abort 支持——改用局部变量隔离。
    const ctrl = new AbortController()
    // 总超时保护：chatWithTools 非流式，卡死会永久阻塞。本地模型推理慢给 180s，云模型 60s。
    // 超时后 abort 释放连接并抛出错误，避免记忆工作流调用方无限等待。
    const isLocalProvider = this.isLocalProvider()
    const totalTimeoutMs = isLocalProvider ? 180000 : 60000
    let timedOut = false
    const totalTimer = setTimeout(() => {
      timedOut = true
      console.warn(`[llm] chatWithTools 总超时 ${totalTimeoutMs}ms，abort`)
      ctrl.abort()
    }, totalTimeoutMs)

    try {
      const response = await this.client.chat.completions.create(
        {
          model: model ?? this.config.model,
          messages: wireMessages.map((m) => ({
            role: m.role,
            content: m.content ?? '',
            ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
            ...(this.isDeepSeekProvider() && m.role === 'assistant' && m.reasoning
              ? { reasoning_content: m.reasoning }
              : {})
          })) as never,
          tools: tools.length > 0 ? tools : undefined,
          temperature: options?.temperature ?? this.config.temperature ?? 0.7,
          max_tokens: this.config.maxTokens ?? undefined,
          stream: false,
          ...this.buildReasoningParams(options?.reasoningEffort),
          ...this.buildSamplingParams()
        },
        { signal: ctrl.signal }
      )

      const choice = response.choices[0]
      return {
        content: choice?.message?.content ?? null,
        toolCalls: (choice?.message?.tool_calls as ToolCallResult[]) ?? [],
        finishReason: choice?.finish_reason ?? 'stop',
        reasoning: (choice?.message as { reasoning_content?: string } | undefined)
          ?.reasoning_content,
        usage: mapUsage(response.usage as never)
      }
    } catch (err) {
      if (timedOut) {
        throw new Error(`chatWithTools 请求超时(${totalTimeoutMs}ms)`, { cause: err })
      }
      if (ctrl.signal.aborted) {
        throw new Error('aborted', { cause: err })
      }
      throw err
    } finally {
      clearTimeout(totalTimer)
    }
  }

  // ⚠️ 2026-08-12 修复：工具执行阶段 controller 可能不在 active（上轮 stream 已删），
  // 仅 abort controller 会让轮次检查（signal.aborted）恒 false → abort 丢失，
  // 旧流跑完工具再发一轮 LLM，新消息在 streamChain 干等 → 用户看到"打断后不响应"。
  // 2026-08-16 并发化后的实现：每请求独立 controller 存 controllers map（value 含 ctrl + abortReason），
  // abort 置 entry.abortReason 并调用 entry.ctrl.abort()——signal.aborted 随 controller 跨轮次存活，
  // 工具阶段也能立即中断，无需额外独立标志。
  abort(tag?: string): void {
    for (const [, entry] of this.controllers) {
      if (tag && entry.tag !== tag) continue
      entry.abortReason = 'user'
      entry.ctrl.abort()
    }
  }

  /**
   * AUTO 模型热切换的「上下文占比」特征（§8.3）：0~1，null = 不可得。
   * 为什么用可注入 provider 而不是让 LLMClient 自己算：占比是**会话级**信号
   * （`lastInjectedEstimateRef` + 预算），属于 `server.ts` 的闭包；LLMClient 是共享客户端，
   * 不该持有会话状态。`server.ts` 在 `makeLlmClient` 里注入，客户端重建也自动带上。
   */
  private contextRatioProvider: (() => number | null) | null = null

  setContextRatioProvider(fn: (() => number | null) | null): void {
    this.contextRatioProvider = fn
  }

  getContextRatio(): number | null {
    try {
      return this.contextRatioProvider?.() ?? null
    } catch {
      return null
    }
  }

  /**
   * 流式带工具调用循环：实现已外移到 `./tool-loop` 的 `runToolLoop`（ADR-03 阶段 5）。
   * 本方法只做委托，签名与对外语义不变（消费方零改动）。
   * maxRounds 轮次上限已取消（2026-10-02 按用户要求）：不再因轮次上限中断 LLM，
   * 防死循环由 llm-guardrails 护栏承担（failure/idempotent/loop_caps 检测），
   * maxRounds 仅保留显式传参以兼容工作流节点等需要自定边界的调用方。
   */
  async streamWithTools(
    messages: ChatMessage[],
    tools: ToolExecutor[],
    callbacks: StreamCallbacks,
    options?: ToolLoopOptions
  ): Promise<void> {
    return runToolLoop(this, messages, tools, callbacks, options)
  }
}
