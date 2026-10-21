/**
 * @category API
 * @summary 单轮流式消费：建流 → 逐 chunk 解析（思考/正文/工具调用）→ 超时与复读打断
 *
 * 为什么独立成模块：这一段是「provider 流式差异 + TTFT/idle 超时 + 复读打断」的集中地，
 * 此前是 `llm.ts` 的 `streamWithTools` 方法体里最长的一段（约 250 行），与工具派发、护栏判定
 * 混在同一方法；拆出后工具循环引擎只剩编排，流解析可独立阅读。
 *
 * 什么作用：`runTurnStream(ctx)` 发一次流式请求并消费到底，返回本轮缓冲（正文/思考/工具调用累积）
 * 与打断标记；不执行工具、不做跨轮判定——那些是引擎与护栏模块的职责。
 *
 * 不删理由：TTFT/idle 超时与两类复读打断（尾部重复、`<system>` 回放）是长任务不挂死的唯一保护；
 * 删掉即请求可能永久挂起、复读无人打断。
 *
 * ⚠️ 计时器生命周期（易错）：TTFT/idle 计时器**在本模块创建、由调用方在轮次 finally 释放**
 * （见返回的 `timers.dispose`）。原实现把创建与释放都放在 `streamWithTools` 的同一 try/finally 内，
 * 其语义是「计时器在工具执行阶段仍然武装」——工具跑超时会被 idle 打断。本模块若在返回前自行清理
 * 计时器，会静默改变该语义（工具阶段不再被打断），故计时器句柄必须交回调用方。
 * 异常路径（本模块内抛出）自行清理后重抛，避免句柄泄漏。
 */
import type OpenAI from 'openai'
import type { TokenUsage } from '@shared/types'
import { mapUsage, type StreamCallbacks, type WireMessage } from '../llm-types'
import { detectTailRepetition, REPETITION_CHECK_INTERVAL } from '../llm-guardrails'

/** 计时器释放句柄：调用方在轮次 finally 调用（保持「工具执行阶段仍武装」的既有语义） */
export interface TurnTimers {
  dispose(): void
}

export interface TurnStreamResult {
  /** 正文缓冲（本轮全部 content token） */
  contentBuf: string
  /** 思考缓冲（本轮全部 reasoning token） */
  reasoningBuf: string
  /** 工具调用累积：index → { id, name, args } */
  toolCallMap: Map<number, { id: string; name: string; args: string }>
  /** 本轮 content token 计数（runaway 判定用） */
  tokenCount: number
  /** 本轮流内累计 usage（无 usage chunk 时为 null），供引擎累加进总用量 */
  usageDelta: TokenUsage | null
  /** 最后一个 usage chunk 的原值（供「stream 完成」日志与既有输出一致） */
  lastUsage: TokenUsage | null
  /** 是否检测到重复/系统回放（打断路径标记） */
  repetitionDetected: boolean
  /** 本轮 finish_reason（观测用） */
  finishReason: string | null
  /** 请求开始时刻（耗时日志用） */
  requestStart: number
  timers: TurnTimers
}

export interface TurnStreamContext {
  client: OpenAI
  conversation: WireMessage[]
  useModel: string
  /** 调用方显式传入的 temperature（options.temperature） */
  temperature?: number
  /** LLMConfig 的 temperature/maxTokens 兜底值 */
  config: { temperature?: number; maxTokens?: number | null }
  /** 工具 schema（已含 `_result_mode` 注入；空数组时传 undefined 以省略字段） */
  tools: unknown
  buildReasoningParams(): Record<string, unknown>
  buildSamplingParams(): Record<string, unknown>
  isLocalProvider: boolean
  ctrl: AbortController
  /** 请求登记项（写 abortReason） */
  entry: { abortReason: string | null }
  callbacks: StreamCallbacks
  round: number
}

export async function runTurnStream(ctx: TurnStreamContext): Promise<TurnStreamResult> {
  const { client, conversation, ctrl, entry, callbacks } = ctx
  const requestStart = Date.now()
  // 本地模型（Ollama/llama.cpp）本身推理就慢，不再叠加人为节流
  const isLocalProvider = ctx.isLocalProvider
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
  let ttftTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const disposeTimers = (): void => {
    if (ttftTimer) {
      clearTimeout(ttftTimer)
      ttftTimer = null
    }
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  try {
    ttftTimer = setTimeout(() => {
      if (firstTokenAt === 0) {
        console.warn(`[llm] TTFT 超时 ${ttftTimeoutMs}ms，abort`)
        entry.abortReason = 'ttft_timeout'
        ctrl.abort()
      }
    }, ttftTimeoutMs)
    console.log(
      `[llm] stream 请求开始 model=${ctx.useModel} msgs=${conversation.length} round=${ctx.round} ttftLimit=${ttftTimeoutMs}ms`
    )
    const stream = await client.chat.completions.create(
      {
        model: ctx.useModel,
        // 2026-08-26 修复（系统故障：子 agent 执行完就 400 断链）：
        // DeepSeek 思考模式要求历史 assistant 消息的 reasoning_content 原样回传，否则下一请求 400。
        // reasoning_content 在 conversation 构建处已从 ChatMessage.reasoning 转好，
        // 请求内轮次的 push 也带 reasoning_content——这里整体展开即可，无需再改名。
        messages: conversation.map((m) => ({ ...m })) as never,
        temperature: ctx.temperature ?? ctx.config.temperature ?? 0.7,
        max_tokens: ctx.config.maxTokens ?? undefined,
        stream: true,
        // 2026-08-15：请求流式 usage（DeepSeek 需显式 include_usage 才会在流末尾返回
        // prompt_cache_hit_tokens 等用量；否则缓存命中率/真实 token 成本永远不可见）
        stream_options: { include_usage: true },
        tools: ctx.tools as never,
        ...ctx.buildReasoningParams(),
        ...ctx.buildSamplingParams()
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
    const usageDelta: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0
    }
    let sawUsage = false
    let lastUsage: TokenUsage | null = null

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

    let finishReason: string | null = null

    for await (const chunk of stream) {
      if (ctrl.signal.aborted) break
      // 流末尾 usage chunk（choices 为空数组，usage 有值）
      if (chunk.usage) {
        const u = mapUsage(chunk.usage as never)
        if (u) {
          sawUsage = true
          lastUsage = u
          usageDelta.inputTokens += u.inputTokens
          usageDelta.outputTokens += u.outputTokens
          usageDelta.cacheReadTokens = (usageDelta.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0)
          usageDelta.reasoningTokens = (usageDelta.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0)
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
              `[llm] 🔁 检测到思考流重复（reasoning loop），abort round=${ctx.round} tokens=${tokenCount}`
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
              `[llm] 🔁 检测到思考流系统消息回放（<system> 标签 ×${systemTagCount}），abort round=${ctx.round} tokens=${tokenCount}`
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
              `[llm] 🔁 检测到流式输出重复（generation loop），abort round=${ctx.round} tokens=${tokenCount}`
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
    // 流结束后补检一次尾部（正文 + 思考流），命中即标记 repetitionDetected（走 abort 打断路径）。
    if (!repetitionDetected) {
      const tailRepeatInBody = detectTailRepetition(contentBuf)
      const tailRepeatInReasoning = detectTailRepetition(reasoningBuf)
      if (tailRepeatInBody || tailRepeatInReasoning) {
        repetitionDetected = true
        entry.abortReason = 'repetition_loop'
        // 模拟流内重复检测的 abort：触发调用方的打断路径（注入换策略指令续一轮）
        ctrl.abort()
        console.warn(
          `[llm] 🔁 流末复读补检命中（正文=${tailRepeatInBody} 思考=${tailRepeatInReasoning}），abort round=${ctx.round} tokens=${tokenCount}`
        )
      }
    }

    return {
      contentBuf,
      reasoningBuf,
      toolCallMap,
      tokenCount,
      usageDelta: sawUsage ? usageDelta : null,
      lastUsage,
      repetitionDetected,
      finishReason,
      requestStart,
      timers: { dispose: disposeTimers }
    }
  } catch (err) {
    // 本模块内抛出：计时器不会被调用方持有，须在此清理后重抛（防句柄泄漏）
    disposeTimers()
    throw err
  }
}
