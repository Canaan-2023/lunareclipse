/**
 * 流式错误策略：LLM 流失败后的「分类 → 分支决策 → 用户可见文案」（纯函数）
 * ------------------------------------------------------------
 * 为什么存在：`stream-runner.ts` 的 `onError` 回调是主链路最关键的异常收口——它要在
 * 「永久性错误（未配置 / 余额不足）/ 用户中止 / 静默续接重试 / 断线中断恢复 / 重试耗尽恢复」
 * 五条出路之间做选择。这些判定原先是一串内联的布尔常量与 if/else 链，埋在 1400 行流式引擎
 * 的闭包里（还夹着 flush、定时器清理等副作用），**零测试覆盖**：分类口径写错只会表现为
 * 「该重试的不重试」「该恢复的静默失败」「余额不足被当成网络抖动重试 5 次再恢复 10 次」
 * （2026-09-08 真实故障，见下），没有任何断言会拦住。本模块把纯判定部分抽出来，使其可脱离
 * electron 被逐条验证。
 * 作用：`classifyStreamError` 给出错误事实；`decideStreamErrorAction` 在该事实 + 连接/重试
 * 状态上给出唯一动作；`buildPermanentErrorPayload` 生成永久性错误推给前端的可行动文案。
 * 不删理由：这五条分支对应的是「用户可感知的失败方式」，每一条都已有真实故障背书
 * （余额不足死循环、用户停止按钮无效、断线后自主激活开新任务丢上下文）；删掉即退回无验证状态。
 *
 * 为什么独立成文件而不并入 stream-runner.ts：本模块是**纯函数**，不含 ws/timer/store 依赖，
 * 可被 vitest 直接 import；而 stream-runner.ts 的模块图（ws / openai / 工具集）会把测试绑上
 * 整套运行时依赖。抽取理由是「可测」，与 0.33 抽 context-sanitize.ts 同一性质。
 */

/**
 * 账户级「余额不足」的文案特征（各服务商措辞不一，故并列多种）。
 *
 * ⚠️ 禁止加 `g`（或 `y`）标志：`RegExp.prototype.test` 在带 `g` 时会推进 `lastIndex`，
 * 而本常量是**模块级共享实例**（原实现内联在 onError 内、每次调用重建正则，误加 `g`
 * 只污染单次）；抽到模块级后状态会**跨调用泄漏**，表现为「同一个错误第二次起不再被判为
 * 余额不足」。测试用「同一输入连续调用两次结果一致」钉住这条。
 * 带 `i` 是有意的（服务商文案大小写不固定），`i` 不影响 `lastIndex`。
 */
const BALANCE_ERROR_PATTERN = /insufficient balance|余额不足|quota exceeded|insufficient_quota/i

/**
 * 一次流错误的判定事实（纯分类结果，不带任何副作用）。
 * 为什么单独成形：五条分支的判断依据需要被逐条断言，而它们原先只是 onError 里的局部布尔量。
 */
export interface StreamErrorFacts {
  /** 用户主动中止（llm.ts 的 abort() 把 abortReason 置为 'user'；'aborted' 为兜底口径） */
  isUserAbort: boolean
  /** 流超时（首 token 超时 / 空闲超时）——只有它用更短的退避基准 */
  isTimeout: boolean
  /** LLM 未配置（llm.ts 在 client 为空时抛 'LLM 未配置：…'） */
  isConfigError: boolean
  /** 余额/配额类错误（HTTP 402 或文案命中） */
  isBalanceError: boolean
  /** 永久性错误：重试注定失败，必须停止自动恢复（否则形成无效重试循环） */
  isPermanentError: boolean
}

/**
 * 错误分类：从错误对象提取五项事实。
 *
 * 为什么存在：见文件头——五条分支的判定依据集中于此，可被逐条断言。
 * 作用：入参是错误消息与可选的 HTTP 状态（Error 上挂 `status` 是 OpenAI SDK 的运行时事实，
 * 类型里没有，故调用方传 `(err as { status?: unknown }).status`）；出参是事实对象，无副作用。
 * 不删理由：`isPermanentError` 的分组（未配置 ∪ 余额不足）是 2026-09-08 修复的核心口径，
 * 拆散或放宽都会让「注定失败的自动恢复」回归。
 */
export function classifyStreamError(err: { message: string; status?: unknown }): StreamErrorFacts {
  const isUserAbort = err.message === 'user' || err.message === 'aborted'
  const isTimeout = err.message === 'ttft_timeout' || err.message === 'idle_timeout'
  const isConfigError = err.message.startsWith('LLM 未配置')
  const isBalanceError = err.status === 402 || BALANCE_ERROR_PATTERN.test(err.message)
  return {
    isUserAbort,
    isTimeout,
    isConfigError,
    isBalanceError,
    isPermanentError: isConfigError || isBalanceError
  }
}

/**
 * 错误收敛动作（与 onError 的 if/else 链一一对应，不多不少）。
 * - `permanent-error`：推 error 给前端、清活跃标志、**不重试不恢复**
 * - `user-abort`：清审查定时器、推 abort、清活跃标志、**不恢复**
 * - `retry`：按退避静默续接（前端无感）
 * - `ws-closed-recovery`：WS 已断，**不推任何事件**（推 error 会让前端判空闲而触发自主激活、
 * 丢掉原任务上下文），只写 raw_memory + 触发中断恢复
 * - `retry-exhausted-recovery`：WS 还在但重试耗尽，推 `interrupted`（不是 error）+ 触发中断恢复
 */
export type StreamErrorAction =
  | 'permanent-error'
  | 'user-abort'
  | 'retry'
  | 'ws-closed-recovery'
  | 'retry-exhausted-recovery'

export interface StreamErrorDecision {
  /** 唯一动作；调用方按它分派副作用（推帧 / 清定时器 / 调度重试 / 触发恢复） */
  action: StreamErrorAction
  /** 分类事实，供调用方取用（如余额不足要选专用文案） */
  facts: StreamErrorFacts
  /** 静默续接的退避基准延迟：超时 500ms（超时多为瞬时抖动，尽快续）、其余 1500ms */
  baseDelayMs: number
}

/**
 * 分支决策：把「错误事实 + 连接状态 + 重试进度」收敛为唯一动作。
 *
 * 为什么存在：这五个分支原先内联在 onError 里，与 flush/清定时器/推帧等副作用交织，
 * 无法单独验证；抽出来后「哪种错误走哪条路」成为可断言的表。
 * 作用：入参为错误（消息 + 可选 status）、WS 是否仍 OPEN、当前重试次数与上限；出参为动作
 * + 事实 + 退避基准。纯函数，不读时钟、不碰网络、不改状态。
 * 不删理由：五条分支的**顺序即语义**。特别是「永久性错误」必须排在「可重试」之前——
 * 402/未配置若落到 retry 分支，就会重复 2026-09-08 那个「重试 5 次 × 恢复 10 次 × 必然再 402」
 * 的死循环；「用户中止」必须排在恢复之前——否则用户点停止后反而触发中断恢复，停止按钮失效。
 * `ws-closed-recovery` 与 `retry-exhausted-recovery` 的前后关系同样不可倒置：两者动作
 * （是否推 interrupted）不同，WS 已断时必须走前者（推 error/interrupted 会诱发前端自主激活）。
 */
export function decideStreamErrorAction(params: {
  message: string
  status?: unknown
  /** 调用方传 `ws.readyState === WebSocket.OPEN`——只传布尔，避免本模块依赖 ws 运行时 */
  wsOpen: boolean
  retryCount: number
  maxRetries: number
}): StreamErrorDecision {
  const facts = classifyStreamError({ message: params.message, status: params.status })
  const baseDelayMs = facts.isTimeout ? 500 : 1500
  // ↓ 判定顺序与 stream-runner 原有 if/else 链逐条对应，不可重排（见函数头「不删理由」）
  if (facts.isPermanentError) return { action: 'permanent-error', facts, baseDelayMs }
  if (facts.isUserAbort) return { action: 'user-abort', facts, baseDelayMs }
  // 原式为 !isUserAbort && !isPermanentError && wsOpen && retryCount < max：
  // 前两个否定条件已被上面两次提前 return 吸收，此处只留后两个（不是放宽，是等价化简）
  const canDirectRetry = params.wsOpen && params.retryCount < params.maxRetries
  if (canDirectRetry) return { action: 'retry', facts, baseDelayMs }
  // WS 已断优先于「重试耗尽」（对应原 `else if (ws.readyState !== OPEN)`）
  if (!params.wsOpen) return { action: 'ws-closed-recovery', facts, baseDelayMs }
  return { action: 'retry-exhausted-recovery', facts, baseDelayMs }
}

/**
 * 永久性错误推给前端的用户可见文案。
 *
 * 为什么存在：2026-09-08 的真实故障——402 余额不足被当作瞬时网络错误静默重试，最终只发
 * `interrupted`，真实原因被埋在中断恢复的系统注入文本里，用户**不知道要去充值**。修复的关键
 * 不只是「不重试」，还有「把原因与可行动建议直接推给前端」。这段文案就是那个修复的一半，
 * 故独立成函数以便被断言（行为测试能证明「不重试」，但证明不了「用户看得到原因」）。
 * 作用：余额不足 → 原文 + 充值/换 Key 建议 + 「已暂停自动恢复」的说明；其余永久性错误
 * （如 LLM 未配置）→ 原样返回错误消息（消息本身已是可行动提示：「请在设置中填写 API Key」）。
 * 不删理由：删掉即把「用户看得懂为什么失败」这件事退回到只能靠日志排查。
 */
export function buildPermanentErrorPayload(message: string, isBalanceError: boolean): string {
  return isBalanceError
    ? `LLM API 余额不足（${message}）：请在服务商处充值或更换 API Key 后重试。（系统已暂停自动恢复，避免无效重试循环）`
    : message
}
