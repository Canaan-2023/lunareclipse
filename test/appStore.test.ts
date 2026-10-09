/**
 * 批次 A2：appStore 测试网

 * 覆盖：
 * 1. handleWSMessage 纯函数分支（continuous_start / tool_start / tool_end / done / token /
 *    reasoning / error / abort / interrupted / stream_status / takeover_ok / row_op）
 *    —— 用轻量 fake store 驱动，不依赖 React 渲染环境
 * 2. selectSession 会话切换重置（SESSION_RESET_FIELDS 生效 + 流式中止与 abort 消息）
 * 3. initBrowserEvents / initSandboxStreams 订阅注册→返回 unsubscribe 的释放配对，
 *    cleanupApp 关闭 WS 兜底
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { handleWSMessage, handleDmnEvent, wsState } from '../src/stores/appStore-handlers'
import type { SetState } from '../src/stores/appStore-handlers'
import type { AppState } from '../src/stores/appStore-types'
import { useAppStore, trimMessagesForWs } from '../src/stores/appStore'
import type { ChatMessage } from '../src/stores/appStore-types'
import type { ToolCall } from '../src/stores/appStore-types'

// ===== 工具：轻量 fake store（只含 handlers 消费的最小字段） =====
function makeFakeStore(overrides: Partial<AppState> = {}) {
  const state: AppState = {
    config: { aiMode: 'coding' } as AppState['config'],
    sessions: [],
    currentSessionId: 's1',
    currentMessages: [],
    streamingMessageId: null,
    activeStreamStatus: null,
    status: 'idle',
    errorMessage: null,
    settingsOpen: false,
    pendingAttachments: [],
    inputPrefill: null,
    ws: null,
    memoryWorkflowEnabled: true,
    diaryWorkflowEnabled: true,
    dmnAskPrompt: null,
    dmnLog: [],
    dmnConditionWait: null,
    currentUser: null,
    authReady: true,
    lastTokenCount: null,
    lastTokenBudget: null,
    lastDroppedCount: 0,
    contextWarning: null,
    lastUsage: null,
    currentSessionModel: null,
    currentSessionContinuousActivation: false,
    lilithChatOpen: false,
    activeToolCalls: [],
    todos: [],
    visualization: null,
    visualizationLoading: false,
    vizPanelOpen: false,
    browserPanelOpen: false,
    browserViewVisible: false,
    sidebarWidth: 210,
    todoPanelWidth: 224,
    workshopWidth: 380,
    workshopFullscreen: false,
    sidebarCollapsed: false,
    pinnedSessions: [],
    chatViewMode: 'normal',
    lang: 'zh',
    internalSessions: [],
    activeInternalSession: null,
    previewingFilePath: null,
    rightPanelTabs: ['chat'],
    activeRightPanel: 'chat',
    activeDrawer: null,
    dynamicPanels: [],
    browserUrl: '',
    browserTitle: '',
    browserLoading: false,
    browserCanGoBack: false,
    browserCanGoForward: false,
    browserCurrentAction: null,
    browserHistory: [],
    sandboxPanelOpen: false,
    sandboxLanguage: 'javascript',
    sandboxCode: '',
    sandboxRunning: false,
    sandboxOutput: '',
    sandboxResult: null,
    pythonAvailable: null,
    pythonVersion: '',
    sandboxExecutors: [],
    editingMessageId: null,
    ...overrides,
    // 串联 store action（handlers 内部 void 调用，无需真实现）
    refreshTodos: vi.fn(async () => {}),
    triggerActivation: vi.fn(async () => {}),
    ...overrides
  }
  const set: SetState = (partial) => {
    if (typeof partial === 'function') {
      Object.assign(state, partial(state))
    } else {
      Object.assign(state, partial)
    }
  }
  const get = () => state
  return { state, set, get }
}

function makeAssistantMsg(id: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: '', createdAt: Date.now(), ...extra }
}

// ===== WS 消息类型工具 =====
function wsMsg(partial: Record<string, unknown>) {
  return partial as Parameters<typeof handleWSMessage>[0]
}

describe('appStore-handlers：handleWSMessage 四类主分支（批次 A2）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      lunareclipse: { saveMessages: vi.fn(() => Promise.resolve()) }
    })
    wsState.lastUserAbortTs = 0
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('continuous_start：挂接续接流（追加 assistant 消息 + 置 streaming 态 + 持久化）', () => {
    const { state, set, get } = makeFakeStore({ streamingMessageId: null, status: 'idle' })
    handleWSMessage(
      wsMsg({ type: 'continuous_start', messageId: 'm_cont_1', sessionId: 's1', content: '续接' }),
      set,
      get
    )
    expect(state.status).toBe('streaming')
    expect(state.streamingMessageId).toBe('m_cont_1')
    expect(state.currentMessages).toHaveLength(1)
    expect(state.currentMessages[0]).toMatchObject({ id: 'm_cont_1', role: 'assistant', activation: true })
    // 持久化调用（safeSave）
    const saveMessages = (window.lunareclipse.saveMessages as ReturnType<typeof vi.fn>)
    expect(saveMessages).toHaveBeenCalledWith('s1', expect.any(Array))
  })

  it('continuous_start：已有流在跑时忽略（防 React 最大更新深度）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_existing',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_existing')]
    })
    handleWSMessage(
      wsMsg({ type: 'continuous_start', messageId: 'm_cont_dup', sessionId: 's1' }),
      set,
      get
    )
    expect(state.streamingMessageId).toBe('m_existing')
    expect(state.currentMessages).toHaveLength(1)
  })

  it('continuous_start：用户中止窗口内忽略（wsState.lastUserAbortTs 拦截）', () => {
    const { state, set, get } = makeFakeStore()
    wsState.lastUserAbortTs = Date.now()
    handleWSMessage(
      wsMsg({ type: 'continuous_start', messageId: 'm_cont_abort', sessionId: 's1' }),
      set,
      get
    )
    expect(state.streamingMessageId).toBeNull()
    expect(state.currentMessages).toHaveLength(0)
  })

  it('tool_start：挂接 activeToolCalls + 消息 toolCalls（Read 中文标签）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(
      wsMsg({
        type: 'tool_start',
        messageId: 'm_1',
        toolName: 'Read',
        toolCallId: 'tc_1',
        toolArgs: JSON.stringify({ path: '/tmp/a.txt' })
      }),
      set,
      get
    )
    expect(state.activeToolCalls).toEqual([
      expect.objectContaining({ toolCallId: 'tc_1', toolName: 'Read' })
    ])
    const msg = state.currentMessages[0]
    expect(msg.toolCalls).toHaveLength(1)
    const tc = msg.toolCalls![0]
    expect(tc).toMatchObject({
      id: 'tc_1',
      toolName: 'Read',
      toolLabel: '读取文件',
      category: 'file-read',
      status: 'running',
      args: { path: '/tmp/a.txt' }
    })
  })

  it('tool_start：messageId 不匹配当前流则丢弃（切走会话不产生幽灵 toolCall）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_current',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_current')]
    })
    handleWSMessage(
      wsMsg({ type: 'tool_start', messageId: 'm_old', toolName: 'Read', toolCallId: 'tc_stale' }),
      set,
      get
    )
    expect(state.activeToolCalls).toHaveLength(0)
    expect(state.currentMessages[0].toolCalls ?? []).toHaveLength(0)
  })

  it('tool_end：移除 activeToolCalls + toolCalls 置 done + 自动刷新任务清单', () => {
    const running: ToolCall = {
      id: 'tc_1',
      toolName: 'Read',
      toolLabel: '读取文件',
      category: 'file-read',
      args: {},
      status: 'running',
      startedAt: Date.now()
    }
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1', { toolCalls: [running] })],
      activeToolCalls: [{ toolCallId: 'tc_1', toolName: 'Read', startedAt: Date.now() }]
    })
    handleWSMessage(
      wsMsg({
        type: 'tool_end',
        messageId: 'm_1',
        toolCallId: 'tc_1',
        toolName: 'Read',
        toolResult: JSON.stringify({ ok: true, data: { lines: ['hello'] } }),
        toolSummary: JSON.stringify({ primary: '读取文件成功' })
      }),
      set,
      get
    )
    expect(state.activeToolCalls).toHaveLength(0)
    const tc = state.currentMessages[0].toolCalls![0]
    expect(tc.status).toBe('done')
    expect(tc.result).toMatchObject({
      ok: true,
      data: { lines: ['hello'] },
      summary: { primary: '读取文件成功' }
    })
    expect(state.refreshTodos).toHaveBeenCalled()
  })

  it('tool_end：toolResult.ok=false 置 error 状态并保留 errorMsg', () => {
    const running: ToolCall = {
      id: 'tc_2',
      toolName: 'Glob',
      toolLabel: '查找文件',
      category: 'file-read',
      args: {},
      status: 'running',
      startedAt: Date.now()
    }
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1', { toolCalls: [running] })],
      activeToolCalls: [{ toolCallId: 'tc_2', toolName: 'Glob', startedAt: Date.now() }]
    })
    handleWSMessage(
      wsMsg({
        type: 'tool_end',
        messageId: 'm_1',
        toolCallId: 'tc_2',
        toolName: 'Glob',
        toolResult: JSON.stringify({ ok: false, error: '路径不存在' })
      }),
      set,
      get
    )
    const tc = state.currentMessages[0].toolCalls![0]
    expect(tc.status).toBe('error')
    expect(tc.result).toMatchObject({ ok: false, error: '路径不存在' })
  })

  it('done：finalContent 替换 content + 折叠 result.data + 置 idle + 记录 usage', () => {
    const running: ToolCall = {
      id: 'tc_1',
      toolName: 'Read',
      toolLabel: '读取文件',
      category: 'file-read',
      args: {},
      status: 'done',
      startedAt: Date.now(),
      result: { ok: true, data: { big: 'x'.repeat(100) }, summary: { primary: 's' } }
    }
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1', { content: '原文内容', toolCalls: [running] })],
      activeToolCalls: []
    })
    handleWSMessage(
      wsMsg({
        type: 'done',
        messageId: 'm_1',
        finalContent: '最终完整内容',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 }
      }),
      set,
      get
    )
    expect(state.status).toBe('idle')
    expect(state.streamingMessageId).toBeNull()
    expect(state.lastUsage).toEqual({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 })
    const msg = state.currentMessages[0]
    expect(msg.content).toBe('最终完整内容')
    // result.data 被清空为 undefined（只留 summary）
    expect(msg.toolCalls![0].result).toEqual({
      ok: true,
      summary: { primary: 's' }
    })
    expect('data' in msg.toolCalls![0].result!).toBe(false)
  })

  it('done：清理空 activation 空气泡（AI 决定不输出时）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [
        makeAssistantMsg('m_1', { content: '有内容', activation: false }),
        makeAssistantMsg('m_empty', { activation: true })
      ]
    })
    handleWSMessage(wsMsg({ type: 'done', messageId: 'm_1' }), set, get)
    expect(state.currentMessages).toHaveLength(1)
    expect(state.currentMessages[0].id).toBe('m_1')
  })

  it('token：记录计数/预算 + 超 80% 警告 + payload 追加到消息', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    // 第一次 token：110/120 = 91.7% → 普通警告（>80%）；携带 payload 追加
    handleWSMessage(
      wsMsg({ type: 'token', messageId: 'm_1', tokens: 110, budget: 120, payload: '你好' }),
      set,
      get
    )
    expect(state.lastTokenCount).toBe(110)
    expect(state.lastTokenBudget).toBe(120)
    expect(state.contextWarning).toContain('接近极限')
    expect(state.currentMessages[0].content).toBe('你好')
    // 第二次：118/120 = 98.3% → 紧急警告（>95%）
    handleWSMessage(
      wsMsg({ type: 'token', messageId: 'm_1', tokens: 118, budget: 120, payload: '世界' }),
      set,
      get
    )
    expect(state.contextWarning).toContain('已达')
    expect(state.currentMessages[0].content).toBe('你好世界')
    // 第三次：60/120 = 50% → 无警告
    handleWSMessage(
      wsMsg({ type: 'token', messageId: 'm_1', tokens: 60, budget: 120, payload: '!' }),
      set,
      get
    )
    expect(state.contextWarning).toBeNull()
    expect(state.currentMessages[0].content).toBe('你好世界!')
  })

  it('token：dropped>0 时提示截断（未触发水位告警路径）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(
      wsMsg({ type: 'token', messageId: 'm_1', tokens: 5, budget: 100, dropped: 3 }),
      set,
      get
    )
    expect(state.lastDroppedCount).toBe(3)
    expect(state.contextWarning).toContain('已截断 3 条')
  })

  it('reasoning：增量追加到消息 reasoning 字段', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(wsMsg({ type: 'reasoning', messageId: 'm_1', reasoning: '思考' }), set, get)
    handleWSMessage(wsMsg({ type: 'reasoning', messageId: 'm_1', reasoning: '过程' }), set, get)
    expect(state.currentMessages[0].reasoning).toBe('思考过程')
  })

  it('error：置 error 态并标记消息错误（真实错误 payload）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(wsMsg({ type: 'error', messageId: 'm_1', payload: 'LLM 超时' }), set, get)
    expect(state.status).toBe('error')
    expect(state.errorMessage).toBe('LLM 超时')
    expect(state.currentMessages[0].error).toBe('LLM 超时')
    expect(state.streamingMessageId).toBeNull()
  })

  it('error：payload=aborted 时静默复位 idle（不展示错误、不覆盖已展示 error）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      errorMessage: '之前遗留的错误',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(wsMsg({ type: 'error', messageId: 'm_1', payload: 'aborted' }), set, get)
    expect(state.status).toBe('idle')
    expect(state.streamingMessageId).toBeNull()
    expect(state.currentMessages[0].error).toBeUndefined() // 不标记消息
    expect(state.errorMessage).toBe('之前遗留的错误') // 不被覆盖
  })

  it('interrupted：置 idle + 消息标记 aborted（温和提示，不显示 error）', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(wsMsg({ type: 'interrupted', messageId: 'm_1' }), set, get)
    expect(state.status).toBe('idle')
    expect(state.streamingMessageId).toBeNull()
    expect(state.currentMessages[0].aborted).toBe(true)
    expect(state.errorMessage).toBeNull()
  })

  it('abort：清除 streaming 状态与 activeToolCalls', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      activeToolCalls: [{ toolCallId: 'tc_1', toolName: 'Read', startedAt: Date.now() }],
      currentMessages: [makeAssistantMsg('m_1')]
    })
    handleWSMessage(wsMsg({ type: 'abort', messageId: 'm_1' }), set, get)
    expect(state.status).toBe('idle')
    expect(state.streamingMessageId).toBeNull()
    expect(state.activeToolCalls).toHaveLength(0)
  })

  it('stream_status：维护后端活跃流状态（active 布尔 + 归属信息）', () => {
    const { state, set, get } = makeFakeStore()
    handleWSMessage(
      wsMsg({ type: 'stream_status', active: true, sessionId: 's1', messageId: 'm_1', startedAt: 123 }),
      set,
      get
    )
    expect(state.activeStreamStatus).toEqual({
      active: true,
      sessionId: 's1',
      messageId: 'm_1',
      startedAt: 123
    })
    handleWSMessage(wsMsg({ type: 'stream_status', active: false }), set, get)
    expect(state.activeStreamStatus?.active).toBe(false)
  })

  it('takeover_ok：建立 streamingMessageId 并重放锚点（磁盘缺消息时补空 assistant）', () => {
    const { state, set, get } = makeFakeStore({ status: 'idle', streamingMessageId: null })
    handleWSMessage(wsMsg({ type: 'takeover_ok', messageId: 'm_take' }), set, get)
    expect(state.status).toBe('streaming')
    expect(state.streamingMessageId).toBe('m_take')
    expect(state.currentMessages).toHaveLength(1)
    expect(state.currentMessages[0].id).toBe('m_take')
    expect(state.currentMessages[0].role).toBe('assistant')
  })

  it('row_op：row.appended 去重插入 + row.delta 追加文本 + row.removed 移除', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_1',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_1')]
    })
    // appended：插入行
    handleWSMessage(
      wsMsg({
        type: 'row_op',
        messageId: 'm_1',
        rowOp: {
          op: 'row.appended',
          row: {
            rowId: 1,
            turnId: 'turn_1',
            createdAt: Date.now(),
            createdAtSeq: 0,
            kind: 'assistantText',
            state: 'streaming',
            text: ''
          }
        }
      }),
      set,
      get
    )
    expect(state.currentMessages[0].rows).toHaveLength(1)
    // 重复 appended 同一 rowId → 去重
    handleWSMessage(
      wsMsg({
        type: 'row_op',
        messageId: 'm_1',
        rowOp: {
          op: 'row.appended',
          row: {
            rowId: 1,
            turnId: 'turn_1',
            createdAt: Date.now(),
            createdAtSeq: 0,
            kind: 'assistantText',
            state: 'streaming',
            text: '重试'
          }
        }
      }),
      set,
      get
    )
    expect(state.currentMessages[0].rows).toHaveLength(1)
    // delta：追加文本
    handleWSMessage(
      wsMsg({ type: 'row_op', messageId: 'm_1', rowOp: { op: 'row.delta', rowId: 1, path: ['text'], append: 'AB' } }),
      set,
      get
    )
    handleWSMessage(
      wsMsg({ type: 'row_op', messageId: 'm_1', rowOp: { op: 'row.delta', rowId: 1, path: ['text'], append: 'C' } }),
      set,
      get
    )
    expect(state.currentMessages[0].rows![0]).toMatchObject({ text: 'ABC' })
    // removed：按 fromRowId 移除
    handleWSMessage(
      wsMsg({ type: 'row_op', messageId: 'm_1', rowOp: { op: 'row.removed', fromRowId: 1 } }),
      set,
      get
    )
    expect(state.currentMessages[0].rows).toHaveLength(0)
  })

  it('旧流延迟消息（messageId 不匹配）在 token/done/tool_end 均被忽略', () => {
    const { state, set, get } = makeFakeStore({
      streamingMessageId: 'm_new',
      status: 'streaming',
      currentMessages: [makeAssistantMsg('m_new')],
      activeToolCalls: [{ toolCallId: 'tc_1', toolName: 'Read', startedAt: Date.now() }]
    })
    handleWSMessage(wsMsg({ type: 'token', messageId: 'm_old', payload: 'X' }), set, get)
    handleWSMessage(wsMsg({ type: 'done', messageId: 'm_old' }), set, get)
    handleWSMessage(
      wsMsg({ type: 'tool_end', messageId: 'm_old', toolCallId: 'tc_1', toolResult: '{"ok":true}' }),
      set,
      get
    )
    expect(state.status).toBe('streaming') // 不被旧 done 清掉
    expect(state.streamingMessageId).toBe('m_new')
    expect(state.activeToolCalls).toHaveLength(1) // 不被旧 tool_end 移除
    expect(state.currentMessages[0].content).toBe('')
  })
})

describe('appStore-handlers：handleDmnEvent（批次 A2）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      lunareclipse: { saveMessages: vi.fn(() => Promise.resolve()) }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('activation:trigger 委托 store.triggerActivation', () => {
    const { state, set, get } = makeFakeStore()
    handleDmnEvent({ type: 'activation:trigger', content: '健康检查报错' }, set, get)
    expect(state.triggerActivation).toHaveBeenCalledWith('健康检查报错')
  })

  it('dmn:output 追加 DMN 日志（裁剪到 100 条）', () => {
    const { state, set, get } = makeFakeStore({ dmnLog: [] })
    for (let i = 0; i < 105; i++) {
      handleDmnEvent({ type: 'dmn:output', dmnId: 'dmn1', text: `log-${i}` }, set, get)
    }
    expect(state.dmnLog).toHaveLength(100)
    expect(state.dmnLog[0].text).toBe('log-5') // 最旧 5 条被裁掉
  })

  it('dmn:askUser 设置待提问弹窗；cyc求激活等待态', () => {
    const { state, set, get } = makeFakeStore()
    handleDmnEvent({ type: 'dmn:askUser', dmnId: 'dmn1', question: '是否继续？', context: 'ctx' }, set, get)
    expect(state.dmnAskPrompt).toMatchObject({ dmnId: 'dmn1', question: '是否继续？', context: 'ctx' })
    handleDmnEvent({ type: 'dmn:cycleStart', dmnId: 'dmn1' }, set, get)
    expect(state.dmnConditionWait).toBeNull()
  })

  it('dmn:crash 记录崩溃日志并置 errorMessage', () => {
    const { state, set, get } = makeFakeStore()
    handleDmnEvent({ type: 'dmn:crash', dmnId: 'dmn1', reason: '栈溢出' }, set, get)
    expect(state.errorMessage).toBe('DMN-1 崩溃: 栈溢出')
    expect(state.dmnLog[0]).toMatchObject({ dmnId: 'dmn1', text: '[crash] 栈溢出' })
  })
})

describe('appStore：会话切换重置与订阅释放（批次 A2）', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      lunareclipse: {
        saveMessages: vi.fn(() => Promise.resolve()),
        getSession: vi.fn(async () => ({
          id: 's2',
          title: '新会话',
          messages: [
            { id: 'u1', role: 'user', content: '你好', createdAt: Date.now() }
          ],
          model: null
        })),
        dmnSetActiveSession: vi.fn(),
        todosGet: vi.fn(async () => ({ ok: true, todos: [] }))
      }
    })
    // 重置真实 store 到干净基线
    useAppStore.setState({
      currentSessionId: 's1',
      currentMessages: [
        { id: 'u1', role: 'user', content: '旧内容', createdAt: Date.now() },
        { id: 'a1', role: 'assistant', content: '旧回复', createdAt: Date.now() }
      ],
      status: 'idle',
      streamingMessageId: null,
      errorMessage: null,
      activeToolCalls: [],
      lastTokenCount: null,
      lastTokenBudget: null,
      lastDroppedCount: 0,
      contextWarning: null,
      lastUsage: null,
      internalSessions: [],
      activeInternalSession: null,
      ws: null
    } as Partial<AppState>)
  })
  afterEach(() => {
    // 防止残留 ws/定时器：cleanupApp 兜底
    try { useAppStore.getState().cleanupApp() } catch { /* ignore */ }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('selectSession：切换会话应用 SESSION_RESET_FIELDS（工具调用/token 计数/上下文残留清零）', async () => {
    // 污染当前会话状态（模拟上一会话残留）
    useAppStore.setState({
      currentSessionId: 's1',
      activeToolCalls: [{ toolCallId: 'tc_x', toolName: 'Read', startedAt: Date.now() }],
      lastTokenCount: 999,
      lastTokenBudget: 4096,
      lastDroppedCount: 5,
      contextWarning: '旧警告',
      lastUsage: { inputTokens: 1, outputTokens: 2 },
      internalSessions: [{ id: 'is_1', ownerSessionId: 's1', title: 't', summary: 's', createdAt: 1, updatedAt: 1 }],
      activeInternalSession: {} as AppState['activeInternalSession']
    } as Partial<AppState>)

    await useAppStore.getState().selectSession('s2')

    const st = useAppStore.getState()
    expect(st.currentSessionId).toBe('s2')
    expect(st.currentMessages.map((m) => m.content)).toEqual(['你好'])
    // SESSION_RESET_FIELDS 全部清零
    expect(st.activeToolCalls).toEqual([])
    expect(st.lastTokenCount).toBeNull()
    expect(st.lastTokenBudget).toBeNull()
    expect(st.lastDroppedCount).toBe(0)
    expect(st.contextWarning).toBeNull()
    expect(st.lastUsage).toBeNull()
    expect(st.internalSessions).toEqual([])
    expect(st.activeInternalSession).toBeNull()
    // 持久化当前会话 + 后端活跃会话同步
    expect(window.lunareclipse.dmnSetActiveSession).toHaveBeenCalledWith('s2')
  })

  it('selectSession：流式中切走会话 → 终止旧流（abort 消息 + 消息标记 aborted + 持久化）', async () => {
    const wsMock = { send: vi.fn() } as unknown as WebSocket
    useAppStore.setState({
      currentSessionId: 's1',
      status: 'streaming',
      streamingMessageId: 'a1',
      ws: wsMock,
      currentMessages: [
        { id: 'u1', role: 'user', content: '旧内容', createdAt: Date.now() },
        { id: 'a1', role: 'assistant', content: '', createdAt: Date.now(), activation: false }
      ]
    } as Partial<AppState>)
    const saveMessages = window.lunareclipse.saveMessages as ReturnType<typeof vi.fn>

    await useAppStore.getState().selectSession('s2')

    // 旧流被中止
    expect(wsMock.send).toHaveBeenCalledWith(JSON.stringify({ type: 'abort' }))
    // 切走后 currentMessages 已换成新会话 → 标记发生在切换前的快照（持久化校验）
    expect(saveMessages).toHaveBeenCalledWith('s1', expect.any(Array))
  })

  it('initBrowserEvents：注册→返回 unsubscribe→事件驱动 store 更新→释放后不再更新', () => {
    // 注册表模拟：unsubscribe 后主进程不再分发事件
    const registered = new Set<(e: Record<string, unknown>) => void>()
    ;(window.lunareclipse as Record<string, unknown>).onBrowserEvent = vi.fn((cb: (e: Record<string, unknown>) => void) => {
      registered.add(cb)
      return () => registered.delete(cb)
    }) as unknown
    ;(window.lunareclipse as Record<string, unknown>).browserIsVisible = vi.fn(async () => ({ visible: false }))
    const dispatch = (e: Record<string, unknown>) => {
      for (const cb of registered) cb(e)
    }

    const unsubscribe = useAppStore.getState().initBrowserEvents()
    // 事件驱动 store 更新
    dispatch({
      type: 'browser:state',
      visible: true,
      url: 'https://example.com',
      title: 'Example',
      loading: false,
      canGoBack: true,
      canGoForward: false
    })
    const st = useAppStore.getState()
    expect(st.browserViewVisible).toBe(true)
    expect(st.browserUrl).toBe('https://example.com')
    expect(st.browserTitle).toBe('Example')
    expect(st.rightPanelTabs).toContain('browser')

    // 释放订阅
    unsubscribe()
    expect(registered.size).toBe(0)
    // 释放后事件不再更新
    dispatch({ type: 'browser:state', visible: false, url: 'https://x.test', title: 'X', loading: false, canGoBack: false, canGoForward: false })
    expect(useAppStore.getState().browserUrl).toBe('https://example.com')
  })

  it('initBrowserEvents：browser:closed 移除浏览器标签并回落 chat', () => {
    const registered = new Set<(e: Record<string, unknown>) => void>()
    ;(window.lunareclipse as Record<string, unknown>).onBrowserEvent = vi.fn((cb: (e: Record<string, unknown>) => void) => {
      registered.add(cb)
      return () => registered.delete(cb)
    }) as unknown
    ;(window.lunareclipse as Record<string, unknown>).browserIsVisible = vi.fn(async () => ({ visible: false }))
    const dispatch = (e: Record<string, unknown>) => {
      for (const cb of registered) cb(e)
    }
    useAppStore.setState({
      rightPanelTabs: ['chat', 'browser'],
      activeRightPanel: 'browser',
      browserPanelOpen: true
    } as Partial<AppState>)

    useAppStore.getState().initBrowserEvents()
    dispatch({ type: 'browser:closed' })
    const st = useAppStore.getState()
    expect(st.rightPanelTabs).toEqual(['chat'])
    expect(st.activeRightPanel).toBe('chat')
    expect(st.browserPanelOpen).toBe(false)
  })

  it('initSandboxStreams：注册→返回 unsubscribe→流事件驱动→释放配对', () => {
    const registered = new Set<{ onStdout?: (c: string) => void; onStderr?: (c: string) => void; onDone?: (r: unknown) => void }>()
    ;(window.lunareclipse as Record<string, unknown>).onCodeStream = vi.fn(
      (handlers: { onStdout?: (c: string) => void; onStderr?: (c: string) => void; onDone?: (r: unknown) => void }) => {
        registered.add(handlers)
        return () => registered.delete(handlers)
      }
    ) as unknown

    useAppStore.setState({
      sandboxRunning: true,
      sandboxOutput: '',
      sandboxLanguage: 'javascript',
      sandboxCode: '1+1'
    } as Partial<AppState>)

    const unsubscribe = useAppStore.getState().initSandboxStreams()

    const h = [...registered][0]
    h.onStdout!('out ')
    h.onStderr!('err')
    expect(useAppStore.getState().sandboxOutput).toBe('out err')
    // 释放后主进程分发列表被清空 → 不再有任何 handler 能收到流事件
    unsubscribe()
    expect(registered.size).toBe(0)
    const beforeCount = useAppStore.getState().sandboxOutput.length
    for (const handler of registered) handler.onStdout?.('LATE') // 空集合：无分发
    expect(useAppStore.getState().sandboxOutput.length).toBe(beforeCount)
  })

  it('cleanupApp：关闭 ws 并置空（无残留重连引用）', () => {
    const wsMock = {
      close: vi.fn(),
      onclose: null as (() => void) | null,
      onerror: null,
      onmessage: null,
      onopen: null,
      readyState: 1
    } as unknown as WebSocket
    useAppStore.setState({ ws: wsMock } as Partial<AppState>)

    useAppStore.getState().cleanupApp()
    const st = useAppStore.getState()
    expect(st.ws).toBeNull()
    // 关闭回调被摘除（断开时不会触发重连）
    expect(wsMock.onclose).toBeNull()
    expect(wsMock.close).toHaveBeenCalled()
  })
})

// ===== trimMessagesForWs 边界用例（批次 B3：前端 WS 传输裁剪，2MB 字符预算） =====
// 与后端 truncateConversation（token 预算）不同源：前端是 WS 传输保护（防超大 payload
// 断连），后端是上下文窗口语义截断——计划书明示不同源不强行合并，此处只锁定前端语义。
describe('trimMessagesForWs（批次 B3）', () => {
  const makeMsg = (id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id,
    role: 'user',
    content,
    createdAt: Date.now(),
    ...extra
  })

  it('≤1 条消息原样返回（不裁剪）', () => {
    const single = [makeMsg('m1', 'x')]
    expect(trimMessagesForWs(single)).toEqual(single)
    expect(trimMessagesForWs([])).toEqual([])
  })

  it('预算内全保留，顺序不变（倒序收集后 unshift 回正序）', () => {
    const msgs = [
      makeMsg('m1', 'a'.repeat(100)),
      makeMsg('m2', 'b'.repeat(200)),
      makeMsg('m3', 'c'.repeat(300))
    ]
    const kept = trimMessagesForWs(msgs)
    expect(kept.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('最新一条超预算也无条件保留', () => {
    const msgs = [
      makeMsg('m1', 'x'),
      makeMsg('m2', 'y'.repeat(2 * 1024 * 1024 + 1))
    ]
    const kept = trimMessagesForWs(msgs)
    // 最新 m2 被保留；m1 因超预算被裁
    expect(kept.map((m) => m.id)).toEqual(['m2'])
  })

  it('从旧到新裁剪，保留最近消息直到预算耗尽', () => {
    const big = 'z'.repeat(1024 * 1024) // 1MB
    const msgs = [
      makeMsg('old1', big),
      makeMsg('old2', big),
      makeMsg('new1', 'n'),
      makeMsg('new2', 'n')
    ]
    const kept = trimMessagesForWs(msgs)
    // 从 new2 倒序：new2(1) + new1(1) + old2(1MB) ≈ 预算内；old1(1MB) 超预算被裁
    // 注：预算 2MB，old2 后 total≈1MB+2B，加 old1 会超 → old1 被裁
    expect(kept.map((m) => m.id)).toEqual(['old2', 'new1', 'new2'])
  })

  it('content/reasoning/attachments 合计计入预算', () => {
    const msgs = [
      makeMsg('m1', 'x', { reasoning: 'r'.repeat(1024 * 1024) }),
      makeMsg('m2', 'y', {
        attachments: [{ dataUrl: 'a'.repeat(1024 * 1024) }]
      }),
      makeMsg('m3', 'n')
    ]
    const kept = trimMessagesForWs(msgs)
    // m3(1) + m2(1MB attachment) 在预算内；m1(1MB reasoning) 超预算被裁
    expect(kept.map((m) => m.id)).toEqual(['m2', 'm3'])
  })

  it('null content / 无 attachments 按 0 计，不误裁', () => {
    const msgs = [
      makeMsg('m1', ''), // content 空串
      { ...makeMsg('m2', 'n'), content: null } // content null
    ]
    const kept = trimMessagesForWs(msgs)
    expect(kept.map((m) => m.id)).toEqual(['m1', 'm2'])
  })
})