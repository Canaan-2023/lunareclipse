/**
 * @category 核心
 * @summary 流式引擎：单次 LLM 流请求的全过程执行（缓冲推送、工具循环、激活注入、落盘、审查链调度）
 *
 * F-6 拆分自 server.ts（原 runStream 1627-2813 行，纯搬移不改行为）：
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
import type { LLMClient, ToolExecutor, ApiMessage } from './llm'
import type { LLMConfig } from '@shared/types'
import { enforceChatOutput } from './chat-envelope'
import { stripThinkingLeak, buildContinuationMessages } from '@shared/utils/output-discipline'
import { estimateMessagesTokens } from '@shared/utils/token-estimate'
import { computeBackoffDelay } from '@shared/utils/backoff'
import { getTodos } from '../tools/todo-write'
import type { ToolContext } from '../tools/base-tool'
import type { SubAgentEvent } from '../sub-agent'
import { StreamSession } from './stream-session'
import type {
  ChatMessage,
  ConversationRow,
  RowOp,
  AssistantTextRow,
  ReasoningRow,
  ToolCallRow,
  TurnHeaderRow,
  SubagentRow,
  TimelineMarkerRow,
  SessionContext
} from '@shared/types'
import { ActivationManager } from './activation-manager'

import { buildToolCallSummary } from './tool-bridge'
// 0.34：行协议统计与错误策略抽为独立纯函数模块（理由：可测性，调用点仍各只有一个——
// 见两个模块的文件头注释；此处仅 import，逻辑实现不回流本文件）
import { countFileToolChanges } from './stream-file-changes'
import { decideStreamErrorAction, buildPermanentErrorPayload } from './stream-error-policy'
import {
  hasReviewPass,
  setCodeReviewChain,
  appendCodeReviewChain,
  takeCodeReviewChain,
  openCodeReviewReport,
  MAX_REVIEW_ROUNDS,
  REVIEWER_SYSTEM_PROMPT,
  REVIEW_INSTRUCTION
} from './code-review'
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

  // 重试退避上限（连接级常量，原 server.ts 1616-1617 行）： body 内经此绑定保持原名引用
  // 重试次数不设上限：MAX_STREAM_RETRIES 由 ws-protocol 注入 Number.POSITIVE_INFINITY，
  // 2026-10-02 按用户要求取消 LLM 调用次数上限；永久错误/用户中止仍短路（见 onError 分派）
  const MAX_RETRY_DELAY_MS = maxRetryDelayMs
  const MAX_STREAM_RETRIES = maxStreamRetries

  // 跨轮输出复读检测（奥卡姆根治②）阈值：归一化后 short/long ≥ 该比例且互为子串 → 判复读轮。
  // REPEAT_MIN_CHARS：短于该长度的消息不参与复读比较（太短无判别力，避免系统片段误判）。
  const REPEAT_MIN_CHARS = 50
  const REPEAT_SIMILAR_RATIO = 0.8

  // 工具输出持久化裁剪（onToolEnd 内）：output.text 全量落盘会让 session 文件膨胀到几十 MB
  // （真实案例：77.9MB 会话文件 / 200KB 阈值仍让 75 个 120-190KB 的 run_command 输出累积成
  // 42.8MB 再爆）。UI 不消费 output.text（ToolCallCard 显示消息级 summary），超 MAX 时
  // 只保留头 HEAD / 尾 TAIL。
  const OUTPUT_TEXT_MAX = 8 * 1024
  const OUTPUT_TEXT_HEAD = 4 * 1024
  const OUTPUT_TEXT_TAIL = 2 * 1024

  // 上下文预算警告阈值（tokenBudget 配置可用时按绝对预算、否则按软预算）：
  // 使用率达到 BUDGET_WARN_PERCENT 才向 AI 注入警告消息（平时不注入，避免噪音）。
  // SOFT_BUDGET_HINT_PERCENT：tokenBudget 未配置时，从该使用率起开始提示用量。
  const BUDGET_WARN_PERCENT = 80
  const SOFT_BUDGET_HINT_PERCENT = 60

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
      const subagentRows = new Map<string, SubagentRow>() // agentId → 行
      const subagentTypeOf = (mode?: 'serial' | 'parallel') =>
        mode === 'parallel' ? 'parallel-agent' : 'sub-agent'
      streamSession.setForwarder((evt: SubAgentEvent) => {
        if (ws.readyState !== WebSocket.OPEN) return
        const base = { messageId, parentToolCallId: evt.parentToolCallId, agentId: evt.agentId }
        switch (evt.type) {
          case 'start': {
            const row: SubagentRow = {
              kind: 'subagent',
              rowId: nextRow(),
              turnId,
              createdAt: Date.now(),
              createdAtSeq: deps.rowIdRef.current,
              parentToolCallId: evt.parentToolCallId,
              subagentType: subagentTypeOf(evt.mode),
              status: 'running',
              summaryText: evt.prompt.slice(0, 120),
              startedAt: Date.now()
            }
            subagentRows.set(evt.agentId, row)
            appendRow(row)
            streamSession.push(
              ws,
              JSON.stringify({
                type: 'subagent_start',
                ...base,
                prompt: evt.prompt,
                mode: evt.mode,
                index: evt.index,
                total: evt.total
              })
            )
            break
          }
          case 'tool_start':
            streamSession.push(
              ws,
              JSON.stringify({
                type: 'subagent_tool_start',
                ...base,
                toolName: evt.toolName,
                toolCallId: evt.toolCallId,
                toolArgs: JSON.stringify(evt.args)
              })
            )
            break
          case 'tool_end':
            streamSession.push(
              ws,
              JSON.stringify({
                type: 'subagent_tool_end',
                ...base,
                toolName: evt.toolName,
                toolCallId: evt.toolCallId,
                toolResult: evt.result
              })
            )
            break
          case 'output':
            streamSession.push(
              ws,
              JSON.stringify({ type: 'subagent_output', ...base, text: evt.text })
            )
            break
          case 'done': {
            const row = subagentRows.get(evt.agentId)
            if (row) {
              const ended: SubagentRow = {
                ...row,
                status: evt.error ? 'failed' : evt.timedOut ? 'cancelled' : 'success',
                summaryText: evt.error ? `❌ ${evt.error.slice(0, 200)}` : evt.output.slice(0, 160),
                endedAt: Date.now()
              }
              subagentRows.set(evt.agentId, ended)
              upsertRow(ended)
            }
            streamSession.push(
              ws,
              JSON.stringify({
                type: 'subagent_done',
                ...base,
                output: evt.output,
                error: evt.error,
                timedOut: evt.timedOut
              })
            )
            break
          }
        }
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

      const totalTokens = estimateMessagesTokens(injectedMessages)
      deps.lastInjectedEstimateRef.current = totalTokens
      if (streamSession.isOpen(ws)) {
        streamSession.push(
          ws,
          JSON.stringify({
            type: 'token',
            messageId,
            tokens: totalTokens,
            budget: cfg.tokenBudget ?? null,
            dropped: droppedCount
          })
        )
      }

      if (cfg.tokenBudget && cfg.tokenBudget > 0) {
        const remaining = Math.max(0, cfg.tokenBudget - totalTokens)
        const usagePercent = Math.round((totalTokens / cfg.tokenBudget) * 100)
        // 预算≠任务——平时不注入预算消息，只在使用率达到 BUDGET_WARN_PERCENT 时给信息性提醒。
        // AI 需要时用 context_usage 自查。
        if (usagePercent >= BUDGET_WARN_PERCENT) {
          injectedMessages.push({
            id: `budget_${Date.now()}`,
            role: 'system',
            content: `【上下文预算警告】已用 ${totalTokens}/${cfg.tokenBudget} tokens（${usagePercent}%），剩余 ${remaining}。如需继续当前任务，请提醒用户开新会话。`,
            createdAt: Date.now()
          })
        }
      } else {
        // tokenBudget 未配置：用软预算兜底提示（防止 AI 对上下文用量完全无感）
        const usagePercent = Math.round((totalTokens / resolveSoftBudget()) * 100)
        if (usagePercent >= SOFT_BUDGET_HINT_PERCENT) {
          const remaining = Math.max(0, resolveSoftBudget() - totalTokens)
          const hint =
            usagePercent >= BUDGET_WARN_PERCENT
              ? `【上下文预算警告（软预算）】当前对话约 ${totalTokens} tokens，软预算 ${resolveSoftBudget()}（${usagePercent}%），剩余 ${remaining}。请提醒用户开新会话。`
              : `【上下文用量】当前对话约 ${totalTokens} tokens（软预算 ${resolveSoftBudget()} 的 ${usagePercent}%）。长任务注意用 context_usage 工具自查用量。`
          injectedMessages.push({
            id: `budget_${Date.now()}`,
            role: 'system',
            content: hint,
            createdAt: Date.now()
          })
        }
      }

      // 流式缓冲：批量推送，防止 UI 渲染跟不上
      const BUFFER_INTERVAL_MS = 33
      const BUFFER_MAX_CHARS = 64
      let tokenBuffer = ''
      let bufferTimer: NodeJS.Timeout | null = null
      let bufferClosed = false
      // 行协议 delta 缓冲：row.delta 逐 token 推送会绕过 tokenBuffer 缓冲
      // 高频 set(currentMessages 新数组) 触发前端订阅组件同步重渲染 → 嵌套更新爆栈
      // "Maximum update depth exceeded"（与 TodoPanel set 风暴同类机制）。
      // 这里按 33ms 合并同一行 append 批量推，把前端 set 频率压到 ~30/s。
      const rowDeltaBuffer = new Map<number, { rowId: number; path: string[]; append: string }>()
      let rowDeltaTimer: NodeJS.Timeout | null = null
      const flushRowDeltas = () => {
        rowDeltaTimer = null
        if (bufferClosed || rowDeltaBuffer.size === 0) return
        for (const d of rowDeltaBuffer.values()) {
          if (d.append && streamSession.isOpen(ws)) {
            streamSession.push(
              ws,
              JSON.stringify({ type: 'row_op', messageId, rowOp: { op: 'row.delta', rowId: d.rowId, path: d.path, append: d.append } })
            )
          }
        }
        rowDeltaBuffer.clear()
      }
      const scheduleRowDeltaFlush = () => {
        if (rowDeltaTimer || bufferClosed) return
        rowDeltaTimer = setTimeout(flushRowDeltas, BUFFER_INTERVAL_MS)
      }
      let firstTokenFlushed = false
      let reasoningBuffer = ''
      let reasoningTimer: NodeJS.Timeout | null = null
      let firstReasoningFlushed = false
      let fullOutput = prevOutput
      // 累积 reasoning（深度思考）全文，续接时带上让模型恢复思考上下文
      let fullReasoning = ''
      // 编码模式输出纪律：本轮工具失败收集（onToolEnd 填充，onDone 校验真实性）
      const toolFailures: Array<{ toolName: string; error: string }> = []
      // ===== 行协议（Row Protocol）：本轮行流状态 =====
      // 硬格式：与旧 token/reasoning/tool_* 事件并行推送 row_op 流（row.appended/delta/upserted）
      // 前端优先按行渲染；旧事件保留作兼容兜底（重试/未升级前端）。
      // rowId 会话内全局递增（deps.rowIdRef.current，模块级）——重试时局部计数器会重置
      // 新行 id 与旧行冲突，前端按 rowId 去重会丢弃重试行。
      const nextRow = () => ++deps.rowIdRef.current
      const turnStartedAt = Date.now()
      const turnId = `turn_${turnStartedAt}_${Math.random().toString(36).slice(2, 6)}`
      let textRow: AssistantTextRow | null = null
      let reasoningRow: ReasoningRow | null = null
      const toolRows = new Map<string, ToolCallRow>() // toolCallId → 行（upsert 用）
      /** 本轮全部行（持久化到 ChatMessage.rows 用；upsert 按 rowId 替换，保持终态） */
      const turnRows = new Map<number, ConversationRow>()
      // finalRows 提升到本作用域（onDone 顶层）：供 finalAiMsg（本轮落盘）与代码审查 agent 两处复用。
      // 原定义在下方 if(sessionId) 块内，审查 setTimeout 在兄弟块访问不到（TS2304）。
      let finalRows: ConversationRow[] = []
      let turnHeaderRowId: number | null = null

      const sendRowOp = (op: RowOp) => {
        if (streamSession.isOpen(ws)) {
          streamSession.push(ws, JSON.stringify({ type: 'row_op', messageId, rowOp: op }))
        }
      }
      const appendRow = (row: ConversationRow) => {
        turnRows.set(row.rowId, row)
        sendRowOp({ op: 'row.appended', row })
        return row.rowId
      }
      const upsertRow = (row: ConversationRow) => {
        turnRows.set(row.rowId, row)
        sendRowOp({ op: 'row.upserted', row })
      }
      const deltaRow = (rowId: number, path: string[], append: string) => {
        if (!append) return
        // 同步更新本地行（持久化终态完整），delta 累积进缓冲批量推前端（防逐 token set 风暴）
        const local = turnRows.get(rowId)
        if (
          local &&
          path.length === 1 &&
          path[0] === 'text' &&
          (local.kind === 'assistantText' || local.kind === 'reasoning')
        ) {
          const updated = { ...local, text: local.text + append }
          turnRows.set(rowId, updated)
          if (textRow && textRow.rowId === rowId) textRow = updated as AssistantTextRow
          if (reasoningRow && reasoningRow.rowId === rowId) reasoningRow = updated as ReasoningRow
        }
        // 同一行多次 delta 合并 append（流式输出天然高频，33ms 窗口内合并成一次推送）
        const existing = rowDeltaBuffer.get(rowId)
        if (existing) {
          existing.append += append
        } else {
          rowDeltaBuffer.set(rowId, { rowId, path, append })
        }
        scheduleRowDeltaFlush()
      }

      // 轮次头 + 用户输入行（仅首次流输出，重试不重复）
      if (retryCount === 0 && ws.readyState === WebSocket.OPEN) {
        turnHeaderRowId = appendRow({
          kind: 'turnHeader',
          rowId: nextRow(),
          turnId,
          createdAt: turnStartedAt,
          createdAtSeq: deps.rowIdRef.current,
          origin: 'userInput',
          state: 'running',
          startedAt: turnStartedAt
        })
        // 行协议：模型切换时间线标记（该会话上次模型 ≠ 本次模型时可见）
        if (sessionId) {
          const prevModel = lastModelBySession.get(sessionId)
          if (model && prevModel && prevModel !== model) {
            appendRow({
              kind: 'timelineMarker',
              rowId: nextRow(),
              turnId,
              createdAt: Date.now(),
              createdAtSeq: deps.rowIdRef.current,
              marker: { type: 'modelChange', fromModel: prevModel, toModel: model }
            } satisfies TimelineMarkerRow)
          }
          if (model) setLastModel(sessionId, model)
        }
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        if (lastUser?.content) {
          appendRow({
            kind: 'userInput',
            rowId: nextRow(),
            turnId,
            createdAt: turnStartedAt,
            createdAtSeq: deps.rowIdRef.current,
            text: lastUser.content,
            origin: 'realUser'
          })
        }
      }

      const flushBuffer = () => {
        bufferTimer = null
        if (bufferClosed) return
        if (tokenBuffer && streamSession.isOpen(ws)) {
          streamSession.push(ws, JSON.stringify({ type: 'token', payload: tokenBuffer, messageId }))
        }
        tokenBuffer = ''
      }

      const flushReasoning = () => {
        reasoningTimer = null
        if (bufferClosed) return
        if (reasoningBuffer && streamSession.isOpen(ws)) {
          streamSession.push(
            ws,
            JSON.stringify({ type: 'reasoning', reasoning: reasoningBuffer, messageId })
          )
        }
        reasoningBuffer = ''
      }

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
            reasoningBuffer += token
            fullReasoning += token
            streamSession.appendReasoning(messageId, token)
            // 行协议：首个 reasoning token 建行（streaming），后续 delta 追加
            if (reasoningRow === null) {
              reasoningRow = {
                kind: 'reasoning',
                rowId: nextRow(),
                turnId,
                createdAt: Date.now(),
                createdAtSeq: deps.rowIdRef.current,
                text: token,
                state: 'streaming'
              }
              appendRow(reasoningRow)
            } else {
              reasoningRow = { ...reasoningRow, text: reasoningRow.text + token }
              deltaRow(reasoningRow.rowId, ['text'], token)
            }
            if (!firstReasoningFlushed) {
              firstReasoningFlushed = true
              if (reasoningTimer) {
                clearTimeout(reasoningTimer)
                reasoningTimer = null
              }
              flushReasoning()
              return
            }
            if (reasoningBuffer.length >= BUFFER_MAX_CHARS) {
              if (reasoningTimer) {
                clearTimeout(reasoningTimer)
                reasoningTimer = null
              }
              flushReasoning()
            } else if (!reasoningTimer) {
              reasoningTimer = setTimeout(flushReasoning, BUFFER_INTERVAL_MS)
            }
          },
          onToken: (token) => {
            if (bufferClosed) return
            tokenBuffer += token
            fullOutput += token
            streamSession.appendOutput(messageId, token)
            // 行协议：首个正文 token 建行（streaming），后续 delta 追加
            if (textRow === null) {
              textRow = {
                kind: 'assistantText',
                rowId: nextRow(),
                turnId,
                createdAt: Date.now(),
                createdAtSeq: deps.rowIdRef.current,
                text: token,
                state: 'streaming'
              }
              appendRow(textRow)
            } else {
              textRow = { ...textRow, text: textRow.text + token }
              deltaRow(textRow.rowId, ['text'], token)
            }
            if (!firstTokenFlushed) {
              firstTokenFlushed = true
              if (bufferTimer) {
                clearTimeout(bufferTimer)
                bufferTimer = null
              }
              flushBuffer()
              return
            }
            if (tokenBuffer.length >= BUFFER_MAX_CHARS) {
              if (bufferTimer) {
                clearTimeout(bufferTimer)
                bufferTimer = null
              }
              flushBuffer()
            } else if (!bufferTimer) {
              bufferTimer = setTimeout(flushBuffer, BUFFER_INTERVAL_MS)
            }
          },
          // 工具结果蒸馏回调：llm.ts 在每个工具轮执行完、下一轮请求构建前批量蒸馏：
          // - distillToolResult 用 LLM 提炼有用信息（大体积结果）
          // - 蒸馏成功 → 摘要重包护栏替换 conversation 中 tool 消息 content
          // - 失败重试一次，仍失败保留原文进上下文（不截断不落盘）
          ...makeDistillCallbacks(),
          onDone: async () => {
            // 兜底 flush 最后一批 row delta，避免 33ms 窗口内的增量在流结束时被丢弃
            flushRowDeltas()
            bufferClosed = true
            if (bufferTimer) {
              clearTimeout(bufferTimer)
              bufferTimer = null
            }
            if (reasoningTimer) {
              clearTimeout(reasoningTimer)
              reasoningTimer = null
            }
            // 会话模式硬约束：照抄 MOD 五件套完整链路（envelope 解析 → 语言检测 → 重试 → fallback → 规范化）
            // 放在所有下游处理（parseAIOutput/落盘/done 推送）之前，保证最终内容已强制净化
            // enforceChatOutput 返回完整 {text, emotion, animation}——emotion/animation 通过 done 消息传给前端
            let chatEmotion: string | undefined
            let chatAnimation: string | undefined
            if (cfg.aiMode === 'chat' && fullOutput) {
              const retryMessages = injectedMessages.map((m) => ({
                role: m.role,
                content: m.content ?? ''
              })) as ApiMessage[]
              const chatResult = await enforceChatOutput(deps.llmClientRef.current, fullOutput, retryMessages, model)
              fullOutput = chatResult.text
              chatEmotion = chatResult.emotion
              chatAnimation = chatResult.animation
            } else if (cfg.aiMode !== 'chat' && fullOutput) {
              // 编码模式输出纪律：工具失败真实性校验（不编造结果原则）
              // 本轮有工具失败 → 检查 AI 是否在输出中如实提及失败；若输出声称"全部完成/成功"
              // 却隐瞒了失败，追加失败标注，防止 AI 粉饰结果。
              if (toolFailures.length > 0) {
                const failureSummary = toolFailures
                  .map((f) => `- ${f.toolName}: ${f.error.slice(0, 120)}`)
                  .join('\n')
                const claimedDone =
                  /(全部完成|已完成|都成功|全部成功|搞定|顺利完成|成功完成|处理完毕)/.test(
                    fullOutput
                  )
                const mentionedFailure = toolFailures.every((f) => fullOutput.includes(f.toolName))
                let annotation = ''
                if (claimedDone && !mentionedFailure) {
                  console.warn(
                    '[server] 编码模式输出纪律：AI 声称完成但存在未提及的工具失败，追加标注'
                  )
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
            if (tokenBuffer && streamSession.isOpen(ws)) {
              streamSession.push(
                ws,
                JSON.stringify({ type: 'token', payload: tokenBuffer, messageId })
              )
              tokenBuffer = ''
            }
            if (reasoningBuffer && streamSession.isOpen(ws)) {
              streamSession.push(
                ws,
                JSON.stringify({ type: 'reasoning', reasoning: reasoningBuffer, messageId })
              )
              reasoningBuffer = ''
            }
            // stream 正常完成，清除活跃标志，允许后续自主激活
            activationManager.setStreamActive(false)

            // 流结束处理顺序：
            // 1. ActivationManager.parseAIOutput（解析原始输出）
            // 2. [TASK_COMPLETE] 检测（原始输出）
            // 3. writeRawMemoryForStream（完整版本）
            // 4. 持久化 ChatMessage（完整版本）
            if (fullOutput) {
              activationManager.parseAIOutput(fullOutput)
            }
            // 不再在对话结束后自动触发反思循环——用户明确要求：
            // 自主激活应由 AI 规划任务时通过 [TIMER:时长:任务] 指令按时间定时触发
            // 而不是每说完一句话就紧跟着自主激活。
            // parseAIOutput 已解析 [TIMER:...] 并注册定时器，到点才触发自主激活。
            // [TASK_COMPLETE] 检测：AI 显式声明任务完成，重置中断恢复计数
            // 避免上一轮中断恢复的计数残留影响下一轮
            // 检测原始输出
            if (fullOutput && fullOutput.includes('[TASK_COMPLETE]')) {
              activationManager.resetInterruptRecovery()
            }

            // ===== 奥卡姆根治②：跨轮输出复读检测（调度层，历史断链）=====
            // 持续激活场景：本轮输出与上一轮 AI 输出高度相似 → 复读轮。
            // 复读轮：不写 RAW、不落盘、不喂评论家、不续接——历史里不留复读文本
            // 自回归强化源头断裂（模型下一轮看不到自己上一轮的复读原话）。
            // 归一化后子串判定（与 llm.ts 跨轮检测同算法）：短者是长者的子串且占比 ≥80%。
            // 实测修正：复读主要发生在【思考流】（reasoning）而非正文
            // 系统注入样文本会被模型当指令复读、正文空转。检测必须同时覆盖
            // fullOutput（正文）与 fullReasoning（思考流），任一复读即判复读轮。
            // （首版只查正文 → 正文空时复读全漏，实测"没修好"的根因）
            let isRepeatTurn = false
            const normTurn = (s: string): string => s.replace(/\s+/g, '')
            const curText = normTurn(fullOutput || '')
            const curThink = normTurn(fullReasoning || '')
            // 上一轮 assistant 取尾部第一条——排除 partial_ 前缀的续接锚消息：
            // 为什么存在：续接轮（断线重试）的 messages 尾部必含 partial（content=续接前的
            // 全文），curText 是"续接前全文+续接新增"的完整版，天然 includes(partial.content)；
            // 若 partial 参与比较，新增占比 ≤20%（shorter/longer ≥ REPEAT_SIMILAR_RATIO 阈值）即误判跨轮复读，
            // 导致续接轮整轮结果不落盘、RAW/评论家全跳过——有效新增内容丢失（2026-09-27
            // 评审确认的 MAJOR）。partial 是"本轮续接上下文的一部分"，不是"上一轮输出"，
            // 参与复读比较在语义上就是错的。
            // 作用：排除 partial 后，比较对象回到真正的上一轮 assistant 消息（历史轮次），
            // curText 与真正的跨轮内容比较，续接轮不再误判。
            // 不删理由：续接是高频路径（网络抖动/超时），误判导致静默丢轮，破坏落盘完整性。
            const prevAiMsg = [...messages]
              .reverse()
              .find((m) => m.role === 'assistant' && !(typeof m.id === 'string' && m.id.startsWith('partial_')))
            const prevContent =
              typeof prevAiMsg?.content === 'string' ? normTurn(prevAiMsg.content) : ''
            const prevThink =
              typeof prevAiMsg?.reasoning === 'string' ? normTurn(prevAiMsg.reasoning) : ''
            const similar = (cur: string, prev: string): boolean => {
              if (cur.length < REPEAT_MIN_CHARS || prev.length < REPEAT_MIN_CHARS) return false
              const shorter = Math.min(cur.length, prev.length)
              const longer = Math.max(cur.length, prev.length)
              return (
                (cur.includes(prev) || prev.includes(cur)) &&
                longer > 0 &&
                shorter / longer >= REPEAT_SIMILAR_RATIO
              )
            }
            if (similar(curText, prevContent) || similar(curThink, prevThink)) {
              isRepeatTurn = true
              console.warn(
                `[server] 检测到跨轮复读（正文=${similar(curText, prevContent)} 思考=${similar(curThink, prevThink)}），跳过 RAW/落盘/评论家 — messageId=${messageId}`
              )
            }

            if (fullOutput && !isRepeatTurn) {
              writeRawMemoryForStream(false, fullOutput, activation, messages)
            }
            // 后端落盘完整消息（修复：会话中断根因）
            // 后端落盘完整消息：后端在 onDone 直接保存完整对话，
            // 前端切走/挂接显示都不影响落盘（防会话中断）。
            if (sessionId) {
              // 行协议：文本/思考行收尾为 complete（streaming → complete 状态迁移，前端停止光标）
              if (textRow) {
                const endedText: AssistantTextRow = { ...textRow, state: 'complete' }
                turnRows.set(endedText.rowId, endedText)
                upsertRow(endedText)
              }
              if (reasoningRow) {
                const endedReasoning: ReasoningRow = { ...reasoningRow, state: 'complete' }
                turnRows.set(endedReasoning.rowId, endedReasoning)
                upsertRow(endedReasoning)
              }
              // 行协议：turn 收尾——turnHeader upsert 为 completedSuccess（activeMs + fileChanges）
              if (turnHeaderRowId !== null) {
                const turnEndedAt = Date.now()
                const endedHeader: TurnHeaderRow = {
                  kind: 'turnHeader',
                  rowId: turnHeaderRowId,
                  turnId,
                  createdAt: turnStartedAt,
                  createdAtSeq: turnHeaderRowId,
                  origin: 'userInput',
                  state: 'completedSuccess',
                  startedAt: turnStartedAt,
                  endedAt: turnEndedAt,
                  activeMs: turnEndedAt - turnStartedAt,
                  // 文件变更近似统计：文件写入类工具成功数（Write/Edit/MoveFile/CopyFile/DeleteFile）
                  fileChanges: countFileToolChanges(toolRows)
                }
                upsertRow(endedHeader)
              }
              // 行流持久化：assistantText/reasoning 收尾为 complete（delta 已同步本地，这里补终态）
              finalRows = [...turnRows.values()]
                .sort((a, b) => a.rowId - b.rowId)
                .map((r) => {
                  if (r.kind === 'assistantText' && r.state === 'streaming')
                    return { ...r, state: 'complete' as const }
                  if (r.kind === 'reasoning' && r.state === 'streaming')
                    return { ...r, state: 'complete' as const }
                  return r
                })
              // 输出纪律机制（思考不进上下文）：正文落盘进会话历史前剥离显式思考块
              // （<thinking>/<reasoning>/<analysis> 标签与 thinking fence）。rows（UI 行流）
              // 已保留原文供展示，剥离只影响 LLM 上下文——与"UI 完整、上下文压缩"哲学一致
              // （微压缩层已删，输出纪律是当前唯一的"UI 完整、上下文剥离"机制）
              const strippedBody = stripThinkingLeak(fullOutput || '')
              if (strippedBody.stripped && !strippedBody.text) {
                console.error(`[server] 正文仅含思考块已整体剥离（messageId=${messageId}）`)
              }
              const finalAiMsg: ChatMessage = {
                id: messageId,
                role: 'assistant',
                content: strippedBody.text || '',
                createdAt: Date.now(),
                activation,
                ...(finalRows.length > 0 ? { rows: finalRows } : {}),
                // 保存 reasoning 到会话历史——之前 fullReasoning 只在重试续接时用
                // 正常完成时丢弃了。导致下一轮 LLM 上下文里完全没有上轮的思考内容
                // AI 看不到自己之前想过什么（"思考内容对AI屏蔽"的根因）。
                // 注意：这是 wire 协议层回传（DeepSeek 思考模式 reasoning_content 缺失即 400）
                // 与"思考不进上下文"的语义约束不冲突（语义注入已移除，协议字段必须保留）
                ...(fullReasoning ? { reasoning: fullReasoning } : {})
              }
              if (!isRepeatTurn) {
                // 落盘前剔除续接锚 partial_ 消息：续接成功后 finalAiMsg 已含完整正文+rows，
                // partial（无 rows 的残片全文）只用于续接请求的上下文锚定，使命已完成；
                // 若一并落盘，下一轮注入历史会出现同轮回复双份（partial 前缀版 + finalAiMsg
                // 完整版），既冗余 token 又会误导复读判定（prevAiMsg 将命中 partial 而非
                // finalAiMsg，见 2300 行同类排除）——2026-09-27 评审确认，与排除逻辑同源。
                sessionStore.saveMessages(sessionId, [
                  ...messages.filter((m) => !(typeof m.id === 'string' && m.id.startsWith('partial_'))),
                  finalAiMsg
                ])
              }

              // 内部会话：上下文层两写（延迟 500ms 异步——摘要+压缩轻量 LLM，不阻塞回复流）
              // 仅主回复轮写入：审查/修正轮（review_/rework_ 前缀）与 isRepeatTurn 不写内部会话、不触发摘要/压缩
              const idHead = messageId.split('_')[0]
              const isContextWriteTurn = !isRepeatTurn && idHead !== 'review' && idHead !== 'rework'
              if (sessionId && isContextWriteTurn && activeInternalContext?.sessionId === sessionId) {
                // 两写 user 侧消息 = 本轮真实用户输入，排除 activation 系统注入（与路由端 1716 同构）：
                // activation 消息是系统注入（审查提示词 phaseMsg / 健康检查激活等），被视为"用户发言"
                // 写进内部会话会污染会话内容与摘要语义——Q1 根因：审查轮 phaseMsg 是 user+activation，
                // 若出现在 messages 尾部会被 find 命中（如激活轮无 content、尾部恰为 phaseMsg），
                // 导致【代码审查】提示词全文进入内部会话与摘要。
                // 激活轮（activation=true）messages 尾部是系统激活消息而非真实用户输入，
                // 若走 find 会退回更早的历史 user 与"本轮激活回复"错配成对（Q2）——
                // 故复用 RAW 记忆链路（writeRawMemoryForStream 910 行）的【系统自激活】占位语义，
                // 保证"激活来源可见且与回复成对成立"，不冒充任何历史真实发言。
                // deps.activationContentRef.current 在本轮 onDone 尾段（stream-runner.ts 908 行）会被置 null，
                // 这里必须在入队前完成快照。
                const turnUserMsg: ChatMessage | undefined = activation
                  ? {
                      // 占位 id 加随机后缀：内部会话消息 id 用作撤回剔除的匹配键（removeMessagesByOwner），
                      // 仅用 Date.now() 在同毫秒两次激活时可能重号，导致撤回时两条占位一并被剔除；
                      // 随机后缀与 internal-session-store 自身 id 生成风格一致，保证全局唯一。
                      id: `sys_act_2write_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                      role: 'user',
                      content: `【系统自激活】${deps.activationContentRef.current ?? '系统触发自动续接'}`,
                      createdAt: Date.now()
                    }
                  : [...messages].reverse().find((m) => m.role === 'user' && !m.activation)
                const blockToolSummaries = finalRows
                  .filter((r): r is ToolCallRow => r.kind === 'toolCall')
                  .map((r) => {
                    const text = r.error?.message ?? r.output?.text ?? ''
                    const brief = text.replace(/\s+/g, ' ').slice(0, 160)
                    return brief ? `${r.toolName}: ${brief}` : r.toolName
})
                // K3：两写/摘要/继承走单飞队列（enqueueInternalSessionJob，见上方约 520 行）——
                // 原实现每轮独立 setTimeout(500) 并发执行，快速连发多轮时 append 与摘要/继承互相覆盖
                // （两个任务同时读到旧状态再先后写回，后者覆盖前者 patch）。
                // 入队即把本轮 user/assistant/工具摘要交给队列：500ms 末次合并 + 同会话串行链执行，
                // 每轮至多一次 append + 一次摘要 + 一次超限继承（0.17 起：原会话不动，新建子会话承接），
                // 快照之后追加的消息不会被并发覆盖。
                deps.enqueueInternalSessionJob(sessionId, activeInternalContext.internalId, {
                  userMsg: turnUserMsg,
                  aiMsg: finalAiMsg,
                  toolSummaries: blockToolSummaries
                })
              }
            }
            // 清除激活内容缓存（本轮已用完）
            deps.activationContentRef.current = null

            // 内部会话摘要/继承不走 onDone 同步链路：由上面的单飞队列任务维护（入队后
            // 500ms 末次合并 + 串行链执行一次 append + 一次摘要 + 一次超限继承，不阻塞回复流）
            // done 必须在此之后发送并带上 finalContent（流结束后的完整最终正文），
            // 前端在 done 处理时用 streamingMessageId 定位消息替换 content
            // （此时 streamingMessageId 尚未清空，时序安全）。
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
            broadcastStreamStatus()

            // 代码审查：主回复完成后触发"代表用户立场"的审查轮，输出渲染在用户侧（像用户在说话）。
            // 设计依据：审查者必须是独立 AI——有自己的审查提示词（独立身份避免「自己审自己」
            // 的立场偏置，审查视角与主回复视角分离才能暴露主 AI 的第一原理推导盲区），
            // 但不隔离上下文：吃内部会话上下文（看得见对话），流式输出。
            // 实现：审查轮（review/再审）经 runStream opts.systemOverride 注入独立审查提示词，
            // 与内部会话上下文合并（见 runStream 内 override 路径）；修正轮（rework）仍是主 AI 身份。
            // 交替直到 [REVIEW_PASS] 或达最大轮数强制结束。开关：continuousActivation（前端「代码审查」按钮）。
            // 本轮审查请求（user 消息，给审查者看；审查立场主要在独立提示词里）

            if (sessionId && configStore.get().continuousActivation === true && fullOutput.trim().length > 0) {
              const idParts = messageId.split('_')
              const isReview = idParts[0] === 'review'
              const isRework = idParts[0] === 'rework'
              const curRound = isReview || isRework ? (parseInt(idParts[1], 10) || 0) : 0

              // 审查链收集（报告通道）：主回复完成时以 sessionId 为键初始化，审查/修正轮按序追加；
              // 结束时（通过或强制结束）整链渲染为 HTML 报告并在月蚀浏览器打开（openCodeReviewReport）。
              const chainRole = isRework ? ('修正' as const) : isReview ? ('审查' as const) : ('产出' as const)
              // 审查链收集（报告通道）：主回复完成时以 sessionId 为键初始化，审查/修正轮按序追加；
              // 结束时（通过或强制结束）整链渲染为 HTML 报告并在月蚀浏览器打开（openCodeReviewReport）。
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
              } else if (curRound >= MAX_REVIEW_ROUNDS) {
                console.log(`[code-review] 已达最大审查轮数 ${MAX_REVIEW_ROUNDS}，强制结束`)
                void openCodeReviewReport(takeCodeReviewChain(sessionId), sessionId)
              } else {
                const nextRound = curRound + 1
                const nextPhase = isReview ? 'rework' : 'review'
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
                  { id: `prev_${messageId}`, role: 'assistant' as const, content: fullOutput.slice(0, 8000), createdAt: Date.now() }
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
                        streamSession.push(ws, JSON.stringify({ type: 'continuous_start', messageId: nextId, sessionId }))
                      }
                      streamSession.enqueue(() =>
                        runStream(
                          fullPhaseMessages,
                          true,
                          nextId,
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
                  } catch (err) {
                    console.error('[code-review] 触发失败:', err)
                  }
                }, 500)
              }
            }

          },
          onError: (err) => {
            // 兜底 flush 最后一批 row delta，错误收尾也不丢增量
            flushRowDeltas()
            bufferClosed = true
            if (bufferTimer) {
              clearTimeout(bufferTimer)
              bufferTimer = null
            }
            if (reasoningTimer) {
              clearTimeout(reasoningTimer)
              reasoningTimer = null
            }
            // 错误时仍刷新已生成内容，避免丢失
            if (tokenBuffer && streamSession.isOpen(ws)) {
              streamSession.push(
                ws,
                JSON.stringify({ type: 'token', payload: tokenBuffer, messageId })
              )
              tokenBuffer = ''
            }
            if (reasoningBuffer && streamSession.isOpen(ws)) {
              streamSession.push(
                ws,
                JSON.stringify({ type: 'reasoning', reasoning: reasoningBuffer, messageId })
              )
              reasoningBuffer = ''
            }

            // 错误分类与分支决策收在纯函数模块 stream-error-policy.ts（抽取理由：可测）。
            // 原先这串布尔常量 + if/else 链内联在此，与 flush/清定时器/推帧交织，零测试覆盖：
            // 分类口径改错只会表现为「该重试的不重试」「用户点了停止却触发中断恢复」「余额不足
            // 被当成瞬时网络错误静默重试 5 次后再由恢复机制排队 10 次」（2026-09-08 真实故障）。
            // 此处只做分派，判定口径与顺序一律不在本文件重写。
            const decision = decideStreamErrorAction({
              message: err.message,
              // Error 上挂 status 是 OpenAI SDK 的运行时事实，类型里没有（原代码同款断言）
              status: (err as { status?: unknown }).status,
              wsOpen: ws.readyState === WebSocket.OPEN,
              retryCount,
              maxRetries: MAX_STREAM_RETRIES
            })
            const facts = decision.facts

            if (decision.action === 'permanent-error') {
              // 直接把原因推给前端（error 事件在消息上渲染，用户立即看到可行动的提示）
              const payload = buildPermanentErrorPayload(err.message, facts.isBalanceError)
              if (streamSession.isOpen(ws)) {
                streamSession.push(
                  ws,
                  JSON.stringify({ type: 'error', payload, messageId })
                )
              }
              activationManager.setStreamActive(false)
              // 不触发中断恢复：永久性错误重试注定失败，恢复机制只会排进另一个注定失败的激活
              return
            }

            if (decision.action === 'user-abort') {
              // 用户主动中止，尊重决定，不恢复
              // 取消 onDone 已调度但尚未触发的代码审查（setTimeout 500ms 窗口），与 ws abort 分支一致
              if (deps.continuationTimerRef.current) {
                clearTimeout(deps.continuationTimerRef.current)
                deps.continuationTimerRef.current = null
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
                maxDelayMs: MAX_RETRY_DELAY_MS
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
                runStream(
                  continuedMessages,
                  activation,
                  messageId,
                  sessionId,
                  model,
                  retryCount + 1,
                  fullOutput,
                  // 重试沿用原请求的覆盖参数：审查轮重试保持独立审查提示词，普通流程保持 undefined
                  opts
                ).catch((streamErr) => {
                  activationManager.setStreamActive(false)
                  throw streamErr
                })
              }, retryDelay)
            } else if (decision.action === 'ws-closed-recovery') {
              // WebSocket 已关闭，无法继续重试
              // 不推 error——推 error 会让前端 status=idle → isFrontendIdle=true → 触发自主激活
              // 自主激活会开启新任务，丢失原任务上下文（用户明确反对这个行为）
              // 改触发中断恢复：下次 AI 被激活时通过 consumeEvents 注入续接提示
              console.warn(
                `[server] WebSocket 已断开，触发中断恢复：${err.message}（messageId=${messageId}）`
              )
              // 中断时也写入 raw_memory
              writeRawMemoryForStream(true, fullOutput, activation, messages, err.message)
              activationManager.setStreamActive(false)
              activationManager.requestInterruptRecovery(err.message, messageId, sessionId)
            } else {
              // 剩余唯一动作：retry-exhausted-recovery（WS 还开着但重试已达上限）——
              // 触发中断恢复而非无限重试。
              // 2026-10-02 起 MAX_STREAM_RETRIES=Infinity，WS 开着时恒走 retry 分支，此分支
              // 实际不可达；保留作为防御性兜底（若未来显式配置有限重试次数仍可正确收敛）。
              console.warn(
                `[server] 重试上限已达，触发中断恢复：${err.message}（messageId=${messageId}）`
              )
              // 中断时也写入 raw_memory
              writeRawMemoryForStream(true, fullOutput, activation, messages, err.message)
              activationManager.setStreamActive(false)
              // 通知前端当前 stream 结束（但不是 error，避免前端显示错误）
              if (streamSession.isOpen(ws)) {
                streamSession.push(
                  ws,
                  JSON.stringify({
                    type: 'interrupted',
                    messageId,
                    reason: err.message,
                    retryCount
                  })
                )
              }
              activationManager.requestInterruptRecovery(err.message, messageId, sessionId)
            }
          },
          onToolStart: (toolName, toolCallId, args) => {
            // 工具开始前，先同步刷新残留的 reasoning/token buffer
            // 修复 Bug：onToolStart 之前未刷新 buffer，残留 reasoning 文本会在工具执行期间
            // （33ms 定时器触发）才推给前端，造成"边思考边执行工具"的视觉错觉
            if (reasoningTimer) {
              clearTimeout(reasoningTimer)
              reasoningTimer = null
            }
            if (bufferTimer) {
              clearTimeout(bufferTimer)
              bufferTimer = null
            }
            flushReasoning()
            flushBuffer()
            // 思考/正文按段隔离：工具调用是天然分隔点——封口当前行，工具后的新思考/正文开新行。
            textRow = null
            reasoningRow = null
            // 行协议：工具调用建行（running）
            if (streamSession.isOpen(ws)) {
              const tcRow: ToolCallRow = {
                kind: 'toolCall',
                rowId: nextRow(),
                turnId,
                createdAt: Date.now(),
                createdAtSeq: deps.rowIdRef.current,
                toolCallId,
                toolName,
                status: 'running',
                inputText: JSON.stringify(args ?? {}),
                input: args,
                startedAt: Date.now()
              }
              toolRows.set(toolCallId, tcRow)
              appendRow(tcRow)
            }
            if (streamSession.isOpen(ws)) {
              // 附带当前任务清单快照（payload.todos 驱动计划气泡实时更新）
              streamSession.push(
                ws,
                JSON.stringify({
                  type: 'tool_start',
                  messageId,
                  toolName,
                  toolCallId,
                  toolArgs: JSON.stringify(args),
                  todos: getTodos()
                })
              )
            }
          },
          onToolEnd: (toolName, toolCallId, result) => {
            // 收集工具失败（编码模式输出纪律用：onDone 时校验 AI 是否如实报告失败）
            try {
              const parsed = JSON.parse(result) as { ok?: boolean; error?: string }
              if (parsed?.ok === false || parsed?.error) {
                toolFailures.push({
                  toolName,
                  error: parsed.error ?? '未知错误'
                })
              }
            } catch {
              // 结果非 JSON（如纯文本输出）不算失败
            }
            // 行协议：工具调用收尾（success/error）
            const tcRow = toolRows.get(toolCallId)
            if (tcRow) {
              let status: ToolCallRow['status'] = 'success'
              let error: { code: string; message: string } | undefined
              try {
                const parsed = JSON.parse(result) as { ok?: boolean; error?: string }
                if (parsed?.ok === false || parsed?.error) {
                  status = 'error'
                  error = { code: 'tool_error', message: parsed.error ?? '未知错误' }
                }
              } catch {
                // 非 JSON 结果视为成功输出
              }
              // 持久化裁剪：output.text 全量落盘会让 session 文件膨胀到几十 MB
              // （阈值常量见模块头部 OUTPUT_TEXT_MAX/HEAD/TAIL，8KB 存档足够）。
              let outputText = result
              const outputTruncated = result.length > OUTPUT_TEXT_MAX
              if (outputTruncated) {
                outputText =
                  result.slice(0, OUTPUT_TEXT_HEAD) +
                  `\n\n... [已截断：完整结果 ${result.length} 字符，仅保留头尾] ...\n\n` +
                  result.slice(result.length - OUTPUT_TEXT_TAIL)
              }
              const endedRow: ToolCallRow = {
                ...tcRow,
                status,
                ...(error ? { error } : {}),
                output: { text: outputText, truncated: outputTruncated },
                endedAt: Date.now()
              }
              toolRows.set(toolCallId, endedRow)
              upsertRow(endedRow)
            }
            if (streamSession.isOpen(ws)) {
              // 不截断工具结果——用户要看完整结果，截断会让用户以为模型只读到一半
              const summary = buildToolCallSummary(toolName, result)
              streamSession.push(
                ws,
                JSON.stringify({
                  type: 'tool_end',
                  messageId,
                  toolName,
                  toolCallId,
                  toolResult: result,
                  toolSummary: JSON.stringify(summary),
                  // 任务清单快照（tool.complete payload.todos 驱动计划气泡）
                  todos: getTodos()
                })
              )
            }
          }
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
