/**
 * 为什么存在：工作流实例运行中需要可见、可控制的状态条，
 * 独立组件订阅 workflowStore 并展示运行进度。
 * 作用：渲染工作流状态条——活跃实例状态（进度/阶段）、展开查看节点历史、
 * 暂停/恢复/取消操作。
 */
import { useState, memo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  ChevronDown,
  Loader2,
  Pause,
  Play,
  X,
  CircleDot,
  CheckCircle2,
  AlertCircle,
  Circle,
  Workflow,
  Brain,
  Wrench,
  Sparkles,
  Split,
  MessageSquare,
  CornerDownLeft,
  Flag
} from 'lucide-react'
import { useWorkflowStore } from '../../stores/workflowStore'
import type { WorkflowInstance, NodeRun, NodeType } from '@shared/workflow/types'

/** 节点类型 → 图标映射（NodeHistoryRow 视觉识别用） */
const NODE_TYPE_ICONS: Record<NodeType, typeof Brain> = {
  llm: Brain,
  tool: Wrench,
  skill: Sparkles,
  condition: Split,
  human: MessageSquare,
  answer: CornerDownLeft,
  end: Flag
}

/** 节点类型 → 中文标签 */
const NODE_TYPE_LABELS: Record<NodeType, string> = {
  llm: 'LLM',
  tool: '工具',
  skill: 'SKILL',
  condition: '条件',
  human: '人工',
  answer: '回复',
  end: '结束'
}

/**
 * 工作流引擎：工作流状态条



 * 行为：
 * - 订阅 workflowStore.activeInstances，有活跃实例时在聊天区顶部显示状态条
 * - 每个实例一个折叠行：名称 + 当前节点 + 状态徽章 + 进度 + 控制按钮
 * - 点击行可展开节点历史列表
 * - 控制按钮：暂停/恢复/取消（调用 workflowStore.modifyInstance）

 * 样式对齐：参考 TodoListCard 进度条 + ToolCallCard 状态色 + ChatArea 顶部状态条
 */
export const WorkflowStatusBar = memo(
  function WorkflowStatusBar() {
    const activeInstances = useWorkflowStore((s) => s.activeInstances)
    const modifyInstance = useWorkflowStore((s) => s.modifyInstance)

    if (activeInstances.length === 0) return null

    return (
      <div className="border-b border-border-subtle bg-bg-surface/60">
        {activeInstances.map((inst) => (
          <WorkflowInstanceRow
            key={inst.id}
            instance={inst}
            onModify={modifyInstance}
          />
        ))}
      </div>
    )
  }
)

/** 单个实例行 */
function WorkflowInstanceRow({
  instance,
  onModify
}: {
  instance: WorkflowInstance
  onModify: (params: { instanceId: string; action: 'pause' | 'resume' | 'cancel' }) => Promise<unknown>
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

  const total = instance.history.length
  const completed = instance.history.filter((n) => n.status === 'done').length
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0
  const isRunning = instance.status === 'running'
  const isPaused = instance.status === 'paused'
  const isFailed = instance.status === 'failed'

  // 状态色映射（对齐 ToolCallCard getStatusBar）
  const statusBar = isRunning
    ? 'bg-accent'
    : isFailed
    ? 'bg-danger'
    : isPaused
    ? 'bg-warning'
    : 'bg-success'

  const statusText = isRunning
    ? '运行中'
    : isPaused
    ? (instance.pauseReason === 'human' ? '等待输入' : instance.pauseReason === 'await_user' ? '等待消息' : '已暂停')
    : isFailed
    ? '失败'
    : instance.status === 'completed'
    ? '已完成'
    : instance.status === 'cancelled'
    ? '已取消'
    : '未知'

  const handleAction = async (action: 'pause' | 'resume' | 'cancel') => {
    setBusy(true)
    try {
      await onModify({ instanceId: instance.id, action })
    } finally {
      setBusy(false)
    }
  }

  // 找当前节点（history 最后一条或 currentNode 对应）
  const currentNode = instance.history.length > 0
    ? instance.history[instance.history.length - 1]
    : null
  const CurrentNodeIcon = currentNode ? (NODE_TYPE_ICONS[currentNode.nodeType] ?? Circle) : null

  return (
    <div className="relative">
      {/* 左侧状态色条：运行中加呼吸动画 */}
      <span className={`absolute left-0 top-0 h-full w-1 ${statusBar} ${isRunning ? 'animate-pulse' : ''}`} />

      {/* 主行：外层用 role=button 的 div 而非 <button>——
          内层有真实的暂停/恢复/取消按钮，button 嵌套 button 违反 HTML content model，
          DOM 会被浏览器自动拆开导致点击错位、无障碍树异常。
          用 div 承载展开/收起：Enter/Space 触发、Tab 可达，与原生按钮行为等价。 */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded(!expanded)
          }
        }}
        className="relative flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left hover:bg-bg-muted/40 transition-colors focus-visible:outline-2 focus-visible:outline-accent"
      >
        {/* 状态图标 */}
        {isRunning ? (
          <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
        ) : isPaused ? (
          <Pause size={12} className="shrink-0 text-warning" />
        ) : isFailed ? (
          <AlertCircle size={12} className="shrink-0 text-danger" />
        ) : (
          <CheckCircle2 size={12} className="shrink-0 text-success" />
        )}

        {/* 工作流图标 + 名称 */}
        <Workflow size={12} className="shrink-0 text-fg-muted" />
        <span className="shrink-0 text-caption font-medium text-fg-primary truncate max-w-[180px]" title={instance.templateName ?? instance.templateId}>
          {instance.templateName ?? instance.templateId}
        </span>
        <span className="shrink-0 rounded bg-bg-muted px-1 py-0.5 text-[10px] text-fg-muted">
          {instance.mode === 'chatflow' ? '对话流' : '工作流'}
        </span>

        {/* 当前节点 + 类型图标 */}
        {currentNode && CurrentNodeIcon && (
          <span className="flex shrink-0 items-center gap-1 text-caption text-fg-muted">
            <span className="text-fg-muted/70">·</span>
            <CurrentNodeIcon size={11} className="text-fg-muted" />
            <span className="truncate max-w-[140px]" title={currentNode.nodeName}>{currentNode.nodeName}</span>
          </span>
        )}

        {/* 进度条 */}
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-bg-muted">
          <div
            className={`h-full transition-all duration-300 ${statusBar}`}
            style={{ width: `${percent}%` }}
          />
        </div>

        {/* 进度数字 */}
        <span className="shrink-0 tabular-nums text-caption text-fg-muted">
          {completed}/{total || '?'}
        </span>

        {/* 状态徽章 */}
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
          isRunning ? 'bg-accent/15 text-accent' :
          isFailed ? 'bg-danger-soft text-danger' :
          isPaused ? 'bg-warning-soft text-warning' :
          'bg-success-soft text-success'
        }`}>
          {statusText}
        </span>

        {/* 控制按钮 */}
        <div className="flex shrink-0 items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
          {isRunning && (
            <button
              onClick={() => handleAction('pause')}
              disabled={busy}
              title="暂停"
              aria-label="暂停"
              className="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-warning disabled:opacity-50"
            >
              <Pause size={11} />
            </button>
          )}
          {isPaused && instance.pauseReason === 'manual' && (
            <button
              onClick={() => handleAction('resume')}
              disabled={busy}
              title="恢复"
              aria-label="恢复"
              className="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-accent disabled:opacity-50"
            >
              <Play size={11} />
            </button>
          )}
          {(isRunning || isPaused) && (
            <button
              onClick={() => {
                // 取消会终止运行中的工作流实例，已执行节点进度无法恢复，先确认再调用
                if (!window.confirm('取消将终止该工作流实例，已执行的进度无法恢复。确定取消？')) return
                void handleAction('cancel')
              }}
              disabled={busy}
              title="取消"
              aria-label="取消"
              className="rounded p-1 text-fg-muted hover:bg-bg-muted hover:text-danger disabled:opacity-50"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <ChevronDown
          size={12}
          className={`shrink-0 text-fg-secondary transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </div>

      {/* 展开态：节点历史列表 */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden border-t border-border-subtle/60 bg-bg-base/40"
          >
            {instance.history.length === 0 ? (
              <div className="px-4 py-2 text-caption text-fg-muted">暂无节点执行记录</div>
            ) : (
              <div className="max-h-[240px] overflow-y-auto">
                {instance.history.map((node, idx) => (
                  <NodeHistoryRow key={`${node.nodeId}-${idx}`} node={node} />
                ))}
              </div>
            )}
            {instance.error && (
              <div className="border-t border-border-subtle/30 px-4 py-2 text-caption text-danger">
                错误：{instance.error}
              </div>
            )}
            {instance.output && (
              <div className="border-t border-border-subtle/30 px-4 py-2 text-caption text-fg-secondary">
                <span className="text-fg-muted">输出：</span>
                <span className="line-clamp-2">{instance.output}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** 节点历史行 */
function NodeHistoryRow({ node }: { node: NodeRun }) {
  const statusIcon = node.status === 'done' ? (
    <CheckCircle2 size={11} className="text-success" />
  ) : node.status === 'failed' ? (
    <AlertCircle size={11} className="text-danger" />
  ) : node.status === 'running' ? (
    <CircleDot size={11} className="text-accent animate-pulse" />
  ) : (
    <Circle size={11} className="text-fg-muted" />
  )

  const NodeIcon = NODE_TYPE_ICONS[node.nodeType] ?? Circle
  const duration = node.endedAt && node.startedAt
    ? `${((node.endedAt - node.startedAt) / 1000).toFixed(1)}s`
    : null

  return (
    <div className="flex items-center gap-2 px-4 py-1 hover:bg-bg-muted/40 transition-colors border-t border-border-subtle/30 first:border-t-0">
      <span className="shrink-0">{statusIcon}</span>
      <NodeIcon size={11} className="shrink-0 text-fg-muted" />
      <span className="shrink-0 rounded bg-bg-muted/60 px-1 py-0.5 text-[10px] tabular-nums text-fg-muted">
        {NODE_TYPE_LABELS[node.nodeType] ?? node.nodeType}
      </span>
      <span className={`flex-1 truncate text-caption ${
        node.status === 'failed' ? 'text-danger' : 'text-fg-secondary'
      }`}>
        {node.nodeName}
      </span>
      {node.error && (
        <span className="shrink-0 text-[10px] text-danger truncate max-w-[120px]" title={node.error}>
          {node.error}
        </span>
      )}
      {duration && (
        <span className="shrink-0 tabular-nums text-[10px] text-fg-muted">
          {duration}
        </span>
      )}
    </div>
  )
}
