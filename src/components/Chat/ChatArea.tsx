/**
 * 为什么存在：主聊天区是会话消息流的渲染容器，滚动定位、消息上限与各类内嵌
 * 组件（气泡/工具箱/输入区/工作流状态条）都在此装配，独立组件承载整体布局。
 * 作用：渲染消息列表（上限保护与滚动到底）、流式光标、工具调用指示、
 * 输入区与工作流状态条/人工输入弹窗的区域编排。
 */
import { useEffect, useRef, useState } from 'react'
import { Wrench, Loader2, ArrowDown } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useAppStore } from '../../stores/appStore'
import type { ChatMessage } from '@shared/types'

import { TOOL_MAP } from '@shared/tools/registry'
import { MessageBubble } from './MessageBubble'
import { MessageLocator } from './MessageLocator'
import { InputArea } from '../Input/InputArea'
import { WorkflowStatusBar } from './WorkflowStatusBar'
import { InternalSessionsView } from './InternalSessionsView'
import { LilithPanel } from '../Lilith/LilithPanel'
import { useT } from '../../i18n/useT'


/** 工具名 → 中文标签（单一数据源：shared/tools/registry.ts 的 TOOL_MAP，与 ToolCallCard/appStore 一致） */
function toolLabel(name: string): string {
  return TOOL_MAP[name]?.name ?? name
}

/** 单次渲染的消息硬上限：展开历史后全量渲染无上限，
 * 会话积累几百上千条时 DOM 爆炸 → 渲染线程卡死。超出只渲染最近 N 条 + 提示。 */
const MAX_RENDER_MESSAGES = 300

/** 空消息列表常量：selector 里 `?? []` 每次调用都新建数组（新引用）→ zustand 无限重渲染。
 * 防御 undefined 必须用稳定引用，不能用字面量。 */
const EMPTY_MESSAGES: ChatMessage[] = []

/** 工具调用状态指示器：streaming 期间显示"正在调用 xxx..." */
function ToolCallIndicator() {
  const activeToolCalls = useAppStore((s) => s.activeToolCalls)
  const t = useT()
  const [, force] = useState(0)
  // 每 200ms 重渲染以更新已耗时
  useEffect(() => {
    if (activeToolCalls.length === 0) return
    const timer = setInterval(() => force((n) => n + 1), 200)
    return () => clearInterval(timer)
  }, [activeToolCalls.length])

  if (activeToolCalls.length === 0) return null
  const call = activeToolCalls[activeToolCalls.length - 1]
  const elapsed = ((Date.now() - call.startedAt) / 1000).toFixed(1)

  return (
    <div className="flex items-center gap-2 border-b border-accent/40 bg-accent/12 px-6 py-2 text-caption text-accent">
      <Loader2 size={13} className="animate-spin" />
      <Wrench size={13} />
      <span className="font-medium">{t('tool.calling', { name: toolLabel(call.toolName) })}</span>
      <span className="text-accent/70">·</span>
      <span className="tabular-nums font-medium">{elapsed}s</span>
      {activeToolCalls.length > 1 && (
        <span className="bg-accent/20 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
          {t('tool.parallel', { n: activeToolCalls.length - 1 })}
        </span>
      )}
    </div>
  )
}

export function ChatArea() {
  // 防御：currentMessages 理论上恒为数组，但历史数据/异常路径可能 undefined——
  // 渲染层对 store 数据宽容，避免 messages.length 抛 TypeError。
  // 不能用 `?? []`（每次新建数组 → zustand 无限重渲染），用稳定引用 EMPTY_MESSAGES。
  const messages = useAppStore((s) => s.currentMessages ?? EMPTY_MESSAGES)
  // 会话正文宽度档位（config.messageWidth，设置页可调；旧配置缺省时回退 medium）
  const messageWidth = useAppStore((s) => s.config?.messageWidth ?? 'medium')
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const lilithChatOpen = useAppStore((s) => s.lilithChatOpen)
  const status = useAppStore((s) => s.status)
const errorMessage = useAppStore((s) => s.errorMessage)
const contextWarning = useAppStore((s) => s.contextWarning)
  const chatViewMode = useAppStore((s) => s.chatViewMode)
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  // UI 始终显示完整线性历史（session.messages 唯一真相源），显示与 AI 上下文注入解耦
  // 智能滚动跟随：用户是否处于底部附近（距底部 < 100px）
  const [isAtBottom, setIsAtBottom] = useState(true)
  const isAtBottomRef = useRef(true)
  isAtBottomRef.current = isAtBottom
  // 不在底部时显示"回到底部"浮动按钮
  const [showJumpButton, setShowJumpButton] = useState(false)
  // 已展开的历史条数（超出 MAX_RENDER_MESSAGES 的部分）：
  // 为什么存在——消息超上限时默认只渲染最近 N 条，但没有入口回看更早内容，
  // 历史消息虽在 store 中完整存在却不可见（截断提示是死胡同）。
  // 每次点击「加载更早」前移上限，展开不会再截断，尊重用户主动回看历史的意图。
  // 不删理由：这是截断上限唯一的展开入口；删除则 >300 条的历史永久不可见。
  const [renderOffset, setRenderOffset] = useState(0)

  const loadEarlier = () => {
    // 记录展开前容器高度：新增历史渲染在头部，滚轮位置必须换算进新高度，
    // 否则浏览器会把视口固定在顶部产生"跳到中间"的错位感
    const el = scrollRef.current
    const prevHeight = el ? el.scrollHeight : 0
    setRenderOffset((o) => o + MAX_RENDER_MESSAGES)
    // React 状态提交后在同一宏任务里无法拿到新高度，用 rAF 等渲染完成后修正
    requestAnimationFrame(() => {
      if (!el) return
      el.scrollTop = el.scrollHeight - prevHeight
    })
  }

  const handleScroll = () => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const atBottom = distanceFromBottom < 100
    setIsAtBottom(atBottom)
    if (atBottom) setShowJumpButton(false)
  }

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    setIsAtBottom(true)
    setShowJumpButton(false)
  }

  // 自动滚动：仅在用户处于底部附近时跟随，避免打断向上翻看历史。
  // 流式输出时 messages 每 token 变化——直接同步写 scrollTop 会每帧强制同步布局
  // （scrollTop 赋值是布局写，与滚动容器的布局读冲突），长会话下拖慢主线程。
  // 合并到 rAF：一帧内多次 messages 变更只做一次布局写，尾帧补到最底。
  const scrollRafRef = useRef(0)
  useEffect(() => {
    if (scrollRafRef.current) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0
      if (!scrollRef.current) return
      if (isAtBottomRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        setShowJumpButton(false)
      } else {
        // 不在底部且有新内容 → 显示"回到底部"按钮
        setShowJumpButton(true)
      }
    })
    return () => {
      if (scrollRafRef.current) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = 0
      }
    }
  }, [messages])

  // 切回普通视图（内部会话 → 对话）时定位到底部：
  // 视图切换不触发 messages 变更，滚轮位置停留在旧状态，用户回到对话页看到的是中间段落。
  useEffect(() => {
    if (chatViewMode === 'normal') scrollToBottom()
  }, [chatViewMode])

// 莉莉丝会话：主聊天窗口与桌宠对话（与游戏内共享上下文）
  if (lilithChatOpen) {
    return <LilithPanel />
  }

  if (!currentSessionId) {
    return (
      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden bg-bg-base">
        <div
          className="pointer-events-none absolute h-[320px] w-[320px] rounded-full blur-3xl"
          style={{
            background: 'radial-gradient(circle, var(--color-accent-glow) 0%, transparent 70%)',
            animation: 'chat-empty-glow 5s ease-in-out infinite'
          }}
        />
        <div className="relative z-10 flex flex-col items-center">
          {/* CSS 月相图形：复用 globals.css 的 .eclipse-moon-phase 动画 */}
          <div className="eclipse-moon-phase mb-4" />
          <div className="mt-3 flex flex-col items-center gap-1.5 text-center">
            <div className="text-heading font-light tracking-[0.4em] text-fg-primary">
              月蚀
            </div>
            <div className="text-micro uppercase tracking-[0.3em] text-fg-muted">
              {t('empty.brand')}
            </div>
            <div className="mt-3 max-w-md text-body text-fg-secondary">
              {t('empty.subtitle')}
            </div>
          </div>
        </div>
        <style>{`
          @keyframes chat-empty-glow {
            0%, 100% { opacity: 0.4; transform: scale(1); }
            50% { opacity: 0.7; transform: scale(1.08); }
          }
        `}</style>
      </main>
    )
  }

// 上下文警告条：仅在有警告时显示（token 计数已移入输入区工具条）
  return (
    <main className="flex flex-1 flex-col bg-bg-base">
      {contextWarning && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border-subtle px-6 py-1 text-caption text-amber-400">
          <span className="min-w-0 truncate">{contextWarning}</span>
          <button
            onClick={() => useAppStore.setState({ contextWarning: null })}
            className="shrink-0 text-amber-400/70 hover:text-amber-400"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            ×
          </button>
        </div>
      )}

      {/* 工具调用状态指示器：streaming 期间 AI 调用工具时显示"正在调用 xxx..." */}
      {status === 'streaming' && <ToolCallIndicator />}

      {/* 工作流状态条：有活跃实例时显示在聊天区顶部 */}
      <WorkflowStatusBar />

{/* 对话区 / 内部会话区（tree 视图原位替换旧块树） */}
      {chatViewMode === 'tree' ? (
        <div className="relative flex flex-1 overflow-hidden">
          <InternalSessionsView sessionId={currentSessionId} />
        </div>
      ) : (
        <div className="relative flex flex-1 overflow-hidden">
        <div className="relative flex flex-1 overflow-hidden gap-2">
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto px-4 py-4"
            >
              {messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-4">
                  <div className="eclipse-moon-phase opacity-80" />
                  <div className="text-body text-fg-secondary">
                    {t('empty.hint')}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                    {[t('empty.suggestion1'), t('empty.suggestion2'), t('empty.suggestion3')].map((hint) => (
                      <button
                        key={hint}
                        onClick={() => {
                          useAppStore.getState().setInputPrefill(hint)
                          document.getElementById('chat-input-area')?.focus()
                        }}
                        className="rounded-btn border border-border-subtle bg-transparent px-3 py-1.5 text-caption text-fg-muted/70 transition-all hover:border-accent/30 hover:bg-bg-surface/40 hover:text-fg-secondary"
                      >
                        {hint}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 text-micro text-fg-muted">
                    {t('input.hint')}
                  </div>
                </div>
              ) : (
                <div
                  className={`mx-auto w-full space-y-4 px-2 ${
                    messageWidth === 'narrow'
                      ? 'max-w-[768px]'
                      : messageWidth === 'wide'
                        ? 'max-w-[1100px]'
                        : 'max-w-[896px]'
                  }`}
                >
                  {messages.slice(-(MAX_RENDER_MESSAGES + renderOffset)).map((m) => (
                    <MessageBubble key={m.id} message={m} />
                  ))}
                  {messages.length > MAX_RENDER_MESSAGES + renderOffset && (
                    <div className="rounded-card border border-border-subtle bg-bg-surface/40 px-4 py-2 text-center text-caption text-fg-muted">
                      {t('msg.historyTruncated', { n: MAX_RENDER_MESSAGES + renderOffset, total: messages.length })}{' '}
                      {/* 截断提示必须带展开入口：提示而无入口等于把历史消息锁死，用户无法回看更早内容 */}
                      <button
                        onClick={loadEarlier}
                        className="ml-1 rounded-btn border border-border-subtle bg-bg-elevated px-2 py-0.5 text-caption text-accent hover:bg-accent/10"
                      >
                        {t('msg.loadEarlier')}
                      </button>
                    </div>
                  )}
                  {status === 'error' && errorMessage && (
                    <div className="rounded-card border border-red-500/30 bg-red-500/10 px-4 py-3 text-caption text-red-400">
                      {errorMessage}
                    </div>
                  )}
                </div>
              )}
            </div>
            <MessageLocator
              messages={messages}
              scrollRef={scrollRef}
            />
            <AnimatePresence>
              {showJumpButton && (
                <motion.button
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={{ duration: 0.15 }}
                  onClick={scrollToBottom}
                  className="absolute bottom-4 right-4 flex h-8 w-8 items-center justify-center rounded-full border border-border-subtle bg-bg-elevated/80 text-fg-secondary shadow-lg backdrop-blur hover:bg-bg-muted hover:text-accent"
                  title={t('common.jumpingToBottom')}
                >
                  <ArrowDown size={14} />
                </motion.button>
              )}
</AnimatePresence>
</div>
        </div>
      )}
      <InputArea />
    </main>
  )
}
