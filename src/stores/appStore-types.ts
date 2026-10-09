/**
 * 为什么存在：类型与实现分离可避免 slice 之间循环依赖并降低主 bundle 解析成本
 * （纯类型文件无运行时副作用）。
 * @category 前端状态
 * @summary appStore 的类型定义（从 appStore.ts 抽出，纯类型、无运行时依赖）
 */
import type { Session, ChatMessage, AppConfig, Attachment, CurrentUser, VisualizationData, InternalSession, InternalSessionSummary } from '@shared/types'
import type { AiRecord } from '../../electron/main/models/ai-registry'
import type { BrowserHistoryEntry } from '../../electron/main/tools/browser-view-manager'
import type { CodeSandboxResult, CodeLanguage } from '../../electron/main/tools/code-sandbox'

type ConnectionStatus = 'idle' | 'streaming' | 'error'

/**
 * 标签页类型：'chat' 是永久的会话标签（不可关闭），其余为功能面板标签。
 * 浏览器 / 代码沙箱 / 文件预览 / SKILL / 插件 / 定时任务 / Hook 检视 / 日历 + 动态模块面板（plugin:{id}）
 */
export type RightPanelTabId = 'chat' | 'browser' | 'sandbox' | 'file' | 'workshop' | 'skill' | 'lilith' | 'plugin' | 'cron' | 'hook' | 'todo' | 'calendar' | 'admin' | 'backup' | 'friend' | 'chatRoom' | 'publishBoard' | 'social' | 'ai' | 'profile' | (string & {})

interface DmnAskPrompt {
  dmnId: string
  question: string
  context?: string
  sessionId?: string
}

/** 正在执行的工具调用条目（tool_start → tool_end 期间存在） */
export interface ActiveToolCall {
  toolCallId: string
  toolName: string
  /** 开始时间戳（用于前端展示已耗时） */
  startedAt: number
}

/** 任务清单条目（计划面板用，与主进程 TodoWrite 数据结构对齐） */
export interface PlanTodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  priority: 'high' | 'medium' | 'low'
}

export interface AppState {
  config: AppConfig
  sessions: Session[]
  currentSessionId: string | null
  currentMessages: ChatMessage[]
  /** 当前会话归属 AI 编号（月蚀=1；private 后端会话不带 aiId 时回退 1） */
  currentAiId: number
  /** AI 注册表快照（前端 AiManagerPanel / 会话切换器 / 会话头共用） */
  ais: AiRecord[]
  /** 新建会话选择器是否打开（多 AI 时点 "+" 弹出；仅系统月蚀时直接建） */
  aiPickerOpen: boolean
  /** 打开/关闭新建会话选择器 */
  setAiPickerOpen: (open: boolean) => void
  /** 新建会话入口：仅系统月蚀一个启用 AI 时直接建，多 AI 时弹出选择器 */
  requestNewSession: () => void
  /** 从主进程拉取 AI 注册表快照（登录/面板打开时刷新） */
  loadAis: () => Promise<void>
  streamingMessageId: string | null
  // 后端运行中流的状态（stream_status 广播维护）——前端持续监控后端
  activeStreamStatus: { active: boolean; sessionId?: string; messageId?: string; startedAt?: number } | null
  status: ConnectionStatus
  errorMessage: string | null
  settingsOpen: boolean
  pendingAttachments: Attachment[]
  /** 输入框预填请求：ChatArea 空状态提示词按钮 → InputArea 消费，一次性 */
  inputPrefill: string | null
  ws: WebSocket | null
  /** 记忆工作流开关（由 raw_memory 驱动工作流引擎） */
  memoryWorkflowEnabled: boolean
  /** 日记工作流开关（后端 DiaryWorkflowScheduler，隔天自动补写 diary.md） */
  diaryWorkflowEnabled: boolean
  dmnAskPrompt: DmnAskPrompt | null
  dmnLog: Array<{ dmnId: string; text: string; ts: number }>
  dmnConditionWait: string | null
  currentUser: CurrentUser | null
  authReady: boolean
  lastTokenCount: number | null
  lastTokenBudget: number | null
  lastDroppedCount: number
  contextWarning: string | null
  /** 最新一轮真实 token 用量（done.usage） */
  lastUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | null

  currentSessionModel: string | null
  /** 当前会话的代码审查讨论开关（continuousActivation：开关打开时回复完成后触发多轮审查者↔执行者讨论） */
  currentSessionContinuousActivation: boolean
  /** 莉莉丝会话是否打开（会话栏置顶独立栏，进入主聊天窗口与桌宠对话） */
  lilithChatOpen: boolean
  /** 正在执行的工具调用列表（tool_start 进入，tool_end 移除） */
  activeToolCalls: ActiveToolCall[]
  /** 任务清单（计划面板常驻展示；TodoWrite 工具调用后刷新） */
  todos: PlanTodoItem[]
  visualization: VisualizationData | null
  visualizationLoading: boolean
  vizPanelOpen: boolean
  /** 浏览器面板是否打开（WebContentsView 嵌入主窗口右侧） */
  browserPanelOpen: boolean
  /** 主进程原生浏览器视图的实际可见性（AI 工具直接 show 时前端标签可能不知情，独立于 browserPanelOpen/rightPanelTabs） */
  browserViewVisible: boolean
  /** 左侧 Sidebar 宽度（像素，可拖拽调整） */
  sidebarWidth: number
  /** 右侧计划面板宽度（像素，可拖拽调整） */
  todoPanelWidth: number
  /** 文件工坊侧栏宽度（像素，280-600 可拖拽） */
  workshopWidth: number
  /** 文件工坊全屏展开（占满右侧区域） */
  workshopFullscreen: boolean
  /** 左侧 Sidebar 是否折叠（折叠时收成图标条） */
  sidebarCollapsed: boolean
  /** 置顶会话 ID 列表（前端 localStorage 持久化，不侵入 Session 类型/后端） */
  pinnedSessions: string[]
  /** 切换会话置顶 */
  togglePinSession: (sessionId: string) => void
  /** 聊天区域视图模式：normal=普通气泡流，tree=内部会话视图 */
  chatViewMode: 'normal' | 'tree'
  /** 界面语言 */
  lang: 'zh' | 'en'
  /** 切换界面语言 */
  setLang: (lang: 'zh' | 'en') => void
  /** 切换视图模式 */
  setChatViewMode: (mode: 'normal' | 'tree') => void
  /** 内部会话列表（当前用户会话名下；仅摘要不含正文） */
  internalSessions: InternalSessionSummary[]
  /** 当前展开查看的内部会话详情（含消息正文） */
  activeInternalSession: InternalSession | null
  /** 当前承接的内部会话 id（AI 经 session_select 设置的 active 指针；树画布高亮「正在承接」用） */
  activeInternalId: string | null
  /** 刷新内部会话列表 */
  loadInternalSessions: (sessionId: string) => Promise<void>
  /** 新建内部会话（content 可选，提供则生成首条 user 消息） */
  createInternalSession: (sessionId: string, title: string, content?: string) => Promise<void>
  /** 就地编辑内部会话（title/summary/messages/cacheLocations；乐观更新直落盘，IPC 返回为准；返回是否成功） */
  updateInternalSession: (
    sessionId: string,
    internalId: string,
    patch: Partial<Pick<InternalSession, 'title' | 'summary' | 'messages' | 'cacheLocations'>>
  ) => Promise<boolean>
  /** 删除内部会话（无确认，文件即删） */
  deleteInternalSession: (sessionId: string, internalId: string) => Promise<void>
  /** 设置当前展开查看的内部会话 */
  setActiveInternalSession: (s: InternalSession | null) => void
  /** 当前文件预览面板打开的文件路径（null 表示无预览，供 AI 上下文注入） */
  previewingFilePath: string | null
  /** 右侧面板标签页列表（已打开的面板，顺序即标签顺序） */
  rightPanelTabs: RightPanelTabId[]
  /** 右侧面板当前激活的标签页（null 表示无面板打开） */
  activeRightPanel: RightPanelTabId | null
  /** 右侧抽屉面板（轻量面板 overlay 展开，不开标签页；null=关闭） */
  activeDrawer: RightPanelTabId | null
  /** 动态模块面板声明（从 plugin:panels IPC 获取，插件通过 manifest.panel 声明） */
  dynamicPanels: Array<{ id: string; title: string; icon: string; component: string }>
  /** 刷新动态模块面板列表（从主进程拉取已注册的 panel 声明） */
  refreshDynamicPanels: () => Promise<void>
  /** 浏览器当前 URL */
  browserUrl: string
  /** 浏览器当前页面标题 */
  browserTitle: string
  /** 浏览器是否正在加载 */
  browserLoading: boolean
  /** 浏览器导航历史：能否后退 */
  browserCanGoBack: boolean
  /** 浏览器导航历史：能否前进 */
  browserCanGoForward: boolean
  /** 当前正在执行的动作（null 表示空闲） */
  browserCurrentAction: { action: string; detail: string } | null
  /** 操作历史（最新在上） */
  browserHistory: BrowserHistoryEntry[]

  // ===== 代码沙箱面板 =====
  /** 代码沙箱面板是否打开 */
  sandboxPanelOpen: boolean
  /** 当前语言（javascript / python / go / bash 等任意执行器 ID） */
  sandboxLanguage: CodeLanguage
  /** 代码内容 */
  sandboxCode: string
  /** 是否正在执行 */
  sandboxRunning: boolean
  /** 输出文本（stdout + stderr 拼接，最新在底部） */
  sandboxOutput: string
  /** 最近一次执行结果（done 时填充） */
  sandboxResult: CodeSandboxResult | null
  /** Python 是否可用（首次打开时检测） */
  pythonAvailable: boolean | null
  /** Python 版本字符串 */
  pythonVersion: string
  /** 可用执行器列表（从 sandbox-env.json 加载） */
  sandboxExecutors: Array<{ id: string; label: string; mode: string; builtin: boolean }>

  initApp: () => Promise<void>
  /** 清理 initApp 创建的副作用（WebSocket/interval/listeners），组件卸载时调用 */
  cleanupApp: () => void
  /** 刷新任务清单（计划面板挂载/启动时调用，从主进程读 .activation/todos.json） */
  refreshTodos: () => Promise<void>
  loadSessions: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  createSession: (aiId?: number) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  sendMessage: (content: string) => Promise<void>
  abortStream: () => void
  /** 撤回消息：标记 recalled，双层同步（session.messages + 内部会话） */
  recallMessage: (messageId: string) => Promise<void>
  /** 删除消息（连同配对消息） */
  deleteMessage: (messageId: string) => Promise<void>
  /** 编辑用户消息并重发：更新内容，清除原 AI 回复，重新生成 */
  editAndResend: (messageId: string, newContent: string) => Promise<void>
  /** 重新生成 AI 回复：清除原回复内容，重新请求 */
  regenerateResponse: (messageId: string) => Promise<void>
  /** 当前正在编辑的消息 ID（编辑重发模式，InputArea 消费） */
  editingMessageId: string | null
  /** 设置/清除编辑模式 */
  setEditingMessageId: (id: string | null) => void
  /** 请求预填输入框（空状态提示词按钮用） */
  setInputPrefill: (text: string | null) => void
  openSettings: () => void
  closeSettings: () => void
  saveConfig: (config: AppConfig) => Promise<void>
  addAttachment: (file: Attachment) => void
  removeAttachment: (index: number) => void
  /** 切换记忆工作流开关 */
  setMemoryWorkflowEnabled: (enabled: boolean) => Promise<void>
  /** 切换日记工作流开关（后端 DiaryWorkflowScheduler） */
  setDiaryWorkflowEnabled: (enabled: boolean) => Promise<void>
  answerDmnQuestion: (dmnId: string, answer: string | null) => Promise<void>
  dismissDmnAsk: () => void
  setSessionModel: (model: string | null) => Promise<void>
  /** 打开莉莉丝会话（主聊天窗口与桌宠对话，与游戏内共享上下文） */
  openLilithChat: () => void
  /** 关闭莉莉丝会话，回到普通会话视图 */
  closeLilithChat: () => void

  /** 切换当前会话的持续激活模式开关（持久化到 session） */
  toggleContinuousActivation: (enabled: boolean) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string, intent?: 'local' | 'createMaster' | 'joinSatellite') => Promise<void>
  logout: () => Promise<void>
  /** 登出双确认：确认退出 + 询问是否清空本账号工作域数据（清理确认后先清数据再登出） */
  confirmLogout: () => Promise<void>
  switchUser: () => Promise<void>
  /** 注销账号：删除账号记录但保留所有记忆数据，之后回到登录界面 */
  deleteAccount: () => Promise<void>
  triggerActivation: (content?: string) => Promise<void>
  refreshVisualization: () => Promise<void>
  /** 手动触发一轮健康检查（监控面板「立即检查」按钮），完成后刷新可视化数据 */
  healthCheckRun: () => Promise<void>
  /** 取消 AI 倒计时（监控面板「定时器」tab），完成后刷新可视化数据 */
  cancelTimer: (id: string) => Promise<void>
  setVizPanelOpen: (open: boolean) => void
  /** 打开浏览器面板（嵌入主窗口右侧） */
  browserOpen: () => Promise<void>
  /** 关闭浏览器面板 */
  browserClose: () => Promise<void>
  /** 设置左侧 Sidebar 宽度（拖拽分隔条时调用） */
  setSidebarWidth: (px: number) => void
  /** 设置右侧计划面板宽度（拖拽分隔条时调用） */
  setTodoPanelWidth: (px: number) => void
  /** 设置文件工坊侧栏宽度（拖拽手柄时调用） */
  setWorkshopWidth: (px: number) => void
  /** 切换文件工坊全屏展开 */
  setWorkshopFullscreen: (on: boolean) => void
  /** 折叠/展开左侧 Sidebar（折叠时收成图标条） */
  setSidebarCollapsed: (collapsed: boolean) => void
  /** 设置当前文件预览路径（同步推送主进程供 AI 上下文注入） */
  setPreviewingFilePath: (path: string | null) => void
  /** 打开右侧面板标签页（若已存在则切换到该标签，否则新增并激活） */
  openRightPanelTab: (tab: RightPanelTabId) => void
  /** 关闭右侧面板标签页（关闭后自动切换到相邻标签，无标签则面板收起） */
  closeRightPanelTab: (tab: RightPanelTabId) => void
  /** 切换右侧面板激活标签页 */
  setActiveRightPanel: (tab: RightPanelTabId) => void
  /** 打开右侧抽屉面板（轻量面板 overlay，关闭已有抽屉再开新的） */
  openDrawer: (tab: RightPanelTabId) => void
  /** 关闭右侧抽屉面板 */
  closeDrawer: () => void
  /** 浏览器导航 */
  browserNavigate: (url: string) => Promise<void>
  /** 浏览器后退（像真浏览器一样直接操作） */
  browserBack: () => Promise<void>
  /** 浏览器前进（像真浏览器一样直接操作） */
  browserForward: () => Promise<void>
  /** 浏览器点击元素 */
  browserClick: (selector: string) => Promise<void>
  /** 浏览器输入文本 */
  browserType: (selector: string, text: string, clear?: boolean) => Promise<void>
  /** 浏览器滚动 */
  browserScroll: (direction: 'up' | 'down', amount?: number) => Promise<void>
  /** 浏览器截图（返回文件路径/dataUrl，供"截图发送到会话"使用） */
  browserScreenshot: (fullPage?: boolean) => Promise<{
    ok: boolean
    data?: { path: string; dataUrl: string; size: number }
    error?: string
  } | undefined>
  /** 浏览器执行 JS（返回执行结果） */
  browserEvaluate: (script: string) => Promise<{
    ok: boolean
    data?: { result: unknown }
    error?: string
  } | undefined>
  /** 初始化浏览器事件监听（应用启动时调用一次） */
  initBrowserEvents: () => () => void

  // ===== 代码沙箱面板 actions =====
  /** 打开代码沙箱面板 */
  sandboxOpen: () => Promise<void>
  /** 关闭代码沙箱面板 */
  sandboxClose: () => void
  /** 切换语言 */
  sandboxSetLanguage: (lang: CodeLanguage) => void
  /** 设置代码内容 */
  sandboxSetCode: (code: string) => void
  /** 执行代码（流式输出） */
  sandboxRun: () => Promise<void>
  /** 清空输出 */
  sandboxClearOutput: () => void
  /** 初始化流式订阅（应用启动时调用一次） */
  initSandboxStreams: () => () => void
  /** 加载可用执行器列表 */
  sandboxLoadExecutors: () => Promise<void>
}