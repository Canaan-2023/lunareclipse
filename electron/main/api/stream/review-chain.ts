/**
 * @category 核心
 * @summary 代码审查续轮子协议：审查链收集 → [REVIEW_PASS]/轮数判定 → 500ms 调度下一轮
 *
 * 为什么独立成文件：审查续轮是主回复完成后的**二级协议**（审查 ↔ 修正交替），原先内联在
 * `stream-runner.ts` 的 `onDone` 尾部（约 100 行），与落盘、行协议、错误分派混居。ADR-04 外移：
 * 审查轮的身份/轮数/链收集规则集中一处，可整体阅读与演进。
 *
 * 什么作用：`scheduleReviewContinuation(deps)` 在主回复完成时被调用一次——按消息 id 前缀判定
 * 当前处于「产出 / 审查 / 修正」哪一相，收集审查链，决定「通过收尾（打开报告）/ 达最大轮数强制
 * 收尾 / 调度下一相」，后者经 500ms 定时器 + `deps.launchPhase` 发起。
 *
 * 不删理由：删掉即「代码审查」按钮失效（不再有独立审查者视角，只剩主 AI 自评）。
 *
 * 设计依据（原实现注释，保留）：审查者必须是独立 AI——有自己的审查提示词（独立身份避免
 * 「自己审自己」的立场偏置，审查视角与主回复视角分离才能暴露主 AI 的第一原理推导盲区），
 * 但不隔离上下文：吃内部会话上下文（看得见对话），流式输出。审查轮经 runStream 的
 * `opts.systemOverride` 注入独立审查提示词；修正轮（rework）仍是主 AI 身份。
 *
 * ⚠️ 定时器归口：本模块经 `deps.continuationTimerRef` 读写 500ms 定时器句柄——该句柄同时被
 * ws close / abort / 用户中止路径清理（见 `ws-protocol.ts` 与 `stream/error-dispatch.ts`），
 * 是「停止按钮有效」的关键：用户点停止后 500ms 内必须能取消已调度的审查轮。
 */
import type { WebSocket } from 'ws'
import type { ChatMessage } from '@shared/types'
import type { SessionStore } from '../session-store'
import type { StreamSession } from '../stream-session'
import {
  appendCodeReviewChain,
  hasReviewPass,
  MAX_REVIEW_ROUNDS,
  openCodeReviewReport,
  REVIEW_INSTRUCTION,
  REVIEWER_SYSTEM_PROMPT,
  setCodeReviewChain,
  takeCodeReviewChain
} from '../code-review'

export interface ReviewChainDeps {
  sessionId: string
  messageId: string
  fullOutput: string
  model: string | undefined
  /** 本轮请求消息（被审产出拼在其后） */
  messages: ChatMessage[]
  ws: WebSocket
  streamSession: StreamSession
  sessionStore: SessionStore
  continuationTimerRef: { current: ReturnType<typeof setTimeout> | null }
  /** 发起下一相（审查/修正）：宿主提供，经 streamSession 串行队列调用 runStream */
  launchPhase: (
    phaseMessages: ChatMessage[],
    phaseId: string,
    phaseModel: string | undefined,
    nextPhase: 'review' | 'rework'
  ) => void
}

export function scheduleReviewContinuation(deps: ReviewChainDeps): void {
  const { sessionId, messageId, fullOutput, model, messages, ws, streamSession, sessionStore } = deps

  const idParts = messageId.split('_')
  const isReview = idParts[0] === 'review'
  const isRework = idParts[0] === 'rework'
  const curRound = isReview || isRework ? parseInt(idParts[1], 10) || 0 : 0

  // 审查链收集（报告通道）：主回复完成时以 sessionId 为键初始化，审查/修正轮按序追加；
  // 结束时（通过或强制结束）整链渲染为 HTML 报告并在月蚀浏览器打开（openCodeReviewReport）。
  const chainRole = isRework ? ('修正' as const) : isReview ? ('审查' as const) : ('产出' as const)
  const chainEntry = { role: chainRole, content: fullOutput }
  if (!isReview && !isRework) {
    setCodeReviewChain(sessionId, chainEntry)
  } else {
    // 异常顺序兜底：未初始化就出现 review/rework 轮（理论不达）也建链，不丢内容
    appendCodeReviewChain(sessionId, chainEntry)
  }

  if (hasReviewPass(fullOutput)) {
    console.log('[code-review] 审查通过，讨论结束')
    void openCodeReviewReport(takeCodeReviewChain(sessionId), sessionId)
    return
  }
  if (curRound >= MAX_REVIEW_ROUNDS) {
    console.log(`[code-review] 已达最大审查轮数 ${MAX_REVIEW_ROUNDS}，强制结束`)
    void openCodeReviewReport(takeCodeReviewChain(sessionId), sessionId)
    return
  }

  const nextRound = curRound + 1
  const nextPhase: 'review' | 'rework' = isReview ? 'rework' : 'review'
  const nextId = `${nextPhase}_${nextRound}_${Date.now()}`

  let phaseMessages: ChatMessage[]
  let phasePrompt: string
  const phaseModel = model

  // 内部会话上下文对三个分支都可用：审查分支走 systemOverride（独立审查提示词 + 内部会话上下文），
  // 修正分支走 buildInjectedMessages（主 AI 身份 + 记忆 + 内部会话）。
  // 被审/被修正的那条产出显式拼进 messages，确保审查方一定看得到。
  const withPrevOutput: ChatMessage[] = [
    ...messages,
    // 被审产出截断带 8000 字符（与 rework phasePrompt 截断一致），防超长产出把审查轮上下文撑爆
    {
      id: `prev_${messageId}`,
      role: 'assistant' as const,
      content: fullOutput.slice(0, 8000),
      createdAt: Date.now()
    }
  ]

  if (!isReview && !isRework) {
    // 主回复完成 → 审查（独立审查提示词 + 内部会话上下文，代表用户立场）
    phasePrompt = REVIEW_INSTRUCTION
    phaseMessages = withPrevOutput
  } else if (isReview) {
    // 审查给了反馈 → 执行者修正（完整上下文，主 AI 身份）
    phasePrompt = `你的产出收到了以下审查意见（代表用户立场）。请核对：认同则落实修正，不认同则说明理由（不要盲从）：

${fullOutput.slice(0, 8000)}`
    phaseMessages = withPrevOutput
  } else {
    // 执行者修正完 → 再审（独立审查提示词 + 内部会话上下文）
    phasePrompt = REVIEW_INSTRUCTION
    phaseMessages = withPrevOutput
  }

  const phaseMsg: ChatMessage = {
    id: nextId,
    role: 'user',
    content: `【代码审查】${phasePrompt}`,
    createdAt: Date.now(),
    activation: true
  }
  const fullPhaseMessages: ChatMessage[] = [...phaseMessages, phaseMsg]

  deps.continuationTimerRef.current = setTimeout(() => {
    // 流已断开（用户中止/页面关闭/重连）则放弃本轮审查，防止"停止按钮无效"与孤立审查轮
    if (!streamSession.isOpen(ws)) {
      deps.continuationTimerRef.current = null
      return
    }
    try {
      const session = sessionStore.get(sessionId)
      if (session) {
        sessionStore.saveMessages(sessionId, [...session.messages, phaseMsg])
        if (streamSession.isOpen(ws)) {
          streamSession.push(
            ws,
            JSON.stringify({ type: 'code_review_start', messageId: nextId, sessionId })
          )
        }
        deps.launchPhase(fullPhaseMessages, nextId, phaseModel, nextPhase)
      }
    } catch (err) {
      console.error('[code-review] 触发失败:', err)
    }
  }, 500)
}

export { REVIEWER_SYSTEM_PROMPT }
