/**
 * 任务清单 IPC：前端常驻「计划面板」读取会话级 todo 文件
 * （.activation/todos-{sessionId}.json）；写入由 TodoWrite 工具负责，
 * 本模块只读，避免与工具写入双轨冲突。
 */
import { ipcMain } from 'electron'
import type { BaseDataPaths } from '../../models/paths'
import { readPersistedTodos } from '../../tools/todo-write'
import { errorFallback, safeHandle } from './safe-handle'

/**
 * 任务清单 IPC：前端常驻「计划面板」读取 .activation/todos-{sessionId}.json。
 * 写入侧由 TodoWrite 工具负责（saveToFile），本 handler 只读。
 * sessionId 用于会话级隔离——前端传入当前会话 ID，读取该会话专属的 todo 文件。
 */
export function registerTodoHandlers(
  ipc: typeof ipcMain,
  getDataPaths: () => BaseDataPaths | null
): void {
  safeHandle(
    ipc,
    'todos:get',
    (event, sessionId?: unknown) => {
      const paths = getDataPaths()
      if (!paths) return { ok: false, error: '数据路径未就绪' }
      const sid = typeof sessionId === 'string' ? sessionId : undefined
      return { ok: true, todos: readPersistedTodos(paths.root, sid) }
    },
    errorFallback('读取任务清单失败')
  )
}
