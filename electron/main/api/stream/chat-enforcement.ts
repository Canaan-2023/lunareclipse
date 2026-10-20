/**
 * @category 核心
 * @summary 输出纪律：会话模式强制净化（enforceChatOutput）+ 编码模式工具失败真实性标注
 *
 * 为什么独立成文件：这是「最终交给用户/落盘的内容」的最后一道加工，两类模式各有一套硬约束，
 * 原先内联在 `stream-runner.ts` 的 `onDone` 头部。ADR-04 外移——纪律规则集中一处，可整体阅读。
 *
 * 什么作用：`enforceOutputDiscipline(deps)` 返回加工后的正文与（会话模式的）emotion/animation；
 * 会话模式走 `enforceChatOutput`（MOD 五件套：envelope 解析 → 语言检测 → 重试 → fallback → 规范化），
 * 编码模式在有工具失败时按「不编造结果」原则补失败标注。
 *
 * 不删理由：删掉即会话模式输出不再强制净化（前端拿不到 emotion/animation、格式漂移），
 * 且「AI 声称全部完成却隐瞒工具失败」无人纠正（粉饰结果）。
 *
 * 时机：必须在所有下游处理（parseAIOutput / 落盘 / done 推送）之前——保证最终内容已强制净化。
 * 会话模式与编码模式互斥（`aiMode === 'chat'` 判定），两者不会同时生效。
 */
import type { WebSocket } from 'ws'
import type { ChatMessage } from '@shared/types'
import { enforceChatOutput } from '../chat-envelope'
import type { LLMClient, ApiMessage } from '../llm'
import type { StreamSession } from '../stream-session'

export interface OutputDisciplineDeps {
  aiMode: string
  fullOutput: string
  llmClient: LLMClient
  model: string | undefined
  /** 注入后的消息（会话模式重试请求用） */
  injectedMessages: ChatMessage[]
  /** 本轮工具失败（编码模式真实性校验用） */
  toolFailures: Array<{ toolName: string; error: string }>
  ws: WebSocket
  messageId: string
  streamSession: StreamSession
}

export interface OutputDisciplineResult {
  fullOutput: string
  emotion?: string
  animation?: string
}

export async function enforceOutputDiscipline(
  deps: OutputDisciplineDeps
): Promise<OutputDisciplineResult> {
  const { aiMode, injectedMessages, toolFailures, ws, messageId, streamSession } = deps
  let fullOutput = deps.fullOutput
  let chatEmotion: string | undefined
  let chatAnimation: string | undefined

  if (aiMode === 'chat' && fullOutput) {
    const retryMessages = injectedMessages.map((m) => ({
      role: m.role,
      content: m.content ?? ''
    })) as ApiMessage[]
    const chatResult = await enforceChatOutput(deps.llmClient, fullOutput, retryMessages, deps.model)
    fullOutput = chatResult.text
    chatEmotion = chatResult.emotion
    chatAnimation = chatResult.animation
  } else if (aiMode !== 'chat' && fullOutput) {
    // 编码模式输出纪律：工具失败真实性校验（不编造结果原则）
    // 本轮有工具失败 → 检查 AI 是否在输出中如实提及失败；若输出声称"全部完成/成功"
    // 却隐瞒了失败，追加失败标注，防止 AI 粉饰结果。
    if (toolFailures.length > 0) {
      const failureSummary = toolFailures
        .map((f) => `- ${f.toolName}: ${f.error.slice(0, 120)}`)
        .join('\n')
      const claimedDone =
        /(全部完成|已完成|都成功|全部成功|搞定|顺利完成|成功完成|处理完毕)/.test(fullOutput)
      const mentionedFailure = toolFailures.every((f) => fullOutput.includes(f.toolName))
      let annotation = ''
      if (claimedDone && !mentionedFailure) {
        console.warn('[server] 编码模式输出纪律：AI 声称完成但存在未提及的工具失败，追加标注')
        annotation = `\n\n> ⚠️ 系统标注：本轮有工具调用失败但未在回复中说明，如实补充如下：\n${failureSummary}`
      } else if (!mentionedFailure) {
        annotation = `\n\n> ⚠️ 系统标注：本轮有工具调用失败（见下方），请如实处理：\n${failureSummary}`
      }
      if (annotation) {
        fullOutput += annotation
        // 补发一段 token 让用户当场看到失败标注（与 fullOutput 尾部一致，前端按序拼接）。
        // 流式已结束、tokenBuffer 里没有标注内容，不补发前端永远看不到。
        if (streamSession.isOpen(ws)) {
          streamSession.push(
            ws,
            JSON.stringify({ type: 'token', payload: annotation, messageId })
          )
        }
      }
    }
  }

  return { fullOutput, emotion: chatEmotion, animation: chatAnimation }
}
