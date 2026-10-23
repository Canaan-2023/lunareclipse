/**
 * 工作流引擎 IPC（L8）：模板管理、实例运行、人工节点响应、ask_user
 * 响应与事件订阅共六组通道，把 WorkflowManager 能力桥接给前端工作流
 * 面板；引擎事件经 webContents.send 推送给订阅方。
 */
import type { ipcMain as ipcMainType } from 'electron'
import type { BrowserWindow } from 'electron'
import type { WorkflowManager } from '../../workflow/manager'
import type {
  WorkflowSaveParams,
  WorkflowDefineParams,
  WorkflowEditParams,
  WorkflowListParams,
  WorkflowRunParams,
  WorkflowModifyParams,
  WorkflowEngineEvent
} from '@shared/workflow/types'
import { logError } from '../../services/crash-logger'

/**
 * L8 工作流引擎：IPC 处理器



 * 通道分组：
 * 1. 模板管理：list/get/save/define/edit/delete/export/import
 * 2. 实例管理：run/modify/get/listActive
 * 3. 人工节点响应：respondHumanInput / cancelHumanInput
 * 4. ask_user 响应：respondAskUser / cancelAskUser
 * 5. Chatflow 继续：continueChatflow
 * 6. 事件订阅：subscribe（前端注册回调，引擎事件通过 webContents.send 推送）

 * 事件推送：WorkflowManager.emit → 此处桥接 → mainWindow.webContents.send('workflow:event', event)
 * 前端在 preload 注册 onWorkflowEvent 监听。
 */
export function registerWorkflowHandlers(
  ipc: typeof ipcMainType,
  getManager: () => WorkflowManager | null,
  _getWindow: () => BrowserWindow | null
): void {
  /** 统一包装：manager 未初始化时返回错误 */
  const withManager = <T>(
    handler: (manager: WorkflowManager) => T | Promise<T>
  ): Promise<{ ok: boolean; data?: T; error?: string }> => {
    const manager = getManager()
    if (!manager) {
      return Promise.resolve({ ok: false, error: 'WorkflowManager 未初始化' })
    }
    try {
      // 不兜底——handler rejection 直接传播给 ipcRenderer.invoke 调用方
      return Promise.resolve(handler(manager))
        .then((data) => ({ ok: true, data }))
    } catch (err) {
      logError('ipc:workflow', err)
      return Promise.resolve({ ok: false, error: (err as Error).message })
    }
  }

  // ===== 输入校验辅助 =====

  const isNonEmptyString = (v: unknown): v is string =>
    typeof v === 'string' && v.trim().length > 0

  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)

  const requireString = (name: string, v: unknown): string | null =>
    isNonEmptyString(v) ? null : `${name} 必须为非空字符串`

  const requireObject = (name: string, v: unknown): string | null =>
    isPlainObject(v) ? null : `${name} 必须为对象`

  const requireFields = (obj: object, fields: string[]): string | null => {
    const o = obj as Record<string, unknown>
    for (const f of fields) {
      const val = o[f]
      if (val === undefined || val === null) return `缺少必填字段: ${f}`
      if (typeof val === 'string' && val.trim() === '') return `字段 ${f} 不能为空`
    }
    return null
  }

  // ===== 模板管理 =====

  /** 列出模板（可按 mode/tag 过滤） */
  ipc.handle('workflow:listTemplates', async (_e, params?: WorkflowListParams) => {
    const manager = getManager()
    if (!manager) return []
    if (params !== undefined && !isPlainObject(params)) return []
    try {
      return manager.listTemplates(params)
    } catch (err) {
      logError('ipc:workflow:listTemplates', err)
      return []
    }
  })

  ipc.handle('workflow:getTemplate', async (_e, id: string) => {
    const manager = getManager()
    if (!manager) return null
    if (!isNonEmptyString(id)) return null
    try {
      return manager.getTemplate(id)
    } catch (err) {
      logError('ipc:workflow:getTemplate', err)
      return null
    }
  })

  /** 创建/更新模板（save 语义：覆盖更新或新建） */
  ipc.handle('workflow:saveTemplate', async (_e, params: WorkflowSaveParams) => {
    const objErr = requireObject('params', params) ?? requireFields(params, ['name', 'description', 'mode', 'nodes', 'edges'])
    if (objErr) return { ok: false, error: objErr }
    return withManager((m) => m.saveTemplate(params))
  })

  /** 从 define 参数创建模板（AI 工具 workflow_define 用） */
  ipc.handle('workflow:defineTemplate', async (_e, params: WorkflowDefineParams) => {
    const objErr = requireObject('params', params) ?? requireFields(params, ['name', 'description', 'mode', 'nodes', 'edges'])
    if (objErr) return { ok: false, error: objErr }
    return withManager((m) => m.defineTemplate(params))
  })

  /** 编辑模板（add_node/remove_node/update_node 等操作） */
  ipc.handle('workflow:editTemplate', async (_e, params: WorkflowEditParams) => {
    const objErr = requireObject('params', params) ?? requireFields(params, ['templateId', 'action', 'payload'])
    if (objErr) return { ok: false, error: objErr }
    return withManager((m) => m.editTemplate(params))
  })

  /** 删除模板 */
  ipc.handle('workflow:deleteTemplate', async (_e, id: string) => {
    const idErr = requireString('id', id)
    if (idErr) return { ok: false, error: idErr }
    return withManager((m) => m.deleteTemplate(id))
  })

  /** 导出模板为 JSON 字符串（用于复制/分享） */
  ipc.handle('workflow:exportTemplate', async (_e, id: string) => {
    const manager = getManager()
    if (!manager) return { ok: false, error: 'WorkflowManager 未初始化' }
    if (!isNonEmptyString(id)) return { ok: false, error: 'id 必须为非空字符串' }
    const json = manager.exportTemplate(id)
    if (json === null) return { ok: false, error: '模板不存在' }
    return { ok: true, data: json }
  })

  /** 从 JSON 字符串导入模板 */
  ipc.handle('workflow:importTemplate', async (_e, jsonStr: string, newName?: string) => {
    const jsonErr = requireString('jsonStr', jsonStr)
    if (jsonErr) return { ok: false, error: jsonErr }
    if (newName !== undefined && !isNonEmptyString(newName)) {
      return { ok: false, error: 'newName 必须为非空字符串' }
    }
    return withManager((m) => m.importTemplate(jsonStr, newName))
  })

  // ===== 实例管理 =====

  /** 启动工作流实例 */
  ipc.handle('workflow:runInstance', async (_e, params: WorkflowRunParams) => {
    const objErr = requireObject('params', params) ?? requireFields(params, ['templateId'])
    if (objErr) return { ok: false, error: objErr }
    return withManager((m) => m.runInstance(params))
  })

  /** 修改实例（pause/resume/cancel/update_context） */
  ipc.handle('workflow:modifyInstance', async (_e, params: WorkflowModifyParams) => {
    const objErr = requireObject('params', params) ?? requireFields(params, ['instanceId', 'action'])
    if (objErr) return { ok: false, error: objErr }
    return withManager((m) => m.modifyInstance(params))
  })

  /** 获取实例状态 */
  ipc.handle('workflow:getInstance', async (_e, instanceId: string) => {
    const manager = getManager()
    if (!manager) return null
    if (!isNonEmptyString(instanceId)) return null
    try {
      return manager.getInstance(instanceId)
    } catch (err) {
      logError('ipc:workflow:getInstance', err)
      return null
    }
  })

  ipc.handle('workflow:listActiveInstances', async () => {
    const manager = getManager()
    if (!manager) return []
    try {
      return manager.listActiveInstances()
    } catch (err) {
      logError('ipc:workflow:listActiveInstances', err)
      return []
    }
  })

  // ===== 人工节点响应 =====

  /** 响应 human 节点（用户在弹窗中提交了输入） */
  ipc.handle('workflow:respondHumanInput', async (_e, instanceId: string, response: string) => {
    const idErr = requireString('instanceId', instanceId)
    if (idErr) return { ok: false, error: idErr }
    const respErr = requireString('response', response)
    if (respErr) return { ok: false, error: respErr }
    const manager = getManager()
    if (!manager) return { ok: false, error: 'WorkflowManager 未初始化' }
    const ok = manager.respondHumanInput(instanceId, response)
    return { ok, error: ok ? undefined : '未找到待响应的 human 节点（可能已超时或已响应）' }
  })

  /** 取消 human 节点（用户关闭了弹窗） */
  ipc.handle('workflow:cancelHumanInput', async (_e, instanceId: string) => {
    const idErr = requireString('instanceId', instanceId)
    if (idErr) return { ok: false, error: idErr }
    const manager = getManager()
    if (!manager) return { ok: false, error: 'WorkflowManager 未初始化' }
    const ok = manager.cancelHumanInput(instanceId)
    return { ok, error: ok ? undefined : '未找到待取消的 human 节点' }
  })

  // ===== ask_user 响应 =====

  /** 响应 ask_user（AI 临时提问） */
  ipc.handle('workflow:respondAskUser', async (_e, requestId: string, response: string) => {
    const idErr = requireString('requestId', requestId)
    if (idErr) return { ok: false, error: idErr }
    const respErr = requireString('response', response)
    if (respErr) return { ok: false, error: respErr }
    const manager = getManager()
    if (!manager) return { ok: false, error: 'WorkflowManager 未初始化' }
    const ok = manager.respondAskUser(requestId, response)
    return { ok, error: ok ? undefined : '未找到待响应的 ask_user 请求' }
  })

  /** 取消 ask_user */
  ipc.handle('workflow:cancelAskUser', async (_e, requestId: string) => {
    const idErr = requireString('requestId', requestId)
    if (idErr) return { ok: false, error: idErr }
    const manager = getManager()
    if (!manager) return { ok: false, error: 'WorkflowManager 未初始化' }
    const ok = manager.cancelAskUser(requestId)
    return { ok, error: ok ? undefined : '未找到待取消的 ask_user 请求' }
  })

  // ===== Chatflow 继续 =====

  /** Chatflow 模式：用户发新消息后继续工作流（answer 节点恢复） */
  ipc.handle('workflow:continueChatflow', async (_e, instanceId: string, userMessage: string) => {
    const idErr = requireString('instanceId', instanceId)
    if (idErr) return { ok: false, error: idErr }
    const msgErr = requireString('userMessage', userMessage)
    if (msgErr) return { ok: false, error: msgErr }
    return withManager((m) => m.continueChatflow(instanceId, userMessage))
  })

  // ===== 事件订阅 =====
  // 前端通过 ipcRenderer.on('workflow:event', cb) 监听事件，无需 invoke 订阅。
  // 事件推送由 WorkflowManager.emit → 桥接器 → webContents.send('workflow:event') 完成。
  // （原 workflow:subscribe 是无操作占位 handler，已移除——前端直接 on 监听即可）

  /**
   * 内部桥接：把 WorkflowManager.emit 的事件推到前端

   * 由 index.ts 在创建 WorkflowManager 时注入 emit 回调，
   * 此处不直接实现，仅作为文档说明。
   */
  // 桥接代码在 index.ts 中：emit = (event) => getWindow()?.webContents.send('workflow:event', event)
}

/**
 * 创建事件桥接器：把 WorkflowEngineEvent 推到前端
 *
 * 在 index.ts 创建 WorkflowManager 时注入到 emit 回调：
 * ```ts
 * const emit = createEventBridge(() => mainWindow)
 * const manager = new WorkflowManager({ ..., emit })
 * ```
 */
export function createWorkflowEventBridge(
  getWindow: () => BrowserWindow | null
): (event: WorkflowEngineEvent) => void {
  return (event) => {
    const win = getWindow()
    // M13 修复：TOCTOU 竞态——检查后到 send 之间窗口可能销毁，用 try-catch 包裹
    try {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('workflow:event', event)
      }
    } catch (err) {
      // 窗口在 send 过程中销毁，忽略
      console.debug('[workflow] 事件推送失败（窗口可能已销毁）:', (err as Error).message)
    }
  }
}
