/**
 * 为什么存在：莉莉丝是游戏联动 AI，需独立会话视图承载实时双击（点按）玩法交互，
 * 且数据经月蚀后端代理绕 CORS，与主聊天 UI 分离。
 * 作用：渲染莉莉丝会话视图——在线状态/双击提示、消息流与输入框，
 * 数据走 /api/lilith/* 代理并通过 lilithSlice 开合。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Heart, Send, Radio, Square, AlertTriangle } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'

/**
 * 莉莉丝会话视图：会话栏置顶独立会话，主聊天窗口呈现。
 * - 数据走月蚀后端代理（/api/lilith/* → companion API，绕 CORS + 注入 token）
 * - 上下文与游戏内莉莉丝同源：companion 调月蚀 /chat/completions 桥接 → 同一份记忆
 * - 显示游戏/MOD 在线状态，消息带 emotion 标签（与游戏内动画同步）
 */

interface LilithMsg {
  role: 'user' | 'assistant'
  content: string
  emotion?: string
}

interface LilithStatus {
  running: boolean
  reason?: string
  mock_mode?: boolean
  character_id?: string
  game_pid?: number
  token_ok?: boolean
  /** 莉莉丝插件总开关：false = 已停用 */
  enabled?: boolean
  /** companion（游戏内同步）是否在跑 */
  companion_running?: boolean
}

const EMOTION_LABEL: Record<string, string> = {
  happy: '开心', sad: '难过', angry: '生气', surprised: '惊讶',
  shy: '害羞', thinking: '思考', neutral: '平静', listen: '聆听',
  love: '心动', sleepy: '困倦', excited: '兴奋', worried: '担心'
}

function apiBase(): string {
  const port = window.lunareclipse?.getApiPort?.()
  return port ? `http://127.0.0.1:${port}` : ''
}

export function LilithPanel() {
  const lilithChatOpen = useAppStore((s) => s.lilithChatOpen)
  // 总开关关闭时隐藏窗口（与侧栏入口联动）
  const lilithEnabled = useAppStore((s) => s.config.lilith?.enabled !== false)
  if (!lilithEnabled || !lilithChatOpen) return null
  return <LilithChatView />
}

function LilithChatView() {
  const [status, setStatus] = useState<LilithStatus | null>(null)
  const [messages, setMessages] = useState<LilithMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  /** 当前请求的 AbortController（停止按钮用） */
  const abortRef = useRef<AbortController | null>(null)
  /** 中断原因：timeout=超时 / user=用户点停止（提示文案区分） */
  const abortReasonRef = useRef<'timeout' | 'user' | null>(null)
  /** 清空等操作的结果提示（成功/失败均可见），4 秒后自动消失 */
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  /** 短暂展示一条操作提示：这是清空等异步操作唯一的成败反馈通道，
   * 失败必须可见，否则用户会误以为清空已生效——禁止移除。 */
  const flashNotice = (msg: string) => {
    setNotice(msg)
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 4000)
  }

  // 卸载时清理提示定时器，避免组件销毁后 setState 泄漏
  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase()}/api/lilith/status`)
      setStatus(await r.json())
    } catch {
      setStatus({ running: false, reason: '月蚀后端不可达' })
    }
  }, [])

  const refreshHistory = useCallback(async () => {
    try {
      const r = await fetch(`${apiBase()}/api/lilith/history`)
      const data = await r.json()
      if (Array.isArray(data.messages)) {
        const next = data.messages.map((m: { role?: string; content?: string }) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content : ''
        })).filter((m: LilithMsg) => m.content)
        // 内容未变化时不重绘，避免轮询导致列表闪烁/滚动跳动
        setMessages((prev) => {
          if (prev.length === next.length && prev.every((m, i) => m.role === next[i].role && m.content === next[i].content)) {
            return prev
          }
          return next
        })
      }
    } catch {
      /* companion 未运行，忽略 */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshHistory()
    // history 也轮询：游戏内莉莉丝新对话自动同步到面板
    const t = setInterval(() => {
      refreshStatus()
      refreshHistory()
    }, 5000)
    return () => clearInterval(t)
  }, [refreshStatus, refreshHistory])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const send = async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    setMessages((ms) => [...ms, { role: 'user', content: text }])
    // 超时保护：莉莉丝回复是非流式（fetch 等全部生成完才返回），
    // agent 模式 8 轮工具循环可能几分钟——没有超时会让 sending 永久锁死（"思考中…" + 发不出消息）。
    // 180 秒超时：sending 复位 + 提示，用户可重试；主进程继续跑完后写 sessions（不丢回复）。
    const ac = new AbortController()
    abortRef.current = ac
    abortReasonRef.current = null
    const timer = setTimeout(() => {
      abortReasonRef.current = 'timeout'
      ac.abort()
    }, 180_000)
    try {
      const r = await fetch(`${apiBase()}/api/lilith/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: ac.signal
      })
      const data = await r.json()
      if (data.text) {
        setMessages((ms) => [...ms, { role: 'assistant', content: data.text, emotion: data.ui?.emotion }])
      } else {
        setMessages((ms) => [...ms, { role: 'assistant', content: `⚠️ ${data.error || '无回复'}` }])
      }
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError'
      const reason = abortReasonRef.current
      setMessages((ms) => [
        ...ms,
        {
          role: 'assistant',
          content: aborted
            ? reason === 'user'
              ? '🛑 已停止（她的思考被打断，还没说完）。可以再发一条。'
              : '⏳ 回复超时（她还在后台思考/做事，长任务可能要好几分钟）。你可以稍后再发一条，或等她忙完。'
            : `⚠️ 请求失败：${(e as Error).message}`
        }
      ])
    } finally {
      clearTimeout(timer)
      abortRef.current = null
      abortReasonRef.current = null
      setSending(false)
    }
  }

  /** 用户主动中断当前回复 */
  const stop = () => {
    if (!abortRef.current) return
    abortReasonRef.current = 'user'
    abortRef.current.abort()
  }

  /** 清空莉莉丝会话（独立清空入口） */
  const clearSession = async () => {
    if (!window.confirm('清空莉莉丝的对话上下文？（游戏内黑框和这里的对话记录都会清空）')) return
    try {
      const r = await fetch(`${apiBase()}/api/lilith/clear`, { method: 'POST' })
      const data = await r.json()
      if (data.ok) {
        setMessages([])
        flashNotice('已清空莉莉丝的上下文')
      } else {
        flashNotice(data.error ? `清空失败：${data.error}` : '清空失败（后端未确认）')
      }
    } catch (err) {
      flashNotice(`清空失败：${(err as Error).message}`)
    }
  }

  return (
    <main className="flex flex-1 flex-col bg-bg-base">
      {/* 头部：状态 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
        <Heart size={13} className="text-accent" />
        <span className="text-caption font-medium text-fg-primary">莉莉丝</span>
        <span
          className={`flex items-center gap-1 text-[10px] ${
            status?.enabled === false ? 'text-fg-muted' : status?.running ? 'text-emerald-500' : 'text-fg-muted'
          }`}
          title={status?.reason}
        >
          <Radio size={10} className={status?.running && status?.enabled !== false ? 'animate-pulse' : ''} />
          {status?.enabled === false
            ? '已停用'
            : status?.running
              ? `已连接${status.companion_running ? ' · 游戏中' : ' · 月蚀大脑'}${status.game_pid ? ` (PID ${status.game_pid})` : ''}${status.mock_mode ? ' · 模拟模式' : ''}`
              : '未连接'}
        </span>
        <button
          onClick={clearSession}
          className="ml-auto rounded px-2 py-0.5 text-[10px] text-fg-muted hover:bg-bg-elevated hover:text-fg-primary"
          title="清空莉莉丝的对话上下文"
        >
          清空
        </button>
      </div>

      {/* 操作提示条：清空等异步操作的成败反馈，失败时用户必须能看到（否则误以为已生效） */}
      {notice && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-danger-soft/30 bg-danger-soft/10 px-4 py-1 text-[10px] text-danger" role="status">
          <AlertTriangle size={10} />
          {notice}
        </div>
      )}

      {/* 消息列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-4">
        {loading && (
          <div className="py-8 text-center text-caption text-fg-muted">加载会话历史…</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="py-8 text-center text-caption text-fg-muted">
            还没有对话。和游戏里的莉莉丝聊天，或在这里开始——
            <br />
            游戏内与这里共享同一份上下文。
          </div>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-2.5">
          {messages.map((m, i) => (
            <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <span className="mb-0.5 px-1 text-[10px] text-fg-muted">
                {m.role === 'user' ? '你' : '莉莉丝'}
              </span>
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
                  m.role === 'user'
                    ? 'rounded-br-sm bg-accent text-accent-fg'
                    : 'rounded-bl-sm border border-border-subtle bg-bg-elevated text-fg-primary'
                }`}
              >
                {m.role === 'assistant' && m.emotion && EMOTION_LABEL[m.emotion] && (
                  <span className="mb-1 block text-[10px] text-fg-muted">
                    ♥ {EMOTION_LABEL[m.emotion]}
                  </span>
                )}
                {m.content}
              </div>
            </div>
          ))}
          {sending && (
            <div className="flex justify-start">
              <div className="rounded-lg rounded-bl-sm border border-border-subtle bg-bg-elevated px-3 py-2 text-[12.5px] text-fg-muted shadow-sm">
                思考中…
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 输入区 */}
      <div className="border-t border-border-subtle bg-bg-surface px-6 py-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder={status?.running ? '对莉莉丝说点什么…' : '游戏未运行，消息会暂时无法送达'}
            rows={1}
            className="max-h-[200px] flex-1 resize-none rounded-card border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
          />
          {sending ? (
            <button
              onClick={stop}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-warning/90 px-3 text-caption text-warning-fg transition-all duration-150 hover:bg-warning active:scale-95"
              title="停止生成"
            >
              <Square size={12} />
              <span>停止</span>
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="flex h-8 shrink-0 items-center gap-1.5 rounded-btn bg-accent px-3 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95 disabled:opacity-30"
              title="发送"
            >
              <Send size={12} />
              <span>发送</span>
            </button>
          )}
        </div>
      </div>
    </main>
  )
}
