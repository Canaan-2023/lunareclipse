/**
 * @category CLI-TUI
 * @summary 月蚀 CLI 常驻终端界面主组件（Ink / React 渲染）
 *
 * 布局：顶部标题栏 → 消息区（滚动窗口，可见窗口取最后 N 行，输入框固定底部）
 * → 状态栏 → 输入框。
 *
 * 协议：本组件是 WS 客户端，复用 `app/electron/main/api/ws-protocol.ts` 的
 * 前端同款消息协议：
 *   - 发送 `{ type:'token', messages: ChatMessage[], sessionId, messageId }` 发起对话
 *   - 接收 `{ type:'token', payload: string, messageId }` 流式增量 → 追加到对应消息
 *   - 接收 `{ type:'reasoning', reasoning, messageId }` → 累积到消息 reasoning
 *   - 接收 `{ type:'done', messageId, finalContent }` → 用完整正文替换（后端已落盘）
 *   - 接收 `{ type:'error', payload, messageId }` → 显示错误并复位输入状态
 *
 * messageId 归属：主回复消息是我们发送时携带的 assistant 占位 id；后续审查轮
 * （review_ 星号 / rework_ 星号）after 主 done 到达时按 id 自动追加为独立消息，避免串台。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout, renderToString } from 'ink'
import type { ChatMessage } from '@shared/types'
import { TOOL_MAP } from '@shared/tools/registry'
import { wrapText } from './format'
import { PromptInput } from './PromptInput'

export interface SessionHandle {
  id: string
  messages: ChatMessage[]
}

/** WS 客户端最小接口（兼容 ws 包与 DOM WebSocket，避免依赖具体实现类型） */
export interface TuiWs {
  readyState: number
  send(data: string): void
  on(ev: string, cb: (data: unknown) => void): void
  off(ev: string, cb: (data: unknown) => void): void
}

export interface CliAppProps {
  ws: TuiWs
  initialSessionId: string
  initialMessages: ChatMessage[]
  port: number
  /** 自动发送模式（自动化验证用）：连接就绪后立即发送该消息，避免依赖手工输入 */
  autopilot?: string
  /** autopilot 主回复结束后回调完整界面帧文本（renderToString，非 tty 可验证/展示） */
  onAutopilotDone?: (frame: string) => void
  onExit: (code: number) => void
  newSession: () => SessionHandle
  switchSession: (id: string) => SessionHandle | null
}

/** ws 包消息负载（Buffer / ArrayBuffer / string）统一转 UTF-8 文本 */
function rawToString(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return String(data)
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** 独立 re-render 的流式 spinner（避免高频帧重绘整棵组件树） */
function Spinner(): React.JSX.Element {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % SPINNER_FRAMES.length), 90)
    return () => clearInterval(t)
  }, [])
  return <Text color="cyan">{SPINNER_FRAMES[i]}</Text>
}

/** AI 当前活动摘要：CLI 状态栏显示"思考中/正在调用工具/正在生成"（与桌面端 AiStatusBar 口径一致） */
export interface AiActivity {
  phase: 'thinking' | 'tool' | 'generating'
  /** 正在调用的工具名（phase === 'tool' 时有效） */
  toolName?: string
}

/** 工具名 → 中文标签（单一数据源：shared/tools/registry.ts 的 TOOL_MAP，与桌面端一致） */
function cliToolLabel(name: string): string {
  return TOOL_MAP[name]?.name ?? name
}

/** 按 messageId 更新消息；未知 id（审查轮）自动追加为新的 assistant 消息 */
function upsert(
  prev: ChatMessage[],
  id: string | undefined,
  updater: (m: ChatMessage) => ChatMessage
): ChatMessage[] {
  if (!id) return prev
  const idx = prev.findIndex((m) => m.id === id)
  if (idx >= 0) return prev.map((m, i) => (i === idx ? updater(m) : m))
  return [...prev, updater({ id, role: 'assistant', content: '', createdAt: Date.now() })]
}

export function CliApp(props: CliAppProps): React.JSX.Element {
  const { ws, port, onExit } = props
  const [sessionId, setSessionId] = useState(props.initialSessionId)
  const [messages, setMessages] = useState<ChatMessage[]>(props.initialMessages)
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<'idle' | 'streaming'>('idle')
  const [activity, setActivity] = useState<AiActivity | null>(null)
  const [wsReady, setWsReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusLine, setStatusLine] = useState<string>(`会话 ${props.initialSessionId}`)

  // ref 镜像（回调/事件处理器读取最新值，避免闭包过期）
  const seqRef = useRef(0)
  const startedMsgId = useRef<string | null>(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const statusRef = useRef(status)
  statusRef.current = status
  const activityRef = useRef<AiActivity | null>(activity)
  activityRef.current = activity
  const errorRef = useRef<string | null>(error)
  errorRef.current = error
  const sessionIdRef = useRef(sessionId)
  sessionIdRef.current = sessionId
  const wsReadyRef = useRef(wsReady)
  wsReadyRef.current = wsReady
  const inputHistoryRef = useRef<string[]>([])
  const histIdxRef = useRef(-1)
  const autopilotSentRef = useRef(false)
  const autopilotDeliveredRef = useRef(false)
  const deliverFrameRef = useRef(false)

  const { stdout } = useStdout()
  const width = Math.max(50, ((stdout as { columns?: number }).columns ?? 100) - 2)
  const height = (stdout as { rows?: number }).rows ?? 24
  // 消息区可见行由 buildFrameElement 内部按终端高度推导（预留：标题 1 + 分隔/状态 2 + 输入 1 + 快捷键提示 1）

  // ---- WS 生命周期 ----
  useEffect(() => {
    if (ws.readyState === 1 /* OPEN */) setWsReady(true)
    const onOpen = () => setWsReady(true)
    const onError = () => {
      setError('API 服务连接失败')
      setStatus('idle')
    }
    const onClose = () => {
      setWsReady(false)
      if (!autopilotSentRef.current) setError('API 服务连接已断开')
    }
    ws.on('open', onOpen)
    ws.on('error', onError)
    ws.on('close', onClose)
    return () => {
      ws.off('open', onOpen)
      ws.off('error', onError)
      ws.off('close', onClose)
    }
  }, [ws])

  // ---- WS 出站消息（流式增量 / 推理 / 完成 / 错误）----
  useEffect(() => {
    const onMessage = (data: unknown) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(rawToString(data)) as Record<string, unknown>
      } catch {
        return
      }
      const type = msg.type as string | undefined
      const messageId = msg.messageId as string | undefined

      if (type === 'token') {
        const payload = msg.payload
        if (typeof payload === 'string' && payload) {
          // 先同步更新 ref 事实源（帧导出/竞态读取用），再触发渲染
          messagesRef.current = upsert(messagesRef.current, messageId, (m) => ({
            ...m,
            content: m.content + payload
          }))
          setMessages((prev) => upsert(prev, messageId, (m) => ({ ...m, content: m.content + payload })))
          // 首个内容 token 到达：从"思考中"切换到"正在生成"
          setActivity((prev) => (prev && prev.phase === 'generating' ? prev : { phase: 'generating' }))
        }
        // 无 payload 的 token 消息（tokens/budget 元信息）忽略
      } else if (type === 'reasoning') {
        const reasoning = msg.reasoning
        if (typeof reasoning === 'string' && reasoning) {
          messagesRef.current = upsert(messagesRef.current, messageId, (m) => ({
            ...m,
            reasoning: (m.reasoning ?? '') + reasoning
          }))
          setMessages((prev) =>
            upsert(prev, messageId, (m) => ({ ...m, reasoning: (m.reasoning ?? '') + reasoning }))
          )
          // 思考内容到达（在工具调用/正文化之前）→ 显示"思考中"
          setActivity((prev) =>
            prev && prev.phase !== 'thinking' ? { phase: 'thinking' } : prev
          )
        }
      } else if (type === 'tool_start') {
        const toolName = typeof msg.toolName === 'string' ? msg.toolName : '未知工具'
        // 记录到消息行：附加一个 running 工具调用（与消息同树，不单独占状态位）
        messagesRef.current = upsert(messagesRef.current, messageId, (m) => ({
          ...m,
          toolCalls: [
            ...(m.toolCalls ?? []),
            {
              id: typeof msg.toolCallId === 'string' ? msg.toolCallId : `tc_${Date.now()}`,
              toolName,
              toolLabel: cliToolLabel(toolName),
              category: 'mechanism',
              args: {},
              status: 'running',
              startedAt: Date.now()
            }
          ]
        }))
        setMessages((prev) => upsert(prev, messageId, (m) => ({ ...m, toolCalls: (m.toolCalls ?? []).concat([
          {
            id: typeof msg.toolCallId === 'string' ? msg.toolCallId : `tc_${Date.now()}`,
            toolName,
            toolLabel: cliToolLabel(toolName),
            category: 'mechanism',
            args: {},
            status: 'running',
            startedAt: Date.now()
          }
        ]) })))
        setActivity({ phase: 'tool', toolName })
      } else if (type === 'tool_end') {
        // 把对应工具调用标记为完成（状态栏回落为纯文本生成阶段）
        messagesRef.current = upsert(messagesRef.current, messageId, (m) => ({
          ...m,
          toolCalls: (m.toolCalls ?? []).map((tc) =>
            tc.id === msg.toolCallId ? { ...tc, status: 'done' as const, endedAt: Date.now() } : tc
          )
        }))
        setMessages((prev) => upsert(prev, messageId, (m) => ({ ...m, toolCalls: (m.toolCalls ?? []).map((tc) =>
          tc.id === msg.toolCallId ? { ...tc, status: 'done' as const, endedAt: Date.now() } : tc
        ) })))
        // 若还有 running 工具，保持"正在调用"；否则回落"正在生成"
        setActivity((prev) => {
          if (prev && prev.phase === 'tool') {
            const running = messagesRef.current
              .flatMap((m) => m.toolCalls ?? [])
              .some((tc) => tc.status === 'running')
            return running ? prev : { phase: 'generating' }
          }
          return prev
        })
      } else if (type === 'done') {
        const finalContent = msg.finalContent
        if (typeof finalContent === 'string') {
          // 同步更新 ref，保证帧导出能拿到完整正文（setMessages 是异步批处理）
          messagesRef.current = upsert(messagesRef.current, messageId, (m) => ({
            ...m,
            content: finalContent
          }))
          setMessages((prev) => upsert(prev, messageId, (m) => ({ ...m, content: finalContent })))
        }
        // 主回复完成 → 复位输入状态；审查轮（review_*）done 不匹配 startedMsgId，保留"生成中"直到全部结束
        if (messageId && startedMsgId.current === messageId) {
          deliverFrameRef.current = true
          setStatus('idle')
          setActivity(null)
        }
      } else if (type === 'error') {
        errorRef.current = typeof msg.payload === 'string' ? msg.payload : '未知错误'
        setError(errorRef.current)
        setStatus('idle')
        setActivity(null)
      }
    }
    ws.on('message', onMessage)
    return () => ws.off('message', onMessage)
  }, [ws])

  // ---- 发送消息 ----
  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      if (statusRef.current !== 'idle') return
      if (!wsReadyRef.current || ws.readyState !== 1 /* OPEN */) {
        setError('尚未连接 API 服务，请稍候')
        return
      }
      const ts = Date.now()
      const seq = seqRef.current++
      const userMsg: ChatMessage = {
        id: `u_${ts}_${seq}`,
        role: 'user',
        content: trimmed,
        createdAt: ts
      }
      const assistantId = `a_${ts}_${seq}`
      const assistant: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        createdAt: ts
      }
      const prev = messagesRef.current
      messagesRef.current = [...prev, userMsg, assistant]
      setMessages([...prev, userMsg, assistant])
      setStatus('streaming')
      startedMsgId.current = assistantId
      setError(null)
      inputHistoryRef.current = [...inputHistoryRef.current, trimmed]
      histIdxRef.current = -1
      // 与前端一致：发送"历史 + 用户消息"，占位 assistant 只留在显示层，由后端生成
      ws.send(
        JSON.stringify({
          type: 'token',
          messages: [...prev, userMsg],
          sessionId: sessionIdRef.current,
          messageId: assistantId
        })
      )
    },
    [ws]
  )

  // ---- 命令与快捷键 ----
  const handleCommand = useCallback(
    (cmd: string): boolean => {
      const [, ...parts] = cmd.slice(1).trim().split(/\s+/)
      const name = (parts[0] ?? '').toLowerCase()
      const arg = parts.slice(1).join(' ')
      switch (name) {
        case 'help':
          setStatusLine('命令：/new 新会话 · /s <id> 切换会话 · /exit 退出 · /help 帮助 · 普通文本直接发送')
          return true
        case 'exit':
        case 'quit':
          onExit(0)
          return true
        case 'new': {
          const s = props.newSession()
          setSessionId(s.id)
          setMessages(s.messages)
          setStatus('idle')
          setActivity(null)
          setError(null)
          setStatusLine(`会话 ${s.id}`)
          return true
        }
        case 's':
        case 'session': {
          const s = props.switchSession(arg)
          if (s) {
            setSessionId(s.id)
            setMessages(s.messages)
            setStatus('idle')
            setActivity(null)
            setError(null)
            setStatusLine(`会话 ${s.id}`)
          } else {
            setError(`会话不存在或不可用: ${arg}`)
          }
          return true
        }
        default:
          return false
      }
    },
    [props, onExit]
  )

  const submit = useCallback(() => {
    const text = input
    setInput('')
    if (text.startsWith('/') && handleCommand(text)) return
    send(text)
  }, [input, handleCommand, send])

  // 全局 Ctrl-C：流式中 → 中止当前流；空闲 → 退出（autopilot 非交互模式不监听按键）
  useInput(
    (input, key) => {
      if (key.ctrl && input.toLowerCase() === 'c') {
        if (statusRef.current === 'streaming') {
          try {
            ws.send(JSON.stringify({ type: 'abort' }))
          } catch {
            /* ignore */
          }
          const mid = startedMsgId.current
          if (mid) {
            setMessages((prev) => prev.map((m) => (m.id === mid ? { ...m, aborted: true } : m)))
          }
          setStatus('idle')
          setActivity(null)
        } else {
          onExit(0)
        }
      }
    },
    { isActive: !props.autopilot }
  )

  // 输入历史（↑/↓ 回填）
  const prevHistory = useCallback(() => {
    const h = inputHistoryRef.current
    if (h.length === 0) return
    const next = histIdxRef.current < 0 ? h.length - 1 : Math.max(0, histIdxRef.current - 1)
    histIdxRef.current = next
    setInput(h[next])
  }, [])
  const nextHistory = useCallback(() => {
    const h = inputHistoryRef.current
    if (h.length === 0) return
    if (histIdxRef.current < 0) return
    const next = histIdxRef.current + 1
    if (next >= h.length) {
      histIdxRef.current = -1
      setInput('')
    } else {
      histIdxRef.current = next
      setInput(h[next])
    }
  }, [])

  // 由于 useInput 在 App 与 PromptInput 都会消费 keypress，这里只处理 ↑/↓
  // （autopilot 非交互模式不监听按键）
  useInput(
    (_input, key) => {
      if (key.upArrow) prevHistory()
      else if (key.downArrow) nextHistory()
    },
    { isActive: !props.autopilot }
  )

  // ---- 自动发送（autopilot，供自动化验证）----
  useEffect(() => {
    if (!props.autopilot) return
    if (autopilotSentRef.current) return
    if (!wsReady) return
    autopilotSentRef.current = true
    send(props.autopilot)
  }, [props.autopilot, wsReady, send])

  // ---- autopilot 主回复完成后导出完整界面帧（renderToString，非 tty 可用）----
  useEffect(() => {
    if (!props.autopilot || !props.onAutopilotDone) return
    if (!autopilotSentRef.current) return
    if (status !== 'idle') return
    if (autopilotDeliveredRef.current) return
    // 仅主回复 done（deliverFrame 标记）时导出；消息从 ref 读取，避免 setState 批处理竞态
    if (!deliverFrameRef.current) return
    autopilotDeliveredRef.current = true
    // 延迟一拍等 React 提交最新的渲染后再导出（帧内消息已走 ref，这里仅保证 UI 状态稳定）
    const t = setTimeout(() => {
      try {
        const frame = renderToString(
          buildFrameElement({
            sessionId,
            messages: messagesRef.current,
            status: 'idle',
            wsReady,
            error: errorRef.current,
            input,
            statusLine,
            port
          })
        )
        props.onAutopilotDone?.(frame)
      } catch (err) {
        props.onAutopilotDone?.(
          `[autopilot] 帧导出失败: ${(err as Error).message}\nmessages=${messagesRef.current.length} status=${status}`
        )
      }
    }, 50)
    return () => clearTimeout(t)
  }, [status, messages, sessionId, wsReady, error, input, statusLine, props.autopilot, props.onAutopilotDone, port])

  // ---- 消息区渲染行（可见窗口 = 最后 viewLines 行；输入框固定底部）----
  return buildFrameElement({
    sessionId,
    messages,
    status,
    wsReady,
    error,
    input,
    statusLine,
    port,
    width,
    height,
    activity,
    active: !props.autopilot,
    onSubmit: submit,
    onChange: setInput
  })
}

/** 界面帧构建（纯函数）：真实渲染与 autopilot renderToString 共用同一布局 */
interface FrameElementInput {
  sessionId: string
  messages: ChatMessage[]
  status: 'idle' | 'streaming'
  wsReady: boolean
  error: string | null
  input: string
  statusLine: string
  port: number
  /** AI 当前活动（思考/调用工具/生成），流式期间状态栏显示 */
  activity?: AiActivity | null
  width?: number
  height?: number
  viewLines?: number
  separator?: string
  active?: boolean
  onSubmit?: () => void
  onChange?: (v: string) => void
}

/** 消息区渲染行：文本 + 类型（决定着色与对齐） */
interface RenderLine {
  text: string
  kind: 'user' | 'ai' | 'reasoning' | 'tool' | 'system' | 'error' | 'meta'
}

function buildFrameElement(input: FrameElementInput): React.JSX.Element {
  const {
    sessionId,
    messages,
    status,
    wsReady,
    error,
    input: inputValue,
    statusLine,
    port,
    width = 100,
    height = 24,
    viewLines = Math.max(3, height - 5),
    separator = '─'.repeat(Math.max(0, Math.min(width, 100) - 2)),
    active = true,
    activity,
    onSubmit,
    onChange
  } = input

  const renderLines: RenderLine[] = []
  const pushBlock = (
    linesOut: RenderLine[],
    label: string,
    body: string,
    streaming: boolean,
    kind: RenderLine['kind']
  ) => {
    linesOut.push({ text: '', kind: 'meta' })
    const labelW = label.length
    const wrapped = wrapText(body || '', Math.max(10, width - labelW - 1))
    wrapped.forEach((ln, i) => {
      linesOut.push({ text: (i === 0 ? label : ' '.repeat(labelW)) + ln, kind })
    })
    if (streaming && !body) linesOut.push({ text: label + '…', kind })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      pushBlock(renderLines, '❯ ', m.content ?? '', false, 'user')
    } else if (m.role === 'assistant') {
      if ((m.reasoning ?? '').length > 0 && !m.recalled) {
        renderLines.push({ text: '', kind: 'meta' })
        renderLines.push({ text: `┆ 思考 ${(m.reasoning ?? '').length} 字`, kind: 'reasoning' })
      }
      // 工具调用行（与消息同树渲染）：running → 正在调用，done → ✓ 已完成，error → ✗
      for (const tc of m.toolCalls ?? []) {
        renderLines.push({ text: '', kind: 'meta' })
        if (tc.status === 'done') {
          renderLines.push({ text: `✓ ${tc.toolLabel ?? tc.toolName}`, kind: 'tool' })
        } else if (tc.status === 'error') {
          renderLines.push({ text: `✗ ${tc.toolLabel ?? tc.toolName}`, kind: 'error' })
        } else {
          renderLines.push({ text: `┆ 正在调用 ${tc.toolLabel ?? tc.toolName}…`, kind: 'tool' })
        }
      }
      if (m.recalled) {
        renderLines.push({ text: '', kind: 'meta' })
        renderLines.push({ text: '(已撤回)', kind: 'system' })
      } else if (m.aborted) {
        pushBlock(renderLines, '月蚀 ', `(已中止) ${m.content ?? ''}`, false, 'ai')
      } else {
        pushBlock(renderLines, '月蚀 ', m.content ?? '', false, 'ai')
      }
    } else {
      renderLines.push({ text: '', kind: 'meta' })
      renderLines.push({ text: `${m.role}: ${m.content ?? ''}`, kind: 'system' })
    }
  }
  if (error) {
    renderLines.push({ text: '', kind: 'meta' })
    renderLines.push({ text: `⚠ ${error}`, kind: 'error' })
  }
  const visible = renderLines.slice(-viewLines)

  return (
    <Box flexDirection="column" height={height}>
      <Box>
        <Text bold color="magenta">
          月蚀 CLI
        </Text>
        <Text dimColor>
          {'  '}·{'  '}
        </Text>
        <Text dimColor>{sessionId}</Text>
        <Text dimColor>
          {'  '}·{'  '}
        </Text>
        <Text dimColor>端口 {port}</Text>
        <Text dimColor>
          {'  '}·{'  '}
        </Text>
        <Text color={wsReady ? 'green' : 'yellow'}>{wsReady ? '已连接' : '连接中'}</Text>
        {status === 'streaming' && (
          <>
            <Box marginLeft={1}>
              <Spinner />
            </Box>
            {activity?.phase === 'thinking' && <Text dimColor> 思考中…</Text>}
            {activity?.phase === 'tool' && (
              <Text color="cyan">
                {' '}正在调用 {activity.toolName ? cliToolLabel(activity.toolName) : '工具'}…
              </Text>
            )}
            {activity?.phase === 'generating' && <Text dimColor> 正在生成…</Text>}
            {!activity && <Text dimColor> 生成中…</Text>}
          </>
        )}
      </Box>
      <Box flexGrow={1} flexDirection="column" justifyContent="flex-end">
        {visible.map((ln, i) => {
          switch (ln.kind) {
            case 'user':
              return (
                <Text key={i} color="green">
                  {ln.text}
                </Text>
              )
            case 'reasoning':
              return (
                <Text key={i} color="gray" italic>
                  {ln.text}
                </Text>
              )
            case 'tool':
              return (
                <Text key={i} color="cyan">
                  {ln.text}
                </Text>
              )
            case 'error':
              return (
                <Text key={i} color="red">
                  {ln.text}
                </Text>
              )
            case 'system':
            case 'meta':
              return (
                <Text key={i} color="gray">
                  {ln.text}
                </Text>
              )
            default:
              return <Text key={i}>{ln.text}</Text>
          }
        })}
      </Box>
      {status === 'streaming' && activity ? (
        activity.phase === 'tool' ? (
          <Text color="cyan">
            AI 正在调用 {activity.toolName ? cliToolLabel(activity.toolName) : '工具'}…
          </Text>
        ) : (
          <Text dimColor>{activity.phase === 'thinking' ? 'AI 思考中…' : 'AI 正在生成回复…'}</Text>
        )
      ) : (
        <Text dimColor>{statusLine}</Text>
      )}
      <Box>
        <Text color="gray" dimColor>
          {separator}
        </Text>
      </Box>
      <PromptInput
        value={inputValue}
        onChange={onChange ?? (() => undefined)}
        onSubmit={onSubmit ?? (() => undefined)}
        placeholder="输入消息，/help 查看命令"
        active={active}
      />
      <Text color="gray" dimColor>
        Enter 发送 · ↑/↓ 历史 · Ctrl-C 中止/退出 · /exit 退出
      </Text>
    </Box>
  )
}