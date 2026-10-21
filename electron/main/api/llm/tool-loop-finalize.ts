/**
 * @category API
 * @summary 流末收尾判定：跨轮复读检测 + 无工具调用轮的「承诺/编造/runaway」补检与正常收尾
 *
 * 为什么独立成模块：这两段都是「流已结束、工具尚未派发」之间的判定，是防 AI 空转/幻觉的最后一道网，
 * 此前内联在 `llm.ts` 的 `streamWithTools` 方法体中段。拆出后引擎只保留编排，判定可单独阅读与回归。
 *
 * 什么作用：
 * - `trackCrossRoundRepetition()`：把本轮输出与实例级复读基准比较，连续近似重复达阈值即注入换方向指令；
 * - `finalizeNoToolCalls()`：无 tool_calls 的轮次——承诺未执行 / 编造执行 / 纯文本 runaway 三类补检
 *   （各只续一轮），或走正常收尾（onUsage + onDone）。
 *
 * 不删理由：删掉即「连续 N 轮复述同一段」「声称查了却没调工具」「无工具输出超长」三类空转无人拦截。
 *
 * ⚠️ 复读基准是**实例级**（跨 `streamWithTools` 调用持久），与本模块的其余部分不同——
 * 它由调用方经 `RepetitionBaseline` 传入并就地更新（ADR-03 §2.3：属 LLMClient 实例状态）。
 */
import type { TokenUsage } from '@shared/types'
import { logInfo } from '../../services/crash-logger'
import type { StreamCallbacks, ToolExecutor, WireMessage } from '../llm-types'
import type { TurnGuardrailState } from './session-state'

/** 跨请求输出重复检测基准（LLMClient 实例字段；跨 streamWithTools 调用持久） */
export interface RepetitionBaseline {
  lastFinalOutput: string
  lastReasoningOutput: string
  crossRequestHits: number
}

/**
 * 跨轮输出重复检测（cross-round loop breaker，请求内+请求间统一）。
 *
 * 现象：AI 陷入"每轮输出一大段相似内容但方向没变"的循环——单轮内部没有文本级重复
 * （尾部重复检测抓不到），工具调用也正常（幂等/失败检测抓不到），内容也长（空转检测抓不到）。
 * 用户感知为"长字数的大段重复"，但三种现有检测全部漏掉。
 * 机制：记录每条最终输出（lastFinalOutput），与上一条做相似度比较。
 * 归一化（去空白）后若当前输出是上一条输出的子串（或反之）且长度 ≥ 阈值，
 * 判定"近似重复"，连续 ≥2 条命中则注入打断指令让 AI 换方向。
 * 设计：只比较相邻两条（不累计历史），避免误伤"多轮推进但内容渐进"的正常场景；
 * 子串判定比全文相似更稳——循环时每条几乎原样复述，正常推进时不会互为子串。
 * 2026-08-26（奥卡姆剃刀）：比较基准提升为实例字段——续接轮每轮都是独立请求，
 * 原请求内 roundOutputs 数组跨请求即失效，导致"请求间复读"（连发 N 轮同一句）漏网。
 * 2026-08-26（系统级治本）：跨轮重复检测同时覆盖【思考流】。
 * 原实现只比较 contentBuf（正文）——实测复读主要发生在 reasoning（正文空转），
 * 思考流复读全漏。现在正文 OR 思考流任一与上一轮同区重复即计数。
 *
 * @returns true = 已注入换方向指令（调用方应 `rounds++` 后 continue）
 */
export function trackCrossRoundRepetition(
  baseline: RepetitionBaseline,
  state: TurnGuardrailState,
  conversation: WireMessage[],
  contentBuf: string,
  reasoningBuf: string,
  round: number
): boolean {
  const CROSS_ROUND_MIN_LEN = 50 // 参与比较的最小输出长度（太短不判，避免误伤短回复）
  const CROSS_ROUND_MIN_SIM = 0.8 // 相似度阈值：归一化后公共子串占比 ≥80% 判为近似重复
  const CROSS_ROUND_MAX_HITS = 2 // 连续近似重复 ≥2 轮即打断
  if (
    contentBuf.trim().length < CROSS_ROUND_MIN_LEN &&
    reasoningBuf.trim().length < CROSS_ROUND_MIN_LEN
  ) {
    return false
  }
  const norm = (s: string): string => s.replace(/\s+/g, '').trim()
  const curText = norm(contentBuf)
  const curThink = norm(reasoningBuf)
  const prevText = baseline.lastFinalOutput ? norm(baseline.lastFinalOutput) : ''
  const prevThink = baseline.lastReasoningOutput ? norm(baseline.lastReasoningOutput) : ''
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
  baseline.lastFinalOutput = contentBuf
  baseline.lastReasoningOutput = reasoningBuf
  if (sim >= CROSS_ROUND_MIN_SIM) {
    baseline.crossRequestHits++
    console.warn(
      `[llm] 🔁 跨轮输出重复检测命中 ${baseline.crossRequestHits}/${CROSS_ROUND_MAX_HITS}（相似度 ${(sim * 100).toFixed(0)}%）round=${round}`
    )
    if (baseline.crossRequestHits >= CROSS_ROUND_MAX_HITS && !state.haltInjected) {
      state.haltInjected = true
      console.warn(`[llm] 🔇 跨轮输出重复已达阈值，注入换方向指令 round=${round}`)
      conversation.push({
        role: 'user',
        content:
          '（系统检测：你已连续多轮输出高度相似的大段内容，但整体方向没有推进，陷入跨轮重复循环。' +
          '立即停止复述/重复之前说过的内容。重新审视当前目标：如果当前思路走不通，换一种真正不同的方法；' +
          '如果任务卡住，向用户说明卡点并请求指示。不要继续用旧思路输出相似内容。）'
      })
      return true
    }
  } else {
    baseline.crossRequestHits = 0
  }
  return false
}

export interface FinalizeDeps {
  conversation: WireMessage[]
  state: TurnGuardrailState
  tools: ToolExecutor[]
  callbacks: StreamCallbacks
  contentBuf: string
  reasoningBuf: string
  tokenCount: number
  isDeepSeekProvider: boolean
  round: number
  finishReason: string | null
  /** 本轮已登记的工具结果条数（日志用） */
  toolResultCount: number
  hasUsage: boolean
  totalUsage: TokenUsage
}

/**
 * 无工具调用轮次的收尾判定。
 *
 * @returns `retry` = 已注入补检指令（调用方应 `rounds++` 后 continue）；
 *          `done` = 正常收尾（本函数已 logInfo + onUsage + await onDone，调用方直接 return）。
 */
export async function finalizeNoToolCalls(deps: FinalizeDeps): Promise<'retry' | 'done'> {
  const { conversation, state, tools, callbacks, contentBuf, reasoningBuf, tokenCount } = deps

  // ===== 断点兜底：AI 承诺调用工具但未发出 tool_calls =====
  // 现象：小模型（如 flash）在长上下文下输出"我马上做……："后直接正常 stop，
  // 没有发出 tool_calls，系统误判为正常完成（RAW 里留一堆"承诺做但没做"）。
  // 处理：把承诺文本 push 回上下文，追加强制指令让它真正执行工具调用，只续一轮。
  const trimmedEnd = contentBuf.trimEnd()
  const looksPromised =
    trimmedEnd.length > 0 && (/([:：…]$)/.test(trimmedEnd) || trimmedEnd.endsWith('...'))
  if (!state.forcedToolRetry && tools.length > 0 && looksPromised) {
    state.forcedToolRetry = true
    console.warn(
      `[llm] 检测到承诺未执行（输出以冒号/省略号结尾但无 tool_calls），强制续一轮 round=${deps.round}`
    )
    conversation.push({
      role: 'assistant',
      content: contentBuf,
      ...(deps.isDeepSeekProvider && reasoningBuf ? { reasoning_content: reasoningBuf } : {})
    })
    conversation.push({
      role: 'user',
      content:
        '（系统检测：你上一轮承诺要调用工具但未实际发出 tool_calls。请立即执行你要做的工具调用，直接调用工具，不要重复承诺说明。）'
    })
    return 'retry'
  }
  // ===== P2-2 编造工具调用检测（2026-08-24）=====
  // 现象：flash 模型在正文里写"我查了""我读了""typecheck 通过"但实际没发 tool_calls。
  // 承诺检测只抓冒号/省略号结尾，不抓这种"编造已完成"的幻觉。
  // 机制：检测正文是否包含「声称执行了某操作」的模式词 + 有工具可用但未调用，
  // 只续一轮强制真正执行。仅续一轮防死循环。
  if (!state.forcedToolRetry && tools.length > 0 && contentBuf.length > 50) {
    //（奥卡姆剃刀补洞）：原式只匹配"我(?:查了|读了|...)",
    // 实录漏网"我读完了 xxx"（"读完了"≠"读了"）——该轮声称读了文件却无 tool_calls。
    // 补"完了/好了"变体；"已经/刚才"后缀也补完/好。
    const fabricatedAction =
      /(我(?:查(?:了|完了|好了)|读(?:了|完了|好了)|搜(?:了|完了|好了)|跑(?:了|完了|好了)|执行(?:了|完了|好了)|确认(?:了|完了|好了)|验证(?:了|完了|好了)|typecheck(?:了|好了)?|测(?:了|完了|好了)|检查(?:了|完了|好了)|看(?:了|完了|好了))|已经(?:查|读|搜|跑|执行|确认|验证|测|检查|看)(?:了|完|好)|刚才(?:查|读|搜|跑|执行|确认|验证|测|检查|看)(?:了|完|好))/.test(
        contentBuf
      )
    if (fabricatedAction) {
      state.forcedToolRetry = true
      console.warn(
        `[llm] 检测到编造工具调用（正文声称执行操作但无 tool_calls），强制续一轮 round=${deps.round}`
      )
      conversation.push({
        role: 'assistant',
        content: contentBuf,
        ...(deps.isDeepSeekProvider && reasoningBuf ? { reasoning_content: reasoningBuf } : {})
      })
      conversation.push({
        role: 'user',
        content:
          '（系统检测：你正文里声称"查了/读了/执行了/验证了"某操作，但本轮没有发出任何 tool_calls。' +
          '不要在文字里编造执行结果。如果你需要查/读/执行，立即发出对应的工具调用；' +
          '如果不需要工具就能回答，去掉正文中声称执行了操作的虚假表述。）'
      })
      return 'retry'
    }
  }
  // ===== P1-2 纯文本 runaway 检测（2026-08-24）=====
  // 现象：模型无 tool_calls 的纯文本输出超长（>4000 token≈8000 汉字），
  // 在正常对话/编码场景几乎不会出现，通常是 generation loop 没被重复检测抓到
  // （重复单元 < 24 字符或检测间隔内未触发）。作为兜底防线。
  // 机制：tokenCount 超 4000 且无 tool_calls → 截断输出，注入收尾指令续一轮。
  if (tokenCount > 4000 && !state.forcedToolRetry) {
    state.forcedToolRetry = true
    console.warn(
      `[llm] 检测到纯文本 runaway（${tokenCount} tokens 无 tool_calls），截断收尾 round=${deps.round}`
    )
    conversation.push({
      role: 'assistant',
      content: contentBuf.slice(0, 4000),
      ...(deps.isDeepSeekProvider && reasoningBuf ? { reasoning_content: reasoningBuf } : {})
    })
    conversation.push({
      role: 'user',
      content:
        '（系统检测：你的输出过长（超 4000 token）且没有调用任何工具。' +
        '请立即结束当前输出，给出简洁的最终结论。不要继续展开。）'
    })
    return 'retry'
  }

  // 收尾：本轮无工具调用，蒸馏已在各工具轮结束后完成（见循环内调用），此处不再重复
  logInfo('stream-end', {
    reason: 'completed',
    round: deps.round,
    finishReason: deps.finishReason,
    contentLen: contentBuf.length,
    toolResults: deps.toolResultCount
  })
  // ⚠️ 2026-08-10 修复：原实现不 await——onDone 内（会话模式语言重试 chatWithTools、
  // RAW 写入/摘要调度）await 挂起时，finally 已把 controller 清空 →
  // 重试请求失去 abort/超时保护；onDone 内抛错变 unhandledRejection → 前端收不到 done 卡 streaming。
  if (deps.hasUsage) callbacks.onUsage?.(deps.totalUsage)
  await callbacks.onDone()
  return 'done'
}
