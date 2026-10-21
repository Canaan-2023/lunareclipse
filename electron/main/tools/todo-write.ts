/**
 * 待办清单工具：为什么存在——AI 跨多轮推进长任务时需要落盘的结构化待办，供会话间共享。
 * 作用：TodoWrite 以 JSON 文件维护待办列表（status/priority 校验），并提供读取/清理辅助函数。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'
import { join } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type TodoPriority = 'high' | 'medium' | 'low'

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
  priority: TodoPriority
}

export interface TodoWriteParams {
  todos: TodoItem[]
}

const VALID_STATUS: TodoStatus[] = ['pending', 'in_progress', 'completed']
const VALID_PRIORITY: TodoPriority[] = ['high', 'medium', 'low']

const TODOS_FILE = 'todos.json'

/**
 * 归一化单条 todo：兼容旧中文键 `内容`（旧版本持久化的数据），统一为 content。
 * 写入端（execute）与读取端（loadFromFile / readPersistedTodos）共用，保证新旧数据无缝兼容。
 */
export function normalizeTodoItem(t: unknown): TodoItem {
  const item = (t ?? {}) as Record<string, unknown>
if (typeof item['内容'] === 'string' && typeof item.content !== 'string') {
    const rest = { ...item }
    delete rest['内容']
    return { ...rest, content: item['内容'] } as unknown as TodoItem
  }
  return item as unknown as TodoItem
}

// 内存缓存（无 ctx 时降级使用，向后兼容）
let inMemoryTodos: TodoItem[] = []

/**
 * 解析持久化文件路径：{root}/.activation/todos-{sessionId}.json
 * 会话级隔离：每个会话的 todo 计划独立存储，不跨会话残留。
 * sessionId 缺失时回退到通用 todos.json（向后兼容旧数据/无会话场景）。
 */
export function resolveTodosFile(root?: string, sessionId?: string | null): string | null {
  if (!root) return null
  if (sessionId) {
    return join(root, '.activation', `todos-${sessionId}.json`)
  }
  return join(root, '.activation', TODOS_FILE)
}

function saveToFile(todos: TodoItem[], ctx?: ToolContext): void {
  const file = resolveTodosFile(ctx?.paths?.root, ctx?.sessionId)
  if (!file) return
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(todos, null, 2), 'utf-8')
  } catch (err) {
    console.error('[todo-write] 持久化失败:', err)
  }
}

export class TodoWriteTool implements Tool<TodoWriteParams> {
  name = 'TodoWrite'
  description =
    '任务清单管理（自主规划工具）。参数：todos（必填，任务数组，每项 {id, content, status, priority}）。status: pending/in_progress/completed，priority: high/medium/low。返回更新后的任务清单。清单按会话隔离保存，任务激活时当前清单会出现在你的提示词中，用于恢复规划上下文。'
  parameters = [
    { name: 'todos', type: 'array' as const, description: '任务数组，每项 {id, content, status, priority}', required: true }
  ]

  execute(params: TodoWriteParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!params.todos || !Array.isArray(params.todos)) {
      return Promise.resolve({ ok: false, error: 'todos 必须是数组' })
    }
    // 归一化：兼容旧中文键 `内容`（旧版本持久化的数据），统一为 content
    const normalized = params.todos.map(normalizeTodoItem)
    for (const t of normalized) {
      if (!t.id || typeof t.id !== 'string') {
        return Promise.resolve({ ok: false, error: '每个 todo 必须有 string 类型的 id' })
      }
      if (!t.content || typeof t.content !== 'string') {
        return Promise.resolve({ ok: false, error: '每个 todo 必须有 content 字段' })
      }
      if (!VALID_STATUS.includes(t.status)) {
        return Promise.resolve({ ok: false, error: `status 必须是 ${VALID_STATUS.join(' / ')}` })
      }
      if (!VALID_PRIORITY.includes(t.priority)) {
        return Promise.resolve({ ok: false, error: `priority 必须是 ${VALID_PRIORITY.join(' / ')}` })
      }
    }

    const inProgress = normalized.filter((t) => t.status === 'in_progress')
    if (inProgress.length > 1) {
      return Promise.resolve({
        ok: false,
        error: `只能有一个 in_progress 任务，当前有 ${inProgress.length} 个`
      })
    }

    inMemoryTodos = normalized.map((t) => ({ ...t }))
    // 持久化：自主激活到点后系统读取此文件恢复规划上下文
    saveToFile(inMemoryTodos, ctx)

    return Promise.resolve({
      ok: true,
      data: {
        total: inMemoryTodos.length,
        pending: inMemoryTodos.filter((t) => t.status === 'pending').length,
        in_progress: inMemoryTodos.filter((t) => t.status === 'in_progress').length,
        completed: inMemoryTodos.filter((t) => t.status === 'completed').length,
        todos: inMemoryTodos
      }
    })
  }
}

/**
 * 读取持久化的任务清单（供 ActivationManager 在激活时读取，恢复规划上下文）
 * sessionId 用于会话级隔离——每个会话的 todo 独立存储。
 */
export function readPersistedTodos(root?: string, sessionId?: string | null): TodoItem[] {
  const file = resolveTodosFile(root, sessionId)
  if (!file || !existsSync(file)) return []
  try {
    const raw = readFileSync(file, 'utf-8')
    const data = JSON.parse(raw)
    if (Array.isArray(data)) return data.map(normalizeTodoItem)
  } catch (err) {
    console.error('[todo-write] 读取持久化清单失败:', err)
  }
  return []
}

export function getTodos(): TodoItem[] {
  return [...inMemoryTodos]
}

export function clearTodos(): void {
  inMemoryTodos = []
}
