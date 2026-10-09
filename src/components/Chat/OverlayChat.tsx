/**
 * 为什么存在：主窗口聊天区与独立悬浮小窗是两条独立渲染链路（?overlay=1 单独开窗），
 * 小窗需自己维护消息收发——独立成文件避免把双通道逻辑胶合进主聊天组件。
 * 作用：独立悬浮小窗聊天视图，经 overlay:state 接收主窗口推送、经 overlay:send 等
 * 转发用户动作（发送/中止/附件/联网开关），无框窗口支持系统级拖动。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Square, X, GripHorizontal, Paperclip, Globe, FileText } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'

/**
 * 独立悬浮小窗的聊天视图（?overlay=1 路由）

 * 数据通道：
 * - 主窗口通过 overlay:state 推送消息/状态/主题/联网开关/待发附件
 * - 本窗口通过 overlay:send / abort / add-attachment / remove-attachment / toggle-websearch
 * 经主进程转发给主窗口 store 执行

 * 无框窗口：标题栏 -webkit-app-region: drag 系统级拖动，可移出主窗口到桌面任意位置。
 */

/** 小窗消息投影：主窗口推送完整 ChatMessage[]，这里仅取渲染所需字段 */
type OverlayMsg = Pick<ChatMessage, 'id' | 'role' | 'content' | 'attachments'>

interface PendingAtt {
  name: string
  type: string
  size: number
}

const THEME_CLASSES = ['frost-glass', 'parchment', 'night', 'violet-night', 'eclipse', 'gilded']

export function OverlayChat() {
  const [messages, setMessages] = useState<OverlayMsg[]>([])
  const [status, setStatus] = useState<string>('idle')
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [aiName, setAiName] = useState<string>('月蚀')
  const [theme, setTheme] = useState<string>('eclipse')
  const [webSearchEnabled, setWebSearchEnabled] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAtt[]>([])
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 订阅主窗口推送
  useEffect(() => {
    const unsub = window.lunareclipse?.overlayOnState?.((state) => {
      setMessages((state.messages ?? []) as OverlayMsg[])
      setStatus(state.status ?? 'idle')
      setStreamingMessageId(state.streamingMessageId ?? null)
      if (state.aiName) setAiName(state.aiName)
      if (state.theme) setTheme(state.theme)
      setWebSearchEnabled(!!state.webSearchEnabled)
      setPendingAttachments((state.pendingAttachments ?? []) as PendingAtt[])
    })
    void window.lunareclipse?.overlayRequestState?.()
    return () => unsub?.()
  }, [])

  // 应用主题类（小窗独立 renderer，需自行设置 html 主题）
  useEffect(() => {
    const html = document.documentElement
    html.classList.remove(...THEME_CLASSES, 'dark')
    html.classList.add(theme)
  }, [theme])

  // 消息变化自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  // textarea 自适应
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px'
  }, [input])

  const isStreaming = status === 'streaming'

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (isStreaming) return
    if (!text && pendingAttachments.length === 0) return
    setInput('')
    await window.lunareclipse?.overlaySend?.(text)
  }, [input, isStreaming, pendingAttachments.length])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const handleClose = () => {
    void window.lunareclipse?.overlayClose?.()
  }

  // 附件选择：Electron File 对象可拿磁盘路径；图片额外读 dataUrl 用于预览
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files) return
    for (const file of Array.from(files)) {
      if (file.size > 8 * 1024 * 1024) continue
      const path = window.lunareclipse?.getPathForFile?.(file) ?? ''
      let dataUrl: string | undefined
      if (file.type.startsWith('image/')) {
        try {
          dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader()
            r.onload = () => resolve(r.result as string)
            r.onerror = () => reject(r.error)
            r.readAsDataURL(file)
          })
        } catch { /* ignore */ }
      }
      await window.lunareclipse?.overlayAddAttachment?.({
        name: file.name,
        path,
        size: file.size,
        type: file.type || 'application/octet-stream',
        dataUrl
      })
    }
    e.target.value = ''
  }

  const recentMessages = messages.slice(-40)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg-surface">
      {/* 标题栏（系统级拖动区） */}
      <div
        className="flex shrink-0 cursor-move items-center gap-2 border-b border-border-subtle px-3 py-2 select-none"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <GripHorizontal size={13} className="text-fg-muted shrink-0" />
        <span className="text-caption font-medium text-fg-primary truncate flex-1">{aiName}</span>
        <button
          onClick={handleClose}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title="关闭"
        >
          <X size={12} />
        </button>
      </div>

      {/* 消息列表 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2 min-h-0">
        {recentMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-caption text-fg-muted">
            开始与 {aiName} 对话...
          </div>
        ) : (
          recentMessages.map((msg) => {
            const isUser = msg.role === 'user'
            const isStreamingThis = streamingMessageId === msg.id
            return (
              <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[88%] rounded-lg px-2.5 py-1.5 text-[12.5px] leading-relaxed ${
                    isUser
                      ? 'bg-accent/15 text-fg-primary'
                      : 'bg-bg-muted/50 text-fg-secondary'
                  }`}
                >
                  <MarkdownRenderer
                    content={msg.content || ((msg.attachments?.length ?? 0) > 0 ? '' : isStreamingThis ? '' : '(空)')}
                    streaming={isStreamingThis}
                  />
                  {/* 附件：图片带 dataUrl 内联缩略图预览，其余文件图标+名称（与主会话 MessageBubble 同款式） */}
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {msg.attachments.map((a, i) => {
                        const isImage = a.type.startsWith('image/')
                        const sizeStr = a.size > 1024 * 1024
                          ? `${(a.size / 1024 / 1024).toFixed(1)} MB`
                          : `${(a.size / 1024).toFixed(1)} KB`
                        return isImage && a.dataUrl ? (
                          <div
                            key={i}
                            className="flex flex-col gap-1 rounded-md bg-bg-surface/40 p-1"
                            title={a.path}
                          >
                            <img
                              src={a.dataUrl}
                              alt={a.name}
                              className="max-h-40 max-w-52 rounded object-cover"
                            />
                            <div className="flex items-center gap-1 px-0.5 text-caption">
                              <span className="max-w-[120px] truncate text-fg-secondary">{a.name}</span>
                              <span className="shrink-0 text-fg-muted">{sizeStr}</span>
                            </div>
                          </div>
                        ) : (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 rounded-md bg-bg-surface/40 px-2 py-1 text-caption"
                            title={a.path}
                          >
                            <span className="text-fg-muted">{isImage ? '🖼️' : '📄'}</span>
                            <span className="max-w-[120px] truncate">{a.name}</span>
                            <span className="shrink-0 text-fg-muted">{sizeStr}</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* 待发附件条 */}
      {pendingAttachments.length > 0 && (
        <div className="shrink-0 border-t border-border-subtle px-2 py-1.5 flex flex-wrap gap-1">
          {pendingAttachments.map((att, i) => (
            <span
              key={`${att.name}-${i}`}
              className="flex items-center gap-1 rounded bg-bg-muted/60 px-1.5 py-0.5 text-[11px] text-fg-secondary max-w-full"
            >
              <FileText size={10} className="shrink-0" />
              <span className="truncate">{att.name}</span>
              <button
                onClick={() => void window.lunareclipse?.overlayRemoveAttachment?.(i)}
                className="shrink-0 text-fg-muted hover:text-danger"
                title="移除附件"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 输入区 */}
      <div className="shrink-0 border-t border-border-subtle p-2">
        {/* 能力按钮行 */}
        <div className="mb-1.5 flex items-center gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title="添加附件"
          >
            <Paperclip size={12} />
          </button>
          <button
            onClick={() => void window.lunareclipse?.overlayToggleWebSearch?.()}
            className={`flex h-6 items-center gap-1 rounded px-1.5 text-[11px] ${
              webSearchEnabled
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-primary'
            }`}
            title={webSearchEnabled ? '联网搜索：开' : '联网搜索：关'}
          >
            <Globe size={12} />
            联网
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleFileSelect(e)}
          />
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息... (Enter 发送)"
            rows={1}
            className="flex-1 resize-none rounded-md border border-border bg-bg-elevated px-2.5 py-1.5 text-[12.5px] text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none min-h-[32px] max-h-[100px]"
          />
          {isStreaming ? (
            <button
              onClick={() => void window.lunareclipse?.overlayAbort?.()}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-danger/15 text-danger hover:bg-danger/25"
              title="停止"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() && pendingAttachments.length === 0}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-fg hover:bg-accent/90 disabled:opacity-30 disabled:cursor-not-allowed"
              title="发送"
            >
              <Send size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
