/**
 * 为什么存在：浏览器面板是原生 WebContentsView 会盖住 React DOM，聊天必须用
 * 独立置顶 BrowserWindow 悬浮；本文件是主窗口侧的桥接控制器（不渲染 DOM）。
 * 作用：按非 chat 标签页自动开/关小窗、同步 overlay:state 下发消息与主题，
 * 并转发小窗的 send/abort/附件/联网开关等请求。
 */
import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'

/**
 * 聊天小窗控制器（主窗口侧，不渲染任何 DOM）
 *
 * 背景：浏览器面板是原生 WebContentsView，会盖住一切 React DOM，且 DOM 无法穿出主窗口。
 * 因此小卡片直接就是独立置顶 BrowserWindow（见 electron/main/overlay-window.ts）：
 *
 * - 非 chat 标签页自动打开，置顶浮在最上面；切回 chat / 打开全屏浮层时自动关闭
 * - 拖小窗标题栏可到桌面任意位置，无边界限制，无需按钮
 * - 用户手动关窗后本次停留不再弹；切走再切回重新出现
 *
 * 桥接：
 * - 主窗口 → 小窗：overlay:state（消息/状态/主题/联网开关/待发附件）
 * - 小窗 → 主窗口：send / abort / add-attachment / remove-attachment / toggle-websearch
 *
 * 性能约束（为什么存在）：本组件常驻主窗口且订阅全部 messages——
 * 若每次消息变化都把完整 ChatMessage[]（含 rows/reasoning/toolCalls 全文）走 IPC
 * 推给小窗，流式输出时每 token 都会在主渲染线程同步序列化整份会话（Electron IPC
 * 序列化发生在调用方线程），AI 输出一多主线程就被拖死，表现为"渲染到一半不显示、
 * 必须切页再回来才恢复"。修复策略：
 * 1. 小窗未打开（visible=false）时零推送——主界面聊天完全不背这个开销；
 * 2. 只推小窗渲染所需的最近 N 条的最小字段（id/role/content/attachments），
 * 与 OverlayChat.recentMessages 的 slice(40) 对齐，体积降一个数量级；
 * 3. 流式高频变化走防抖合并（150ms），不每 token 打一次 IPC。
 */
import type { ChatMessage } from '@shared/types'

/** 小窗只渲染最近 N 条（与 OverlayChat.recentMessages 的 slice(-40) 对齐） */
const OVERLAY_MESSAGES_LIMIT = 40
/** 流式输出等高频状态变化的推送防抖窗口：合并中间帧，避免每 token 一次全量 IPC */
const OVERLAY_PUSH_DEBOUNCE_MS = 150

/** 小窗消息投影：主窗口推送的最小字段（与 OverlayChat 的 OverlayMsg 一致） */
type OverlayMsg = Pick<ChatMessage, 'id' | 'role' | 'content' | 'attachments'>

interface OverlayState {
  messages: OverlayMsg[]
  status: string
  streamingMessageId: string | null
  aiName: string
  theme: string
  webSearchEnabled: boolean
  pendingAttachments: Array<{ name: string; type: string; size: number }>
}

export function ChatOverlay() {
  const activeTab = useAppStore((s) => s.activeRightPanel)
  const vizPanelOpen = useAppStore((s) => s.vizPanelOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)

  const visible = activeTab !== 'chat' && !vizPanelOpen && !settingsOpen

  const messages = useAppStore((s) => s.currentMessages ?? EMPTY_MESSAGES)
  const sendMessage = useAppStore((s) => s.sendMessage)
  const abortStream = useAppStore((s) => s.abortStream)
  const status = useAppStore((s) => s.status)
  const streamingMessageId = useAppStore((s) => s.streamingMessageId)
  const aiName = useAppStore((s) => s.config.aiName) || '月蚀'
  const theme = useAppStore((s) => s.config.theme)
  const webSearchEnabled = useAppStore((s) => s.config.webSearchEnabled)
  const pendingAttachments = useAppStore((s) => s.pendingAttachments)
  const addAttachment = useAppStore((s) => s.addAttachment)
  const removeAttachment = useAppStore((s) => s.removeAttachment)

  // 用户手动关闭标记
  const userClosedRef = useRef(false)

  // 待发附件的轻量投影（不含 dataUrl，避免每次消息变更都推大图）
  // useMemo：避免每次渲染新建数组触发下方推送 effect 空跑
  const attachmentMeta = useMemo(
    () =>
      pendingAttachments.map((a) => ({
        name: a.name,
        type: a.type,
        size: a.size
      })),
    [pendingAttachments]
  )

  // 最新构建的推送状态 + 防抖定时器：状态高频变化时合并推送
  const latestStateRef = useRef<OverlayState | null>(null)
  const debounceTimerRef = useRef<number | null>(null)

  /** 立即把最新状态推给小窗（visible 打开瞬间 / state-requested 回调共用） */
  const pushNow = () => {
    if (!latestStateRef.current) return
    void window.lunareclipse?.overlayPushState?.(latestStateRef.current)
  }

  // 状态 → 推送小窗（仅小窗可见时；精简字段 + 防抖，避免流式输出时每 token
  // 在主渲染线程同步序列化全量会话导致 UI 卡死）
  useEffect(() => {
    if (!visible) return
    latestStateRef.current = {
      messages: messages.slice(-OVERLAY_MESSAGES_LIMIT).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content ?? '',
        attachments: m.attachments ?? []
      })),
      status,
      streamingMessageId,
      aiName,
      theme,
      webSearchEnabled: !!webSearchEnabled,
      pendingAttachments: attachmentMeta
    }
    // 防抖合并：流式期间有多个 change 到达时只保留最后一个尾沿推送
    if (debounceTimerRef.current != null) return
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null
      pushNow()
    }, OVERLAY_PUSH_DEBOUNCE_MS)
    return () => {
      if (debounceTimerRef.current != null) {
        clearTimeout(debounceTimerRef.current)
        debounceTimerRef.current = null
      }
    }
  }, [messages, status, streamingMessageId, aiName, theme, webSearchEnabled, attachmentMeta, visible])

  // visible 变化 → 开/关小窗
  useEffect(() => {
    if (visible) {
      if (!userClosedRef.current) {
        void window.lunareclipse?.overlayOpen?.()
      }
      // 打开即推一次（小窗 ready 后会发 state-requested 再补一次最新状态）
      pushNow()
    } else {
      userClosedRef.current = false
      void window.lunareclipse?.overlayClose?.()
    }
  }, [visible])

  // 小窗加载完成请求初始状态：监听器只注册一次，回调经 ref 读最新状态
  // （不把 messages 等放进依赖——流式时每 token 重建监听器是纯浪费）
  useEffect(() => {
    const off = window.lunareclipse?.onOverlayStateRequested?.(() => {
      pushNow()
    })
    return () => off?.()
  }, [])

  // 小窗 → 发消息 / 停止
  useEffect(() => {
    const offSend = window.lunareclipse?.onOverlaySendRequest?.((text) => {
      void sendMessage(text)
    })
    const offAbort = window.lunareclipse?.onOverlayAbortRequest?.(() => {
      abortStream()
    })
    return () => {
      offSend?.()
      offAbort?.()
    }
  }, [sendMessage, abortStream])

  // 小窗 → 附件增删
  useEffect(() => {
    const offAdd = window.lunareclipse?.onOverlayAddAttachmentRequest?.((att) => {
      addAttachment(att)
    })
    const offRemove = window.lunareclipse?.onOverlayRemoveAttachmentRequest?.((index) => {
      removeAttachment(index)
    })
    return () => {
      offAdd?.()
      offRemove?.()
    }
  }, [addAttachment, removeAttachment])

  // 小窗 → 切换联网搜索
  useEffect(() => {
    const off = window.lunareclipse?.onOverlayToggleWebSearchRequest?.(async () => {
      const st = useAppStore.getState()
      const nextConfig = { ...st.config, webSearchEnabled: !st.config.webSearchEnabled }
      await window.lunareclipse.setConfig(nextConfig)
      useAppStore.setState({ config: nextConfig })
    })
    return () => off?.()
  }, [])

  // 用户手动关窗
  useEffect(() => {
    const off = window.lunareclipse?.onOverlayClosed?.(() => {
      userClosedRef.current = true
    })
    return () => off?.()
  }, [])

  return null
}

const EMPTY_MESSAGES: import('@shared/types').ChatMessage[] = []
