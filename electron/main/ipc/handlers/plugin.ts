/**
 * 插件管理 IPC：启停/删除插件、分发 kernel 命令与打开外部链接等操作
 * 通道，把插件加载器与内核扩展面暴露给插件管理 UI。
 */
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import type { PluginLoader } from '../../plugins'
import type { UserStore } from '../../models/user-store'
import { kernelRegistry } from '../../kernel'
import type { CommandDef, PanelDef } from '../../kernel/extension'
import type { FeaturePluginsService } from '../../kernel/feature-plugins'
import { safeHandle, createAuthGuard, requireAuth } from './safe-handle'

export function registerPluginHandlers(
  ipc: typeof ipcMain,
  getPluginLoader: () => PluginLoader | null,
  getUserStore?: () => UserStore | null,
  getFeaturePlugins?: () => FeaturePluginsService | null
): void {
  const authCheck = getUserStore ? createAuthGuard(getUserStore) : null

  const togglePlugin = async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    const dirName = String(args[0] ?? '')
    const enabled = args[1] === true
    const loader = getPluginLoader()
    if (!loader) return { ok: false, error: '插件加载器未初始化' }
    await loader.setEnabled(dirName, enabled)
    return { ok: true }
  }

  const deletePlugin = async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    const dirName = String(args[0] ?? '')
    if (!dirName) return { ok: false, error: '缺少插件目录名' }
    const loader = getPluginLoader()
    if (!loader) return { ok: false, error: '插件加载器未初始化' }
    return loader.deletePlugin(dirName)
  }

  const dispatchCommand = async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    const commandId = String(args[0] ?? '')
    const cmdArgs = (args[1] as string[]) ?? []
    const commands = kernelRegistry.get<CommandDef>('command')
    const cmd = commands.find((c) => c.id === commandId)
    if (!cmd) return { ok: false, error: `命令 "${commandId}" 未注册（无插件提供此命令）` }
    return cmd.run(cmdArgs, { commandId })
  }

  safeHandle(
    ipc, 'plugin:list',
    () => {
      const loader = getPluginLoader()
      if (!loader) return { ok: false, error: '插件加载器未初始化' }
      return {
        ok: true,
        plugins: loader.list().map((p) => ({
          dirName: p.dirName,
          name: p.manifest.name,
          description: p.manifest.description,
          version: p.manifest.version,
          author: p.manifest.author,
          enabled: p.enabled,
          toolCount: p.tools.length,
          tools: p.tools.map((t) => ({ name: t.name, description: t.description })),
          loadedModules: p.loadedModules,
          errors: p.errors,
          source: p.source,
          panel: p.panel ? { id: p.panel.id, title: p.panel.title, component: p.panel.component } : null
        })),
        rootDir: loader.getRootDir()
      }
    },
    { ok: false, error: '读取插件列表失败' }
  )

  safeHandle(
    ipc, 'plugin:toggle',
    authCheck
      ? requireAuth(authCheck, togglePlugin, { ok: false, error: '请先登录' })
      : togglePlugin,
    { ok: false, error: '切换插件状态失败' }
  )

  safeHandle(
    ipc, 'plugin:delete',
    deletePlugin,
    { ok: false, error: '删除插件失败' }
  )

  safeHandle(
    ipc, 'plugin:openDir',
    () => {
      const loader = getPluginLoader()
      if (!loader) return { ok: false, error: '插件加载器未初始化' }
      shell.openPath(loader.getRootDir())
      return { ok: true }
    },
    { ok: false, error: '打开插件目录失败' }
  )

  /**
   * 分发人类命令（不经 AI 模型轮次直接执行）。
   * 前端传入 commandId + args，从内核注册表查找匹配的 CommandDef 并调用其 run()。
   * 命令由插件 hooks.js 的 reg.registerCommand() 注册。
   */
  safeHandle(
    ipc, 'plugin:dispatchCommand',
    authCheck
      ? requireAuth(authCheck, dispatchCommand, { ok: false, error: '请先登录' })
      : dispatchCommand,
    { ok: false, error: '命令执行失败' }
  )

/**
   * 返回所有已注册的前端面板声明（插件通过 manifest.panel 声明）。
   * 前端据此动态添加右侧栏 tab。
   */
  safeHandle(
    ipc, 'plugin:panels',
    () => {
      const panels = kernelRegistry.get<PanelDef>('panel')
      const loader = getPluginLoader()
      return {
        ok: true,
        panels: panels.map((p) => ({
          id: p.id,
          title: p.title,
          icon: p.icon,
          component: p.component
        })),
        sources: loader
          ? loader.list()
              .filter((p) => p.panel && p.enabled)
              .map((p) => ({
                panelId: p.panel!.id,
                pluginName: p.dirName,
                pluginDisplayName: p.manifest.name
              }))
          : []
      }
    },
    { ok: false, error: '读取面板列表失败' }
  )

  /**
   * 阶段 4：内核功能插件对象表（十大功能模块）。
   * 枚举全部功能插件（含启用状态），前端 `--plugins` 面板展示内核服务条目。
   */
  safeHandle(
    ipc, 'featurePlugins:list',
    () => {
      const fp = getFeaturePlugins?.()
      if (!fp) return { ok: false, error: '功能插件服务未初始化' }
      return { ok: true, plugins: fp.list() }
    },
    { ok: false, error: '读取功能插件列表失败' }
  )

  /** 阶段 4：逐项开关功能插件（状态持久化 + 广播；当前阶段不改服务实例） */
  const toggleFeaturePlugin = async (_e: IpcMainInvokeEvent, ...args: unknown[]) => {
    const id = String(args[0] ?? '')
    const enabled = args[1] === true
    const fp = getFeaturePlugins?.()
    if (!fp) return { ok: false, error: '功能插件服务未初始化' }
    return fp.setEnabled(id, enabled)
  }

  safeHandle(
    ipc, 'featurePlugins:toggle',
    authCheck
      ? requireAuth(authCheck, toggleFeaturePlugin, { ok: false, error: '请先登录' })
      : toggleFeaturePlugin,
    { ok: false, error: '切换功能插件状态失败' }
  )
}
