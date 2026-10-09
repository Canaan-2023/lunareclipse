/**
 * 为什么存在：TodoWrite 任务清单是跨轮次推进的重要上下文，需要持续可见的
 * 监控面板（抽屉），且上下文窗口引用数需一并呈现。
 * 作用：渲染 Todo 面板——周期轮询 todos 展示（优先级/状态/并发子任务）、
 * 上下文窗口文件引用计数与截断提示。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ListTodo, CheckCircle2, Loader2, ChevronDown, ChevronRight, FileText, Files, X } from 'lucide-react'
import { useAppStore, type PlanTodoItem } from '../stores/appStore'
import { truncateConversation } from '@shared/utils/context-window'
const PRIORITY_LABELS: Record<PlanTodoItem['priority'], string> = {
  high: '高',
  medium: '中',
  low: '低'
}

const PRIORITY_CLASSES: Record<PlanTodoItem['priority'], string> = {
  high: 'bg-danger-soft text-danger',
  medium: 'bg-warning-soft text-warning',
  low: 'bg-bg-muted text-fg-muted'
}

const STATUS_GLYPH: Record<PlanTodoItem['status'], string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]'
}

/** 从工具调用参数里提取文件路径（Read/Write/Edit/Glob/MoveFile/CopyFile 等） */
function extractFilePaths(args: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== 'string') continue
    if (/file|path|source|target/i.test(k)) out.push(v)
  }
  return out
}

/** 从文件名/路径提取展示用短名（取 basename） */
function shortName(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p
  return base.length > 60 ? base.slice(0, 57) + '...' : base
}

/**
 * 计划面板（右侧面板体系）：实时展示 TodoWrite 任务清单 + 当前上下文窗口引用文件数。
 * - 作为右侧面板 tab（todo）存在，与浏览器/代码沙箱共用同一标签页区域（全宽内联布局）
 * - 挂载时从主进程读 .activation/todos.json（refreshTodos），每 3s 轮询
 * - 文件引用：与后端同窗口逻辑（truncateConversation）统计可见消息里的
 * 用户附件 + AI 工具调用的文件路径，去重计数
 */
export function TodoPanel() {
  const todos = useAppStore((s) => s.todos)
  const refreshTodos = useAppStore((s) => s.refreshTodos)
  const messages = useAppStore((s) => s.currentMessages)
  const contextWindow = useAppStore((s) => s.config.contextWindow)
  const open = useAppStore((s) => s.activeDrawer === 'todo' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const [collapsed, setCollapsed] = useState(false)
  const [refsCollapsed, setRefsCollapsed] = useState(false)
  const firstLoad = useRef(false)

  useEffect(() => {
    void refreshTodos()
    firstLoad.current = true
    // 3s 高频轮询 + HMR 重载竞态 → set({todos: 新数组}) 每次都是新引用，
    // 强制订阅组件重渲染，HMR 期间新旧组件并存时形成 set 风暴 → "Maximum update depth exceeded"
    // 渲染循环 → WS 消息（工具结果/AI 输出）无法处理显示 → 用户感知"工具不响应"。
    // 降为低频兜底（30s），主刷新时机改为 AI 工具调用（tool_end）后由 appStore 主动 refreshTodos。
    const t = setInterval(() => {
      void refreshTodos()
    }, 30000)
    return () => clearInterval(t)
  }, [refreshTodos])

  // 与 AI 上下文一致：只统计 contextWindow 截断后可见消息里的文件引用
  // 注意：useMemo 必须在 if (!open) 之前调用（React Hooks 规则）
  const fileRefs = useMemo(() => {
    const { kept } = truncateConversation(messages, contextWindow)
    const set = new Set<string>()
    for (const m of kept) {
      if (Array.isArray(m.attachments)) {
        for (const a of m.attachments) set.add(a.path || a.name)
      }
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) {
          if (!tc.args) continue
          for (const p of extractFilePaths(tc.args)) set.add(p)
        }
      }
    }
    return [...set]
  }, [messages, contextWindow])

  if (!open) return null

  const total = todos.length
  const completed = todos.filter((t) => t.status === 'completed').length
  const inProgress = todos.filter((t) => t.status === 'in_progress')
  const pending = todos.filter((t) => t.status === 'pending')
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0
  const allDone = total > 0 && completed === total
  const hasTask = total > 0

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      {/* 面板头 */}
      <div className="flex items-center border-b border-border-subtle px-3 py-2">
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-fg-primary"
        >
          {collapsed ? (
            <ChevronRight size={14} className="shrink-0 text-fg-muted" />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-fg-muted" />
          )}
          <ListTodo size={14} className={`shrink-0 ${hasTask ? (allDone ? 'text-success' : inProgress.length > 0 ? 'text-accent' : 'text-warning') : 'text-fg-muted'}`} />
          <span className="shrink-0 text-caption font-medium text-fg-primary">计划</span>
          {hasTask && (
            <span className={`ml-auto shrink-0 font-mono text-caption ${allDone ? 'text-success' : 'text-fg-muted'}`}>
              {completed}/{total}
            </span>
          )}
        </button>
        <button
          onClick={() => closeDrawer()}
          className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
          title="关闭计划面板"
          aria-label="关闭计划面板"
        >
          <X size={12} />
        </button>
      </div>

      {/* 进度条（有任务时） */}
      {hasTask && !collapsed && (
        <div className="px-3 pb-2">
          <div className="h-1 overflow-hidden rounded-full bg-bg-muted">
            <div
              className={`h-full transition-all duration-300 ${allDone ? 'bg-success' : inProgress.length > 0 ? 'bg-accent' : 'bg-warning'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>
      )}

      {/* 任务列表 */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto px-1 pb-2">
          {!hasTask && (
            <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
              <ListTodo size={16} className="text-fg-muted/60" />
              <span className="text-[11px] leading-relaxed text-fg-muted">
                暂无计划任务
                <br />
                AI 规划时自动显示
              </span>
            </div>
          )}
          {hasTask && (
            <div className="flex flex-col gap-0.5">
              {/* 进行中优先展示 */}
              {inProgress.map((t) => (
                <TodoRow key={t.id} todo={t} active />
              ))}
              {pending.map((t) => (
                <TodoRow key={t.id} todo={t} />
              ))}
              {todos
                .filter((t) => t.status === 'completed')
                .map((t) => (
                  <TodoRow key={t.id} todo={t} done />
                ))}
            </div>
          )}
        </div>
      )}

      {/* ===== 文件引用分区（分割线分隔） ===== */}
      <div className="shrink-0 border-t border-border-subtle">
        <button
          onClick={() => setRefsCollapsed(!refsCollapsed)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-bg-muted/40 transition-colors"
        >
          {refsCollapsed ? (
            <ChevronRight size={14} className="shrink-0 text-fg-muted" />
          ) : (
            <ChevronDown size={14} className="shrink-0 text-fg-muted" />
          )}
          <Files size={14} className={`shrink-0 ${fileRefs.length > 0 ? 'text-accent' : 'text-fg-muted'}`} />
          <span className="shrink-0 text-caption font-medium text-fg-primary">文件引用</span>
          <span className={`ml-auto shrink-0 font-mono text-caption ${fileRefs.length > 0 ? 'text-fg-muted' : 'text-fg-muted/50'}`}>
            {fileRefs.length}
          </span>
        </button>
        {!refsCollapsed && (
          <div className="max-h-40 overflow-y-auto px-1 pb-2">
            {fileRefs.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 px-3 py-4 text-center">
                <FileText size={14} className="text-fg-muted/50" />
                <span className="text-[11px] leading-relaxed text-fg-muted">
                  当前上下文窗口
                  <br />
                  暂无文件引用
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {fileRefs.map((p) => (
                  <div
                    key={p}
                    className="flex items-start gap-1.5 rounded-card px-2 py-1 hover:bg-bg-muted/40 transition-colors"
                    title={p}
                  >
                    <FileText size={10} className="mt-0.5 shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 break-all font-mono text-[10px] leading-snug text-fg-muted">
                      {shortName(p)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function TodoRow({ todo, done, active }: { todo: PlanTodoItem; done?: boolean; active?: boolean }) {
  return (
    <div
      className={`group flex items-start gap-1.5 rounded-card px-2 py-1.5 transition-colors ${
        active ? 'bg-accent/8' : done ? 'opacity-70' : 'hover:bg-bg-muted/40'
      }`}
    >
      <span
        className={`mt-0.5 shrink-0 font-mono text-[11px] ${
          done ? 'text-success' : active ? 'text-accent animate-pulse' : 'text-fg-muted'
        }`}
      >
        {active ? <Loader2 size={11} className="animate-spin" /> : STATUS_GLYPH[todo.status]}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={`text-[11px] leading-snug ${
            done ? 'text-fg-muted line-through' : 'text-fg-primary'
          }`}
          title={todo.content}
        >
          {todo.content}
        </div>
        <div className="mt-0.5 flex items-center gap-1">
          <span
            className={`shrink-0 rounded-full px-1.5 py-px text-[9px] font-medium ${PRIORITY_CLASSES[todo.priority]}`}
          >
            {PRIORITY_LABELS[todo.priority]}
          </span>
          {done && <CheckCircle2 size={9} className="text-success" />}
        </div>
      </div>
    </div>
  )
}
