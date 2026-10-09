/**
 * Hook 配置 IPC：读取/写入全局与项目作用域的 Hook 配置，并支持
 * 工程级 hooks 开关；写入需用户弹窗确认（Hook 可注入任意拦截逻辑）。
 */
import type { ipcMain as ipcMainType, IpcMainInvokeEvent, dialog as dialogType } from 'electron'
import type { UserStore } from '../../models/user-store'
import type { HooksConfig, HookEvent, HookContext, HookScope } from '../../hooks/types'
import { readHooksConfig, writeHooksConfig, getHooksPaths, setProjectHooksAllowed, hasProjectHooks, isProjectHooksAllowed } from '../../hooks/config-loader'
import { HookManager, loadAllHooks } from '../../hooks'
import { kernelRegistry } from '../../kernel'
import { safeHandle, createAuthGuard, requireAuth } from './safe-handle'

const CONFIRM_BUTTON_INDEX = 0
const CANCEL_BUTTON_INDEX = 1
const VALID_HOOK_SCOPES: readonly string[] = ['global', 'project']
const VALID_HOOK_EVENTS: readonly string[] = [
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PreLLMCall', 'Stop', 'SubagentStop', 'Notification'
]

export function registerHooksHandlers(ipc: typeof ipcMainType, getUserStore?: () => UserStore | null, dialog?: typeof dialogType): void {
  const authCheck = getUserStore ? createAuthGuard(getUserStore) : null
  /** 查询配置文件路径 */
  safeHandle(ipc, 'hooks:getPaths', () => getHooksPaths(), null)

  /** 读取指定作用域的配置 */
  safeHandle(ipc, 'hooks:read', (_event, ...args: unknown[]) => {
    const scope = args[0]
    if (typeof scope !== 'string' || !VALID_HOOK_SCOPES.includes(scope)) {
      return { hooks: [] } as HooksConfig
    }
    return readHooksConfig(scope as HookScope)
  }, { hooks: [] } as HooksConfig)

  /** 写入指定作用域的配置（需用户确认：Hook 可注入任意拦截逻辑） */
  const writeHandler = async (_event: IpcMainInvokeEvent, ...args: unknown[]): Promise<{ ok: boolean; error?: string }> => {
    if (!dialog) return { ok: false, error: '写入 Hook 配置需要用户确认，但 dialog 不可用' }
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['确认写入', '取消'],
      defaultId: CANCEL_BUTTON_INDEX,
      title: 'Hook 配置写入确认',
      message: `即将写入 ${String(args[0] ?? '未知')} 作用域的 Hook 配置`,
      detail: 'Hook 可拦截工具执行和注入自定义逻辑。确认要写入吗？'
    })
    if (result.response !== CONFIRM_BUTTON_INDEX) {
      return { ok: false, error: '用户取消写入' }
    }
    if (typeof args[0] !== 'string' || !VALID_HOOK_SCOPES.includes(args[0])) {
      return { ok: false, error: '无效的 Hook 作用域' }
    }
    if (!args[1] || typeof args[1] !== 'object' || Array.isArray(args[1])) {
      return { ok: false, error: '无效的 Hook 配置' }
    }
    return writeHooksConfig(args[0] as HookScope, args[1] as HooksConfig)
  }

  safeHandle(ipc, 'hooks:write',
    authCheck
      ? requireAuth(authCheck, writeHandler, { ok: false, error: '请先登录' })
      : writeHandler,
    { ok: false, error: '写入 Hook 配置失败' }
  )

  /** 查询已解析的 Hook 列表（合并全局+默认+项目级，调试用——显示全部含未确认） */
  safeHandle(ipc, 'hooks:listResolved', () => loadAllHooks(true), [])

  /** 检测项目级 Hook 是否存在且未确认（前端提示用户确认用） */
  safeHandle(ipc, 'hooks:hasProject', () => ({
    hasProject: hasProjectHooks(),
    allowed: isProjectHooksAllowed()
  }), { hasProject: false, allowed: false })

  /** 确认启用项目级 Hook（用户 UI 确认后调用，触发热重载） */
  const confirmProjectHandler = async (_event: IpcMainInvokeEvent): Promise<{ ok: boolean; error?: string }> => {
    if (!dialog) return { ok: false, error: '确认操作需要 dialog，但 dialog 不可用' }
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['确认启用', '取消'],
      defaultId: CANCEL_BUTTON_INDEX,
      title: '项目级 Hook 确认',
      message: '即将启用项目级 Hook 配置',
      detail: '项目级 Hook 可拦截工具执行和注入自定义逻辑。仅在你信任当前工作区来源时启用。'
    })
    if (result.response !== CONFIRM_BUTTON_INDEX) {
      return { ok: false, error: '用户取消' }
    }
    setProjectHooksAllowed(true)
    return { ok: true }
  }

  safeHandle(ipc, 'hooks:confirmProject',
    authCheck
      ? requireAuth(authCheck, confirmProjectHandler, { ok: false, error: '请先登录' })
      : confirmProjectHandler,
    { ok: false, error: '确认项目级 Hook 失败' }
  )

  /** 生效 Hook 三源合并清单：config 文件 + 内核治理（builtin）+ 插件 hooks.js。
    * 前端 Hook 检视面板用——与 hook_list 工具同源，UI 面。 */
  safeHandle(
    ipc, 'hooks:effective',
    () => {
      const rows: Array<{ event: string; matcher: string; type: string; source: string }> = []
      // 1. config hooks（loadAllHooks(true) 展平合并全局+项目+默认，带 scope——显示全部含未确认）
      for (const r of loadAllHooks(true)) {
        rows.push({
          event: r.event,
          matcher: r.matcher ?? '.*',
          type: r.handler.type,
          source: `config:${r.scope}`
        })
      }
      // 2. 内核 + 插件函数 hook（LXK 注册表）
      for (const hh of kernelRegistry.getHandles('hook')) {
        const v = hh.value as { event: string; matcher?: string }
        rows.push({
          event: v.event,
          matcher: v.matcher ?? '.*',
          type: 'function',
          source: hh.source.kind === 'plugin' ? `plugin:${hh.source.pluginName}` : 'kernel'
        })
      }
      return { ok: true, total: rows.length, rows }
    },
    { ok: false, error: '读取生效 Hook 列表失败' }
  )

  /**
   * 测试 Hook 执行（构造临时 HookManager，不污染主实例）
   *
   * 前端传入 event + ctx，IPC 加载当前所有 hook 配置后执行匹配的 hook，
   * 返回执行结果（action/message）。
   * 主要用于 PostToolUse/PreToolUse hook 调试。
   */
  const testHook = async (_e: IpcMainInvokeEvent, ...args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    const event = args[0]
    const ctx = args[1]
    if (typeof event !== 'string' || !VALID_HOOK_EVENTS.includes(event)) {
      return { ok: false, error: '无效的 Hook 事件' }
    }
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) {
      return { ok: false, error: '无效的 Hook 上下文' }
    }
    const tempManager = new HookManager()
    const hooks = loadAllHooks()
    tempManager.loadHooks(hooks)
    const result = await tempManager.run(event as HookEvent, ctx as HookContext)
    return { ok: true, result }
  }

  safeHandle(
    ipc, 'hooks:test',
    authCheck
      ? requireAuth(authCheck, testHook, { ok: false, error: '请先登录' })
      : testHook,
    { ok: false, error: 'Hook 测试执行失败' }
  )
}
