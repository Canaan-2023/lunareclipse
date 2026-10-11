/**
 * 为什么存在：WS/DMN 事件处理逻辑（消息规范化/会话更新/工具行构造等）与
 * slice 状态更新解耦成纯函数，便于独立复用与测试，同时避免 store 文件臃肿。
 * @category 前端状态
 * @summary appStore 的 WebSocket / DMN 事件消息处理器（从 appStore.ts 抽出，纯函数）
 */
import type {
  ChatMessage,
  RowOp,
  ToolCall,
  ToolCallSummary,
  SubAgentInfo
} from '@shared/types'
import { TOOL_MAP } from '@shared/tools/registry'
import type { AppState } from './appStore-types'

/** 用户中止时间戳（abort 后拦截窗口内到达的 continuous_start；由 store 写入、处理器读取） */
export const wsState = { lastUserAbortTs: 0 }

/** 用户中止后拦截 continuous_start 的时间窗口 */
const ABORT_INTERCEPT_WINDOW_MS = 5000
/** 上下文占用告警阈值 */
const CONTEXT_WARN_RATIO = 0.8
/** 上下文占用严重阈值 */
const CONTEXT_CRITICAL_RATIO = 0.95
/** DMN 日志最多保留条数 */
const DMN_LOG_MAX = 100

/**
 * 安全保存消息：包装 saveMessages 并捕获 reject，避免 unhandled rejection。
 * 用于不需要 await 的 fire-and-forget 场景。
 */
export function safeSave(id: string, messages: unknown): void {
  window.lunareclipse.saveMessages(id, messages).catch((e) =>
    console.error('[saveMessages] failed:', e)
  )
}

export type SetState = (
  partial: Partial<AppState> | ((s: AppState) => Partial<AppState>)
) => void

export function handleWSMessage(
  msg: {
    type: string
    payload?: string
    messageId?: string
    tokens?: number
    budget?: number | null
    dropped?: number
    toolName?: string
    toolCallId?: string
    toolArgs?: string
    toolResult?: string
    toolError?: string
    toolSummary?: string
    reasoning?: string
    /** done 消息携带流结束后的完整最终正文（前端用其替换流式期间拼的 content） */
    finalContent?: string
    /** 激活/续接消息携带的待注入内容（activation:trigger / continuous_start） */
    content?: string
    /** 主进程主导续接：continuous_start 携带归属会话 ID（切走会话时前端据此忽略） */
    sessionId?: string
    /** 子 agent 事件字段（subagent_* 时有效） */
    agentId?: string
    parentToolCallId?: string
    prompt?: string
    mode?: 'serial' | 'parallel'
    index?: number
    total?: number
    output?: string
    error?: string
    /** 行协议：row_op 消息携带的行操作（前端按行渲染，旧事件兜底） */
    rowOp?: RowOp
    active?: boolean
    startedAt?: number
    /** 本轮真实 token 用量（type=done 时有效） */
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }
  },
  set: SetState,
  get: () => AppState
) {
  // 代码审查讨论：后端 onDone 检测到 continuousActivation 开启时推送 continuous_start，
  // 审查发言↔执行者交替对话直到 [REVIEW_PASS]。前端只"挂接显示"。
  // 必须在 streamingMessageId 检查前处理（此时上一轮已 done，streamingMessageId 已清空）
  // 主进程主导——后端已直接调度下一轮流，前端只"挂接显示"：
  //   用户当前就在该会话 → 追加空 assistant 消息并挂接流（streamingMessageId=msg.messageId）
  //   用户切走了（sessionId 不匹配）→ 忽略（后端落盘兜底，切回时 getSession 拉全量）
  if (msg.type === 'continuous_start') {
      const { currentSessionId, currentMessages } = get()
      // 用户中止后拦截窗口内到达的 continuous_start 一律忽略：
      // 后端 onDone 调度的 setTimeout(300ms) 可能在用户 abort 前已入队，
      // 后端 abort handler 虽 clearTimeout，但若 abort 消息晚于 setTimeout 触发到达，
      // continuous_start 已推送到前端 WS 缓冲区——前端必须自行拦截。
      if (wsState.lastUserAbortTs && Date.now() - wsState.lastUserAbortTs < ABORT_INTERCEPT_WINDOW_MS) {
        return
      }
      // 去重：后端持续激活每轮 onDone 后 300ms 推一次 continuous_start。
      // 若当前已在 streaming（streamingMessageId 非空），说明已有流在跑，新的 continuous_start
      // 是异常并发推送——忽略，避免同帧多次 set 触发 React "Maximum update depth exceeded"。
      // 正常时序下上一轮 done 已清空 streamingMessageId（status:'idle'），不会误拦新一轮。
      if (get().streamingMessageId) {
        return
      }
        // 代码审查讨论：不再插入「系统触发代码审查」系统提示——审查发言代表用户，
        // 其本身会以用户侧消息呈现，对话流保持自然的两人对话，不暴露系统文案。
        const baseMessages = currentMessages
        // 顺手刷新任务清单（下次续接显示最新状态）
        void get().refreshTodos()

        const aiMsg: ChatMessage = {
          id: msg.messageId!,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          activation: true
        }
        const next = [...baseMessages, aiMsg]
        set({
          currentMessages: next,
          streamingMessageId: msg.messageId,
          status: 'streaming',
          errorMessage: null
        })
        if (currentSessionId) {
          safeSave(currentSessionId, next)
        }
    return
  }

  // 工具调用状态消息：即使 streamingMessageId 为空也需处理（但当前设计下工具调用只在 stream 中发生）
  if (msg.type === 'tool_start') {
    if (!msg.toolCallId || !msg.toolName) return
    // 用户打断/切走场景：旧 stream 的延迟消息应忽略（messageId 不匹配当前流即丢弃，
    // streamingMessageId 为空时也不处理——切走后旧流工具消息不产生幽灵 toolCall）
    const { streamingMessageId, currentSessionId } = get()
    if (msg.messageId && msg.messageId !== streamingMessageId) return

    // 解析工具参数
    let args: Record<string, unknown> = {}
    if (msg.toolArgs) {
      try { args = JSON.parse(msg.toolArgs) } catch (e) { console.warn('[appStore] tool_start toolArgs 解析失败:', e) }
    }
    // 查工具元数据拿中文标签+分类
    const meta = TOOL_MAP[msg.toolName]
    const toolCall: ToolCall = {
      id: msg.toolCallId,
      toolName: msg.toolName,
      toolLabel: meta?.name ?? msg.toolName,
      category: meta?.category ?? 'mechanism',
      args,
      status: 'running',
      startedAt: Date.now()
    }

    set((s) => ({
      activeToolCalls: [
        ...s.activeToolCalls,
        {
          toolCallId: msg.toolCallId!,
          toolName: msg.toolName!,
          startedAt: Date.now()
        }
      ],
      currentMessages: s.currentMessages.map((m) =>
        m.id === streamingMessageId
          ? { ...m, toolCalls: [...(m.toolCalls ?? []), toolCall] }
          : m
      )
    }))
    // 立即持久化：工具调用开始即落盘，崩溃后可恢复
    if (currentSessionId) {
      safeSave(currentSessionId, get().currentMessages)
    }
    return
  }
  if (msg.type === 'tool_end') {
    if (!msg.toolCallId) return
    const { streamingMessageId, currentSessionId } = get()
    // 切走/打断场景：旧流工具结束消息不匹配当前流即忽略
    if (msg.messageId && msg.messageId !== streamingMessageId) return

    // 解析摘要
    let summary: ToolCallSummary | undefined
    if (msg.toolSummary) {
      try { summary = JSON.parse(msg.toolSummary) } catch (e) { console.warn('[appStore] tool_end toolSummary 解析失败:', e) }
    }
    // 解析完整结果判断 ok/error，并提取 data（TodoListCard 等组件依赖 result.data）
    let isOk = true
    let errorMsg: string | undefined
    let resultData: unknown
    if (msg.toolResult) {
      try {
        const r = JSON.parse(msg.toolResult) as { ok?: boolean; data?: unknown; error?: string }
        if (r.ok === false) { isOk = false; errorMsg = r.error }
        else if (!r.ok && r.error) { isOk = false; errorMsg = r.error }
        resultData = r.data
      } catch (e) { console.warn('[appStore] tool_end toolResult 解析失败:', e) }
    }

    set((s) => ({
      activeToolCalls: s.activeToolCalls.filter(
        (c) => c.toolCallId !== msg.toolCallId
      ),
      currentMessages: s.currentMessages.map((m) => {
        if (m.id !== streamingMessageId || !m.toolCalls) return m
        // 找不到对应 toolCallId：忽略并 log warning（不创建孤立条目）
        const idx = m.toolCalls.findIndex((tc) => tc.id === msg.toolCallId)
        if (idx === -1) {
          console.warn('[appStore] tool_end 未找到对应 toolCallId:', msg.toolCallId)
          return m
        }
        const updated = [...m.toolCalls]
        updated[idx] = {
          ...updated[idx],
          status: isOk ? 'done' : 'error',
          endedAt: Date.now(),
          result: {
            ok: isOk,
            data: resultData,
            error: errorMsg,
            summary: summary ?? { primary: msg.toolName ?? updated[idx].toolName }
          }
        }
        return { ...m, toolCalls: updated }
      })
    }))
    // 立即持久化
    if (currentSessionId) {
      safeSave(currentSessionId, get().currentMessages)
    }
    // AI 工具调用完成后主动刷新任务清单（替代 TodoPanel 高频轮询）
    void get().refreshTodos()
    return
  }

  // ===== 子 agent 过程事件 =====
  // subagent_start/tool_start/tool_end/done：挂到主对话 Agent 工具卡（按 parentToolCallId 定位，
  // 找不到则挂到最近一个 running 的 Agent 卡兜底）。子 agent 内部工具调用复用 ToolCall 结构。
  if (
    msg.type === 'subagent_start' || msg.type === 'subagent_tool_start' ||
    msg.type === 'subagent_tool_end' || msg.type === 'subagent_done'
  ) {
    if (!msg.agentId) return
    const { streamingMessageId: smId, currentSessionId: csId } = get()
    // 用户打断场景：旧 stream 的延迟消息应忽略
    if (msg.messageId && smId && msg.messageId !== smId) return
    if (!smId) return

    set((s) => ({
      currentMessages: s.currentMessages.map((m) => {
        if (m.id !== smId || !m.toolCalls) return m
        // 定位目标 Agent 工具卡：优先 parentToolCallId 精确匹配，兜底最近一个 running 的 Agent 卡
        let targetIdx = m.toolCalls.findIndex((tc) => tc.id === msg.parentToolCallId)
        if (targetIdx === -1) {
          for (let i = m.toolCalls.length - 1; i >= 0; i--) {
            const tc = m.toolCalls[i]
            if (tc.toolName === 'Agent' && tc.status === 'running') { targetIdx = i; break }
          }
        }
        if (targetIdx === -1) return m
        const target = m.toolCalls[targetIdx]
        const subAgents = target.subAgents ?? []
        const saIdx = subAgents.findIndex((sa) => sa.agentId === msg.agentId)

        // 更新指定子 agent 的辅助函数（保持不可变性）
        const updateSa = (sa: SubAgentInfo): ToolCall => ({
          ...target,
          subAgents: subAgents.map((x, i) => (i === saIdx ? sa : x))
        })

        if (msg.type === 'subagent_start') {
          if (saIdx !== -1) return m // 重复 start，忽略
          const sa: SubAgentInfo = {
            agentId: msg.agentId!, // 开头已校验非空（闭包内 TS 控制流失效，非空断言）
            prompt: msg.prompt ?? '',
            mode: msg.mode === 'parallel' ? 'parallel' : 'serial',
            index: msg.index ?? 0,
            total: msg.total ?? 1,
            status: 'running',
            startedAt: Date.now()
          }
          return { ...m, toolCalls: m.toolCalls!.map((tc, i) => (i === targetIdx ? { ...tc, subAgents: [...subAgents, sa] } : tc)) }
        }
        if (saIdx === -1) return m // 其余事件需要 subagent 已存在

        if (msg.type === 'subagent_tool_start') {
          if (!msg.toolName || !msg.toolCallId) return m
          let args: Record<string, unknown> = {}
          if (msg.toolArgs) { try { args = JSON.parse(msg.toolArgs) } catch (e) { console.warn('[appStore] subagent_tool_start toolArgs 解析失败:', e) } }
          const meta = TOOL_MAP[msg.toolName]
          const innerCall: ToolCall = {
            id: msg.toolCallId,
            toolName: msg.toolName,
            toolLabel: meta?.name ?? msg.toolName,
            category: meta?.category ?? 'mechanism',
            args,
            status: 'running',
            startedAt: Date.now()
          }
          const sa = subAgents[saIdx]
          return { ...m, toolCalls: m.toolCalls!.map((tc, i) => (i === targetIdx ? updateSa({ ...sa, toolCalls: [...(sa.toolCalls ?? []), innerCall] }) : tc)) }
        }

        if (msg.type === 'subagent_tool_end') {
          if (!msg.toolCallId) return m
          const sa = subAgents[saIdx]
          const calls = sa.toolCalls ?? []
          const idx = calls.findIndex((c) => c.id === msg.toolCallId)
          if (idx === -1) return m
          let isOk = true
          let errorMsg: string | undefined
          if (msg.toolResult) {
            try {
              const r = JSON.parse(msg.toolResult) as { ok?: boolean; error?: string }
              if (r.ok === false || (!r.ok && r.error)) { isOk = false; errorMsg = r.error }
            } catch (e) { console.warn('[appStore] subagent_tool_end toolResult 解析失败:', e) }
          }
          const updated = [...calls]
          updated[idx] = {
            ...updated[idx],
            status: isOk ? 'done' : 'error',
            endedAt: Date.now(),
            result: {
              ok: isOk,
              error: errorMsg,
              summary: { primary: msg.toolName ?? updated[idx].toolName }
            }
          }
          return { ...m, toolCalls: m.toolCalls!.map((tc, i) => (i === targetIdx ? updateSa({ ...sa, toolCalls: updated }) : tc)) }
        }

        // subagent_done
        const sa = subAgents[saIdx]
        const done: SubAgentInfo = {
          ...sa,
          status: msg.error ? 'error' : 'done',
          output: msg.output,
          error: msg.error,
          endedAt: Date.now()
        }
        return { ...m, toolCalls: m.toolCalls!.map((tc, i) => (i === targetIdx ? updateSa(done) : tc)) }
      })
    }))
    // 立即持久化（崩溃后可恢复）
    if (csId) {
      safeSave(csId, get().currentMessages)
    }
    return
  }

  // ===== 行协议：row_op 行流 =====
  // 主进程并行推送 row.appended/upserted/delta/removed，前端按 rowId 维护消息.rows。
  // 与旧 token/reasoning/tool_* 事件并行（旧事件仍驱动 toolCalls 等兼容字段），
  // rows 是渲染主源，旧字段兜底。
  if (msg.type === 'row_op' && msg.rowOp) {
    const { streamingMessageId: rowSmId, currentSessionId: rowCsId } = get()
    // 行流绑定 streamingMessageId（与 token/tool_* 同一守卫：旧流延迟消息忽略）
    if (msg.messageId && rowSmId && msg.messageId !== rowSmId) return
    if (!rowSmId) return
    const op = msg.rowOp

    set((s) => ({
      currentMessages: s.currentMessages.map((m) => {
        if (m.id !== rowSmId) return m
        const existing = m.rows ?? []
        switch (op.op) {
          case 'row.appended': {
            // 按 rowId 去重（重试/续接时可能重复 appended 同一行）
            if (existing.some((r) => r.rowId === op.row.rowId)) return m
            const rows = [...existing, op.row].sort((a, b) => a.rowId - b.rowId)
            return { ...m, rows }
          }
          case 'row.upserted': {
            const idx = existing.findIndex((r) => r.rowId === op.row.rowId)
            const rows = idx === -1
              ? [...existing, op.row].sort((a, b) => a.rowId - b.rowId)
              : existing.map((r, i) => (i === idx ? op.row : r))
            return { ...m, rows }
          }
          case 'row.removed': {
            return { ...m, rows: existing.filter((r) => r.rowId !== op.fromRowId) }
          }
          case 'row.delta': {
            // path: ['text'] → 追加到文本行；其他 path 暂不支持（目前只有 text）
            if (op.path.length !== 1 || op.path[0] !== 'text') return m
            const rows = existing.map((r) => {
              if (r.rowId !== op.rowId) return r
              if (r.kind !== 'assistantText' && r.kind !== 'reasoning') return r
              // 防御：text 缺失时从空串开始追加（避免 'undefined' 污染）
              return { ...r, text: (r.text ?? '') + op.append }
            })
            return { ...m, rows }
          }
          default:
            return m
        }
      })
    }))
    // 持久化（崩溃后可恢复）：delta 不落盘（逐 token 高频，全量写 session 文件会堵事件循环；
    // 终态由后端 onDone 落盘完整 rows）。appended/upserted 低频才落盘。
    if (op.op !== 'row.delta' && rowCsId) {
      safeSave(rowCsId, get().currentMessages)
    }
    return
  }

  if (msg.type === 'takeover_ok') {
    // takeover success: push target switched, output/reasoning replayed.
    // Establish streamingMessageId (stream guard); if the AI message does not exist
    // on disk (reload happened before it was saved), append an empty assistant msg
    // so replayed token/reasoning has a target to attach to.
    if (!msg.messageId) return
    const { currentSessionId: tkCsId, currentMessages: tkMsgs } = get()
    const exists = tkMsgs.some((m) => m.id === msg.messageId)
    const nextMsgs = exists
      ? tkMsgs.map((m) => (m.id === msg.messageId ? { ...m, aborted: false, error: undefined, content: '', reasoning: '' } : m))
      : [...tkMsgs, { id: msg.messageId, role: 'assistant', content: '', createdAt: Date.now() } as ChatMessage]
    set({
      status: 'streaming',
      streamingMessageId: msg.messageId,
      currentMessages: nextMsgs
    })
    if (tkCsId) {
      safeSave(tkCsId, get().currentMessages)
    }
    return
  }

  if (msg.type === 'stream_status') {
    // backend broadcasts active-stream state on start/done/abort/close-timeout.
    // Front-end keeps monitoring backend continuously (not just one-time query on connect).
    set({
      activeStreamStatus: {
        active: !!msg.active,
        sessionId: msg.sessionId,
        messageId: msg.messageId,
        startedAt: msg.startedAt
      }
    })
    return
  }

  const { streamingMessageId, currentSessionId } = get()
  if (!streamingMessageId) return

  // 用户打断场景：旧 stream 的延迟消息（abort/done/error/token）应忽略，避免干扰新 stream
  if (msg.messageId && msg.messageId !== streamingMessageId) return

  if (msg.type === 'reasoning') {
    // 深度思考 token 增量追加到 message.reasoning
    if (msg.reasoning) {
      set((s) => ({
        currentMessages: s.currentMessages.map((m) =>
          m.id === streamingMessageId
            ? { ...m, reasoning: (m.reasoning ?? '') + msg.reasoning! }
            : m
        )
      }))
    }
    return
  }

  if (msg.type === 'token') {
    // 切走/打断场景：旧流 token 不匹配当前流即忽略（避免污染新会话消息/状态）
    if (msg.messageId && msg.messageId !== streamingMessageId) return
    // 首条 token 消息携带预算/使用量/截断信息（上下文极限预测）
    if (typeof msg.tokens === 'number' && msg.tokens > 0) {
      const budget = typeof msg.budget === 'number' ? msg.budget : null
      const dropped = typeof msg.dropped === 'number' ? msg.dropped : 0
      const patch: Partial<AppState> = {
        lastTokenCount: msg.tokens,
        lastDroppedCount: dropped
      }
      if (budget !== null) {
        patch.lastTokenBudget = budget
        // 接近极限时主动提醒（>80% 警告，>95% 紧急）
        const ratio = msg.tokens / budget
        if (ratio >= CONTEXT_CRITICAL_RATIO) {
          patch.contextWarning = `上下文已达 ${Math.round(ratio * 100)}%（${msg.tokens}/${budget}），建议开新会话继续`
        } else if (ratio >= CONTEXT_WARN_RATIO) {
          patch.contextWarning = `上下文使用 ${Math.round(ratio * 100)}%（${msg.tokens}/${budget}），接近极限`
        } else {
          patch.contextWarning = null
        }
      } else {
        patch.lastTokenBudget = null
        patch.contextWarning = null
      }
      if (dropped > 0 && !patch.contextWarning) {
        patch.contextWarning = `已截断 ${dropped} 条最旧消息以适配预算`
      }
      set(patch)
    }
    if (msg.payload) {
      set((s) => ({
        currentMessages: s.currentMessages.map((m) =>
          m.id === streamingMessageId
            ? { ...m, content: m.content + msg.payload! }
            : m
        )
      }))
    }
  } else if (msg.type === 'done') {
    // 切走/打断场景：旧流 done 不匹配当前流即忽略——否则会清掉新会话的 streaming 状态、
    // 用新会话 ID 误 saveMessages
    if (msg.messageId && msg.messageId !== streamingMessageId) return
    // done 携带 finalContent（流结束后的完整最终正文），此处用 streamingMessageId
    // 定位消息替换流式期间拼的 content（streamingMessageId 还没清空，时序安全）
    const finalContent = msg.finalContent
    if (streamingMessageId && typeof finalContent === 'string') {
      set((s) => ({
        currentMessages: s.currentMessages.map((m) =>
          m.id === streamingMessageId ? { ...m, content: finalContent } : m
        )
      }))
    }
    // 前端持久化精简：stream 结束，精简本轮 toolCalls.result.data
    // 跑的时候前端 result.data 完整（UI 展示 + 持久化），跑完精简：
    //   - 清空 result.data（下次对话发回后端时 AI 看精简版，省 token）
    //   - 保留 result.summary（UI 摘要展示：terminalOutput/searchResults/addedLines 等）
    // 后端 streamWithTools 内部 conversation 已在 onDone 前自行蒸馏替换（摘要重包护栏）
    if (streamingMessageId) {
      set((s) => ({
        currentMessages: s.currentMessages.map((m) => {
          if (m.id !== streamingMessageId || !m.toolCalls) return m
          const hasData = m.toolCalls.some((tc) => tc.result && tc.result.data !== undefined)
          if (!hasData) return m
          return {
            ...m,
            toolCalls: m.toolCalls.map((tc) =>
              tc.result && tc.result.data !== undefined
                ? { ...tc, result: { ok: tc.result.ok, error: tc.result.error, summary: tc.result.summary } }
                : tc
            )
          }
        })
      }))
    }
    // 自主激活但 AI 未输出内容：清理空 activation 消息（避免遗留空气泡）
    // 用户反馈"自主激活的框出三个点然后啥也不说"——AI 决定不输出时应清理空气泡
    const beforeClean = get().currentMessages
    const cleaned = beforeClean.filter(
      (m) => !(m.activation && !m.content?.trim() && !m.reasoning?.trim() && !m.error)
    )
    if (cleaned.length !== beforeClean.length) {
      set({ currentMessages: cleaned })
      if (currentSessionId) {
        safeSave(currentSessionId, cleaned)
      }
    }
    const updated = get().currentMessages
    set({
      status: 'idle',
      streamingMessageId: null,
      activeToolCalls: [],
      // done 携带真实 token 用量（UI 消息尾显示 input/output/缓存命中）
      ...(msg.usage ? { lastUsage: msg.usage } : {})
    })
    if (currentSessionId) {
      safeSave(currentSessionId, updated)
    }
    // 文档 17：系统层已在 server.ts 的 onDone 钩子自动写入 raw_memory
    // 记忆工作流由调度器从 raw_memory 独立拉取处理，前端不再推送对话对
  } else if (msg.type === 'error') {
    // 切走/打断场景：旧流错误不匹配当前流即忽略
    if (msg.messageId && msg.messageId !== streamingMessageId) return
    if (msg.payload && msg.payload !== 'aborted') {
      set((s) => ({
        status: 'error',
        errorMessage: msg.payload,
        streamingMessageId: null,
        activeToolCalls: [],
        currentMessages: s.currentMessages.map((m) =>
          m.id === streamingMessageId
            ? { ...m, error: msg.payload }
            : m
        )
      }))
    } else {
      set({ status: 'idle', streamingMessageId: null, activeToolCalls: [] })
    }
    if (currentSessionId) {
      safeSave(currentSessionId, get().currentMessages)
    }
  } else if (msg.type === 'abort') {
    // 旧流 abort 不匹配当前流即忽略——否则打断后旧流的 abort
    // 会把新消息的 streamingMessageId 清空，新流的 token/done 全部被丢弃
    if (msg.messageId && msg.messageId !== streamingMessageId) return
    set({ status: 'idle', streamingMessageId: null, activeToolCalls: [] })
  } else if (msg.type === 'interrupted') {
    // 重试上限已达，后端已触发中断恢复机制
    // 不显示 error（避免吓到用户），显示温和提示并保持消息内容
    set((s) => ({
      status: 'idle',
      streamingMessageId: null,
      activeToolCalls: [],
      currentMessages: s.currentMessages.map((m) =>
        m.id === streamingMessageId
          ? { ...m, aborted: true }
          : m
      )
    }))
    if (currentSessionId) {
      safeSave(currentSessionId, get().currentMessages)
    }
  }
}

export function handleDmnEvent(
  event: { type: string; [key: string]: unknown },
  set: SetState,
  get: () => AppState
) {
  switch (event.type) {
    case 'activation:trigger':
      // 文档 15.2.1：后端通知前端有激活事件，发起自主激活请求。
      // content 为待注入的激活内容（健康检查报错/倒计时/外部事件等）：
      // 把它作为 user 消息插入对话流（UI 可见），随请求发给 LLM ——
      // AI 明确知道"谁激活了我"，用户也能在界面上看到激活来源。
      void get().triggerActivation(event.content as string | undefined)
      break
    case 'dmn:output': {
      const dmnId = event.dmnId as string
      const text = event.text as string
      set((s) => ({
        dmnLog: [
          // slice(-(N-1)) 保留最近 N-1 条历史，再追加本条 → 稳态恰好 DMN_LOG_MAX 条
          ...s.dmnLog.slice(-(DMN_LOG_MAX - 1)),
          { dmnId, text, ts: Date.now() }
        ]
      }))
      break
    }
    case 'dmn:askUser': {
      set({
        dmnAskPrompt: {
          dmnId: event.dmnId as string,
          question: event.question as string,
          context: event.context as string | undefined,
          sessionId: event.sessionId as string | undefined
        }
      })
      break
    }
    case 'dmn:crash':
      set((s) => ({
        errorMessage: `DMN-${(event.dmnId as string).replace('dmn', '')} 崩溃: ${event.reason as string}`,
        dmnLog: [
          ...s.dmnLog.slice(-(DMN_LOG_MAX - 1)),
          {
            dmnId: event.dmnId as string,
            text: `[crash] ${event.reason as string}`,
            ts: Date.now()
          }
        ]
      }))
      break
    case 'dmn:conditionWait':
      set({ dmnConditionWait: event.reason as string })
      break
    case 'dmn:cycleStart':
      set({ dmnConditionWait: null })
      break
    case 'dmn:cycleComplete':
    case 'dmn:noMemory':
      set({ dmnConditionWait: null })
      break
    default:
      break
  }
}

// ===== P0 可视化数据轮询 =====
// 在 initApp 完成后由组件触发，30 秒刷新一次
