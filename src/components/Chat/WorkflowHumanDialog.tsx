/**
 * 为什么存在：工作流的 human 节点与 ask_user 调用需要阻塞式人工输入弹窗，
 * 独立组件监听 workflowStore 的 pending 状态并渲染输入 UI。
 * 作用：渲染人工输入弹窗——confirm/text/choice 三种输入形态，
 * 提交（respondHumanInput）或取消（cancel）并伴随动画出现/收束。
 */
import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { MessageSquare, Send, X, Check } from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'

/**
 * 工作流引擎：人工节点 & ask_user 输入弹窗



 * 行为：
 * - 订阅 workflowStore.pendingHumanInput（human 节点）和 pendingAskUser（ask_user 工具）
 * - 三种 inputType 分支渲染：confirm / text / choice
 * - 调用 respondHumanInput / respondAskUser 提交，或 cancelHumanInput / cancelAskUser 取消

 * 样式参考：PermissionDialog 的全局模态范式
 */
export function WorkflowHumanDialog() {
  const pendingHuman = useWorkflowStore((s) => s.pendingHumanInput)
  const pendingAsk = useWorkflowStore((s) => s.pendingAskUser)
  const respondHumanInput = useWorkflowStore((s) => s.respondHumanInput)
  const cancelHumanInput = useWorkflowStore((s) => s.cancelHumanInput)
  const respondAskUser = useWorkflowStore((s) => s.respondAskUser)
  const cancelAskUser = useWorkflowStore((s) => s.cancelAskUser)

  // 统一抽象：把两种 pending 合并成一个视图模型
  const pending = pendingHuman
    ? {
        kind: 'human' as const,
        id: pendingHuman.instanceId,
        prompt: pendingHuman.prompt,
        inputType: pendingHuman.inputType,
        options: pendingHuman.options
      }
    : pendingAsk
    ? {
        kind: 'ask' as const,
        id: pendingAsk.requestId,
        prompt: pendingAsk.question,
        inputType: pendingAsk.inputType,
        options: pendingAsk.options
      }
    : null

  const [text, setText] = useState('')
  const [choice, setChoice] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // 弹窗出现时重置输入 + 自动聚焦（confirm/choice 类型无输入框，需主动聚焦容器才能响应快捷键）
  useEffect(() => {
    if (pending) {
      setText('')
      setChoice(null)
      // text 类型由 textarea autoFocus 处理，confirm/choice 主动聚焦容器
      if (pending.inputType !== 'text') {
        requestAnimationFrame(() => dialogRef.current?.focus())
      }
    }
  }, [pending?.id, pending?.kind])

  const handleSubmit = async () => {
    if (!pending) return
    if (pending.kind === 'human') {
      if (pending.inputType === 'confirm') {
        await respondHumanInput('yes')
      } else if (pending.inputType === 'text') {
        if (!text.trim()) return
        await respondHumanInput(text.trim())
      } else if (pending.inputType === 'choice') {
        if (!choice) return
        await respondHumanInput(choice)
      }
    } else {
      if (pending.inputType === 'confirm') {
        await respondAskUser('yes')
      } else if (pending.inputType === 'text') {
        if (!text.trim()) return
        await respondAskUser(text.trim())
      } else if (pending.inputType === 'choice') {
        if (!choice) return
        await respondAskUser(choice)
      }
    }
  }

  const handleCancel = async () => {
    if (!pending) return
    if (pending.kind === 'human') {
      await cancelHumanInput()
    } else {
      await cancelAskUser()
    }
  }

  const handleKey = (e: React.KeyboardEvent) => {
    // Esc 全局取消
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
      return
    }
    // text 类型：Ctrl/Cmd+Enter 提交
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && pending?.inputType === 'text') {
      e.preventDefault()
      handleSubmit()
      return
    }
    // confirm 类型：Enter 直接确认
    if (e.key === 'Enter' && pending?.inputType === 'confirm') {
      e.preventDefault()
      handleSubmit()
      return
    }
    // choice 类型：数字键 1-9 快速选择对应选项
    if (pending?.inputType === 'choice' && pending.options && /^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1
      if (idx < pending.options.length) {
        e.preventDefault()
        setChoice(pending.options[idx])
      }
    }
  }

  return (
    <AnimatePresence>
      {pending && (
        /* 遮罩层：仅承担视觉隔离与居中，点击不触发任何取消——
           对 human/ask 工作流取消=终止整个可中断工作流且进度无法恢复，
           遮罩误触（如输入时鼠标滑出点到背景）直接丢进度不可接受；
           取消入口只保留在显式「取消」按钮与 Esc 快捷键（两个都代表明确意图）。 */
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        >
          <motion.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={pending.kind === 'human' ? '工作流请求输入' : 'AI 询问'}
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 8 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleKey}
            tabIndex={-1}
            className="w-[480px] overflow-hidden rounded-xl border border-accent/30 bg-bg-elevated shadow-2xl focus:outline-none"
          >
            {/* 头部 */}
            <div className="flex items-center gap-2 border-b border-border-base px-5 py-3">
              <MessageSquare size={14} className="text-accent" />
              <span className="text-body font-medium text-fg-primary">
                {pending.kind === 'human' ? '工作流请求输入' : 'AI 询问'}
              </span>
              <span className="ml-auto rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                {pending.inputType === 'confirm' ? '确认' : pending.inputType === 'text' ? '文本' : '选择'}
              </span>
            </div>

            {/* 内容 */}
            <div className="px-5 py-4">
              <div className="text-body text-fg-primary whitespace-pre-wrap">
                {pending.prompt}
              </div>

              {/* text 输入 */}
              {pending.inputType === 'text' && (
                <textarea
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={handleKey}
                  rows={3}
                  placeholder="请输入..."
                  className="mt-3 w-full resize-none rounded-lg border border-border-subtle bg-bg-base px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
                />
              )}

              {/* choice 选项 */}
              {pending.inputType === 'choice' && pending.options && (
                <div className="mt-3 space-y-1.5">
                  {pending.options.map((opt, idx) => (
                    <button
                      key={idx}
                      onClick={() => setChoice(opt)}
                      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-caption transition-colors ${
                        choice === opt
                          ? 'border-accent bg-accent/10 text-accent'
                          : 'border-border-subtle bg-bg-base text-fg-secondary hover:border-accent/40 hover:bg-bg-muted/40'
                      }`}
                    >
                      <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                        choice === opt ? 'border-accent' : 'border-border-subtle'
                      }`}>
                        {choice === opt && <Check size={10} className="text-accent" />}
                      </span>
                      <span className="flex-1">{opt}</span>
                      {idx < 9 && (
                        <kbd className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] tabular-nums ${
                          choice === opt ? 'bg-accent/20 text-accent' : 'bg-bg-muted text-fg-muted'
                        }`}>
                          {idx + 1}
                        </kbd>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {/* confirm 不需要额外输入 */}
              {pending.inputType === 'confirm' && (
                <div className="mt-3 text-caption text-fg-muted">
                  确认后将向工作流返回 "yes"。
                </div>
              )}
            </div>

            {/* 按钮 */}
            <div className="flex items-center justify-between gap-2 border-t border-border-base px-5 py-3">
              <span className="text-[10px] text-fg-muted">
                {pending.inputType === 'text'
                  ? 'Ctrl+Enter 提交 · Esc 取消'
                  : pending.inputType === 'confirm'
                  ? 'Enter 确认 · Esc 取消'
                  : pending.options && pending.options.length > 0
                  ? `数字键 1-${Math.min(pending.options.length, 9)} 选择 · Esc 取消`
                  : 'Esc 取消'}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleCancel}
                  className="flex items-center gap-1 rounded-lg px-3 py-1.5 text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
                >
                  <X size={12} aria-hidden="true" />
                  取消
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={
                    (pending.inputType === 'text' && !text.trim()) ||
                    (pending.inputType === 'choice' && !choice)
                  }
                  className="flex items-center gap-1 rounded-lg bg-accent px-4 py-1.5 text-caption text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-50"
                >
                  <Send size={12} />
                  提交
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
