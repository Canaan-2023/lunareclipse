/**
 * @category API
 * @summary 工具循环引擎：流式请求 → 工具派发 → 结果蒸馏 → 护栏裁决 → 下一轮，直到收尾
 *
 * 为什么独立成模块：这是 `LLMClient.streamWithTools` 的原方法体（约 1205 行），
 * 是「provider 差异屏蔽 + 流式 + 工具循环 + 并发控制器 + 复读护栏」五职责里最重的一环。
 * 拆出后 `LLMClient` 只留 provider 壳与配置，引擎通过 `ToolLoopHost` 反向取壳能力。
 *
 * 什么作用：`runToolLoop(host, messages, tools, callbacks, options)` 跑完一次完整的多轮工具对话，
 * 全程只经 `callbacks` 与壳交互；单轮内的流解析/派发/护栏/收尾分别委托 `tool-loop-*` 子模块。
 *
 * 不删理由：删掉即 `LLMClient.streamWithTools` 失去实现（月蚀唯一的工具调用通道）。
 *
 * ⚠️ 拆分时不得改变的行为（ADR-03 §8）：
 * 1. 护栏判定顺序（由 `evaluateToolGuardrails` 内部保证）；
 * 2. 软超时托管的 `MANAGED_TIMEOUT_TOOLS` 判定 + `registerManagedRun` 登记点（在 `tool-loop-dispatch`）；
 * 3. `reasoning_content` 的读取与回传口径（在 `tool-loop-stream` 与 `tool-loop-dispatch`）；
 * 4. 超时计时器跨工具执行阶段仍武装（由 `runTurnStream` 返回句柄、本模块 finally 释放保证）。
 * 判据：`test/llm-guardrail-wire.test.ts` / `llm-failure-halt` / `llm-concurrency` /
 * `llm-reasoning-wire` / `llm-reasoning-effort` / `build-turn-pairs-intent` 全绿。
 */
import type OpenAI from 'openai'
import type { ChatMessage, LLMConfig, TokenUsage } from '@shared/types'
import { logInfo } from '../../services/crash-logger'
import type { StreamCallbacks, ToolExecutor, WireMessage } from '../llm-types'
import {
  buildGuardrailProtocolPrompt,
  classifyMessageSource,
  parseGuardrail,
  wrapGuardrail
} from '../message-guardrail'
import { createTurnGuardrailState } from './session-state'
import { createDistillBookkeeper } from './tool-loop-distill'
import { dispatchToolCalls } from './tool-loop-dispatch'
import {
  finalizeNoToolCalls,
  trackCrossRoundRepetition,
  type RepetitionBaseline
} from './tool-loop-finalize'
import { evaluateToolGuardrails, type ToolExecResult } from './tool-loop-guards'
import { resolveRoundModel } from './model-switch'
import { recordModelSwitch } from './model-switch-log'
import { runTurnStream, type TurnTimers } from './tool-loop-stream'

/**
 * 工具循环引擎反向依赖的壳能力（由 `LLMClient` 实现）。
 * 设计取向：**只暴露引擎真正需要的最小面**，壳的其余部分（listModels / stream / chatWithTools /
 * abort / isStreaming）与引擎无关。`getRepetitionBaseline()` 返回壳持有的可变基准对象
 * （跨请求复读检测状态属实例级，见 ADR-03 §2.3），引擎就地读写。
 */
export interface ToolLoopHost {
  getClient(): OpenAI | null
  getConfig(): LLMConfig
  isLocalProvider(): boolean
  isDeepSeekProvider(): boolean
  buildReasoningParams(): Record<string, unknown>
  buildSamplingParams(): Record<string, unknown>
  /** 生成请求 id（`${prefix}_${Date.now()}_${seq}`，同毫秒并发不冲突） */
  nextReqId(prefix: string): string
  /** 登记活跃请求（`abort()` / `isStreaming()` 依赖此表） */
  registerController(
    reqId: string,
    entry: { ctrl: AbortController; abortReason: string | null; tag: string }
  ): void
  /** 注销活跃请求（轮次结束/异常退出时必调，否则 isStreaming 恒 true） */
  deleteController(reqId: string): void
  getRepetitionBaseline(): RepetitionBaseline
  /**
   * 上下文 token 占比 0~1（AUTO 模型热切换的判定特征之一，§8.3）。
   * 可选：未实现返回 undefined → 该特征不参与判定（当前 server 侧未穿透，见 ADR-15）。
   */
  getContextRatio?: () => number | null
}

export interface ToolLoopOptions {
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

/**
 * 流式带工具调用循环：LLM stream → 若返回 tool_calls 则执行 → 把结果加入上下文 → 继续 stream
 * maxRounds 轮次上限已取消（2026-10-02 按用户要求）：不再因轮次上限中断 LLM，
 * 防死循环由 llm-guardrails 护栏承担（failure/idempotent/loop_caps 检测），
 * maxRounds 仅保留显式传参以兼容工作流节点等需要自定边界的调用方。
 */
/**
 * 统计本轮工具失败数（AUTO 判定特征，§8.3）。
 * `ToolExecResult.result` 是工具结果的 JSON 字符串，失败以 `error` 字段表达（见 tool-loop-dispatch）；
 * 解析失败按「非失败」计（不因统计本身影响模型选择）。
 */
function countToolFailures(results: readonly ToolExecResult[]): number {
  let n = 0
  for (const r of results) {
    try {
      const parsed = JSON.parse(r.result) as { error?: unknown } | null
      if (parsed && typeof parsed === 'object' && parsed.error) n++
    } catch {
      /* 非 JSON 结果不计失败 */
    }
  }
  return n
}

export async function runToolLoop(
  host: ToolLoopHost,
  messages: ChatMessage[],
  tools: ToolExecutor[],
  callbacks: StreamCallbacks,
  options?: ToolLoopOptions
): Promise<void> {
  const client = host.getClient()
  if (!client) {
    callbacks.onError(new Error('LLM 未配置：请在设置中填写 API Key'))
    return
  }
  const config = host.getConfig()
  // 2026-08-16 并发化：每请求独立 controller（存 controllers map，value 含 ctrl + abortReason）
  const reqId = host.nextReqId('swt')
  const ctrl = new AbortController()
  // 2026-08-17 外部中断联动：子 agent 超时等场景传入外部 signal，
  // 外部 abort 时只终止本请求（controllers map 里其它并发请求不动，父对话不受影响）。
  // tag 优先级：外部 signal > 显式 tag > 'main'（显式 tag 使写作流独立于主会话分组）
  const externalSignal = options?.signal
  const entry = {
    ctrl,
    abortReason: null as string | null,
    tag: externalSignal ? 'subagent' : (options?.tag ?? 'main')
  }
  if (externalSignal) {
    externalSignal.addEventListener(
      'abort',
      () => {
        entry.abortReason = '外部中断（子 agent 超时）'
        ctrl.abort()
      },
      { once: true }
    )
  }
  host.registerController(reqId, entry)
  try {
    // 本轮 abort 状态不设独立标志：entry.abortReason + ctrl.signal.aborted 已随请求级
    // controller 跨轮次持久（存 controllers map），下方轮次/工具段检查直接读 signal。
    // （原有 const abortRequested = false 恒 false，为 2026-08-16 并发化重构残留，已删除）

    // 默认不限制轮次（2026-10-02 取消上限）；显式传参仍生效，护栏兜底防死循环
    const maxRounds = options?.maxRounds ?? Number.POSITIVE_INFINITY
    const useModel =
      options?.modelOverride && options.modelOverride.trim()
        ? options.modelOverride.trim()
        : config.model

    const guardrailKey = options?.guardrailSessionId?.trim()
    // 预分类来源：conversation 是 map 后的 wire 结构，已丢失 ChatMessage 的 id/activation 字段，
    // 必须在 map 前对原始消息分类（审查轮识别依赖这两个字段）
    const guardrailSources = guardrailKey ? messages.map((m) => classifyMessageSource(m)) : null

    const conversation: WireMessage[] = []
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
        ...(host.isDeepSeekProvider() && m.role === 'assistant' && m.reasoning
          ? { reasoning_content: m.reasoning }
          : {})
      })
    }

    // ===== 消息来源护栏（仅传入 guardrailSessionId 时启用）=====
    // 按来源分栏包裹：system 消息不包裹（注入段属系统指令，AI 天然可知）；其余按来源枚举包裹。
    // 护栏不进 conversation 之外的任何持久层：不写 session.messages、不改 ChatMessage 结构、
    // 不推前端 —— 对用户不可见、对 AI 可读。工具结果回流处也按工具名分类包裹（见派发模块）。
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
    // ===== AUTO 模型热切换（§8）：决策点 = 每轮建流前 =====
    // 粒度只能是「轮间」——SSE 流一旦开始就不能换模型（§8.2①）。dwellRounds 记「当前模型已连续驻留轮数」，
    // 用于最小驻留约束（换模型打断前缀缓存，§8.2②）。首轮给足驻留值以允许立即决策。
    const routerConfig = (config as { modelRouter?: import('@shared/types/model-router').ModelRouterConfig }).modelRouter
    let activeModel = useModel
    let dwellRounds = 99
    let prevToolCalls = 0
    let prevToolFailures = 0

    // 2026-08-26：跨轮输出重复检测状态已提升为实例字段（lastFinalOutput/crossRequestHits）——
    // 原 roundOutputs 是请求内局部数组，续接轮每轮都是新请求 → prev 恒空 → 请求间复读漏网。
    // 检测逻辑见流完成处的跨请求比较（比较基准 = 上一条最终输出，请求内/请求间统一）。
    // 2026-08-15：多轮工具调用累计 usage（每轮 stream 末尾都有 usage chunk）
    const totalUsage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0
    }
    let hasUsage = false
    // 2026-09-12 观测：记录本轮次流结束原因（stop/length/tool_calls），断流时用于定位
    let finishReason: string | null = null

    // 单次调用的护栏状态簇（工厂：每次 runToolLoop 调用新建，见 session-state.ts 警示）
    const state = createTurnGuardrailState()
    // 工具结果蒸馏记账：本轮 tool 消息在下一轮请求构建前批量蒸馏（时机见 tool-loop-distill.ts）
    const bookkeeper = createDistillBookkeeper({
      conversation,
      guardrailKey,
      distillToolResult: callbacks.distillToolResult,
      distillIntentTurnPairs: callbacks.distillIntentTurnPairs
    })

    while (rounds <= maxRounds) {
      if (ctrl.signal.aborted) {
        logInfo('stream-abort', { reason: entry.abortReason ?? 'aborted', round: rounds })
        callbacks.onError(new Error(entry.abortReason ?? 'aborted'))
        return
      }

      // 超时计时器句柄：由 runTurnStream 创建、本模块在轮次 finally 释放
      // （保持「工具执行阶段计时器仍武装」的既有语义，见 tool-loop-stream.ts 警示）
      let turnTimers: TurnTimers | null = null
      try {
        // AUTO 决策点（唯一入口）：每轮建流前解析本轮模型。不切时 activeModel 不变。
        const modelDecision = resolveRoundModel({
          baseURL: config.baseURL,
          currentModel: activeModel,
          router: routerConfig,
          dwellRounds,
          features: {
            round: rounds + 1,
            prevToolCalls,
            prevToolFailures,
            guardrailActive: state.hardHalted === true,
            userMessageLength: messages.reduce((n, m) => n + (m.content?.length ?? 0), 0),
            contextRatio: host.getContextRatio?.() ?? null
          }
        })
        if (modelDecision.switched) {
          logInfo('model-switch', {
            from: activeModel,
            to: modelDecision.model,
            tier: modelDecision.targetTier,
            reason: modelDecision.reason,
            round: rounds + 1
          })
          // 可查询的切换审计（ROOM 模型配置区读它；logInfo 只进崩溃日志，不可查）
          recordModelSwitch({
            ts: Date.now(),
            round: rounds + 1,
            from: activeModel,
            to: modelDecision.model,
            tier: modelDecision.targetTier,
            reason: modelDecision.reason
          })
          activeModel = modelDecision.model
          dwellRounds = 0
        } else {
          dwellRounds++
        }

        const turn = await runTurnStream({
          client,
          conversation,
          useModel: activeModel,
          temperature: options?.temperature,
          config,
          buildReasoningParams: () => host.buildReasoningParams(),
          buildSamplingParams: () => host.buildSamplingParams(),
          isLocalProvider: host.isLocalProvider(),
          ctrl,
          entry,
          callbacks,
          round: rounds,
          tools: openaiTools.length > 0 ? openaiTools : undefined
        })
        turnTimers = turn.timers
        const { contentBuf, reasoningBuf, toolCallMap, tokenCount, repetitionDetected } = turn
        if (turn.usageDelta) {
          hasUsage = true
          totalUsage.inputTokens += turn.usageDelta.inputTokens
          totalUsage.outputTokens += turn.usageDelta.outputTokens
          totalUsage.cacheReadTokens =
            (totalUsage.cacheReadTokens ?? 0) + (turn.usageDelta.cacheReadTokens ?? 0)
          totalUsage.reasoningTokens =
            (totalUsage.reasoningTokens ?? 0) + (turn.usageDelta.reasoningTokens ?? 0)
        }
        if (turn.finishReason) finishReason = turn.finishReason

        if (ctrl.signal.aborted) {
          // 2026-08-24：重复检测触发的 abort 走特殊处理——
          // 不直接 onError（那会丢失已生成内容），而是注入打断指令续一轮让 AI 换策略。
          // 只续一轮，防重复-打断-再重复的死循环。
          if (repetitionDetected && !state.haltInjected) {
            state.haltInjected = true
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
          `[llm] stream 完成 tokens=${tokenCount} 总耗时=${Date.now() - turn.requestStart}ms` +
            (turn.lastUsage
              ? ` input=${turn.lastUsage.inputTokens} output=${turn.lastUsage.outputTokens} cacheHit=${turn.lastUsage.cacheReadTokens ?? 0}`
              : '')
        )

        // 2026-08-26 跨轮输出重复检测（cross-round loop breaker，请求内+请求间统一）
        if (
          trackCrossRoundRepetition(
            host.getRepetitionBaseline(),
            state,
            conversation,
            contentBuf,
            reasoningBuf,
            rounds
          )
        ) {
          rounds++
          continue
        }

        // 无工具调用：本轮 stream 完成，走收尾判定（承诺/编造/runaway 补检 或 正常收尾）
        if (toolCallMap.size === 0) {
          const verdict = await finalizeNoToolCalls({
            conversation,
            state,
            tools,
            callbacks,
            contentBuf,
            reasoningBuf,
            tokenCount,
            isDeepSeekProvider: host.isDeepSeekProvider(),
            round: rounds,
            finishReason,
            toolResultCount: bookkeeper.entries.length,
            hasUsage,
            totalUsage
          })
          if (verdict === 'done') return
          rounds++
          continue
        }

        // 有工具调用：派发执行（含 assistant tool_calls 回写、分段并行/串行、结果写回）
        const dispatch = await dispatchToolCalls(toolCallMap, contentBuf, reasoningBuf, {
          conversation,
          guardrailKey,
          tools,
          callbacks,
          ctrl,
          bookkeeper,
          isDeepSeekProvider: host.isDeepSeekProvider()
        })
        // AUTO 判定特征：记录本轮的调用数与失败数，供下一轮决策使用
        prevToolCalls = toolCallMap.size
        prevToolFailures = countToolFailures(dispatch.execResults)

        // 工具结果蒸馏（轮间时机）：本轮工具结果已全部写回 conversation，在下一轮请求
        // 构建前批量蒸馏——成功则摘要替换原文并重包护栏，失败重试一次仍失败保留原文。
        // 只有放在这里蒸馏才真正生效（conversation 是内部 wire 副本，不进 session 历史，
        // 流结束后的替换对任何后续请求都不可观测）。
        await bookkeeper.flush()

        // ===== 工具循环护栏 =====
        // 四类检测：exact_failure（同工具+同参数失败）/ same_tool_failure（同工具失败，参数可不同）/
        // idempotent_no_progress（读类工具结果 hash 相同=无进展）/ loop_caps（runaway 上限）。
        // 软 warn（注入提示，AI 可据此换策略）→ 硬 halt（注入打断指令后收尾）。
        // 判定顺序敏感，红线见 tool-loop-guards.ts 文件头。
        const verdict = evaluateToolGuardrails(state, dispatch.execResults, {
          conversation,
          timedOutTools: dispatch.timedOutTools,
          managedHandoffs: dispatch.managedHandoffs,
          round: rounds
        })
        rounds++
        if (verdict === 'continue') continue
        if (verdict === 'break') break
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
        turnTimers?.dispose()
      }
    }

    // 达到最大轮数仍有工具调用（收尾：蒸馏已在各工具轮结束后完成，此处不再重复）
    logInfo('stream-end', {
      reason: state.hardHalted ? 'loop_halt' : 'max_rounds_reached',
      round: rounds,
      finishReason,
      toolResults: bookkeeper.entries.length
    })
    if (hasUsage) callbacks.onUsage?.(totalUsage)
    callbacks.onDone()
  } finally {
    host.deleteController(reqId)
  }
}
