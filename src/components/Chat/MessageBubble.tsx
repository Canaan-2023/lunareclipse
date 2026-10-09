/**
 * 为什么存在：消息渲染是聊天 UI 的核心单元（用户/AI/工具行协议），动画与重渲染频繁，
 * 独立组件内聚渲染规则并用 memo 控制性能。
 * 作用：渲染单条消息气泡（头像/名称/内容/操作），支持行式协议消息（RowRenderer）、
 * 工具调用卡片、Todo 卡片与复制/重试操作。
 */
import { memo, useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Copy, Check, Brain, ChevronDown, Undo2, Trash2, Pencil, RefreshCw, Sparkles } from 'lucide-react'
import type { ChatMessage, ConversationRow } from '@shared/types'
import {
  GUARDRAIL_SOURCE_LABEL,
  collectMessageActivitySources,
  isReviewerMessageId
} from '@shared/utils/guardrail-sources'
import { MarkdownRenderer } from './MarkdownRenderer'
import { RowRenderer } from './RowRenderer'
import { ToolCallCard } from './ToolCallCard'
import { TodoListCard, type TodoItem } from './TodoListCard'
import { openFilePreview } from '../Workshop/FileWorkshopPanel'
import { useAppStore } from '../../stores/appStore'
import { formatDateTime } from '../../utils/time'
import { copyText } from '../../utils/clipboard'

/**
 * 识别历史消息中的技能调用前缀（InputArea 发送时注入的格式）：
 * "请使用技能「技能名/领域名」完成下面的任务：\n\n{用户正文}"
 * 命中时把前缀渲染成小方块 chip，正文用剩余文本渲染——不在聊天流里铺一大段话。
 */
function parseSkillInvocation(content: string): { skillLabels: string[]; body: string } | null {
  const m = content.match(/^请使用技能((?:「.+?」)+)完成下面的任务：\s*\n+(.*)$/s)
  if (!m) return null
  const skillLabels = [...m[1].matchAll(/「(.+?)」/g)].map((x) => x[1])
  return { skillLabels, body: m[2] }
}

/** 从 TodoWrite 工具调用的 result.data 中安全提取 todos */
function extractTodos(data: unknown): TodoItem[] | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as { todos?: unknown }
  if (!Array.isArray(obj.todos)) return null
  return obj.todos as TodoItem[]
}

interface Props {
  message: ChatMessage
}

export const MessageBubble = memo(
  function MessageBubble({ message }: Props) {
// 代码审查的触发消息（phaseMsg，内容前缀【代码审查】…）是驱动审查轮的内部指令，
    // 不该出现在对话流——审查发言本身已作为独立消息（渲染在用户侧）呈现。
    // 判定用 id 前缀而非内容前缀：phaseMsg 的 id 为 `${nextPhase}_${nextRound}_${Date.now()}`（后端 2441 行），
    // 与后端审查轮判定（server.ts:2285 idHead）同构；只依赖内容前缀在审查提示词文案调整后就会漏隐藏，
    // 导致指令明文以用户气泡形态冒泡。id 前缀判定与 assistant 审查回复（47 行 isReviewer）按 role 互斥，
    // 不会误伤审查发言本身。恒定条件提前返回，不调用任何 hook（同一消息条件不变，hooks 顺序稳定）。
    if (
      message.role === 'user' &&
      message.activation === true &&
      isReviewerMessageId(message.id)
    ) {
      return null
    }
    const isUser = message.role === 'user'
    const isAssistant = message.role === 'assistant'
    // 系统注入消息（健康检查报错/持续激活续接等）：UI 上像用户消息一样可见，
    // 但用灰色样式 + 「系统注入」标注区分，避免误认为是用户真实发言。
    const isSystemInjected = isUser && message.activation === true
    // 代码审查消息：审查方代表用户立场发言，按 id 前缀识别（review_{轮}_{时间戳}）。
    // 呈现上完全等同用户消息（同侧、同气泡），但标签必须标「代码审查」——它代表用户在
    // 说话，来源却是审查 AI 的独立轮次，不能误标为用户本人。口径与主进程护栏分类
    // （shared isReviewerMessageId）同源，避免主进程判 code-review、前端不标审查的错位。
    const isReviewer = isAssistant && isReviewerMessageId(message.id)
    const onUserSide = isUser || isReviewer
    // 历史技能调用消息：前缀「请使用技能「X」完成下面的任务：」渲染为 chip（仅用户侧普通消息）
    const skillInvocation = isUser && !isReviewer ? parseSkillInvocation(message.content) : null
    // 消息内的活动来源徽章（AI 轮次里实际发生过什么）：子AGENT/网页搜索/文件读取/工具返回。
    // 口径与 wire 护栏一致（shared collectMessageActivitySources → classifyToolSource）。
    const activitySources = useMemo(() => collectMessageActivitySources(message), [message])
    // hover 操作按钮显示状态 + 复制成功反馈
    const [hovered, setHovered] = useState(false)
    const [copied, setCopied] = useState(false)

    const handleCopy = async () => {
      const ok = await copyText(message.content)
      if (ok) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }
    const streamingMessageId = useAppStore((s) => s.streamingMessageId)
    const aiName = useAppStore((s) => s.config.aiName) || '月蚀'
    // 消息操作 actions
const recallMessage = useAppStore((s) => s.recallMessage)
    const deleteMessage = useAppStore((s) => s.deleteMessage)
    const regenerateResponse = useAppStore((s) => s.regenerateResponse)
    const setEditingMessageId = useAppStore((s) => s.setEditingMessageId)
    const setInputPrefill = useAppStore((s) => s.setInputPrefill)
    // AI 输出模式：coding=编程模式（推理链可见）；chat=会话模式（思考内部化）
    const aiMode = useAppStore((s) => s.config.aiMode) ?? 'coding'
    // 当前消息是否正在 stream（思考或生成中）
    const isStreaming = isAssistant && streamingMessageId === message.id
    // 有思考内容但还没有 content，且仍在 stream → 处于"深度思考中"
    // 但如果 toolCalls 已开始（tool_start 已到达），说明已进入执行阶段，不再算"思考中"
    // 修复"思考时执行"视觉问题：tool_start 后 reasoning 块应转为"思考完成"折叠态
    const hasToolCallsStarted = (message.toolCalls?.length ?? 0) > 0
    const isThinking = isStreaming && !!message.reasoning && !message.content && !hasToolCallsStarted

    // 提取最后一次 TodoWrite 的任务清单（多次调用只显示最新状态）
    const todoList = useMemo<TodoItem[] | null>(() => {
      if (!message.toolCalls) return null
      for (let i = message.toolCalls.length - 1; i >= 0; i--) {
        const tc = message.toolCalls[i]
        if (tc.toolName === 'TodoWrite' && tc.result?.data) {
          return extractTodos(tc.result.data)
        }
      }
      return null
    }, [message.toolCalls])

    // 无 rows 消息 → 合成时间线行（治本：消灭"无 rows 三段式兜底硬堆"）。
    // 背景：行协议引入前生成的历史旧消息、以及个别漏网路径，只有 reasoning/content/toolCalls
    // 平铺字段、没有 rows。若走旧的三段式兜底（思考块上/正文中/工具卡下硬堆），用户看到的就是
    // 上下文一长后"没法用"的乱堆。这里把这些平铺字段按时间线语义合成 ConversationRow[]，
    // 统一交给 RowRenderer 逐段平铺渲染，与有 rows 的消息表现一致。
    const synthesizedRows = useMemo<ConversationRow[] | null>(() => {
      if (!isAssistant) return null
      if (message.rows && message.rows.length > 0) return null
      const hasContent = !!message.reasoning || !!message.content || (message.toolCalls && message.toolCalls.length > 0)
      if (!hasContent) return null
      const rows: ConversationRow[] = []
      let seq = 0
      const turnId = `synth_${message.id}`
      const base = message.createdAt ?? Date.now()
      if (message.reasoning) {
        rows.push({
          kind: 'reasoning',
          rowId: ++seq,
          turnId,
          createdAt: base,
          createdAtSeq: seq,
          text: message.reasoning,
          state: 'complete'
        })
      }
      if (message.toolCalls && message.toolCalls.length > 0) {
        for (const tc of message.toolCalls) {
          rows.push({
            kind: 'toolCall',
            rowId: ++seq,
            turnId,
            createdAt: base,
            createdAtSeq: seq,
            toolCallId: tc.id,
            toolName: tc.toolName,
            status: tc.status === 'error' ? 'error' : tc.status === 'running' ? 'running' : 'success',
            inputText: '',
            input: tc.args,
            ...(tc.result && !tc.result.ok ? { error: { code: 'error', message: tc.result.error || '' } } : {}),
            startedAt: tc.startedAt,
            endedAt: tc.endedAt
          })
        }
      }
      if (message.content) {
        rows.push({
          kind: 'assistantText',
          rowId: ++seq,
          turnId,
          createdAt: base,
          createdAtSeq: seq,
          text: message.content,
          state: 'complete'
        })
      }
      return rows.length > 0 ? rows : null
    }, [isAssistant, message])

    // 有 rows 用 message.rows，无 rows 用合成的（尽量走同一套时间线渲染）
    const timelineRows = message.rows && message.rows.length > 0 ? message.rows : synthesizedRows

    // 流式输出中但没有 content：显示 shimmer 骨架屏（替代旧的"三个点"）
  // 仅在真正流式输出时显示，避免历史空消息残留时显示加载态
  const showStreamingSkeleton = isAssistant && isStreaming && !message.content && !message.error

  // 消息锚点 id：供「定位小圆点」滚动跳转（getElementById 需要合法 id，去掉特殊字符）
  const anchorId = `msg-${String(message.id).replace(/[^a-zA-Z0-9_-]/g, '')}`

  // 点击小圆点 → 平滑滚动到本条消息（居中显示）
  const jumpToSelf = () => {
    const el = document.getElementById(anchorId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  // 编辑用户消息：填充到输入框 + 设置编辑模式
  const handleEdit = () => {
    setEditingMessageId(message.id)
    setInputPrefill(message.content)
  }

  // 撤回消息：已撤回时显示占位符，不渲染正文
  if (message.recalled) {
    return (
      <motion.div
        id={anchorId}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.15 }}
        className={`flex flex-col ${onUserSide ? 'items-end' : 'items-start'}`}
      >
        <div
          className={`mb-1 flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide ${
            isUser ? 'text-accent/80' : 'text-fg-secondary/80'
          } opacity-60`}
        >
          {isUser ? (
            <>
              <span className="rounded-full bg-accent/10 px-1.5 py-px text-[9px]">你</span>
              <span>用户</span>
            </>
          ) : (
            <>
              <span className="rounded-full bg-accent/10 px-1.5 py-px text-[9px]">✦</span>
              <span>{aiName}</span>
            </>
          )}
        </div>
        <div
          className={`flex items-center gap-1.5 rounded-card px-4 py-2 text-caption text-fg-muted italic ${
            isUser ? 'bg-accent/5' : 'bg-bg-surface'
          }`}
        >
          <Undo2 size={11} className="shrink-0 opacity-60" />
          <span>{isUser ? '你撤回了一条消息' : 'AI 回复已撤回'}</span>
          {message.recalledAt && (
            <span className="opacity-50">
              {formatDateTime(message.recalledAt)}
            </span>
          )}
        </div>
      </motion.div>
    )
  }

  return (
    <motion.div
      id={anchorId}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // 操作栏可见性跟随 hover 会让纯键盘用户（Tab 遍历）永远看不到复制/编辑/撤回，
      // 焦点进入消息区同样置为可见，键盘路径与鼠标路径能力对齐。
      onFocus={() => setHovered(true)}
      onBlur={(e) => {
        // 焦点移到消息自身之外的区域才收起（含内部按钮间移动不闪烁）
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false)
      }}
      className={`flex flex-col ${onUserSide ? 'items-end' : 'items-start'}`}
    >
      {/* 角色标签：用户/AI 区分，hover 时显示（系统注入特殊标注） */}
      <div
        className={`mb-1 flex items-center gap-1.5 px-1 text-[10px] font-medium tracking-wide ${
          onUserSide
            ? isSystemInjected
              ? 'text-fg-muted'
              : 'text-accent/80'
            : 'text-fg-secondary/80'
        } ${hovered ? 'opacity-100' : 'opacity-60'}`}
      >
        {onUserSide ? (
          isSystemInjected ? (
            <>
              <span className="rounded-full border border-dashed border-fg-muted/40 bg-bg-muted/60 px-1.5 py-px text-[9px]">
                ⚙️ 系统
              </span>
              <span>系统注入</span>
            </>
          ) : isReviewer ? (
            <>
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-px text-[9px] text-amber-400">
                ⚖️ 审查
              </span>
              <span>代码审查</span>
              <span className="text-fg-muted/60">· AI 独立轮次</span>
            </>
          ) : (
            <>
              <span className="rounded-full bg-accent/10 px-1.5 py-px text-[9px]">你</span>
              <span>用户</span>
            </>
          )
        ) : (
          <>
            <span className="rounded-full bg-accent/10 px-1.5 py-px text-[9px]">✦</span>
            <span>{aiName}</span>
            {/* AI 轮次内实际发生的活动来源徽章（子AGENT/网页搜索/文件读取/工具返回） */}
            {activitySources.length > 0 && (
              <span className="ml-0.5 flex items-center gap-1">
                {activitySources.map((s) => (
                  <span
                    key={s}
                    className="rounded-full border border-border-subtle bg-bg-muted/60 px-1.5 py-px text-[9px] text-fg-muted"
                    title={GUARDRAIL_SOURCE_LABEL[s]}
                  >
                    {GUARDRAIL_SOURCE_LABEL[s]}
                  </span>
                ))}
              </span>
            )}
          </>
        )}
      </div>
      <div className={`flex w-full items-start gap-1 ${onUserSide ? 'justify-end' : 'justify-start'}`}>
        {/* 定位小圆点：仅真实用户消息（系统注入除外）显示，点击跳到这条消息 */}
        {isUser && !isSystemInjected && (
          <button
            onClick={jumpToSelf}
            className="mt-5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-fg-muted/40 transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-90"
            title="定位到这条消息"
            aria-label="定位到这条消息"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          </button>
        )}
      <div
          className={`relative word-break max-w-[85%] rounded-card px-4 py-3 ${
            onUserSide
              ? isSystemInjected
                ? 'bg-bg-muted text-fg-secondary border border-dashed border-fg-muted/40'
                : isReviewer
                  ? 'bg-bg-surface text-fg-primary border border-border-subtle'
                  : 'bg-accent text-accent-fg'
              : 'bg-bg-surface text-fg-primary'
          }`}
        >
          {/* 深度思考块（chat 模式：正文出现后消失；coding 模式：保留折叠入口，推理链可见）
              有行（message.rows 或合成行）时不渲染——RowRenderer 的 reasoning 行已覆盖 */}
          {isAssistant && !timelineRows && message.reasoning && (isThinking || aiMode !== 'chat') && (
            <ReasoningBlock
              reasoning={message.reasoning}
              isThinking={isThinking}
              hideWhenDone={aiMode === 'chat'}
            />
          )}

          <div className="message-content break-words text-body leading-relaxed">
            {onUserSide && !isReviewer ? (
              /* 用户消息：若是技能调用消息（历史格式带指令前缀），前缀渲染为 chip、正文走 Markdown */
              skillInvocation ? (
                <div className="space-y-1.5">
                  <span className="inline-flex flex-wrap items-center gap-1">
                    {skillInvocation.skillLabels.map((label) => (
                      <span
                        key={label}
                        className="inline-flex max-w-full items-center gap-1.5 rounded-btn border border-accent-fg/25 bg-accent-fg/10 px-2 py-1 text-caption text-accent-fg"
                      >
                        <Sparkles size={11} className="shrink-0" />
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                    ))}
                  </span>
                  {skillInvocation.body.trim() && (
                    <MarkdownRenderer
                      content={skillInvocation.body}
                      streaming={isStreaming && !!message.content}
                    />
                  )}
                </div>
              ) : (
                /* 普通用户消息走整段 Markdown，像"我"在说话 */
                <MarkdownRenderer content={message.content} streaming={isStreaming && !!message.content} />
              )
            ) : timelineRows ? (
              /* 行协议：有 rows 时按行渲染；无 rows 时用合成行同样走 RowRenderer——统一时间线平铺，
                 消灭"无 rows 三段式硬堆"（思考块/正文/工具卡上下堆叠）。
                 代码审查发言（isReviewer）也走这里：审查者的 rows 含 reasoning 行（后端 onReasoning
                 在审查轮同样创建），只有走 RowRenderer 才能让"思考"块显示出来——之前进 onUserSide
                 分支直接丢 rows 只渲染 content，审查思考被整个吞掉 */
              <RowRenderer rows={timelineRows} streaming={isStreaming} />
            ) : message.content ? (
              /* streaming 原绑定 isThinking（内容出现即 false）→
                 无 reasoning 或正文输出时流式光标永不显示。改为：流式中且已有内容 → 光标 */
              <MarkdownRenderer content={message.content} streaming={isStreaming && !!message.content} />
            ) : showStreamingSkeleton ? (
              <StreamingSkeleton />
            ) : null}
            {message.aborted && (
              <span className="ml-1 text-caption text-fg-muted">[已终止]</span>
            )}
            {message.error && (
              <span className="ml-1 text-caption text-red-400">
                [错误: {message.error}]
              </span>
            )}
          </div>
          {/* 任务清单卡片（TodoWrite 工具调用渲染） */}
          {isAssistant && todoList && todoList.length > 0 && (
            <TodoListCard todos={todoList} />
          )}
          {/* 工具调用（内联行风格：文件/命令/搜索都在行内，无需单独文件面板）
              有行（message.rows 或合成行）时不渲染——RowRenderer 的 toolCall 行已覆盖 */}
          {isAssistant && !timelineRows && message.toolCalls && message.toolCalls.length > 0 && (
            <ToolCallCard
              toolCalls={message.toolCalls}
onPreviewFile={(path) => {
                // C 子项目挂载点：应用内文件预览（只读），支持后续扩展 diff 视图
                openFilePreview(path)
              }}
              onOpenInBrowser={(url) => {
                // C 子项目挂载点：当前用内嵌浏览器面板打开
                // 原实现不检查 res.ok——浏览器未初始化时
                // 主进程 throw 被吞，用户点击无反馈。失败时至少 console 提示（主进程 handler
                // 侧已加懒创建 view 兜底，正常不会再失败）。
                void window.lunareclipse.browserNavigate(url).then((res: { ok?: boolean; error?: string } | undefined) => {
                  if (res && !res.ok) {
                    console.warn('[browser] 打开失败:', res.error)
                  }
                })
              }}
            />
          )}
          {/* 附件 chip：图片带 dataUrl 时内联缩略图预览，其余文件显示图标+名称 */}
          {message.attachments && message.attachments.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t border-white/10 pt-2">
              {message.attachments.map((a, i) => {
                const isImage = a.type.startsWith('image/')
                const sizeStr = a.size > 1024 * 1024
                  ? `${(a.size / 1024 / 1024).toFixed(1)} MB`
                  : `${(a.size / 1024).toFixed(1)} KB`
                return isImage && a.dataUrl ? (
                  <div
                    key={i}
                    className="flex flex-col gap-1 rounded-md bg-bg-muted/50 p-1.5"
                    title={a.path}
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="max-h-48 max-w-64 rounded object-cover"
                    />
                    <div className="flex items-center gap-1.5 px-0.5 text-caption">
                      <span className="max-w-[140px] truncate text-fg-secondary">{a.name}</span>
                      <span className="shrink-0 text-fg-muted">{sizeStr}</span>
                    </div>
                  </div>
                ) : (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 rounded-md bg-bg-muted/50 px-2 py-1 text-caption"
                    title={a.path}
                  >
                    <span className="text-fg-muted">{isImage ? '🖼️' : '📄'}</span>
                    <span className="max-w-[140px] truncate">{a.name}</span>
                    <span className="shrink-0 text-fg-muted">{sizeStr}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
{/* 消息底部操作栏（hover 显示，流式生成中隐藏）；系统注入消息同样显示（仅时间戳+复制） */}
        <AnimatePresence>
          {hovered && !isStreaming && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.15 }}
              className="mt-1 flex items-center justify-end gap-0.5 px-1"
            >
              {/* 时间戳（用户 & AI & 系统注入通用，悬浮时随操作一起浮出） */}
              {!!message.createdAt && (
                <span className="mr-1 select-none px-1 text-[10px] tabular-nums text-fg-muted/70" title={new Date(message.createdAt).toLocaleString('zh-CN')}>
                  {formatDateTime(message.createdAt)}
                </span>
              )}
              {/* 复制（用户 & AI 通用） */}
              <button
                onClick={handleCopy}
                className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-90"
                title="复制"
                aria-label="复制"
              >
                {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              </button>
              {/* 用户消息（系统注入除外）：编辑 + 撤回 */}
              {isUser && !isSystemInjected && (
                <>
                  <button
                    onClick={handleEdit}
                    className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-90"
                    title="编辑并重发"
                    aria-label="编辑并重发"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => void recallMessage(message.id)}
                    className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-90"
                    title="撤回"
                    aria-label="撤回"
                  >
                    <Undo2 size={12} />
                  </button>
                </>
              )}
              {/* AI 消息：重新生成 + 删除 */}
              {isAssistant && (
                <>
                  <button
                    onClick={() => void regenerateResponse(message.id)}
                    className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-90"
                    title="重新生成"
                    aria-label="重新生成"
                  >
                    <RefreshCw size={12} />
                  </button>
                  <button
                    onClick={() => {
                      // 删除消息会连配对消息一并落盘移除（含内部会话同步），无回收站，误触代价高，先确认再删
                      if (!window.confirm('删除该消息将同时删除其配对的回复，且无法恢复。确定删除？')) return
                      void deleteMessage(message.id)
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-red-400 active:scale-90"
                    title="删除"
                    aria-label="删除"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    )
  },
  // 自定义比较函数：只有这些字段变化时才重渲染
  (prev, next) => {
    const a = prev.message
    const b = next.message
    return (
      a.id === b.id &&
      a.content === b.content &&
      a.reasoning === b.reasoning &&
      a.aborted === b.aborted &&
      a.error === b.error &&
      a.activation === b.activation &&
      a.toolCalls === b.toolCalls &&
      a.rows === b.rows &&
a.recalled === b.recalled &&
      a.recalledAt === b.recalledAt &&
      a.editedAt === b.editedAt
    )
  }
)

/**
 * 流式输出占位骨架（替代旧的"三个点"加载动画）
 * 仅在 AI 正在 stream 但还未输出 content 时短暂显示
 * - 没有 reasoning 时：显示 shimmer 条 + "正在组织回复" 文案
 * - 有 reasoning 时：reasoning 块自身有思考光标，这里只显示极简 shimmer 条
 */
function StreamingSkeleton() {
  return (
    <div className="flex flex-col gap-2 py-1">
      <div className="flex items-center gap-2 text-caption text-fg-muted">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/40" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent/70" />
        </span>
        <span>正在组织回复</span>
      </div>
      <div className="space-y-1.5">
        <div className="h-2 w-48 animate-pulse rounded-full bg-bg-muted" />
        <div className="h-2 w-32 animate-pulse rounded-full bg-bg-muted" style={{ animationDelay: '120ms' }} />
      </div>
    </div>
  )
}

/**
 * 深度思考块（按模式区分渲染）：
 * - chat 模式（hideWhenDone=true）：思考中一行灰字"思考中…"+ 呼吸光标；
 * 正文出现后整块消失——设计依据：chat 模式思考是后台行为、不参与交付体验，
 * 保留会干扰正文阅读，故正文出现即隐藏思考过程
 * - coding 模式（hideWhenDone=false）：思考中同左；结束后保留"思考 · N 字"
 * 折叠入口（点击展开全文）——编程模式输出纪律硬性要求"第一原理推导、推理链可见"，
 * 不能像 chat 一样消失
 */
function ReasoningBlock({
  reasoning,
  isThinking,
  hideWhenDone
}: {
  reasoning: string
  isThinking: boolean
  hideWhenDone: boolean
}) {
  // hooks 必须先声明（条件 return 后不能调用 useState）
  const [expanded, setExpanded] = useState(false)
  // chat 模式：思考结束即消失
  if (hideWhenDone && !isThinking) return null
  // 思考中：一行灰字 + 呼吸光标（瞬态提示）
  if (isThinking) {
    return (
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fg-muted/50" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-fg-muted/70" />
        </span>
        <span className="text-[11px] text-fg-muted italic">思考中…</span>
      </div>
    )
  }
  // coding 模式思考结束：一行"思考 · N 字"入口，点击展开
  return (
    <div className="mb-1.5 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 px-0.5 text-left hover:opacity-80 transition-opacity"
        title={expanded ? '收起思考过程' : '展开思考过程'}
      >
        <Brain size={10} className="shrink-0 text-fg-muted" />
        <span className="text-[10px] text-fg-muted">
          思考 · {reasoning.length} 字
        </span>
        <ChevronDown
          size={10}
          className={`shrink-0 text-fg-muted/60 transition-transform ${
            expanded ? 'rotate-180' : ''
          }`}
        />
      </button>
      {expanded && (
        <div className="mt-1 max-h-[300px] overflow-y-auto rounded-btn border border-border-subtle/60 bg-bg-muted/30 px-2.5 py-2 text-[11px] italic leading-relaxed text-fg-muted whitespace-pre-wrap">
          {reasoning}
        </div>
      )}
    </div>
  )
}
