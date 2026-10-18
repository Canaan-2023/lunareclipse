/**
 * @category 核心
 * @summary 流结束收尾链：原始输出解析 → [TASK_COMPLETE] → 跨轮复读判定 → RAW 归档 → done 帧
 *
 * 为什么独立成文件：这是「一次流正常结束」的固定处理顺序（原实现注释明写 1~4 的顺序），
 * 原先内联在 `stream-runner.ts` 的 `onDone`。ADR-04 外移——收尾顺序集中一处，不与其他职责混居。
 *
 * 什么作用：两个步骤函数——
 * - `finalizeTurnCompletion`：解析原始输出、[TASK_COMPLETE] 检测、跨轮复读判定（正文 + 思考流）、
 *   RAW 记忆归档；返回 `isRepeatTurn` 供落盘阶段决定是否写会话历史；
 * - `emitDoneFrame`：推送 `done` 帧（带 finalContent / emotion / animation / usage）并清运行快照 + 广播状态。
 *
 * 不删理由：删掉即前端收不到 done（流式消息永远停在生成中）、`/api/streams/active` 永远报 active。
 *
 * 顺序约束（不可重排）：复读判定必须在 RAW 归档与落盘**之前**——复读轮跳过 RAW/落盘是「历史断链」
 * 的核心（模型下一轮看不到自己上一轮的复读原话，自回归强化源头断裂）。done 帧必须在落盘之后
 * （前端在 done 处理时用 streamingMessageId 定位消息替换 content，此时该 id 尚未清空，时序安全）。
 */
import type { ChatMessage } from '@shared/types'
import type { StreamSession } from '../stream-session'
import type { ActivationManager } from '../activation-manager'
import { detectCrossTurnRepeat } from './repeat-guard'

export interface TurnCompletionDeps {
  fullOutput: string
  fullReasoning: string
  messages: ChatMessage[]
  activation: boolean
  messageId: string
  activationManager: ActivationManager
  writeRawMemoryForStream: (
    isInterrupted: boolean,
    fullOutput: string,
    activation: boolean,
    messages: ChatMessage[],
    interruptReason?: string
  ) => void
}

/** 返回 `isRepeatTurn`：复读轮不写 RAW、不落盘、不喂评论家（历史断链） */
export function finalizeTurnCompletion(deps: TurnCompletionDeps): { isRepeatTurn: boolean } {
  const { fullOutput, fullReasoning, messages, activation, messageId, activationManager } = deps

  // 流结束处理顺序：
  // 1. ActivationManager.parseAIOutput（解析原始输出）
  // 2. [TASK_COMPLETE] 检测（原始输出）
  // 3. writeRawMemoryForStream（完整版本）
  // 4. 持久化 ChatMessage（完整版本，见 ./persistence）
  if (fullOutput) {
    activationManager.parseAIOutput(fullOutput)
  }
  // 不再在对话结束后自动触发反思循环——用户明确要求：
  // 自主激活应由 AI 规划任务时通过 [TIMER:时长:任务] 指令按时间定时触发
  // 而不是每说完一句话就紧跟着自主激活。
  // parseAIOutput 已解析 [TIMER:...] 并注册定时器，到点才触发自主激活。
  // [TASK_COMPLETE] 检测：AI 显式声明任务完成，重置中断恢复计数
  // 避免上一轮中断恢复的计数残留影响下一轮（检测原始输出）
  if (fullOutput && fullOutput.includes('[TASK_COMPLETE]')) {
    activationManager.resetInterruptRecovery()
  }

  // 跨轮输出复读检测（调度层，历史断链）——判定见 ./repeat-guard
  // （正文 OR 思考流任一命中；partial_ 续接锚已排除，避免续接轮被误判）
  const repeatVerdict = detectCrossTurnRepeat({ messages, fullOutput, fullReasoning })
  const isRepeatTurn = repeatVerdict.isRepeat
  if (isRepeatTurn) {
    console.warn(
      `[server] 检测到跨轮复读（正文=${repeatVerdict.bodySimilar} 思考=${repeatVerdict.thinkSimilar}），跳过 RAW/落盘/评论家 — messageId=${messageId}`
    )
  }

  if (fullOutput && !isRepeatTurn) {
    deps.writeRawMemoryForStream(false, fullOutput, activation, messages)
  }
  return { isRepeatTurn }
}

export interface DoneFrameDeps {
  ws: Parameters<StreamSession['push']>[0]
  messageId: string
  streamSession: StreamSession
  fullOutput: string
  chatEmotion?: string
  chatAnimation?: string
  streamUsageInfo?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  broadcastStreamStatus: () => void
}

export function emitDoneFrame(deps: DoneFrameDeps): void {
  const { ws, messageId, streamSession, fullOutput, chatEmotion, chatAnimation, streamUsageInfo } =
    deps
  // 内部会话摘要/继承不走 onDone 同步链路：由单飞队列任务维护（入队后 500ms 末次合并 +
  // 串行链执行一次 append + 一次摘要 + 一次超限继承，不阻塞回复流）
  // done 必须在此之后发送并带上 finalContent（流结束后的完整最终正文），
  // 前端在 done 处理时用 streamingMessageId 定位消息替换 content（此时该 id 尚未清空，时序安全）。
  streamSession.push(
    ws,
    JSON.stringify({
      type: 'done',
      messageId,
      ...(fullOutput ? { finalContent: fullOutput } : {}),
      // 会话模式：emotion/animation 供前端角色表情/动画展示
      ...(chatEmotion ? { emotion: chatEmotion, animation: chatAnimation } : {}),
      // 真实 token 用量（input 不含缓存命中；cacheRead 存在时才带）
      ...(streamUsageInfo ? { usage: streamUsageInfo } : {})
    })
  )

  // onDone 正常完成也要清运行快照（否则 /api/streams/active 仍报 active:true）
  streamSession.clearSnapshot(messageId)
  deps.broadcastStreamStatus()
}
