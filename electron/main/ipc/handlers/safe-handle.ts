/**
 * IPC handler 注册包装器：统一参数校验、认证守卫与错误 fallback 语义，
 * 各领域 handler 只需关注业务逻辑；错误行为（直接传播 vs 结构化 fallback）
 * 由使用方在此显式选择，避免裸 ipc.handle 的异常穿透主进程。
 */
import type { ipcMain as ipcMainType, IpcMainInvokeEvent } from 'electron'
import type { UserStore } from '../../models/user-store'

export function createAuthGuard(getUserStore: () => UserStore | null): () => boolean {
  return () => getUserStore()?.getCurrentUser() != null
}

export function requireAuth<T>(
  authCheck: () => boolean,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>,
  _fallback: T
): (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> {
  return async (event, ...args) => {
    if (!authCheck()) {
      throw new Error('Unauthorized')
    }
    return handler(event, ...args)
  }
}

/**
 * IPC handler 注册包装器（参数校验 + 直接传播错误）。

 * 行为：
 * 1. 可选参数校验——失败时 throw
 * 2. 直接调用 handler，同步异常或 rejected promise 会传播给 ipcRenderer.invoke

 * 不做错误捕获、不返回 fallback——错误直接暴露给渲染进程。
 * 渲染进程通过 invoke 的 reject 捕获并显示。
 */
export type ParamValidator = (args: unknown[]) => string | null

export function safeHandle<T>(
  ipc: typeof ipcMainType,
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>,
  _fallback: T | { ok: false; error: string },
  validator?: ParamValidator
): void {
  ipc.handle(channel, async (event, ...args: unknown[]) => {
    if (validator) {
      const validationError = validator(args)
      if (validationError) {
        throw new Error(`参数校验失败: ${validationError}`)
      }
    }
    return await handler(event, ...args)
  })
}

/**
 * 默认 fallback 工厂：返回 { ok: false, error } 结构化错误。
 * 用于本身返回 {ok,...} 形状的 handler（auth/workspace/mcp/hooks/eval/skill 等）。
 */
export function errorFallback(message = '操作失败，请查看日志'): { ok: false; error: string } {
  return { ok: false, error: message }
}

/**
 * 包装返回 {ok, data?, error?} 形状的 handler。
 * 成功时自动包成 { ok: true, data }；失败时返回 { ok: false, error }。
 * 适用于原本直接返回 data、想统一成 {ok,data} 形状的新 handler。
 */
export function safeHandleOk<T>(
  ipc: typeof ipcMainType,
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => T | Promise<T>,
  validator?: ParamValidator
): void {
  ipc.handle(channel, async (event, ...args: unknown[]) => {
    if (validator) {
      const validationError = validator(args)
      if (validationError) {
        throw new Error(`参数校验失败: ${validationError}`)
      }
    }
    const data = await handler(event, ...args)
    return { ok: true, data }
  })
}
