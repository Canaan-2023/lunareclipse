/**
 * @category 核心
 * @summary 流错误分派：onError 的五条出路（永久错误 / 用户中止 / 静默续接 / 断线恢复 / 重试耗尽）
 *
 * 为什么独立成文件：五条出路的**判定**已抽为纯函数模块 `stream-error-policy.ts`，但**副作用分派**
 * （推帧 / 清审查定时器 / 调度续接 / 写 RAW / 触发中断恢复）仍内联在 `stream-runner.ts` 的 onError
 * 里，与行协议、缓冲、落盘同处一个 1163 行闭包。ADR-04 把它外移：本模块只做「按裁决执行动作」，
 * 不再重复任何判定口径（判定顺序与语义见 `stream-error-policy.ts` 文件头）。
 *
 * 什么作用：`dispatchStreamError(deps)` 消费一次流错误，执行唯一动作后返回；续接动作经
 * `deps.resume` 回调重新发起 runStream（保持原实现的递归语义，宿主提供以复用同一份闭包状态）。
 *
 * 不删理由：删掉即五条出路的副作用（尤其是「永久错误不重试」「用户中止不触发恢复」）失去唯一落点，
 * 会退回 2026-09-08 的「余额不足被静默重试 5 次 × 恢复排队 10 次」故障形态。
 */
import { WebSocket } from 'ws'
import type { ChatMessage } from '@shared/types'
import { computeBackoffDelay } from '@shared/utils/backoff'
import { buildContinuationMessages } from '@shared/utils/output-discipline'
import type { StreamSession } from '../stream-session'
import type { ActivationManager } from '../activation-manager'
import { buildPermanentErrorPayload, decideStreamErrorAction } from '../stream-error-policy'

export interface ErrorDispatchDeps {
  err: Error
  ws: WebSocket
  messageId: string
  sessionId: string | undefined
  activation: boolean
  retryCount: number
  maxStreamRetries: number
  maxRetryDelayMs: number
  /** 审查续轮定时器句柄（用户中止时须清掉已调度的审查轮） */
  continuationTimerRef: { current: ReturnType<typeof setTimeout> | null }
  streamSession: StreamSession
  activationManager: ActivationManager
  /** 本轮请求消息（续接上下文构造与 RAW 写入用） */
  messages: ChatMessage[]
  fullOutput: string
  fullReasoning: string
  writeRawMemoryForStream: (
    isInterrupted: boolean,
    fullOutput: string,
    activation: boolean,
    messages: ChatMessage[],
    interruptReason?: string
  ) => void
  /** 续接：按退避延迟后重新发起 runStream（宿主提供，保持递归与 .catch 语义） */
  resume: (continuedMessages: ChatMessage[], nextRetryCount: number) => void
}

export function dispatchStreamError(deps: ErrorDispatchDeps): void {
  const {
    err,
    ws,
    messageId,
    sessionId,
    activation,
    retryCount,
    maxStreamRetries,
    maxRetryDelayMs,
    continuationTimerRef,
    streamSession,
    activationManager,
    messages,
    fullOutput,
    fullReasoning,
    writeRawMemoryForStream,
    resume
  } = deps

  // 判定口径与顺序一律不在本文件重写（见 stream-error-policy.ts 文件头「五条分支的顺序即语义」）
  const decision = decideStreamErrorAction({
    message: err.message,
    // Error 上挂 status 是 OpenAI SDK 的运行时事实，类型里没有（原代码同款断言）
    status: (err as { status?: unknown }).status,
    wsOpen: ws.readyState === WebSocket.OPEN,
    retryCount,
    maxRetries: maxStreamRetries
  })
  const facts = decision.facts

  if (decision.action === 'permanent-error') {
    // 直接把原因推给前端（error 事件在消息上渲染，用户立即看到可行动的提示）
    const payload = buildPermanentErrorPayload(err.message, facts.isBalanceError)
    if (streamSession.isOpen(ws)) {
      streamSession.push(ws, JSON.stringify({ type: 'error', payload, messageId }))
    }
    activationManager.setStreamActive(false)
    // 不触发中断恢复：永久性错误重试注定失败，恢复机制只会排进另一个注定失败的激活
    return
  }

  if (decision.action === 'user-abort') {
    // 用户主动中止，尊重决定，不恢复
    // 取消 onDone 已调度但尚未触发的代码审查（setTimeout 500ms 窗口），与 ws abort 分支一致
    if (continuationTimerRef.current) {
      clearTimeout(continuationTimerRef.current)
      continuationTimerRef.current = null
    }
    if (streamSession.isOpen(ws)) {
      streamSession.push(ws, JSON.stringify({ type: 'abort', messageId }))
    }
    // 用户中止时清除活跃标志
    activationManager.setStreamActive(false)
    return
  }

  if (decision.action === 'retry') {
    // 直接注入：超时/网络错误时 server 内部直接续接，前端完全无感
    // 不推任何提示，静默重试
    // 指数退避：首次 500ms，每次翻倍，上限 30s（基准延迟由策略模块给出：超时 500 / 其余 1500）
    const retryDelay = computeBackoffDelay({
      attempt: retryCount,
      baseDelayMs: decision.baseDelayMs,
      maxDelayMs: maxRetryDelayMs
    })
    console.warn(
      `[server] 静默续接：${err.message}（messageId=${messageId}，retry=${retryCount + 1}，delay=${retryDelay}ms）`
    )
    // 续接时恢复完整上下文：
    // - 已输出正文（content）作为 assistant 消息，让 AI 续上而非重新开始
    // - 深度思考（reasoning）不做语义注入：只思考未出正文时干净重试（模型重新思考），
    // 已出正文时思考仅随 partial 消息走 wire 协议字段回传（DeepSeek 400 硬约束）
    // 消息构造收拢在共享纯函数 buildContinuationMessages（shared/utils/output-discipline.ts）
    // ——"思考不进上下文"行为由单测锁定，此处只调用不重复实现
    const continuedMessages = buildContinuationMessages(messages, fullOutput, fullReasoning)
    // 重试前再次检查 WS 状态：断开则不调度重试，避免无意义定时器泄漏
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn(`[server] WS 已断开，取消重试（messageId=${messageId}）`)
      activationManager.setStreamActive(false)
      // WS 断开且重试失败：触发中断恢复，让 AI 下次被激活时续接任务
      activationManager.requestInterruptRecovery(err.message, messageId, sessionId)
      return
    }
    setTimeout(() => {
      // 调度时 WS 可能已断开，执行前再检查一次
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn(`[server] 重试时 WS 已断开，放弃（messageId=${messageId}）`)
        activationManager.setStreamActive(false)
        activationManager.requestInterruptRecovery(err.message, messageId, sessionId)
        return
      }
      resume(continuedMessages, retryCount + 1)
    }, retryDelay)
  } else if (decision.action === 'ws-closed-recovery') {
    // WebSocket 已关闭，无法继续重试
    // 不推 error——推 error 会让前端 status=idle → isFrontendIdle=true → 触发自主激活
    // 自主激活会开启新任务，丢失原任务上下文（用户明确反对这个行为）
    // 改触发中断恢复：下次 AI 被激活时通过 consumeEvents 注入续接提示
    console.warn(`[server] WebSocket 已断开，触发中断恢复：${err.message}（messageId=${messageId}）`)
    // 中断时也写入 raw_memory
    writeRawMemoryForStream(true, fullOutput, activation, messages, err.message)
    activationManager.setStreamActive(false)
    activationManager.requestInterruptRecovery(err.message, messageId, sessionId)
  } else {
    // 剩余唯一动作：retry-exhausted-recovery（WS 还开着但重试已达上限）——
    // 触发中断恢复而非无限重试。
    // 2026-10-02 起 MAX_STREAM_RETRIES=Infinity，WS 开着时恒走 retry 分支，此分支
    // 实际不可达；保留作为防御性兜底（若未来显式配置有限重试次数仍可正确收敛）。
    console.warn(`[server] 重试上限已达，触发中断恢复：${err.message}（messageId=${messageId}）`)
    // 中断时也写入 raw_memory
    writeRawMemoryForStream(true, fullOutput, activation, messages, err.message)
    activationManager.setStreamActive(false)
    // 通知前端当前 stream 结束（但不是 error，避免前端显示错误）
    if (streamSession.isOpen(ws)) {
      streamSession.push(
        ws,
        JSON.stringify({ type: 'interrupted', messageId, reason: err.message, retryCount })
      )
    }
    activationManager.requestInterruptRecovery(err.message, messageId, sessionId)
  }
}
