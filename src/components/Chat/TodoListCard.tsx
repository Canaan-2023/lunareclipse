/**
 * 为什么存在：TodoList 工具产生的任务清单是跨 turn 的持久数据，需要内联在消息流里
 * 展示进度而不打断阅读，独立卡片组件承载。
 * 作用：渲染任务清单卡片——折叠头部 + 进度条 + 状态字形，
 * 全部完成时默认折叠，失败/中途态保持展开。
 */
import { useState, memo } from 'react'
import { ListTodo } from 'lucide-react'

export interface TodoItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
  priority: 'high' | 'medium' | 'low'
}

interface Props {
  todos: TodoItem[]
}

export const PRIORITY_LABELS: Record<TodoItem['priority'], string> = {
  high: '高',
  medium: '中',
  low: '低'
}

export const PRIORITY_CLASSES: Record<TodoItem['priority'], string> = {
  high: 'bg-danger-soft text-danger',
  medium: 'bg-warning-soft text-warning',
  low: 'bg-bg-muted text-fg-muted'
}

/**
 * 任务清单状态字形：
 * [x] completed / [>] in_progress / [-] cancelled / [ ] pending
 */
export function todoGlyph(status: TodoItem['status']): string {
  return status === 'completed' ? '[x]' : status === 'cancelled' ? '[-]' : status === 'in_progress' ? '[>]' : '[ ]'
}

/**
 * 计算任务清单进度统计
 * 视觉重做核心：进度条 + 状态色条 + 标题色依赖此函数
 */
export function getProgressStats(todos: TodoItem[]): {
  total: number
  completed: number
  percent: number
  hasInProgress: boolean
  incomplete: number
} {
  const total = todos.length
  const completed = todos.filter((t) => t.status === 'completed').length
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0
  const hasInProgress = todos.some((t) => t.status === 'in_progress')
  const incomplete = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress').length
  return { total, completed, percent, hasInProgress, incomplete }
}

/**
 * 任务清单卡片（TodoPanel 风格）：
 * - 折叠头：▸/▾ Todo (done/total) · incomplete 标记（未完成时）
 * - 行字形：[x]/[>]/[-]/[ ]（todoGlyph）
 * - 全部完成 → 默认折叠；未完成 → 展开 + incomplete 标记
 * 数据来自 TodoWrite 工具调用的 todos（跨 turn 快照由后端推送）。
 */
export const TodoListCard = memo(
  function TodoListCard({ todos }: Props) {
    const { total, completed, percent, hasInProgress, incomplete } = getProgressStats(todos)
    // 语义：全部完成则默认折叠（done ? todoCollapsedByDefault : todoIncomplete）
    const [expanded, setExpanded] = useState(incomplete === 0 ? false : true)

    if (!todos || todos.length === 0) return null

    const allDone = incomplete === 0

    return (
      <div className={`relative my-2 rounded-card border border-border-subtle overflow-hidden transition-colors ${hasInProgress ? 'bg-accent/8' : allDone ? 'bg-success/6' : 'bg-warning/5'}`}>
        {/* 左侧色条 */}
        <span className={`absolute left-0 top-0 h-full w-1 ${hasInProgress ? 'bg-accent' : allDone ? 'bg-success' : 'bg-warning'}`} />
        {/* 顶部：折叠头 "▸/▾ Todo (done/total) · incomplete" */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="relative flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-muted/40 transition-colors"
        >
          <span className={`shrink-0 font-mono text-caption ${hasInProgress ? 'text-accent' : allDone ? 'text-success' : 'text-warning'}`}>
            {expanded ? '▾' : '▸'}
          </span>
          <ListTodo size={13} className={`shrink-0 ${hasInProgress ? 'text-accent' : allDone ? 'text-success' : 'text-warning'}`} />
          <span className={`shrink-0 font-mono text-caption font-medium ${hasInProgress ? 'text-accent' : allDone ? 'text-success' : 'text-warning'}`}>
            Todo ({completed}/{total})
          </span>
          {/* 未完成标记（incomplete） */}
          {incomplete > 0 && (
            <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-warning">
              {incomplete} 未完成
            </span>
          )}
          {/* 进度条 */}
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-muted">
            <div
              className={`h-full transition-all duration-300 ${hasInProgress ? 'bg-accent' : allDone ? 'bg-success' : 'bg-warning'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className={`shrink-0 tabular-nums text-caption font-medium ${hasInProgress ? 'text-accent' : allDone ? 'text-success' : 'text-warning'}`}>
            {percent}%
          </span>
        </button>

        {/* 展开态：任务列表（字形 + 内容，缩进 marginLeft） */}
        {expanded && (
          <div className="border-t border-border-subtle/60 bg-bg-base/40">
            {todos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </div>
        )}
      </div>
    )
  },
  (prev, next) => prev.todos === next.todos
)

/** 单条任务行（[x]/[>]/[-]/[ ] + content，缩进 2 空格） */
function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 pl-4 hover:bg-bg-muted/40 transition-colors border-t border-border-subtle/30">
      {/* 状态字形（todoGlyph） */}
      <span
        className={`shrink-0 font-mono text-caption ${
          todo.status === 'completed'
            ? 'text-success'
            : todo.status === 'cancelled'
              ? 'text-fg-muted'
              : todo.status === 'in_progress'
                ? 'text-accent animate-pulse'
                : 'text-fg-muted'
        }`}
      >
        {todoGlyph(todo.status)}
      </span>
      {/* 内容文本 */}
      <span
        className={`flex-1 truncate text-caption ${
          todo.status === 'completed'
            ? 'text-fg-muted line-through'
            : todo.status === 'cancelled'
              ? 'text-fg-muted line-through opacity-60'
              : 'text-fg-primary'
        }`}
      >
        {todo.content}
      </span>
      {/* 优先级标签 */}
      <span
        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_CLASSES[todo.priority]}`}
      >
        {PRIORITY_LABELS[todo.priority]}
      </span>
    </div>
  )
}
