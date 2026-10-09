/**
 * 工作区 IPC：多工作区的列表/添加/删除/激活/重命名与目录选择通道，
 * 管理 AI 的文件操作范围，切换激活工作区即切换读写根。
 */
import type { ipcMain as ipcMainType, dialog as dialogType } from 'electron'
import {
  ensureWorkspaceConfigExists,
  loadWorkspaceConfig,
  addWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  renameWorkspace,
  getActiveWorkspace,
  ensureWorkspaceDir
} from '../../services/workspace-config'
import { safeHandle } from './safe-handle'

/**
 * 工作区 IPC 处理器（对齐 MCP 系统架构）

 * 通道：
 * 1. workspace:list —— 列出所有工作区 + 当前激活 ID
 * 2. workspace:add —— 添加工作区（name + path）
 * 3. workspace:remove —— 删除工作区（至少保留一个）
 * 4. workspace:setActive —— 切换激活工作区
 * 5. workspace:rename —— 重命名工作区
 * 6. workspace:current —— 获取当前激活工作区
 * 7. workspace:selectDir —— 打开目录选择对话框（返回用户选择的路径）

 * 【为什么 configPath 是 getter 而非字符串】configPath 来自 getScopedPath('config')，
 * 未登录态（干净环境首次启动）禁止解析分层路径，注册期立即求值会抛
 * 「未登录态禁止解析分层路径」并使 app.whenReady 初始化失败；
 * 改为回调后在 handler 调用期（登录后）才求值，与 IpcHandlerDeps 其它
 * getter 注入（getSupervisor/getDataPaths 等）保持同一时序契约。
 */
export function registerWorkspaceHandlers(
  ipc: typeof ipcMainType,
  dialog: typeof dialogType,
  configPath: () => string
): void {
  // 首次启动确保配置文件存在（未登录态解析失败由 catch 吞掉，不阻塞注册；
  // handler 运行期登录后再次尝试创建/读取）
  try {
    ensureWorkspaceConfigExists(configPath())
  } catch (err) {
    // 创建失败不阻塞 handler 注册，后续操作会再次尝试
    console.error('[workspace] ensureWorkspaceConfigExists 失败:', err)
  }

  /** 列出所有工作区 + 当前激活 ID */
  safeHandle(
    ipc, 'workspace:list',
    () => loadWorkspaceConfig(configPath()),
    // 失败返回最小可用结构（activeWorkspaceId 必须为 string 类型），前端不崩
    { workspaces: [], activeWorkspaceId: '' }
  )

  /** 添加工作区 */
  safeHandle(
    ipc, 'workspace:add',
    (_e, name: unknown, path: unknown) => {
      if (!path || typeof path !== 'string') {
        return { ok: false, error: '路径不能为空' }
      }
      ensureWorkspaceDir(path)
      const config = addWorkspace(configPath(), name as string, path)
      return { ok: true, config }
    },
    { ok: false, error: '添加工作区失败，请查看日志' }
  )

  /** 删除工作区（至少保留一个） */
  safeHandle(
    ipc, 'workspace:remove',
    (_e, workspaceId: unknown) => removeWorkspace(configPath(), workspaceId as string),
    { ok: false, error: '删除工作区失败，请查看日志' }
  )

  /** 切换激活工作区 */
  safeHandle(
    ipc, 'workspace:setActive',
    (_e, workspaceId: unknown) => setActiveWorkspace(configPath(), workspaceId as string),
    { ok: false, error: '切换工作区失败，请查看日志' }
  )

  /** 重命名工作区 */
  safeHandle(
    ipc, 'workspace:rename',
    (_e, workspaceId: unknown, newName: unknown) =>
      renameWorkspace(configPath(), workspaceId as string, newName as string),
    { ok: false, error: '重命名工作区失败，请查看日志' }
  )

  /** 获取当前激活工作区 */
  safeHandle(
    ipc, 'workspace:current',
    () => getActiveWorkspace(configPath()),
    null
  )

  /** 打开目录选择对话框（前端"选择目录"按钮调用） */
  safeHandle(
    ipc, 'workspace:selectDir',
    async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, path: null }
      }
      return { ok: true, path: result.filePaths[0] }
    },
    { ok: false, path: null }
  )
}