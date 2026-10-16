/**
 * 为什么存在：AI 流式回复期间需要向用户交代"当前在做什么"——思考 / 调用工具 /
 * 正在生成三个阶段的实时指示。旧实现把工具调用指示放在消息流上方（会话气泡之上），
 * 会挤占首屏内容且把用户的视线从"AI 回答"引开；本组件把状态条移到消息流下方、
 * 输入区上方，作为独立的收尾提示带，跟随流式生命周期显示。
 * 作用：派生 AI 当前阶段（thinking / tool / generating），渲染转圈动画 + 阶段文案
 * （含正在调用的工具名与已耗时）。
 *
 * 性能说明：AIStatusBar 独立订阅 store 的 activeToolCalls / streamingMessageId /
 * currentMessages，放在 ChatArea 层而非消息气泡内——流式每 token 只重渲染
 * 这一条状态带，不影响 MessageBubble memo 树。
 */
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Wrench } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { TOOL_MAP } from '@shared/tools/registry'
import { useT } from '../../i18n/useT'

/** 工具名 → 中文标签（单一数据源：shared/tools/registry.ts 的 TOOL_MAP） */
function toolLabel(name: string): string {
  return TOOL_MAP[name]?.name ?? name
}

/** AI 当前所处阶段 */
type AiPhase = 'thinking' | 'tool' | 'generating'

export function AiStatusBar() {
  const status = useAppStore((s) => s.status)
  const activeToolCalls = useAppStore((s) => s.activeToolCalls)
  const streamingMessageId = useAppStore((s) => s.streamingMessageId)
  const currentMessages = useAppStore((s) => s.currentMessages)
  const t = useT()
  const [, force] = useState(0)
  // 每 200ms 重渲染以更新工具已耗时（仅活跃工具调用期间启动，结束后清理）
  useEffect(() => {
    if (activeToolCalls.length === 0) return
    const timer = setInterval(() => force((n) => n + 1), 200)
    return () => clearInterval(timer)
  }, [activeToolCalls.length])

  // 仅在流式期间显示；idle/error 一律不渲染（避免 done/abort 后残留旧状态）
  if (status !== 'streaming') return null

  // 有活跃工具调用 → 工具执行阶段；否则看当前流式消息是否只有思考内容
  const call = activeToolCalls.length > 0 ? activeToolCalls[activeToolCalls.length - 1] : null
  const phase: AiPhase = call
    ? 'tool'
    : (() => {
        const streamMsg =
          streamingMessageId != null
            ? currentMessages.find((m) => m.id === streamingMessageId)
            : undefined
        return streamMsg && streamMsg.reasoning && !streamMsg.content ? 'thinking' : 'generating'
      })()

  if (phase === 'tool' && call) {
    const elapsed = ((Date.now() - call.startedAt) / 1000).toFixed(1)
    return (
      <div className="flex items-center gap-2 border-t border-accent/40 bg-accent/12 px-6 py-2 text-caption text-accent">
        <Loader2 size={13} className="animate-spin" />
        <Wrench size={13} />
        <span className="font-medium">{t('aiStatus.calling', { name: toolLabel(call.toolName) })}</span>
        <span className="text-accent/70">·</span>
        <span className="tabular-nums font-medium">{elapsed}s</span>
        {activeToolCalls.length > 1 && (
          <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium">
            {t('tool.parallel', { n: activeToolCalls.length - 1 })}
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-muted/40 px-6 py-2 text-caption text-fg-muted">
      <Loader2 size={13} className="animate-spin text-accent" />
      <span>{phase === 'thinking' ? t('aiStatus.thinking') : t('aiStatus.generating')}</span>
    </div>
  )
}