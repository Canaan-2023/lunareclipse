/**
 * @category 核心
 * @summary 流式引擎：单次 LLM 流请求的全过程执行（缓冲推送、工具循环、激活注入、落盘、审查链调度）
 *
 * F-6 拆分自 server.ts 的 runStream（纯搬移不改行为）：
 * - 由 createStreamRunner(deps) 工厂按连接实例化，每条 WS 连接持有一份引擎状态；
 * - 共享可变状态（llmClient / 工具集 / 行号 / 激活内容 / 注入估算 / 审查定时器）经 ref 容器注入，
 * 保证与 message/close handler、headless 链路读写同一份内存；
 * - activeInternalContext 是连接级中间态，迁入工厂闭包（每连接一份，天然隔离）。
 * - 未来扩展边界：缓冲节流参数（BUFFER_INTERVAL_MS/MAX_CHARS）、软预算策略（resolveSoftBudget）、
 * 审查链调度（code-review 通道）均可在此模块内独立演进，不污染服务装配。
 * - 0.34 主链路可测化批次 2：把两段「纯判定」逻辑迁出本文件，理由只有「可测」——
 * countFileToolChanges → stream-file-changes.ts；onError 的错误分类/分支决策/用户文案 →
 * stream-error-policy.ts。二者调用点仍各只有一个，行为逐字节等价（模块头注释写明了
 * 为什么不删、以及各分支顺序为何不可重排）。
 */
import { WebSocket } from 'ws'
import type { ConfigStore } from './config-store'
import type { SessionStore } from './session-store'
import type { LLMClient, ToolExecutor } from './llm'
import type { LLMConfig } from '@shared/types'
import type { ToolContext } from '../tools/base-tool'
import { StreamSession } from './stream-session'
import type { ChatMessage, SessionContext } from '@shared/types'
import { ActivationManager } from './activation-manager'

// 0.34：行协议统计与错误策略抽为独立纯函数模块（理由：可测性，调用点仍各只有一个——
// 见两个模块的文件头注释；此处仅 import，逻辑实现不回流本文件）
// ADR-04 拆分：行协议 / 输出缓冲 / 子 agent 转发器 / 跨轮复读判定 外移为 ./stream/* 子模块
// （纯搬移不改行为；各模块文件头写明「为什么存在 / 不删理由」）
import { createTurnRows } from './stream/turn-rows'
import { createOutputBuffers } from './stream/output-buffers'
import { createSubagentForwarder } from './stream/subagent-forwarder'
import { dispatchStreamError } from './stream/error-dispatch'
import { createToolEventHandlers } from './stream/tool-events'
import { scheduleReviewContinuation } from './stream/review-chain'
import { persistTurn } from './stream/persistence'
import { applyBudgetWarnings } from './stream/budget'
import { enforceOutputDiscipline } from './stream/chat-enforcement'
import { emitDoneFrame, finalizeTurnCompletion } from './stream/turn-completion'
import { REVIEWER_SYSTEM_PROMPT } from './code-review'
// F-6：内部会话路由/队列不直接 import——两能力点是 createInternalSessionLayer 实例方法，
// 由 server.ts 装配时经 deps 注入（与 llmClientRef 等共享状态一致，依赖面显式化）。
import type { InternalSessionJob, ResolveSessionContextParams } from './internal-session'

/**
 * 流式引擎依赖注入面（F-6）。
 * - 连接级：ws / maxRetryDelayMs / maxStreamRetries / continuationTimerRef（与 message、close handler 共享）
 * - 服务级纯依赖：configStore / streamSession / serverCtx / activationManager / sessionStore /
 * lastModelBySession / setLastModel / 各类能力函数
 * - 服务级可变状态 ref：llmClientRef（懒重建写回）/ toolExecutorsRef / rowIdRef /
 * activationContentRef / lastInjectedEstimateRef
 */
export interface StreamRunnerDeps {
  ws: WebSocket
  maxRetryDelayMs: number
  maxStreamRetries: number
  continuationTimerRef: { current: ReturnType<typeof setTimeout> | null }
  configStore: ConfigStore
  streamSession: StreamSession
  serverCtx: ToolContext
  activationManager: ActivationManager
  sessionStore: SessionStore
  lastModelBySession: Map<string, string>
  setLastModel: (sessionId: string, model: string) => void
  llmClientRef: { current: LLMClient }
  toolExecutorsRef: { current: ToolExecutor[] }
  rowIdRef: { current: number }
  activationContentRef: { current: string | null }
  lastInjectedEstimateRef: { current: number | null }
  makeLlmClient: (cfg: LLMConfig) => LLMClient
  makeDistillCallbacks: () => {
    distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
    distillIntentTurnPairs?: number
  }
  buildInjectedMessages: (
    messages: ChatMessage[],
    sessionId?: string,
    sessionContext?: SessionContext | null
  ) => Promise<ChatMessage[]>
  writeRawMemoryForStream: (
    isInterrupted: boolean,
    fullOutput: string,
    activation: boolean,
    messages: ChatMessage[],
    interruptReason?: string
  ) => void
resolveSoftBudget: () => number
  broadcastStreamStatus: () => void
  /** F-5 内部会话层：路由/装载（continue → 载入内部会话；审查轮沿用选中会话） */
  resolveStreamSessionContext: (
    params: ResolveSessionContextParams
  ) => Promise<{
    sessionContext: SessionContext | null
    activeInternalContext: { sessionId: string; internalId: string } | null
  }>
  /** F-5 内部会话层：两写/摘要/压缩单飞队列入口 */
  enqueueInternalSessionJob: (sid: string, internalId: string, job: InternalSessionJob) => void
}

/**
 * 创建一条连接的流式引擎实例。
 * 工厂在 wss.on('connection') 回调整体调用一次；返回的 runStream 同时被 message handler 复用，
 * 保证「直接注入」续接、工具循环、落盘与审查链路共享同一份连接状态。
 */
export function createStreamRunner(deps: StreamRunnerDeps): { runStream: StreamRunnerType } {
  // 服务级可变状态 ref（llmClientRef / toolExecutorsRef / rowIdRef / activationContentRef /
  // lastInjectedEstimateRef / continuationTimerRef）一律经 deps.X 就地读取，不在此解构。
  // 为什么这样写：解构只是给同一个容器对象再取一个别名（llmClientRef.current 与
  // deps.llmClientRef.current 指向同一格），不产生独立状态，却会多出一批从未被读的局部名；
  // ESLint 据此报 unused。保留 deps.X 形式还能让「读写的是服务级共享状态」在调用点一眼可辨。
  // 不删理由：这些 ref 仍在 StreamRunnerDeps 接口与调用方（server.ts / ws-protocol.ts）之间传递，
  // 是跨模块共享可变状态的唯一通道，只是本文件选择不解构而已。
  const {
    ws,
    maxRetryDelayMs,
    maxStreamRetries,
    configStore,
    streamSession,
    serverCtx,
    activationManager,
    sessionStore,
    lastModelBySession,
    setLastModel,
    makeLlmClient,
    makeDistillCallbacks,
    buildInjectedMessages,
    writeRawMemoryForStream,
    resolveSoftBudget,
    broadcastStreamStatus
  } = deps

  // 连接级中间态：主回复轮选中的内部会话（审查轮沿用它装载上下文）；每连接一份，天然隔离
  let activeInternalContext: { sessionId: string; internalId: string } | null = null

  // 重试退避上限（连接级常量，经 deps 绑定保持原名引用）
  // 重试次数不设上限：MAX_STREAM_RETRIES 由 ws-protocol 注入 Number.POSITIVE_INFINITY，
  // 2026-10-02 按用户要求取消 LLM 调用次数上限；永久错误/用户中止仍短路（见 onError 分派）
  const MAX_RETRY_DELAY_MS = maxRetryDelayMs
  const MAX_STREAM_RETRIES = maxStreamRetries

  const runStream = async (
      messages: ChatMessage[],
      activation: boolean,
      messageId: string,
      sessionId: string | undefined,
      model: string | undefined,
      retryCount: number,
      prevOutput: string,
      // 独立提示词覆盖：传入时用该 system 取代主 AI 身份（审查者提示词），但保留内部会话上下文（sessionContext）
      opts?: { systemOverride?: string }
    ): Promise<void> => {
      if (!deps.llmClientRef.current.isReady()) {
        deps.llmClientRef.current = makeLlmClient(configStore.get().llm)
      }

      // 注入当前会话 ID 到 serverCtx，供工具执行时读取（run_command 会话级权限缓存等）
      serverCtx.sessionId = sessionId

      // 记录流归属的连接 + 运行快照（WS close 定向 abort、/api/streams/active、takeover 重放共用）
      streamSession.begin(ws, sessionId, messageId)
      broadcastStreamStatus()

      // 子 agent 过程事件转发器——绑定当前 stream 的 ws+messageId
      // SubAgentManager 事件转成 WS subagent_* 消息推前端（事件带 parentToolCallId 关联 Agent 工具卡）
      // 行协议：subagent 事件同时映射为 SubagentRow 行流（start→appended running，done→upserted 终态）
      // 行协议与输出缓冲（ADR-04 外移 ./stream/*）：本轮的行流与 33ms 批量推送各由单 owner 持有。
      // 在内部会话路由 await 之前创建（无推送副作用），保证子 agent 事件转发器可立即注册。
      let bufferClosed = false
      const rows = createTurnRows({
        ws,
        messageId,
        streamSession,
        rowIdRef: deps.rowIdRef,
        isClosed: () => bufferClosed
      })
      const buffers = createOutputBuffers({
        ws,
        messageId,
        streamSession,
        isClosed: () => bufferClosed
      })
      // 编码模式输出纪律：本轮工具失败收集（onToolEnd 填充，onDone 校验真实性）
      const toolFailures: Array<{ toolName: string; error: string }> = []

      // 子 agent 过程事件转发器——绑定当前 stream 的 ws+messageId
      // SubAgentManager 事件转成 WS subagent_* 消息推前端（事件带 parentToolCallId 关联 Agent 工具卡）
      // 行协议：subagent 事件同时映射为 SubagentRow 行流（start→appended running，done→upserted 终态）
      streamSession.setForwarder(
        createSubagentForwarder({
          ws,
          messageId,
          streamSession,
          turnId: rows.turnId,
          nextRow: rows.nextRow,
          appendRow: rows.appendRow,
          upsertRow: rows.upsertRow,
          rowIdRef: deps.rowIdRef
        })
      )

      // 工具事件处理（行协议工具行 + WS 工具帧 + 失败收集 + 落盘裁剪）——ADR-04 外移 ./stream/tool-events
      const toolEvents = createToolEventHandlers({
        ws,
        messageId,
        streamSession,
        rows,
        buffers,
        rowIdRef: deps.rowIdRef,
        toolFailures
      })

      // 标记 stream 活跃——阻止自主激活在任务执行中/重试中触发
      // 只有正常完成（onDone）或用户中止（onError isUserAbort）才清除
      activationManager.setStreamActive(true)

      // ===== 内部会话上下文组装）=====
      // 主回复轮：路由（continue → 装载内部会话；create → 立即建空会话）→ sessionContext 锚点注入
      // 审查轮（systemOverride）：沿用主回复轮路由选中的内部会话（activeInternalContext，摘要+当前 messages）
      // 任何未启用/路由失败 → sessionContext=null → 线性管线（不截断）
      // F-5 拆分：路由/装载逻辑迁至 internal-session.ts（resolveStreamSessionContext），
      // 此处只消费返回值，便于未来替换路由策略（阈值/优先级/多语言意图识别）。
      const resolvedCtx = await deps.resolveStreamSessionContext({
        opts,
        sessionId,
        messages,
        activeInternalContext
      })
      const sessionContext = resolvedCtx.sessionContext
      activeInternalContext = resolvedCtx.activeInternalContext

      // 审查模式：独立 system 提示词（审查者身份，非主 AI）+ 选中内部会话上下文 + 审查所需消息。
      // 与旧隔离实现不同：审查者看得到对话历史（不隔离），只是身份换成独立审查者。
      let baseInjected: ChatMessage[]
      if (opts?.systemOverride) {
        const ctxMsgs: ChatMessage[] = sessionContext
          ? [...sessionContext.anchorMessages] // 含缓存索引（已并入历史尾部）
          : []
        baseInjected = [
          { id: `sys_reviewer_${Date.now()}`, role: 'system' as const, content: opts.systemOverride, createdAt: Date.now() },
          ...ctxMsgs,
          ...messages
        ]
      } else {
        baseInjected = await buildInjectedMessages(messages, sessionId, sessionContext)
      }

      // 注入全量：月蚀不设单次注入上限、不实施上下文硬性截断——
      // tokenBudget/softBudgetTrim/truncateByFifo/微压缩的注入职责整体移除（函数实现保留，供其他链路兜底与 AI 提示）。
      // 注：微压缩层已于 0.15 删除，此处引用为历史遗留说明——注入侧不再有任何折叠/截断动作。
      const cfg = configStore.get()
      const injectedMessages = baseInjected
      const droppedCount = 0

      // 上下文预算：估算帧 + 达阈值时的用量提示（./stream/budget）
      applyBudgetWarnings({
        ws,
        messageId,
        streamSession,
        injectedMessages,
        tokenBudget: cfg.tokenBudget,
        resolveSoftBudget,
        lastInjectedEstimateRef: deps.lastInjectedEstimateRef,
        droppedCount
      })

      // 本轮累积态（跨回调共享；行协议/缓冲的其余状态由 ./stream/* 单 owner 持有）
      let fullOutput = prevOutput
      // 累积 reasoning（深度思考）全文，续接时带上让模型恢复思考上下文
      let fullReasoning = ''
      // 轮次头 + 用户输入行（仅首次流输出，重试不重复）——行协议见 ./stream/turn-rows
      rows.openTurn({ messages, model, sessionId, retryCount, lastModelBySession, setLastModel })

      // 温度：用户显式配置了 temperature 时优先用用户的；未配置时按模式区分默认值
      // coding/task=0.3（工具调用稳定，防参数抖动）；chat=0.7（对话自然）
      const modeTemperature = cfg.llm.temperature ?? (cfg.aiMode === 'chat' ? 0.7 : 0.3)
      // 真实 token 用量收集（provider 报告时才有；done 消息携带给前端展示）
      let streamUsageInfo:
        { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined
      await deps.llmClientRef.current.streamWithTools(
        injectedMessages,
        deps.toolExecutorsRef.current,
        {
          onUsage: (u) => {
            streamUsageInfo = {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {})
            }
          },
          onReasoning: (token) => {
            if (bufferClosed) return
            fullReasoning += token
            // 行协议：思考 token 建行/追加（./stream/turn-rows）
            rows.appendReasoningToken(token)
            // 33ms 批量缓冲推送（./stream/output-buffers）
            buffers.pushReasoning(token)
          },
          onToken: (token) => {
            if (bufferClosed) return
            fullOutput += token
            // 行协议：正文 token 建行/追加
            rows.appendTextToken(token)
            // 33ms 批量缓冲推送
            buffers.pushText(token)
          },
          // 工具结果蒸馏回调：llm.ts 在每个工具轮执行完、下一轮请求构建前批量蒸馏：
          // - distillToolResult 用 LLM 提炼有用信息（大体积结果）
          // - 蒸馏成功 → 摘要重包护栏替换 conversation 中 tool 消息 content
          // - 失败重试一次，仍失败保留原文进上下文（不截断不落盘）
          ...makeDistillCallbacks(),
          onDone: async () => {
            // 兜底 flush 最后一批 row delta，避免 33ms 窗口内的增量在流结束时被丢弃
            rows.flushRowDeltas()
            bufferClosed = true
            buffers.clearTimers()
            // 会话模式硬约束 / 编码模式输出纪律（ADR-04 外移 ./stream/chat-enforcement）
            const enforced = await enforceOutputDiscipline({
              aiMode: cfg.aiMode,
              fullOutput,
              llmClient: deps.llmClientRef.current,
              model,
              injectedMessages,
              toolFailures,
              ws,
              messageId,
              streamSession
            })
            fullOutput = enforced.fullOutput
            const chatEmotion = enforced.emotion
            const chatAnimation = enforced.animation
            buffers.flushResidualText()
            buffers.flushResidualReasoning()
            // stream 正常完成，清除活跃标志，允许后续自主激活
            activationManager.setStreamActive(false)

            // 流结束收尾链前半（ADR-04 外移 ./stream/turn-completion）：解析原始输出 →
            // [TASK_COMPLETE] 检测 → 跨轮复读判定 → RAW 记忆归档
            const { isRepeatTurn } = finalizeTurnCompletion({
              fullOutput,
              fullReasoning,
              messages,
              activation,
              messageId,
              activationManager,
              writeRawMemoryForStream
            })
            // 回合落盘（会话历史 + 内部会话两写）——ADR-04 外移 ./stream/persistence
            if (sessionId) {
              persistTurn({
                sessionId,
                messageId,
                messages,
                activation,
                fullOutput,
                fullReasoning,
                isRepeatTurn,
                activeInternalContext,
                activationContentRef: deps.activationContentRef,
                rows,
                sessionStore,
                enqueueInternalSessionJob: deps.enqueueInternalSessionJob
              })
            }
            // 清除激活内容缓存（本轮已用完）
            deps.activationContentRef.current = null

            // done 帧 + 运行快照清理 + 状态广播（ADR-04 外移 ./stream/turn-completion）
            emitDoneFrame({
              ws,
              messageId,
              streamSession,
              fullOutput,
              chatEmotion,
              chatAnimation,
              streamUsageInfo,
              broadcastStreamStatus
            })

            // 代码审查：主回复完成后触发"代表用户立场"的审查轮（子协议与调度见 ./stream/review-chain）
            if (sessionId && configStore.get().codeReview === true && fullOutput.trim().length > 0) {
              scheduleReviewContinuation({
                sessionId,
                messageId,
                fullOutput,
                model,
                messages,
                ws,
                streamSession,
                sessionStore,
                continuationTimerRef: deps.continuationTimerRef,
                launchPhase: (phaseMessages, phaseId, phaseModel, nextPhase) => {
                  streamSession.enqueue(() =>
                    runStream(
                      phaseMessages,
                      true,
                      phaseId,
                      sessionId,
                      phaseModel,
                      0,
                      '',
                      // 审查轮：独立审查提示词 + 内部会话上下文（systemOverride 死代码解除）；
                      // 修正轮：主 AI 身份（不传 override）
                      nextPhase === 'review' ? { systemOverride: REVIEWER_SYSTEM_PROMPT } : undefined
                    )
                  )
                }
              })
            }
          },
          onError: (err) => {
            // 兜底 flush 最后一批 row delta，错误收尾也不丢增量
            rows.flushRowDeltas()
            bufferClosed = true
            buffers.clearTimers()
            // 错误时仍刷新已生成内容，避免丢失
            buffers.flushResidualText()
            buffers.flushResidualReasoning()
            // 错误分类与分支决策收在纯函数模块 stream-error-policy.ts；五条出路的副作用分派
            // 外移 ./stream/error-dispatch（ADR-04）——判定口径与顺序一律不在本文件重写。
            dispatchStreamError({
              err,
              ws,
              messageId,
              sessionId,
              activation,
              retryCount,
              maxStreamRetries: MAX_STREAM_RETRIES,
              maxRetryDelayMs: MAX_RETRY_DELAY_MS,
              continuationTimerRef: deps.continuationTimerRef,
              streamSession,
              activationManager,
              messages,
              fullOutput,
              fullReasoning,
              writeRawMemoryForStream,
              resume: (continuedMessages, nextRetryCount) => {
                runStream(
                  continuedMessages,
                  activation,
                  messageId,
                  sessionId,
                  model,
                  nextRetryCount,
                  fullOutput,
                  // 重试沿用原请求的覆盖参数：审查轮重试保持独立审查提示词，普通流程保持 undefined
                  opts
                ).catch((streamErr) => {
                  activationManager.setStreamActive(false)
                  throw streamErr
                })
              }
            })
          },
          ...toolEvents,
        },
        // maxRounds 不再传（2026-10-02 取消上限）：工具循环轮次不设限，
        // 防死循环由 llm-guardrails 护栏兜底，避免主对话"跑着跑着就中断"
        {
          modelOverride: model,
          temperature: modeTemperature,
          // 消息来源护栏作用域键：主对话/审查轮共用会话护栏（会话内固定哈希、跨会话不同）
          guardrailSessionId: sessionId
        }
      )
      // stream 结束（正常完成或错误处理完毕），清除归属与快照
      // 若期间被其他连接抢占（串行队列下不应发生，防御性判断），保留对方的标记
      streamSession.finish(ws, messageId)
      serverCtx.sessionId = undefined
      broadcastStreamStatus()
    }

  return { runStream }
}

/** runStream 函数签名（供 message handler / StreamRunnerType 标注使用） */
type StreamRunnerType = (
  messages: ChatMessage[],
  activation: boolean,
  messageId: string,
  sessionId: string | undefined,
  model: string | undefined,
  retryCount: number,
  prevOutput: string,
  opts?: { systemOverride?: string }
) => Promise<void>
