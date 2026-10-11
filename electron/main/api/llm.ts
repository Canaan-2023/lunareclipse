/**
 * LLM 客户端封装：月蚀唯一的模型调用通道，屏蔽底层 provider 差异
 * （OpenAI 系 / DeepSeek / 本地推理等），提供流式对话、工具调用循环、
 * 并发请求管理与中止能力，并内置跨请求输出防复读护栏；
 * 思考强度、模型能力等细节统一在此收敛。
 */
import OpenAI from 'openai'
import {
  DEFAULT_TOOL_RESULT_DISTILL,
  type LLMConfig,
  type ChatMessage,
  type ReasoningEffort,
  type TokenUsage,
  type ModelInfo
} from '@shared/types'
import { buildReasoningWireParams, resolveReasoningProfile } from '@shared/reasoning-profiles'
import { logInfo } from '../services/crash-logger'
import { toolCallStorage, toolSignalStorage, mapUsage } from './llm-types'
// 软超时托管：外墙超时不打断可托管工具，转后台继续跑并登记 taskId（工具运行时长机制）
import { registerManagedRun, formatConcurrencyAdvisory } from '../services/tool-run-registry'
import { resolveModelCapabilities } from './model-capability'
import type {
  StreamCallbacks,
  ToolExecutor,
  ToolDef,
  ToolCallResult,
  ApiMessage,
  ChatWithToolsResult
} from './llm-types'
import {
  detectTailRepetition,
  failureFingerprint,
  isFailureResult,
  resultHash,
  isSubAgentish,
  extractPaths,
  pathsConflict,
  REPETITION_CHECK_INTERVAL,
  READ_TOOLS,
  WRITE_TOOLS,
  INTERACTIVE_TOOLS,
  IDEMPOTENT_TOOLS,
  LOOP_CAP,
  TOOL_FAILURE_HALT
} from './llm-guardrails'
import {
  wrapGuardrail,
  classifyMessageSource,
  classifyToolSource,
  buildGuardrailProtocolPrompt,
  parseGuardrail,
  type GuardrailSource
} from './message-guardrail'
// 白名单 re-export：仅对外暴露被消费的契约符号，不透出内部实现
// （toolCallStorage / mapUsage / StreamCallbacks / ToolFunctionDef 为 llm 内部实现细节）
export type {
  ApiMessage,
  ChatWithToolsResult,
  ToolCallResult,
  ToolDef,
  ToolExecutor
} from './llm-types'
export { getCurrentToolCallId } from './llm-types'

/**
 * 组装蒸馏意图：该工具调用前最近 N 对历史对话的**完整消息形态**快照。
 * 为什么按对话对而非字符数（用户要求，2026-10-07）：蒸馏 LLM 判断「这段结果对
 * 当前任务有没有用」的依据是「工具是在哪个对话背景下被调用的」——这是一个
 * 语义单元（一问一答）层面的信息；按字符硬切会把完整的一问一答割裂成残句，
 * 蒸馏器看到半句话无法判断相关性。按「对」取既保证每个上下文单元自洽，
 * 长度也随对话自然增长，与对话轮次节奏一致，且不再是魔法数字。
 * 为什么呈现完整形态而非只取 user/assistant 的 content（用户要求，2026-10-07 升级）：
 * 蒸馏 AI 看到的必须和调取工具的那个 AI 看到的一致——包括它当时的思考
 * （reasoning_content / reasoning）与输出（tool_calls 声明），以及此前轮次的工具
 * 消息链。旧实现只摘 content 文本，而调用侧 AI 的决策链恰恰在思考与工具声明里
 * （DeepSeek 系 content 常为空、正文在思考），蒸馏器看不到"为什么调、打算怎么用"，
 * 蒸馏结果自然偏离任务语义。升级后蒸馏器与调用者在同一视角上评估结果相关性，
 * 唯一差异是最终只保留蒸馏输出本身。
 * @param messages 完整会话（openai 消息格式；wire 副本含 reasoning/tool_calls/tool 消息）
 * @param upToIndex 该 tool 消息在会话中的下标（取它之前的历史，不含自身）
 * @param pairs 最多回溯的对话对数；<=0 返回空串（等同旧行为：不带历史上下文）
 */
export function buildTurnPairsIntent(
  messages: Array<{
    role: string
    content: string | null
    reasoning_content?: string
    reasoning?: string
    tool_call_id?: string
    tool_calls?: ToolCallResult[]
  }>,
  upToIndex: number,
  pairs: number
): string {
  if (pairs <= 0) return ''
  // 从后往前定位第 N 个 user 消息作为窗口起点（最近 N 个问答轮）；
  // 历史不足 N 对时从 0 开始尽量携带（宁多勿空）。窗口内每条消息按完整形态呈现：
  // system/协议段也保留（与调用者同视角），本 tool 原文（upToIndex 自身）除外。
  let userSeen = 0
  let start = 0
  for (let i = upToIndex - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    userSeen++
    if (userSeen === pairs) {
      start = i
      break
    }
  }
  const lines: string[] = []
  // system 消息始终携带（窗口起点按 user 回溯、可能跳过它们）：护栏协议段/角色设定
  // 是调用者 AI 恒定可见的上下文，蒸馏器缺了它就读不懂被包裹消息的语义；system 体量
  // 小、位置恒在对话最前，拼在最前与调用者视角一致。窗口内遍历时跳过已收集的 system。
  for (let i = 0; i < upToIndex; i++) {
    const m = messages[i]
    if (m.role !== 'system') continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (text.trim()) lines.push(`system: ${text}`)
  }
  for (let i = start; i < upToIndex; i++) {
    const m = messages[i]
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      const text = typeof m.content === 'string' ? m.content : ''
      if (text.trim()) lines.push(`tool${m.tool_call_id ? `(${m.tool_call_id})` : ''}: ${text}`)
      continue
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = typeof m.content === 'string' ? m.content : ''
    if (text.trim()) lines.push(`${m.role}: ${text}`)
    // 思考：调用者 AI 决策链的主体（DeepSeek 系正文空、决策全在思考里），必须可见
    const thought = m.reasoning_content ?? m.reasoning
    if (thought && thought.trim()) lines.push(`assistant 思考: ${thought}`)
    // 工具调用声明：调用者 AI 当时的输出（决定调什么工具、传什么参数）
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls) {
        lines.push(`assistant 调用工具: ${tc.function.name}(${tc.function.arguments})`)
      }
    }
  }
  return lines.join('\n')
}

// ===== 软超时托管：外墙对以下工具的超时语义从「abort 强杀」改为「转后台托管」=====
// 为什么是这些工具：run_command（真实子进程，killTree 兜底可后台跑完）、code_run（代码沙箱）。
// 其余工具（文件读写/查询等）超时多为卡死，无后台价值，保留强杀；web 类工具网络请求
// 超时继续等也无意义（服务端响应已丢，外部不可控），故不托管。
// 判定放在 llm.ts 而非工具内部：外墙是唯一能决定「对话是否等得起」的位置，工具无此视角。
const MANAGED_TIMEOUT_TOOLS = new Set(['run_command', 'code_run'])

export class LLMClient {
  private client: OpenAI | null = null
  // 2026-08-16 并发化改造：单字段 currentController → Map<requestId, 请求状态>。
  // 原设计单实例串行（currentController 单例），并行子 agent 同时调 streamWithTools 会
  // 互相覆盖 controller → 一个 abort 全乱 → 并行 2 个以上子任务必失败。
  // 现在每个请求独立 controller + 独立 abortReason，abort() 中止全部活跃请求。
  private controllers = new Map<string, { ctrl: AbortController; abortReason: string | null; tag: string }>()
  // 请求 id 生成（同毫秒并发不冲突）
  private reqIdCounter = 0
  private config: LLMConfig
  // ===== 2026-08-26 跨请求输出重复检测基准（奥卡姆剃刀：请求间复读拦截）=====
  // 原跨轮检测的 roundOutputs 是请求内局部变量——持续激活每轮续接都是独立请求，
  // prev 恒空 → AI 连续 N 个请求复读同一样的话完全漏网（实录：13:56 连发 7 轮同一句）。
  // 把"上一请求最终输出"提升为实例字段：跨请求比较，连续 ≥2 次近似重复注入打断。
  private lastFinalOutput = ''
  // 2026-08-26（系统级治本）：思考流跨轮基准——复读主战场在 reasoning（正文空转），
  // 只有 lastFinalOutput（正文基准）时思考流复读跨轮漏网。两者独立比较、任一命中即计数。
  private lastReasoningOutput = ''
  private crossRequestHits = 0

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

  /** 判断是否为本地推理服务：provider 为 ollama/local，或 baseURL 指向 localhost/127.0.0.1 */
  private isLocalProvider(): boolean {
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
  private isDeepSeekProvider(): boolean {
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
  private buildReasoningParams(effortOverride?: ReasoningEffort): Record<string, unknown> {
    const effort = effortOverride ?? this.config.reasoningEffort ?? 'medium'
    return buildReasoningWireParams(this.config.baseURL, effort)
  }

  /**
   * 采样参数（2026-08-24）：补 frequency_penalty 重复惩罚。
   * 此前三个 create 调用只传 temperature，无任何重复惩罚——上下文里重复模式多
   * （持续激活每轮注入相同任务清单、工具调用闭合标签、persona 反复强调的规则）时，
   * 模型无抑制地陷入重复生成，表现为重复一句话或 </invoke> 标签堆叠几十层。
   * frequency_penalty 精准打击：正常闭合一次的标签不受影响，堆叠几十次才被强烈压制。
   * 刻意不设 presence_penalty——它会惩罚一切已出现 token，可能误伤工具调用里
   * 必须重复出现的结构标签（</invoke> 等），反而破坏工具调用格式。

   * 2026-08-24 升级：默认值从 0.3 → 0.6（实测 0.3 对高频短循环压制力不足，
   * 模型仍可连续重复同一句话几十遍）。0.6 对正常输出几乎无副作用（单次出现不受罚），
   * 但对重复 3+ 次的 token 有显著抑制力。用户可通过 config.frequencyPenalty 覆盖。
   */
  private buildSamplingParams(): Record<string, unknown> {
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
    const reqId = `st_${Date.now()}_${++this.reqIdCounter}`
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
       * DMN/工作流非流式路径（chatWithTools）也统一走护栏，消息来源对 AI 可读。 */
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
      // 已包裹消息跳过：调用方自行细分的护栏（如 DMN/工作流按工具名 wrap 的 tool 消息）
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
    // 超时后 abort 释放连接并抛出错误，避免 DMN 调用方无限等待。
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
        reasoning: (choice?.message as { reasoning_content?: string } | undefined)?.reasoning_content,
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
   * 流式带工具调用循环：LLM stream → 若返回 tool_calls 则执行 → 把结果加入上下文 → 继续 stream
   * maxRounds 轮次上限已取消（2026-10-02 按用户要求）：不再因轮次上限中断 LLM，
   * 防死循环由 llm-guardrails 护栏承担（failure/idempotent/loop_caps 检测），
   * maxRounds 仅保留显式传参以兼容工作流节点等需要自定边界的调用方。
   */
async streamWithTools(
    messages: ChatMessage[],
    tools: ToolExecutor[],
    callbacks: StreamCallbacks,
    options?: {
      modelOverride?: string
      maxRounds?: number
      temperature?: number
      signal?: AbortSignal
      // 请求分组标签：abort(tag) 只中止同 tag 请求。独立流/工具流与主会话
      // 分 tag 后可被精准分别中止（如停止某个侧栏流的生成不打断主会话）
      tag?: string
      // 消息来源护栏作用域键：传入即启用护栏（会话 id 或子 agent 固定键）。
      // 护栏在注入层动态包裹每条非 system 消息的来源声明，对用户不可见、对 AI 可读。
      guardrailSessionId?: string
    }
  ): Promise<void> {
    if (!this.client) {
      callbacks.onError(new Error('LLM 未配置：请在设置中填写 API Key'))
      return
    }
    // 2026-08-16 并发化：每请求独立 controller（存 controllers map，value 含 ctrl + abortReason）
    const reqId = `swt_${Date.now()}_${++this.reqIdCounter}`
    const ctrl = new AbortController()
    // 2026-08-17 外部中断联动：子 agent 超时等场景传入外部 signal，
    // 外部 abort 时只终止本请求（controllers map 里其它并发请求不动，父对话不受影响）。
    // tag 优先级：外部 signal > 显式 tag > 'main'（显式 tag 使写作流独立于主会话分组）
    const externalSignal = options?.signal
    const entry = { ctrl, abortReason: null as string | null, tag: externalSignal ? 'subagent' : (options?.tag ?? 'main') }
    if (externalSignal) {
      externalSignal.addEventListener('abort', () => {
        entry.abortReason = '外部中断（子 agent 超时）'
        ctrl.abort()
      }, { once: true })
    }
    this.controllers.set(reqId, entry)
    try {
    // 本轮 abort 状态不设独立标志：entry.abortReason + ctrl.signal.aborted 已随请求级
    // controller 跨轮次持久（存 controllers map），下方轮次/工具段检查直接读 signal。
    // （原有 const abortRequested = false 恒 false，为 2026-08-16 并发化重构残留，已删除）

    // 默认不限制轮次（2026-10-02 取消上限）；显式传参仍生效，护栏兜底防死循环
    const maxRounds = options?.maxRounds ?? Number.POSITIVE_INFINITY
    const useModel =
      options?.modelOverride && options.modelOverride.trim()
        ? options.modelOverride.trim()
        : this.config.model

    // 转换为 OpenAI 消息格式
    type OpenAIMsg = {
      role: 'system' | 'user' | 'assistant' | 'tool'
      content: string
      tool_calls?: ToolCallResult[]
      tool_call_id?: string
      /** DeepSeek 思考模式：历史 assistant 消息的 reasoning_content 必须原样回传（2026-08-26 修复） */
      reasoning_content?: string
    }
    const guardrailKey = options?.guardrailSessionId?.trim()
    // 预分类来源：conversation 是 map 后的 wire 结构，已丢失 ChatMessage 的 id/activation 字段，
    // 必须在 map 前对原始消息分类（审查轮识别依赖这两个字段）
    const guardrailSources = guardrailKey
      ? messages.map((m) => classifyMessageSource(m))
      : null

    const conversation: OpenAIMsg[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.role === 'system' && !m.content) continue
      const source = guardrailSources ? guardrailSources[i] : null
      // 已包裹消息跳过兜底分类（与 chatWithTools 同规）：调用方自行按细分类包裹
      // 的消息（如工具结果按 web-search/file-read 包裹后回流）不再按 role 重包，
      // 避免 parseGuardrail 只认最外层导致细分来源被 role 兜底覆盖
      const alreadyWrapped = guardrailKey && parseGuardrail(m.content ?? '', guardrailKey).wrapped
      conversation.push({
        role: m.role as 'system' | 'user' | 'assistant',
        content:
          source && guardrailKey && !alreadyWrapped
            ? wrapGuardrail(m.content, source, guardrailKey)
            : m.content,
        // 2026-08-26 修复：ChatMessage.reasoning → wire 字段 reasoning_content
        // （DeepSeek 思考模式回传硬要求；仅 DeepSeek 系 API，其他网关回传会被拒绝）
        ...(this.isDeepSeekProvider() && m.role === 'assistant' && m.reasoning
          ? { reasoning_content: m.reasoning }
          : {})
      })
    }

    // ===== 消息来源护栏（仅传入 guardrailSessionId 时启用）=====
    // 按来源分栏包裹：system 消息不包裹（注入段属系统指令，AI 天然可知）；其余按来源枚举包裹。
    // 护栏不进 conversation 之外的任何持久层：不写 session.messages、不改 ChatMessage 结构、
    // 不推前端 —— 对用户不可见、对 AI 可读。工具结果回流处也按工具名分类包裹（见循环内 push）。
    if (guardrailKey) {
      // 协议说明段置顶注入一次（system role），说明护栏格式/来源枚举/嵌套/无效判定规则
      conversation.unshift({ role: 'system', content: buildGuardrailProtocolPrompt(guardrailKey) })
    }

    // 工具 schema 注入结果处理选项：LLM 可在每次工具调用参数中声明
    // _result_mode = 'full'（原文完整保留）| 'distill'（蒸馏为要点，默认）。
    // 声明只在解析层被消费（剥离后不传给工具本体），不入工具参数校验。
    const openaiTools = tools.map((t) => {
      const parameters = (t.parameters ?? {}) as Record<string, unknown>
      const props = (parameters.properties as Record<string, unknown> | undefined) ?? {}
      return {
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: {
            ...parameters,
            properties: {
              ...props,
              _result_mode: {
                type: 'string',
                enum: ['full', 'distill'],
                description:
                  '本工具调用的结果处理方式（可选）：full = 原始返回原文完整保留；distill（默认）= 把原始返回压缩为要点摘要。默认选 distill 节省后续上下文；需要完整细节（如精确错误原文、关键数值原始表述）时才选 full。'
              }
            }
          }
        }
      }
    })

    let rounds = 0
    // 2026-08-26：跨轮输出重复检测状态已提升为实例字段（lastFinalOutput/crossRequestHits）——
    // 原 roundOutputs 是请求内局部数组，持续激活每轮续接都是新请求 → prev 恒空 → 请求间复读漏网。
    // 检测逻辑见 stream 完成处的跨请求比较（比较基准 = 上一条最终输出，请求内/请求间统一）。
    // 2026-08-15：多轮工具调用累计 usage（每轮 stream 末尾都有 usage chunk）
    const totalUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0
    }
    let hasUsage = false
    // 断点兜底标记：AI 承诺调用工具但未发出 tool_calls 时，只强制续一轮，防止死循环
    let forcedToolRetry = false
    // 2026-08-18：工具失败死循环熔断（自动打断）
    // 现象：任务模式下 web_search/web_extract 抓技术文档反复失败（404/超时/无关结果），
    // AI 陷入"换 URL 再抓→失败→再换"的空转，每轮近似相同文本（用户感知"连续输出相同字符"），
    // 且无任何机制打断，直到 maxRounds 烧完或用户手动杀进程。
    // 机制：跨轮累计"同一工具+同关键参数"的失败次数，达到阈值注入系统打断指令让 AI 换策略或收尾；
    // 若打断后仍顽固重复失败，则直接终止循环，不再空转。
    // 指纹 = toolName + 参数值的有序拼接（稳定，URL/路径等关键参数变化即视为不同调用）。
    //
    // 2026-08-19 全量升级（对照工具护栏参考实现）：在循环内植入四类检测——
    // exact_failure（同工具+同参数失败）/ same_tool_failure（同工具失败，参数可不同）/
    // idempotent_no_progress（读类工具结果 hash 相同=无进展）/ loop_caps（单轮 web_search 等 runaway 上限）。
    // 软 warn 先注入提示（给 AI 换策略的机会），硬 halt 才 break（切断空转）。
    // 落点在 streamWithTools 循环内（非 PreLLMCall），故主对话与团队成员(executeFn→streamWithTools)同时被覆盖。
const toolFailureCounts = new Map<string, number>()
    // 熔断注入的打断指令（仅注入一次），防止重复 push 刷上下文
    let haltInjected = false
    let halted = false
    // 2026-09-12：区分「收尾后硬切断」与「跑满 maxRounds」两种结束原因，日志可辨
    let hardHalted = false

// ===== 2026-08-19 工具护栏状态（对照参考实现）=====
    // IDEMPOTENT_TOOLS / LOOP_CAP 已移至 ./llm-guardrails；此处仅保留跨轮累计状态
    // 跨轮累计（不 reset_for_turn，因为 streamWithTools 本身就是一次循环；工具段每轮都检测）
    const sameToolFailure = new Map<string, number>() // toolName → 连续失败轮数（参数可变）
    const noProgress = new Map<string, { hash: string; count: number }>() // 指纹 → 结果hash+重复次数
let turnWebSearchCount = 0
    let turnSubAgentCount = 0
    // 软 warn 注入的提示（仅注入一次/类，防刷上下文）
    const warnInjected = new Set<string>() // 用 code 去重的提示集合
    const pushGuardrailHint = (code: string, text: string): void => {
      if (warnInjected.has(code)) return
      warnInjected.add(code)
      conversation.push({ role: 'user', content: `（系统提示：${text}）` })
    }
    // 工具结果蒸馏替换：本轮 stream 产生的 tool 消息记录，在【下一轮请求构建前】批量蒸馏。
    // 时机说明：conversation 是每次 streamWithTools 内部的 wire 副本，不进 session 历史、
    // 不出本函数（session 只落 user/assistant，见 stream-runner 落盘），因此"流结束时替换"
    // 对任何后续请求都不可观测，等于白跑。唯一有实际效果的位置是工具轮执行完、
    // 下一轮请求发出之前——AI 后续轮次看到的是提炼摘要而非大段原文。
    const toolMsgIndices: Array<{
      index: number
      toolName: string
      toolCallId: string
      result: string
      // LLM 在工具参数中声明的结果处理方式：full = 原文保留（跳过蒸馏）；distill = 蒸馏
      resultMode: 'full' | 'distill'
    }> = []
    // 2026-09-12 观测：记录本轮流结束原因（stop/length/tool_calls），断流时用于定位
    let finishReason: string | null = null
    // 蒸馏替换 helper：遍历记录，调 distillToolResult 蒸馏对应 tool 消息。
    // 蒸馏成功 → 摘要替换 conversation 原文；失败（返回空或抛错）重试一次，
    // 仍失败保留原文进上下文（不截断不落盘）。
    // 摘要替换时保留消息来源护栏：同样按工具名分类重新包裹，否则下一轮请求中该 tool
    // 消息会退回无护栏裸文本，破坏"每条消息都有来源"契约。
    const distillAllToolMessages = async () => {
      // 意图上下文对话对数量：由服务端从设置注入（缺省回退 shared 单源默认），
      // 组装「该工具调用前的完整对话形态」传给蒸馏器判断相关性——与调取工具的那个
      // AI 同视角（含其思考、工具调用声明与此前工具消息链），见 buildTurnPairsIntent
      const intentPairs = callbacks.distillIntentTurnPairs ?? DEFAULT_TOOL_RESULT_DISTILL.intentTurnPairs
      // 第一步：统一快照全部待蒸馏条目与各自意图（LLM 声明 full = 原文完整保留：跳过蒸馏）。
      // 顺序依赖说明：意图必须基于「该工具调用前的原始 wire 副本」组装——若边蒸馏边替换
      // conversation，后蒸馏工具的意图会读到前一个已被替换成摘要的消息，意图即失真；
      // 先快照后执行可保证每条 intent 与调用者视角严格一致（原串行实现的隐患，一并修正）。
      const todo = toolMsgIndices
        .filter((tm) => tm.resultMode !== 'full')
        .map((tm) => ({ tm, intent: buildTurnPairsIntent(conversation, tm.index, intentPairs) }))
      // 第二步：并行蒸馏。每条最多尝试 2 次（失败 falsy/抛错重试一次，防瞬时超限/断流）；
      // 并发上限不在此叠加——distiller 内部已有信号量并发控制（acquire/release + waiters
      // 队列，见 services/tool-result-distiller.ts），外墙只需并行发起、由信号量统一限流。
      // 性能动机：多工具轮次（N 条结果）若逐条串行 await，下一轮请求构建被拖成 N 次串行
      // LLM 调用；工具消息之间无顺序依赖，并行后总耗时收敛为信号量允许的最大并发批。
      const settled = await Promise.allSettled(
        todo.map(async ({ tm, intent }) => {
          let distilled: string | undefined
          for (let attempt = 0; attempt < 2 && !distilled; attempt++) {
            try {
              distilled = await callbacks.distillToolResult?.(tm.toolName, tm.toolCallId, tm.result, intent)
            } catch {
              distilled = undefined
            }
          }
          return { tm, distilled }
        })
      )
      // 第三步：统一写回，保持原消息顺序。成功 → 摘要替换原文并重包护栏；失败 → 保留原文
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue // 重试内已全量 catch，此处仅防御异常路径
        const { tm, distilled } = r.value
        if (!distilled) continue // 重试仍失败：保留原文进上下文
        const toolSource = guardrailKey ? classifyToolSource(tm.toolName) : null
        conversation[tm.index].content =
          toolSource && guardrailKey ? wrapGuardrail(distilled, toolSource, guardrailKey) : distilled
      }
    }
    while (rounds <= maxRounds) {
      if (ctrl.signal.aborted) {
        logInfo('stream-abort', { reason: entry.abortReason ?? 'aborted', round: rounds })
        callbacks.onError(new Error(entry.abortReason ?? 'aborted'))
        return
      }

      let ttftTimer: ReturnType<typeof setTimeout> | null = null
      // 空闲超时计时器：首 token 到达后启动，每次收到新 token 重置；超过阈值无新 token 则 abort
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      // 2026-08-16 并发化：整请求共用 ctrl（含工具执行阶段；TTFT/idle 超时 abort 后
      // 后续轮次检查 signal.aborted 直接退出，无需每轮新建 controller）
      try {
        const requestStart = Date.now()
        // 本地模型（Ollama/llama.cpp）本身推理就慢，不再叠加人为节流
        const isLocalProvider = this.isLocalProvider()
        // TTFT 超时：本地模型推理慢（含模型加载），给 180s；云模型 30s。
        // 本地模型 cold start 加载可能要 1-2 分钟，180s 给足加载时间。
        const ttftTimeoutMs = isLocalProvider ? 180000 : 30000
        // 空闲超时：首 token 后若推理中途停滞的 abort 阈值。
        // 本地模型：180s。小模型深度思考（reasoning）结束后到开始输出正文之间可能有较长间隙，
        // 思考阶段虽然持续吐 reasoning token，但思考完成到正文生成切换时可能停滞；
        // 且小模型复杂推理/长代码生成时 token 间隔本身就长。
        // 用 180s（与 TTFT 一致）给足余量，避免误杀正在思考/切换阶段的模型。
        // 真正挂掉的请求 180s 内不会有任何 token，能被正确识别。
        // 云模型：30s。云服务稳定，30s 无 token 基本是挂了。
        const idleTimeoutMs = isLocalProvider ? 180000 : 30000
        let firstTokenAt = 0
        ttftTimer = setTimeout(() => {
          if (firstTokenAt === 0) {
            console.warn(`[llm] TTFT 超时 ${ttftTimeoutMs}ms，abort`)
            entry.abortReason = 'ttft_timeout'
            ctrl.abort()
          }
        }, ttftTimeoutMs)
        console.log(
          `[llm] stream 请求开始 model=${useModel} msgs=${conversation.length} round=${rounds} ttftLimit=${ttftTimeoutMs}ms`
        )
        const stream = await this.client.chat.completions.create(
          {
            model: useModel,
            // 2026-08-26 修复（系统故障：子 agent 执行完就 400 断链）：
            // DeepSeek 思考模式要求历史 assistant 消息的 reasoning_content 原样回传，否则下一请求 400。
            // reasoning_content 在 conversation 构建处（432 行）已从 ChatMessage.reasoning 转好，
            // 请求内轮次的 push 也带 reasoning_content——这里整体展开即可，无需再改名。
            messages: conversation.map((m) => ({ ...m })) as never,
            temperature: options?.temperature ?? this.config.temperature ?? 0.7,
            max_tokens: this.config.maxTokens ?? undefined,
            stream: true,
            // 2026-08-15：请求流式 usage（DeepSeek 需显式 include_usage 才会在流末尾返回
            // prompt_cache_hit_tokens 等用量；否则缓存命中率/真实 token 成本永远不可见）
            stream_options: { include_usage: true },
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            ...this.buildReasoningParams(),
            ...this.buildSamplingParams()
          },
          { signal: ctrl.signal }
        )

// 节流已移除：前端 server.ts 已有 BUFFER_INTERVAL_MS=33ms 批量缓冲，无需在此双重节流
        // 旧实现 delayMs>0 时每个 token 都 setTimeout，1000 token 累积 30s 延迟，是 LLM 慢的元凶
        const delayMs = 0
        let tokenCount = 0

        let contentBuf = ''
        // 2026-08-24：思考流重复检测用的 buffer 和计数器（与正文重复检测共享算法和阈值）
        let reasoningBuf = ''
        let reasoningCheckCounter = 0
        const toolCallMap = new Map<number, { id: string; name: string; args: string }>()
        // 流式 usage 收集（DeepSeek 在流末尾的 usage chunk 返回，choices 为空）
        let streamUsage: TokenUsage | undefined

        // ===== 2026-08-24 文本级重复检测（generation loop breaker）=====
        // 现象：模型流式输出陷入文本级重复循环——同一句话或同一段话原样重复几十遍，
        // 或 </invoke></parameter> 等闭合标签堆叠几十层。工具级 guardrail 不触发
        // （这轮有 tool_calls 或没在重复调用工具），但输出已 runaway。
        // 机制：每收到 64 个 content token 做一次尾部重复检测——取 contentBuf 尾部
        // 512 字符窗口，检测是否存在「长度 ≥24 的子串连续出现 ≥3 次」的重复模式。
        // 命中则 abort 当前流并注入打断指令，让 AI 换策略或收尾。
        // - 窗口 512 字符：覆盖一整句到一小段话的重复单元
        // - 子串 ≥24 字符：避免把正常重复词（"的""了"等）误判为循环
        // - 连续 ≥3 次：3 次重复在自然语言里几乎不可能，是 generation loop 的可靠信号
        // - 检测频率 64 token：避免每个 token 都做 O(n²) 检测的开销
        let repetitionDetected = false
        let repetitionCheckCounter = 0
        // 2026-08-26：思考流 <system> 回放计数（跨 chunk 累计，≥2 打断）
        let systemTagCount = 0
// detectTailRepetition / REPETITION_* 常量已移至 ./llm-guardrails

        for await (const chunk of stream) {
          if (ctrl.signal.aborted) break
          // 流末尾 usage chunk（choices 为空数组，usage 有值）
          if (chunk.usage) {
            streamUsage = mapUsage(chunk.usage as never)
            if (streamUsage) {
              hasUsage = true
              totalUsage.inputTokens += streamUsage.inputTokens
              totalUsage.outputTokens += streamUsage.outputTokens
              totalUsage.cacheReadTokens =
                (totalUsage.cacheReadTokens ?? 0) + (streamUsage.cacheReadTokens ?? 0)
              totalUsage.reasoningTokens =
                (totalUsage.reasoningTokens ?? 0) + (streamUsage.reasoningTokens ?? 0)
            }
          }
          const choice = chunk.choices[0]
          if (!choice) continue
          if (choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice.delta as Record<string, unknown> | undefined
          if (!delta) continue

          // ===== 深度思考字段处理 =====
          // 不同模型字段名不同：
          // DeepSeek-R1/Distill: reasoning_content
          // QwQ / GLM-Z1: reasoning_content
          // 部分 OpenAI 兼容接口: thinking
          // 思考 token 不计入 contentBuf（不写入最终回复），单独推给前端展示。
          // reasoning 也做重复检测——思考流陷入重复循环（同一句"让我先查清楚"
          // 重复几十遍）和正文重复一样致命，但之前没有覆盖。
          const reasoningText =
            (delta.reasoning_content as string | undefined) ??
            (delta.thinking as string | undefined) ??
            (delta.reasoning as string | undefined)
          if (reasoningText) {
            if (firstTokenAt === 0) {
              firstTokenAt = Date.now()
              if (ttftTimer) {
                clearTimeout(ttftTimer)
                ttftTimer = null
              }
              console.log(`[llm] TTFT=${firstTokenAt - requestStart}ms (首思考 token)`)
            }
            // 思考 token 也重置 idle timer，避免长时间思考被误判超时
            if (idleTimer) {
              clearTimeout(idleTimer)
            }
            idleTimer = setTimeout(() => {
              console.warn(`[llm] 空闲超时 ${idleTimeoutMs}ms 无新 token，abort`)
              entry.abortReason = 'idle_timeout'
              ctrl.abort()
            }, idleTimeoutMs)
            // ===== 思考流重复检测（2026-08-24）=====
            reasoningBuf += reasoningText
            reasoningCheckCounter++
            if (reasoningCheckCounter >= REPETITION_CHECK_INTERVAL) {
              reasoningCheckCounter = 0
              if (detectTailRepetition(reasoningBuf)) {
                console.warn(
                  `[llm] 🔁 检测到思考流重复（reasoning loop），abort round=${rounds} tokens=${tokenCount}`
                )
                repetitionDetected = true
                entry.abortReason = 'repetition_loop'
                ctrl.abort()
                break
              }
            }
            // ===== 系统消息回放检测（奥卡姆剃刀：防"系统命令泄露"观感）=====
            // deepseek 系模型会把 system 注入消息（激活/续接/健康检查）以
            // <system role="system">…</system> XML 标签形式"回放"进思考流——
            // 用户看到的"思考区一大坨系统命令"即此。逐 token 计数开标签：
            // 思考里出现 ≥2 个 <system 标签 = 模型在复述注入消息，直接 abort 打断。
            const systemTagMatch = reasoningText.match(/<system[\s>]/gi)
            if (systemTagMatch && !repetitionDetected) {
              systemTagCount += systemTagMatch.length
              if (systemTagCount >= 2) {
                console.warn(
                  `[llm] 🔁 检测到思考流系统消息回放（<system> 标签 ×${systemTagCount}），abort round=${rounds} tokens=${tokenCount}`
                )
                repetitionDetected = true
                entry.abortReason = 'system_replay_loop'
                ctrl.abort()
              }
            }
            callbacks.onReasoning?.(reasoningText)
          }

          // ===== 正常 content 处理 =====
          const contentText = delta.content as string | undefined
          if (contentText) {
            if (firstTokenAt === 0) {
              firstTokenAt = Date.now()
              if (ttftTimer) {
                clearTimeout(ttftTimer)
                ttftTimer = null
              }
              console.log(`[llm] TTFT=${firstTokenAt - requestStart}ms (首 token 延迟)`)
            }
            // 首 token 后启动 idle timer；每次收到新 token 重置，本地 60s/云 30s 无新 token 则 abort
            if (idleTimer) {
              clearTimeout(idleTimer)
            }
            idleTimer = setTimeout(() => {
              console.warn(`[llm] 空闲超时 ${idleTimeoutMs}ms 无新 token，abort`)
              entry.abortReason = 'idle_timeout'
              ctrl.abort()
            }, idleTimeoutMs)
            tokenCount++
            contentBuf += contentText
            callbacks.onToken(contentText)
            // ===== 文本级重复检测（2026-08-24）=====
            // 每 64 个 content token 做一次尾部重复检测，命中则 abort 流
            repetitionCheckCounter++
            if (repetitionCheckCounter >= REPETITION_CHECK_INTERVAL) {
              repetitionCheckCounter = 0
              if (detectTailRepetition(contentBuf)) {
                console.warn(
                  `[llm] 🔁 检测到流式输出重复（generation loop），abort round=${rounds} tokens=${tokenCount}`
                )
                repetitionDetected = true
                entry.abortReason = 'repetition_loop'
                ctrl.abort()
                break
              }
            }
            // 节流已移除：delayMs 恒为 0，保留变量仅为兼容性（speed 配置仍读取但不影响流速）
            if (delayMs > 0) {
              await new Promise((r) => setTimeout(r, delayMs))
            }
          }

          // ===== 工具调用字段处理 =====
          const toolCalls = delta.tool_calls as
            | Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            | undefined
          if (toolCalls) {
            for (const tc of toolCalls) {
              const idx = tc.index ?? 0
              if (!toolCallMap.has(idx)) {
                toolCallMap.set(idx, { id: tc.id ?? '', name: '', args: '' })
              }
              const tcEntry = toolCallMap.get(idx)!
              if (tc.id) tcEntry.id = tc.id
              if (tc.function?.name) tcEntry.name += tc.function.name
              if (tc.function?.arguments) tcEntry.args += tc.function.arguments
            }
          }
        }

        // ===== 2026-08-26 流末复读补检（奥卡姆剃刀补洞）=====
        // 原检测只在流内每 64 content token 触发一次——短句复读（"你是在做什么"×30 ≈ 30 token）
        // 流就结束了，根本到不了 64 门槛 → 复读静默放行（实录：a_1787723980979 思考 1290 字全是一句复读）。
        // 流结束后补检一次尾部（正文 + 思考流），命中即标记 repetitionDetected（走下方 abort 打断路径）。
        if (!repetitionDetected) {
          const tailRepeatInBody = detectTailRepetition(contentBuf)
          const tailRepeatInReasoning = detectTailRepetition(reasoningBuf)
          if (tailRepeatInBody || tailRepeatInReasoning) {
            repetitionDetected = true
            entry.abortReason = 'repetition_loop'
            // 模拟流内重复检测的 abort：触发下方 846 的打断路径（注入换策略指令续一轮）
            ctrl.abort()
            console.warn(
              `[llm] 🔁 流末复读补检命中（正文=${tailRepeatInBody} 思考=${tailRepeatInReasoning}），abort round=${rounds} tokens=${tokenCount}`
            )
          }
        }

        if (ctrl.signal.aborted) {
          // 2026-08-24：重复检测触发的 abort 走特殊处理——
          // 不直接 onError（那会丢失已生成内容），而是注入打断指令续一轮让 AI 换策略。
          // 只续一轮，防重复-打断-再重复的死循环。
if (repetitionDetected && !haltInjected) {
            haltInjected = true
            // 判断重复发生在思考流还是正文：reasoningBuf 有内容且 contentBuf 为空 = 思考阶段重复
            const isReasoningLoop = reasoningBuf.length > 0 && contentBuf.length === 0
            console.warn(
              `[llm] 🔁 重复检测打断（${isReasoningLoop ? '思考流' : '正文'}重复），注入换策略指令 round=${rounds}`
            )
            // 2026-08-26（系统级治本）：打断时【不回灌复读原文】。
            // 原实现把复读的 reasoning/content 原文作为 assistant 消息
            // 塞回 conversation——模型下一轮又看到自己刚复读的文本 → 继续复读。
            // 打断机制 = 复读放大器。治本：只给占位（不含任何复读文本），
            // 模型不再接触复读种子，只能基于新指令换方向。
            conversation.push({
              role: 'assistant',
              content: isReasoningLoop
                ? '（系统已截断陷入重复的思考过程）'
                : '（系统已截断陷入重复的输出）'
            })
            conversation.push({
              role: 'user',
              content: isReasoningLoop
                ? '（系统检测：你的思考过程陷入重复循环——同一段思考内容已连续重复多遍。' +
                  '立即停止重复思考。重新审视当前目标：如果当前思路走不通，换一种方法，' +
                  '或直接基于已有结论输出正式回复/执行下一步操作。不要重新思考已经想过的问题。' +
                  '如果任务卡住，向用户说明卡点并请求指示。）'
                : '（系统检测：你的输出陷入重复循环——同一句话或同一段话已连续重复多遍。' +
                  '立即停止重复。重新审视当前目标：如果当前方法/思路走不通，换一种方法，' +
                  '或向用户说明卡点并请求指示。不要继续用旧方法重复尝试，不要重复之前说过的任何内容。' +
                  '如果你已经回答完毕，直接结束。）'
            })
            rounds++
            continue
          }
          callbacks.onError(new Error(entry.abortReason ?? 'aborted'))
          return
        }

        console.log(
          `[llm] stream 完成 tokens=${tokenCount} 总耗时=${Date.now() - requestStart}ms` +
            (streamUsage
              ? ` input=${streamUsage.inputTokens} output=${streamUsage.outputTokens} cacheHit=${streamUsage.cacheReadTokens ?? 0}`
              : '')
        )

        // ===== 2026-08-26 跨轮输出重复检测（cross-round loop breaker，请求内+请求间统一）=====
        // 现象：AI 陷入"每轮输出一大段相似内容但方向没变"的循环——单轮内部没有文本级重复
        // （尾部重复检测抓不到），工具调用也正常（幂等/失败检测抓不到），内容也长（空转检测抓不到）。
        // 用户感知为"长字数的大段重复"，但三种现有检测全部漏掉。
        // 机制：记录每条最终输出（lastFinalOutput），与上一条做相似度比较。
        // 归一化（去空白）后若当前输出是上一条输出的子串（或反之）且长度 ≥ 阈值，
        // 判定"近似重复"，连续 ≥2 条命中则注入打断指令让 AI 换方向。
        // 设计：只比较相邻两条（不累计历史），避免误伤"多轮推进但内容渐进"的正常场景；
        // 子串判定比全文相似更稳——循环时每条几乎原样复述，正常推进时不会互为子串。
        // 2026-08-26（奥卡姆剃刀）：比较基准提升为实例字段 lastFinalOutput——
        // 持续激活的每轮续接都是独立请求，原请求内 roundOutputs 数组跨请求即失效，
        // 导致"请求间复读"（连发 N 轮同一句）漏网。现在请求内/请求间统一比较。
        const CROSS_ROUND_MIN_LEN = 50 // 参与比较的最小输出长度（太短不判，避免误伤短回复）
        const CROSS_ROUND_MIN_SIM = 0.8 // 相似度阈值：归一化后公共子串占比 ≥80% 判为近似重复
        const CROSS_ROUND_MAX_HITS = 2 // 连续近似重复 ≥2 轮即打断
        // 2026-08-26（系统级治本）：跨轮重复检测同时覆盖【思考流】。
        // 原实现只比较 contentBuf（正文）——实测复读主要发生在 reasoning（正文空转），
        // 思考流复读全漏。现在正文 OR 思考流任一与上一轮同区重复即计数。
        if (
          contentBuf.trim().length >= CROSS_ROUND_MIN_LEN ||
          reasoningBuf.trim().length >= CROSS_ROUND_MIN_LEN
        ) {
          const norm = (s: string): string => s.replace(/\s+/g, '').trim()
          const curText = norm(contentBuf)
          const curThink = norm(reasoningBuf)
          const prevText = this.lastFinalOutput ? norm(this.lastFinalOutput) : ''
          const prevThink = this.lastReasoningOutput ? norm(this.lastReasoningOutput) : ''
          const simPair = (cur: string, prev: string): number => {
            if (cur.length < CROSS_ROUND_MIN_LEN || prev.length < CROSS_ROUND_MIN_LEN) return 0
            const shorter = Math.min(cur.length, prev.length)
            const longer = Math.max(cur.length, prev.length)
            const isSubstring = cur.includes(prev) || prev.includes(cur)
            return isSubstring && longer > 0 ? shorter / longer : 0
          }
          const simBody = simPair(curText, prevText)
          const simThink = simPair(curThink, prevThink)
          const sim = Math.max(simBody, simThink)
          // 无论命中与否，更新基准（供下一轮跨轮比较）
          this.lastFinalOutput = contentBuf
          this.lastReasoningOutput = reasoningBuf
          if (sim >= CROSS_ROUND_MIN_SIM) {
            this.crossRequestHits++
            console.warn(
              `[llm] 🔁 跨轮输出重复检测命中 ${this.crossRequestHits}/${CROSS_ROUND_MAX_HITS}（相似度 ${(sim * 100).toFixed(0)}%）round=${rounds}`
            )
            if (this.crossRequestHits >= CROSS_ROUND_MAX_HITS && !haltInjected) {
              haltInjected = true
              console.warn(`[llm] 🔇 跨轮输出重复已达阈值，注入换方向指令 round=${rounds}`)
              conversation.push({
                role: 'user',
                content:
                  '（系统检测：你已连续多轮输出高度相似的大段内容，但整体方向没有推进，陷入跨轮重复循环。' +
                  '立即停止复述/重复之前说过的内容。重新审视当前目标：如果当前思路走不通，换一种真正不同的方法；' +
                  '如果任务卡住，向用户说明卡点并请求指示。不要继续用旧思路输出相似内容。）'
              })
              rounds++
              continue
            }
          } else {
            this.crossRequestHits = 0
          }
        }

        // 无工具调用：本轮 stream 完成
        if (toolCallMap.size === 0) {
          // ===== 断点兜底：AI 承诺调用工具但未发出 tool_calls =====
          // 现象：小模型（如 flash）在长上下文下输出"我马上做……："后直接正常 stop，
          // 没有发出 tool_calls，系统误判为正常完成（RAW 里留一堆"承诺做但没做"）。
          // 处理：把承诺文本 push 回上下文，追加强制指令让它真正执行工具调用，只续一轮。
          const trimmedEnd = contentBuf.trimEnd()
          const looksPromised =
            trimmedEnd.length > 0 && (/([:：…]$)/.test(trimmedEnd) || trimmedEnd.endsWith('...'))
          if (!forcedToolRetry && tools.length > 0 && looksPromised) {
            forcedToolRetry = true
            console.warn(
              `[llm] 检测到承诺未执行（输出以冒号/省略号结尾但无 tool_calls），强制续一轮 round=${rounds}`
            )
            conversation.push({
              role: 'assistant',
              content: contentBuf,
              ...(this.isDeepSeekProvider() && reasoningBuf ? { reasoning_content: reasoningBuf } : {})
            })
            conversation.push({
              role: 'user',
              content:
                '（系统检测：你上一轮承诺要调用工具但未实际发出 tool_calls。请立即执行你要做的工具调用，直接调用工具，不要重复承诺说明。）'
            })
            rounds++
            continue
          }
          // ===== P2-2 编造工具调用检测（2026-08-24）=====
          // 现象：flash 模型在正文里写"我查了""我读了""typecheck 通过"但实际没发 tool_calls。
          // 承诺检测只抓冒号/省略号结尾，不抓这种"编造已完成"的幻觉。
          // 机制：检测正文是否包含「声称执行了某操作」的模式词 + 有工具可用但未调用，
          // 只续一轮强制真正执行。仅续一轮防死循环。
          if (!forcedToolRetry && tools.length > 0 && contentBuf.length > 50) {
            //（奥卡姆剃刀补洞）：原式只匹配"我(?:查了|读了|...)",
            // 实录漏网"我读完了 xxx"（"读完了"≠"读了"）——该轮声称读了文件却无 tool_calls。
            // 补"完了/好了"变体；"已经/刚才"后缀也补完/好。
            const fabricatedAction =
              /(我(?:查(?:了|完了|好了)|读(?:了|完了|好了)|搜(?:了|完了|好了)|跑(?:了|完了|好了)|执行(?:了|完了|好了)|确认(?:了|完了|好了)|验证(?:了|完了|好了)|typecheck(?:了|好了)?|测(?:了|完了|好了)|检查(?:了|完了|好了)|看(?:了|完了|好了))|已经(?:查|读|搜|跑|执行|确认|验证|测|检查|看)(?:了|完|好)|刚才(?:查|读|搜|跑|执行|确认|验证|测|检查|看)(?:了|完|好))/.test(
                contentBuf
              )
            if (fabricatedAction) {
              forcedToolRetry = true
              console.warn(
                `[llm] 检测到编造工具调用（正文声称执行操作但无 tool_calls），强制续一轮 round=${rounds}`
              )
              conversation.push({
                role: 'assistant',
                content: contentBuf,
                ...(this.isDeepSeekProvider() && reasoningBuf
                  ? { reasoning_content: reasoningBuf }
                  : {})
              })
              conversation.push({
                role: 'user',
                content:
                  '（系统检测：你正文里声称"查了/读了/执行了/验证了"某操作，但本轮没有发出任何 tool_calls。' +
                  '不要在文字里编造执行结果。如果你需要查/读/执行，立即发出对应的工具调用；' +
                  '如果不需要工具就能回答，去掉正文中声称执行了操作的虚假表述。）'
              })
              rounds++
              continue
            }
          }
          // ===== P1-2 纯文本 runaway 检测（2026-08-24）=====
          // 现象：模型无 tool_calls 的纯文本输出超长（>4000 token≈8000 汉字），
          // 在正常对话/编码场景几乎不会出现，通常是 generation loop 没被重复检测抓到
          // （重复单元 < 24 字符或检测间隔内未触发）。作为兜底防线。
          // 机制：tokenCount 超 4000 且无 tool_calls → 截断输出，注入收尾指令续一轮。
          if (tokenCount > 4000 && !forcedToolRetry) {
            forcedToolRetry = true
            console.warn(
              `[llm] 检测到纯文本 runaway（${tokenCount} tokens 无 tool_calls），截断收尾 round=${rounds}`
            )
            conversation.push({
              role: 'assistant',
              content: contentBuf.slice(0, 4000),
              ...(this.isDeepSeekProvider() && reasoningBuf
                ? { reasoning_content: reasoningBuf }
                : {})
            })
            conversation.push({
              role: 'user',
              content:
                '（系统检测：你的输出过长（超 4000 token）且没有调用任何工具。' +
                '请立即结束当前输出，给出简洁的最终结论。不要继续展开。）'
            })
            rounds++
            continue
          }
          // 收尾：本轮无工具调用，蒸馏已在各工具轮结束后完成（见循环内调用），此处不再重复
          logInfo('stream-end', {
            reason: 'completed',
            round: rounds,
            finishReason,
            contentLen: contentBuf.length,
            toolResults: toolMsgIndices.length
          })
          // ⚠️ 2026-08-10 修复：原实现不 await——onDone 内（会话模式语言重试 chatWithTools、
          // RAW 写入/摘要调度）await 挂起时，finally 已把 currentController 清空 →
          // 重试请求失去 abort/超时保护；onDone 内抛错变 unhandledRejection → 前端收不到 done 卡 streaming。
          if (hasUsage) callbacks.onUsage?.(totalUsage)
          await callbacks.onDone()
          return
        }

        // 把 assistant 的 tool_calls 加入会话
        const toolCalls: ToolCallResult[] = Array.from(toolCallMap.values()).map((t) => ({
          id: t.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'function' as const,
          function: { name: t.name, arguments: t.args }
        }))
        conversation.push({
          role: 'assistant',
          content: contentBuf || '',
          tool_calls: toolCalls,
          // 2026-08-26 修复：本轮 reasoning 一并回传——带 tool_calls 的 assistant 消息在思考模式下
          // DeepSeek 硬性要求 reasoning_content 原样回传（仅 DeepSeek 系 API，其他网关回传会被拒绝）
          ...(this.isDeepSeekProvider() && reasoningBuf ? { reasoning_content: reasoningBuf } : {})
        })

        // 执行工具调用（2026-08-10 路径重叠并行判定机制本土化）：
        // 读-读并行（Read/Grep/Glob 等只读工具任意并行）；
        // 含写工具（Write/Edit/MoveFile/DeleteFile）对同一路径 → 关段串行（避免读写竞争）；
        // 交互式工具（dmn_ask_user/requestPermission 等弹窗等用户）→ barrier 强制串行；
        // 参数解析失败的调用 → barrier（后续可能依赖其输出）。
        // 无冲突的调用保持并行（分段：parallel 段 / sequential barrier 段交替）。

// 工具分类（READ_TOOLS / WRITE_TOOLS / INTERACTIVE_TOOLS 已移至 ./llm-guardrails）

        // ⚠️ 2026-08-12 修复：用户打断（abort）后工具快速收尾——
        // 默认 30s 超时会让旧流在 streamChain 上拖住新消息（用户感知"发消息不回复"）。
        // abort 后只给 3s 收尾：当前工具最多 3s 内被放弃，旧流立即结束，新消息马上开始。
        const TOOL_TIMEOUT_MS = ctrl.signal.aborted ? 3000 : 30000

// extractPaths / pathsConflict 已移至 ./llm-guardrails

        // 解析所有调用（参数 + 分类），失败标记 barrier
        type ParsedCall = {
          tc: (typeof toolCalls)[number]
          args: Record<string, unknown>
          paths: string[]
          isWrite: boolean
          isInteractive: boolean
          parseFailed: boolean
          isRead: boolean
          // 结果处理模式：LLM 在工具参数里声明 _result_mode = 'full' 则不蒸馏原文保留；
          // 缺省 / 'distill' 走蒸馏。声明在解析层剥离，不传给工具本体。
          resultMode: 'full' | 'distill'
        }
        const parsedCalls: ParsedCall[] = toolCalls.map((tc) => {
          let args: Record<string, unknown> = {}
          let parseFailed = false
          try {
            args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
          } catch (err) {
            args = { _parseError: (err as Error).message }
            parseFailed = true
          }
          const name = tc.function.name
          const resultMode = args._result_mode === 'full' ? 'full' : 'distill'
          // 剥离控制声明：_result_mode 是系统层选项，不得作为真实参数落入工具本体
          if ('_result_mode' in args) delete args._result_mode
          return {
            tc,
            args,
            paths: extractPaths(args),
            isWrite: WRITE_TOOLS.has(name),
            isInteractive: INTERACTIVE_TOOLS.has(name),
            parseFailed,
            isRead: READ_TOOLS.has(name),
            resultMode
          }
        })

        // 分段：贪心把调用分成 parallel 段 / barrier 串行段
        const segments: ParsedCall[][] = []
        let current: ParsedCall[] = []
        for (const call of parsedCalls) {
          // barrier 条件：交互式 / 解析失败 / 与段内已有调用路径冲突（含写）
          const conflictsWithCurrent = current.some((c) => {
            if (call.isInteractive || call.parseFailed) return true
            if (call.isWrite && c.isWrite) return pathsConflict(call.paths, c.paths)
            if (call.isWrite && !c.isWrite && c.isRead) return pathsConflict(call.paths, c.paths)
            if (!call.isWrite && c.isWrite) return pathsConflict(call.paths, c.paths)
            return false
          })
          if (call.isInteractive || call.parseFailed || conflictsWithCurrent) {
            if (current.length > 0) {
              segments.push(current)
              current = []
            }
            // barrier 调用单独成段
            segments.push([call])
          } else {
            current.push(call)
          }
        }
        if (current.length > 0) segments.push(current)

        // 逐段执行（段内并行，段间串行）
        const execResults: Array<{
          tc: (typeof toolCalls)[number]
          toolName: string
          toolCallId: string
          result: string
          timedOut?: boolean
          resultMode: 'full' | 'distill'
        }> = []
        // 本回合超时的工具名：执行后据此注入一次系统提示（提醒 AI 看原因，勿盲目重试）
        const timedOutTools: string[] = []
        // 本回合转入后台托管的任务（软超时：进程不杀，AI 用 tool_watch/tool_stop 接管）
        const managedHandoffs: Array<{ taskId: string; toolName: string }> = []
        for (const segment of segments) {
          // 2026-08-12：abort 后跳过尚未执行的工具段（用户已打断，不再执行剩余工具）
          if (ctrl.signal.aborted) {
            for (const call of segment) {
              callbacks.onToolStart?.(call.tc.function.name, call.tc.id, {})
              const skipResult = JSON.stringify({ error: '工具调用已跳过（用户打断）' })
              callbacks.onToolEnd?.(call.tc.function.name, call.tc.id, skipResult)
              execResults.push({
                tc: call.tc,
                toolName: call.tc.function.name,
                toolCallId: call.tc.id,
                result: skipResult,
                resultMode: call.resultMode
              })
            }
            continue
          }
          const segResults = await Promise.all(
            segment.map(async (call) => {
              const tc = call.tc
              const tool = tools.find((t) => t.name === tc.function.name)
              if (!tool) {
                callbacks.onToolStart?.(tc.function.name, tc.id, {})
                const errMsg = `工具未注册: ${tc.function.name}`
                const errResult = JSON.stringify({ error: errMsg })
                callbacks.onToolEnd?.(tc.function.name, tc.id, errResult)
                return {
                  tc,
                  toolName: tc.function.name,
                  toolCallId: tc.id,
                  result: errResult,
                  resultMode: call.resultMode
                }
              }

              callbacks.onToolStart?.(tc.function.name, tc.id, call.args)
              let result = ''
              let timedOut = false
              const startedAt = Date.now()
              try {
                // 工具执行超时保护，防止工具卡死阻塞整个 stream（本地工具 30s 上限）
                // 超时定时器在工具完成后必须 clearTimeout，否则 reject 后定时器仍挂在事件循环中
                // Agent 工具豁免外层超时：子 agent 由内层 SubAgentManager 超时管理
                // （默认 10 分钟、可按 task.timeoutMs 配置），外层 30s 会掐死长审查/长调研任务
                let timeoutTimer: ReturnType<typeof setTimeout> | null = null
                // 工具级取消信号：超时触发时 abort，让工具本身（经 ToolContext.signal）感知取消，
                // 而非旧实现只 reject 外层——底层工具在后台继续跑成孤儿（进程/请求泄漏）
                const toolAbort = new AbortController()
                try {
                  // 工具执行链注入 toolCallId 上下文（subagent 事件关联用）：
                  // 工具内部（尤其 Agent 工具 → launchSubAgent → SubAgentManager）可通过
                  // getCurrentToolCallId() 读到本工具的调用 id，事件流据此挂到主对话卡片
                  const execWithCtx = () => {
                    // Agent 与 team_launch 豁免外层超时：两者都启动子 agent，由内层
                    // SubAgentManager 超时管理（默认 10 分钟），外层 30s 会掐死长任务
                    // tool_watch / tool_stop 同样豁免：它们是托管协议的配套工具，
                    // 承载 AI 设定的检查等待（waitMs 可达 5 分钟），外墙 30s 会误杀
                    if (
                      tc.function.name === 'Agent' ||
                      tc.function.name === 'team_launch' ||
                      tc.function.name === 'tool_watch' ||
                      tc.function.name === 'tool_stop'
                    ) {
                      const exec = tool.execute(call.args)
                      // 豁免工具与对话打断桥接：tool_watch 可能等至 5 分钟（AI 设定的
                      // 检查时间），若用户在等待中途打断，必须立即让位结束旧流收尾，
                      // 不能让等待继续拖着对话关停。桥接 ctrl（对话级取消）→ toolAbort
                      // （工具级取消），tool_watch 内部按 ctx.signal 感知并提前返回。
                      // Agent/team_launch 有独立子 agent 生命周期，不桥接（避免误中断
                      // 已豁免的子任务内部逻辑）。
                      if (tc.function.name === 'tool_watch' || tc.function.name === 'tool_stop') {
                        const onUserAbort = () => {
                          try {
                            toolAbort.abort()
                          } catch {
                            /* abort 本身不抛错，防御性兜底 */
                          }
                        }
                        ctrl.signal.addEventListener('abort', onUserAbort, { once: true })
                        // 工具先返回时摘除监听，避免 listener 悬挂到对话请求结束。
                        // 必须先 .catch 再 .finally：exec.finally() 会派生新 promise，
                        // exec reject 时派生链同样 reject 且无处处理（Node 默认
                        // --unhandled-rejections=throw，会拖垮测试/进程）——catch 先吞掉
                        // rejection，finally 链自此不再抛。
                        exec
                          .catch(() => {})
                          .finally(() => ctrl.signal.removeEventListener('abort', onUserAbort))
                      }
                      return exec
                    }
                    // 软超时托管：对可托管工具（真实子进程、可后台继续跑），外墙
                    // 超时不 abort、不拒绝——工具转后台继续执行并登记 taskId，立即返回
                    // 托管诊断结果；AI 用 tool_watch(taskId, waitMs) 设定新检查时间继续
                    // 查看，到期未完成可再 watch 或 tool_stop 主动停止。彻底告别「锁死
                    // 固定时间超时打断长任务」。不可托管工具（文件/查询等卡死无后台价值）
                    // 仍走下方强杀路径（30s abort 防拖死对话）。
                    if (MANAGED_TIMEOUT_TOOLS.has(tc.function.name) && !ctrl.signal.aborted) {
                      const execPromise = tool.execute(call.args)
                      return new Promise<string>((resolve) => {
                        let settled = false
                        // 工具在 30s 内完成 → 正常返回（与强杀路径同语义）。
                        // undefined 结果兜底为空串：JSON.stringify(undefined) 返回
                        // undefined（非 string），后续写 conversation 会得到缺失字段
                        execPromise.then(
                          (raw) => {
                            if (settled) return
                            settled = true
                            resolve(
                              typeof raw === 'string'
                                ? raw
                                : typeof raw === 'undefined'
                                  ? ''
                                  : JSON.stringify(raw)
                            )
                          },
                          (err) => {
                            if (settled) return
                            settled = true
                            resolve(JSON.stringify({ error: (err as Error).message }))
                          }
                        )
                        timeoutTimer = setTimeout(() => {
                          if (settled) return
                          settled = true
                          const taskId = registerManagedRun(
                            tc.function.name,
                            call.args,
                            startedAt,
                            toolAbort,
                            execPromise
                          )
                          managedHandoffs.push({ taskId, toolName: tc.function.name })
                          resolve(
                            JSON.stringify({
                              ok: false,
                              timeout: true,
                              managed: true,
                              taskId,
                              tool: tc.function.name,
                              elapsedMs: Date.now() - startedAt,
                              error: `工具「${tc.function.name}」执行超过外墙阈值（${TOOL_TIMEOUT_MS}ms），已转入后台继续运行（未中断进程）`,
                              suggestion:
                                `托管任务未被打断，正在后台继续执行。调 tool_watch(taskId="${taskId}", waitMs) 设定一个检查时间：` +
                                `完成则取回完整结果；到期未完成返回 running，可继续调 tool_watch 设定更长 waitMs 再查，` +
                                `或调 tool_stop(taskId) 主动停止。不要重复发起同一长命令。` +
                                formatConcurrencyAdvisory({ started: 'tool', taskId })
                            })
                          )
                        }, TOOL_TIMEOUT_MS)
                      })
                    }
                    return Promise.race([
                      tool.execute(call.args),
                      new Promise<string>((_, reject) => {
                        timeoutTimer = setTimeout(() => {
                          timedOut = true
                          try { toolAbort.abort() } catch { /* ignore */ }
                          reject(new Error('TOOL_TIMEOUT'))
                        }, TOOL_TIMEOUT_MS)
                      })
                    ])
                  }
                  result = await toolCallStorage.run(tc.id, () =>
                    toolSignalStorage.run(toolAbort.signal, execWithCtx))
                } finally {
                  if (timeoutTimer) clearTimeout(timeoutTimer)
                }
              } catch (err) {
                if (!timedOut) result = JSON.stringify({ error: (err as Error).message })
              }
              // 超时诊断统一在此覆盖（不放 catch 内）：abort 取消信号可能让工具先返回
              // 「已取消」而外层 race 后 reject——若只在 catch 分支写诊断会丢失诊断信息。
              // 只要 timedOut 成立，就以诊断结果为准（不硬截断成一句「超时」）。
              if (timedOut) {
                const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
                result = JSON.stringify({
                  ok: false,
                  timeout: true,
                  tool: tc.function.name,
                  timeoutMs: TOOL_TIMEOUT_MS,
                  elapsedMs: Date.now() - startedAt,
                  error: `工具「${tc.function.name}」执行超时（阈值 ${TOOL_TIMEOUT_MS}ms，已等待 ${elapsed}s 未返回，已向工具发送取消信号）`,
                  suggestion:
                    '超时不等于失败终局，先判断原因：①工具/命令本身耗时长——外层 30s 是对话保护墙，' +
                    '长命令请拆成可分段的小步骤，传更大的 timeoutMs 无效（那是工具内部计时，跨不过外层墙）；' +
                    '②工具卡死/死循环；③在等待外部响应（网络/子进程）。看清原因再决定换方案还是收尾，不要原样重试同一调用。'
                })
                timedOutTools.push(tc.function.name)
              }
              callbacks.onToolEnd?.(tc.function.name, tc.id, result)
              return {
                tc,
                toolName: tc.function.name,
                toolCallId: tc.id,
                result,
                timedOut,
                resultMode: call.resultMode
              }
            })
          )
          execResults.push(...segResults)
        }

        // 按原顺序写回 conversation（tool_calls 顺序与结果一一对应，AI 依赖此顺序理解）
        for (const r of execResults) {
          // 消息来源护栏：工具结果按工具名分类包裹（网页搜索/文件读取/子AGENT/普通工具）
          const toolSource = guardrailKey ? classifyToolSource(r.toolName) : null
          conversation.push({
            role: 'tool',
            tool_call_id: r.tc.id,
            content: toolSource && guardrailKey ? wrapGuardrail(r.result, toolSource, guardrailKey) : r.result
          })
          toolMsgIndices.push({
            index: conversation.length - 1,
            toolName: r.toolName,
            toolCallId: r.toolCallId,
            result: r.result,
            // LLM 声明 full = 原文保留（跳过蒸馏）；缺省 / distill 走蒸馏
            resultMode: r.resultMode
          })
        }

        // 工具结果蒸馏（轮间时机）：本轮工具结果已全部写回 conversation，在下一轮请求
        // 构建前批量蒸馏——成功则摘要替换原文并重包护栏，失败重试一次仍失败保留原文。
        // 只有放在这里蒸馏才真正生效（conversation 是内部 wire 副本，不进 session 历史，
        // 流结束后的替换对任何后续请求都不可观测）。
        await distillAllToolMessages()

        // ===== 2026-08-19：工具循环护栏（对照参考实现）=====
        // 四类检测：exact_failure（同工具+同参数失败）/ same_tool_failure（同工具失败，参数可不同）/
        // idempotent_no_progress（读类工具结果 hash 相同=无进展）/ loop_caps（runaway 上限）。
        // 软 warn（pushGuardrailHint 注入提示，AI 可据此换策略）→ 硬 halt（注入打断指令后 break 收尾）。
        // 每轮 execResults 都已写回 conversation（AI 能看到原因），与已有 exact 熔断保序。
        // 工具超时提示：超时是有代价的等待——注入一次提醒，让 AI 看诊断原因再决策，
        // 而非原样重试（重试=再等一个完整超时周期，正是用户感知「一直等」的来源）。
        // 语义区分：托管工具（run_command/code_run）超时不打断，转后台继续跑——注入
        // 单独提示引导用 tool_watch/tool_stop 接管；强杀工具（文件/查询等）仍按原提示。
        if (!halted && timedOutTools.length > 0) {
          pushGuardrailHint(
            'tool_timeout',
            `本回合有工具执行超时被中止：${timedOutTools.join('、')}。超时结果里已附原因与耗时，` +
            `请先看清再行动——外层 30s 是对话保护墙，长命令应拆成可分段的小步骤或换方案` +
            `（传更大的 timeoutMs 无效，那是工具内部计时，跨不过外层墙），不要盲目重复同一调用。`
          )
        }
        if (!halted && managedHandoffs.length > 0) {
          for (const h of managedHandoffs) {
            pushGuardrailHint(
              `tool_handoff_${h.taskId}`,
              `工具「${h.toolName}」已超过外墙阈值转入后台继续运行（未中断，taskId=${h.taskId}）。` +
              `用 tool_watch(taskId="${h.taskId}", waitMs) 设定检查时间取结果：完成即返回最终结果；` +
              `到期仍 running 可再设更长 waitMs 继续检查，或 tool_stop(taskId="${h.taskId}") 主动停止。`
            )
          }
        }

        // ── loop_caps：runaway 上限（先计数，超限软提示；不硬 break，交给 maxRounds 兜底）──
        for (const r of execResults) {
          if (r.toolName === 'web_search') turnWebSearchCount++
          else if (isSubAgentish(r.toolName)) turnSubAgentCount++
        }
        if (!halted && turnWebSearchCount >= LOOP_CAP.webSearchPerRound) {
          pushGuardrailHint(
            'loop_web_search_cap',
            `本轮 web_search 已达 ${LOOP_CAP.webSearchPerRound} 次上限，疑似搜索风暴。停止再搜，结合已拿到的结果直接推进或回答。`
          )
        }
        if (!halted && turnSubAgentCount >= LOOP_CAP.subAgentPerRound) {
          pushGuardrailHint(
            'loop_subagent_cap',
            `本轮已启动 ${LOOP_CAP.subAgentPerRound} 次子 agent / 团队，疑似委派风暴。停止再启动新成员，基于现有结果汇总或收尾。`
          )
        }

        // ── 失败类：exact_failure（同指纹）+ same_tool_failure（同工具）──
        if (!halted) {
          for (const r of execResults) {
            const failed = isFailureResult(r.result)
            const fp = failureFingerprint(r.toolName, r.tc.function?.arguments ?? {})
            if (failed) {
              // exact：同工具+同参数失败
              const n = (toolFailureCounts.get(fp) ?? 0) + 1
              toolFailureCounts.set(fp, n)
              if (n >= TOOL_FAILURE_HALT) {
                halted = true
                break
              }
              // same_tool：同工具失败（参数可变也累计），换参数仍失败也要警觉
              const sn = (sameToolFailure.get(r.toolName) ?? 0) + 1
              sameToolFailure.set(r.toolName, sn)
              if (sn === 2) {
                pushGuardrailHint(
                  'same_tool_failure_warning',
                  `${r.toolName} 已连续 ${sn} 次失败（参数不同也算）。换一种工具或换整体思路，不要继续撞同一堵墙。`
                )
              } else if (sn >= 4) {
                halted = true
                break
              }
              noProgress.delete(fp)
            } else {
              // 成功：重置失败计数
              toolFailureCounts.delete(fp)
              sameToolFailure.delete(r.toolName)
              // ── idempotent_no_progress：读类工具结果 hash 相同=无进展 ──
              if (IDEMPOTENT_TOOLS.has(r.toolName)) {
                const h = resultHash(r.result)
                const prev = noProgress.get(fp)
                let count = 1
                if (prev && prev.hash === h) count = prev.count + 1
                noProgress.set(fp, { hash: h, count })
                if (!halted && count >= 3) {
                  pushGuardrailHint(
                    'idempotent_no_progress_warning',
                    `${r.toolName} 已返回相同结果 ${count} 次（无进展）。不要再重复同一查询，用已拿到的结果推进，或换一个真正不同的查询/目标。`
                  )
                }
                if (count >= 6) {
                  halted = true
                  break
                }
              } else {
                noProgress.delete(fp)
              }
            }
          }
        }
        // 硬 halt：先注入打断指令并放行一轮收尾，让模型真正产出最终回答（经 onToken 流式推给前端），
        // 避免「断了但没输出」（原实现注入后立即 break，模型从未读到指令 → 空输出）。
        // 若收尾轮仍触发循环，则硬切断（有界：最多多给一轮）。
        if (halted) {
          if (!haltInjected) {
            haltInjected = true
            console.warn(`[llm] 🔇 检测到工具循环（失败/无进展）已达阈值，注入收尾指令 round=${rounds}`)
            conversation.push({
              role: 'user',
              content:
                '（系统检测：你已连续多次重复调用工具且无实质进展（失败循环或返回相同结果），陷入死循环。' +
                '不要再重复这些无效调用。结合已掌握的现状输出最终回答结束任务；' +
                '若确实需要用户输入、授权或网络问题，明确向用户说明，不要空转。）'
            })
            // 放行一轮：不立刻 break，让模型下一轮生成最终回答（走 onDone 自然收尾，保留生成文本）
            halted = false
            rounds++
            continue
          }
          console.warn(`[llm] 🔇 收尾轮仍触发工具循环，硬切断 round=${rounds}`)
          hardHalted = true
          rounds++
          break
        }

        rounds++
      } catch (err) {
        logInfo('stream-error', {
          reason: ctrl.signal.aborted ? (entry.abortReason ?? 'aborted') : 'exception',
          round: rounds,
          error: (err as Error)?.message ?? String(err)
        })
        if (ctrl.signal.aborted) {
          callbacks.onError(new Error(entry.abortReason ?? 'aborted'))
        } else {
          callbacks.onError(err as Error)
        }
        return
      } finally {
        // 清理所有定时器，避免泄漏。原代码只清理 ttftTimer，idleTimer 未清理，
        // 导致每次 stream 结束后 idleTimer 仍挂在事件循环中，长时间运行后定时器堆积
        if (ttftTimer) {
          clearTimeout(ttftTimer)
          ttftTimer = null
        }
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }
    }

    // 达到最大轮数仍有工具调用（收尾：蒸馏已在各工具轮结束后完成，此处不再重复）
    logInfo('stream-end', {
      reason: hardHalted ? 'loop_halt' : 'max_rounds_reached',
      round: rounds,
      finishReason,
      toolResults: toolMsgIndices.length
    })
    if (hasUsage) callbacks.onUsage?.(totalUsage)
    callbacks.onDone()
    } finally {
      this.controllers.delete(reqId)
    }
  }
}
