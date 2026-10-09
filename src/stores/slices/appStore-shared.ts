/**
 * 为什么存在：zustand store 对象字面量内不能声明 let，slice 拆分后可变运行时状态
 * （重连定时器/订阅集合等）必须收敛到唯一收容点保证跨 slice 共享语义。
 * @category 前端状态
 * @summary appStore 的共享常量 / 模块级运行时状态 / 纯辅助函数（slice 拆分共用，无 store 依赖）

 * 说明：zustand store 对象字面量内不能声明 let，原 appStore.ts 把可变状态全部声明在模块级。
 * 拆成 slice 后这些状态收敛到 wsRuntime 单例对象，各 slice 通过 wsRuntime.xxx 读写，
 * 保持跨 slice 共享语义（initApp 建 WS → systemSlice 写 wsRuntime.wsReconnectTimer；
 * sandboxRun 写 wsRuntime.sandboxRunFallbackTimer → cleanupApp 清理同一对象）。
 */
import type {
  ChatMessage,
  InternalSession,
  InternalSessionSummary
} from '@shared/types'
import type { CodeLanguage } from '../../../electron/main/tools/code-sandbox'
import type { AppState, ActiveToolCall, RightPanelTabId } from '../appStore-types'

/** WS 发送前裁剪预算：超大会话全量发送会超出 ws maxPayload 断连（见 trimMessagesForWs 注释） */
export const WS_MESSAGE_BUDGET_CHARS = 2 * 1024 * 1024

/** WS 重连最大延迟（指数退避上限） */
export const WS_RECONNECT_MAX_DELAY_MS = 30000
/** 沙箱运行兜底超时（主进程超时 10s + 余量） */
export const SANDBOX_FALLBACK_TIMEOUT_MS = 35000
/** 沙箱代码执行超时（毫秒） */
export const CODE_RUN_TIMEOUT_MS = 10000
/** 浏览器历史最大条数 */
export const BROWSER_HISTORY_MAX = 100
/** 侧边栏宽度范围（像素） */
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 420
export const DEFAULT_SIDEBAR_WIDTH = 210
/** 计划面板宽度范围（像素） */
export const TODO_PANEL_MIN_WIDTH = 160
export const TODO_PANEL_MAX_WIDTH = 420
export const DEFAULT_TODO_PANEL_WIDTH = 224
/** 文件工坊侧栏宽度范围（像素） */
export const WORKSHOP_MIN_WIDTH = 280
export const WORKSHOP_MAX_WIDTH = 600
export const DEFAULT_WORKSHOP_WIDTH = 380

/**
 * 会话隔离：切换/新建/删除会话时需清除的残留状态。
 * 避免跨会话数据泄漏（上一会话的 token 计数、工具调用、内部会话等残留到新会话）。
 */
export const SESSION_RESET_FIELDS = {
  activeToolCalls: [] as ActiveToolCall[],
  lastTokenCount: null,
  lastTokenBudget: null,
  lastDroppedCount: 0,
  contextWarning: null,
  lastUsage: null,
  internalSessions: [] as InternalSessionSummary[],
  activeInternalSession: null as InternalSession | null,
  activeInternalId: null as string | null
} as const

/** 轻量面板集合：这些面板用右侧抽屉 overlay 展开，不走标签页系统 */
export const LIGHT_PANELS: RightPanelTabId[] = ['todo', 'calendar', 'skill', 'hook', 'plugin', 'cron', 'workshop', 'admin', 'backup', 'friend', 'chatRoom', 'publishBoard', 'ai', 'profile']

/**
 * WS 发送前裁剪：会话消息数组可能被 AI 工具输出撑到几百 MB（实测 254MB），
 * 全量发送会超出服务器 ws maxPayload 导致连接被销毁（"[连接中断]" 循环）。
 * 从尾部（最新）往前保留，预算 2MB 字符——后端 buildInjectedMessages 本来
 * 就按 token 预算截断（16000 软预算），前端提前裁剪语义等价，只少传输垃圾。
 * 最新一条消息总是保留（防止刚发的用户消息被裁掉）。
 */
export function trimMessagesForWs(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages
  const kept: ChatMessage[] = []
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const size =
      (m.content?.length ?? 0) +
      (m.reasoning?.length ?? 0) +
      (Array.isArray(m.attachments)
        ? m.attachments.reduce((s, a) => s + (a.dataUrl?.length ?? 0), 0)
        : 0)
    // 第一条（最新）无条件保留；其后超预算即停
    if (kept.length > 0 && total + size > WS_MESSAGE_BUDGET_CHARS) break
    kept.unshift(m)
    total += size
  }
  return kept
}

/**
 * 模块级可变运行时状态（原 appStore.ts 顶部的 let 声明收敛为单例对象：
 * store 对象字面量内不能声明 let，且需要跨 slice / 跨 action 调用共享）。
 */
export const wsRuntime = {
  /** initApp 初始化守卫：React 18 StrictMode 下 useEffect 会执行两次，避免重复创建 WS/心跳 */
  initStarted: false,
  /** initApp 注册的 IPC 订阅器集合，cleanupApp 必须释放，防止叠加监听 */
  appUnsubscribers: [] as Array<() => void>,
  /** 递增计数器，防止同一毫秒内生成相同消息 ID */
  idCounter: 0,
  /** WS 重连指数退避计数器 */
  wsRetryCount: 0,
  /** WS 重连定时器句柄（cleanupApp 时需清除，防止泄漏） */
  wsReconnectTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  /** 莉莉丝会话切走前的会话上下文快照（openLilithChat 存 / closeLilithChat 恢复） */
  lilithPrevSession: null as { sessionId: string | null; messages: ChatMessage[] } | null,
  /** 沙箱运行状态兜底定时器：code:done 丢失时强制复位 sandboxRunning */
  sandboxRunFallbackTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  /** 最近一次沙箱执行的语言和代码（onDone 回调无法从闭包获取，用模块级变量传递） */
  lastSandboxRunInfo: null as { language: CodeLanguage; code: string } | null
}

/** slice 工厂函数的 set 类型（zustand set 的子集：只用部分更新与函数式更新） */
export type SliceSet = (
  partial: Partial<AppState> | ((state: AppState) => Partial<AppState>)
) => void
/** slice 工厂函数的 get 类型 */
export type SliceGet = () => AppState

/** 递增计数器生成消息 ID（格式：{prefix}_{ts}_{seq}） */
export function nextMsgId(prefix: string): string {
  return `${prefix}_${Date.now()}_${wsRuntime.idCounter++}`
}

/** 构造受保护 HTTP API 请求头（本机令牌鉴权用；无令牌时返回空对象，后端返回 401 由调用方处理） */
export function authorizationHeaders(): Record<string, string> {
  const token = window.lunareclipse?.getApiToken?.()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function createWS(): WebSocket {
  // Electron 渲染进程 location.host 不可信（file:// 为空，dev 指向 Vite），
  // 必须通过 IPC 拿主进程动态分配的 API 端口
  const port = window.lunareclipse?.getApiPort?.()
  if (!port) {
    console.error('[ws] 无法获取 API 端口，WebSocket 连接失败')
  }
  // WS 握手令牌：后端 verifyClient 要求 ?token=<apiToken>，否则 401 拒绝。
  // 为什么存在：WS 无同源限制、CORS 拦不住，令牌是唯一能区分「本机渲染进程」与
  // 「本地任意恶意网页」的凭据（防止网页驱动 LLM/读写会话）。
  // 作用：把 preload 经 IPC 拿到的令牌拼进握手 URL，满足后端鉴权。
  const token = window.lunareclipse?.getApiToken?.()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const host = port ? `127.0.0.1:${port}` : location.host
  const wsUrl = `${proto}://${host}/ws${token ? `?token=${encodeURIComponent(token)}` : ''}`
  return new WebSocket(wsUrl)
}

// 重载/断线后同步后端真实流状态（前端是投影，磁盘快照可能已与后端脱节）
// WS 就绪后查询 /api/streams/active——后端此刻是否仍有流在跑、属于哪个会话哪条消息：
// - active=true → 后端仍有流在跑，发 takeover 接管：推送切到本连接、重放已生成内容、后续续接
// - active=false → 磁盘状态即真实状态，无需干预（旧逻辑靠猜磁盘半成品，盲区是 AI 消息尚未落盘时）
export function syncActiveStream(get: SliceGet): void {
  const port = window.lunareclipse?.getApiPort?.()
  if (!port) return
  // 带令牌获取运行中流状态：/api/streams/active 已纳入本机 API 鉴权（401 无令牌），
  // 渲染进程唯一合法调用方身份就是 Authorization: Bearer <apiToken>。
  fetch(`http://127.0.0.1:${port}/api/streams/active`, {
    headers: authorizationHeaders()
  })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json()
    })
    .then((info: { active: boolean; sessionId?: string; messageId?: string }) => {
      if (!info.active || !info.messageId) return
      // 接管：后端有流在跑，发 takeover 让后端把推送切到本连接并重放已生成内容。
      // 不 abort、不标 aborted——后台任务被前端看见并续接，而不是被掐死。
      const ws = get().ws
      // WS 必须处于 OPEN 状态才能 send，否则会抛 InvalidStateError
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'takeover', messageId: info.messageId }))
      }
    })
    .catch((err) => console.warn('[ws] 查询运行中流状态失败:', err))
}

/** 释放 initApp 注册的全部 IPC 订阅（幂等，单项失败不阻断其余） */
export function disposeAppSubscriptions(): void {
  for (const off of wsRuntime.appUnsubscribers) {
    try {
      off()
    } catch { /* 单个订阅清理失败不应阻断其余清理；幂等，忽略 */ }
  }
  wsRuntime.appUnsubscribers = []
}

/**
 * 统一浏览器原生 view 显隐决策（文档 15.3 核心修复）：
 * 浏览器 view 是 OS 层 WebContentsView，DOM 的 z-index / 遮罩盖不住它。
 * 因此"是否显示"必须由前端统一判定，避免监控面板/设置面板打开时 view 浮在上面。
 *
 * 显示条件：浏览器标签激活 && 无全屏浮层（监控面板/设置面板）
 * overlay 标志只跟全屏浮层挂钩：浮层打开时置 true，抑制主进程侧 show()
 * （由 browser:show/navigate IPC 或前端标签激活触发）自动恢复显示——
 * 否则任何一次 show() 都会让 view 浮在监控/设置面板之上。
 * 注意：非浏览器激活态（如未开面板）不抑制 show，前端标签激活/导航时 view 正常显示。
 */
export function syncBrowserVisibility(get: SliceGet): void {
  const s = get()
  // 抽屉面板不再隐藏浏览器视图——改为通过 right 预留让视图自然收缩
  const shouldShow = s.activeRightPanel === 'browser' && !s.vizPanelOpen && !s.settingsOpen
  const overlayOpen = s.vizPanelOpen || s.settingsOpen
  // 同步遮挡标志：全屏浮层打开时抑制 AI 工具自动 show()
  void window.lunareclipse?.browserSetOverlay?.(overlayOpen)
  if (shouldShow) {
    void window.lunareclipse?.browserShow?.()
  } else {
    window.lunareclipse?.browserHide?.()
  }
}