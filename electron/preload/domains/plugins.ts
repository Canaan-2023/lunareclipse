/**
 * 模块系统（插件）preload 域（L2 行动层 P2）。
 * 为什么存在：插件由主进程从磁盘目录动态加载/注销并注册进工具池，渲染进程只做管理入口，
 * 不能直接触碰插件生命周期。
 * 作用：暴露 plugin:list/toggle/delete/openDir 等插件管理方法。
 */
import { ipcRenderer } from 'electron'

export const api = {
  // ===== 模块系统（L2 行动层 P2） =====
  /** 插件列表（名称/描述/版本/启用状态/工具/错误） */
  pluginList: () =>
    ipcRenderer.invoke('plugin:list') as Promise<{
      ok: boolean
      plugins?: Array<{
        dirName: string
        name: string
        description: string
        version: string
        author?: string
        enabled: boolean
        toolCount: number
        tools: Array<{ name: string; description: string }>
        errors: string[]
        source: 'user' | 'domain' | 'bundled'
        panel: { id: string; title?: string; component: string } | null
      }>
      rootDir?: string
      error?: string
    }>,
  /** 启用/禁用插件 */
  pluginToggle: (dirName: string, enabled: boolean) =>
    ipcRenderer.invoke('plugin:toggle', dirName, enabled) as Promise<{ ok: boolean; error?: string }>,
  /** 删除插件（注销工具 + 回滚内核 + 删除目录） */
  pluginDelete: (dirName: string) =>
    ipcRenderer.invoke('plugin:delete', dirName) as Promise<{ ok: boolean; error?: string }>,
  /** 打开插件目录（系统文件管理器） */
  pluginOpenDir: () =>
    ipcRenderer.invoke('plugin:openDir') as Promise<{ ok: boolean; error?: string }>,
  /** 阶段 4：内核功能插件对象表（十大功能模块，--plugins 面板内核条目展示） */
  featurePluginList: () =>
    ipcRenderer.invoke('featurePlugins:list') as Promise<{
      ok: boolean
      plugins?: Array<{
        id: string
        name: string
        description: string
        version: string
        serviceKey: string
        enabled: boolean
      }>
      error?: string
    }>,
  /** 阶段 4：逐项开关内核功能插件（状态持久化） */
  featurePluginToggle: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('featurePlugins:toggle', id, enabled) as Promise<{ ok: boolean; error?: string }>,
  /**
   * 分发人类命令（不经 AI 模型轮次直接执行）。
   * 命令由插件 hooks.js 的 reg.registerCommand() 注册。
   * @param commandId 命令 id（与注册时一致）
   * @param args 字符串参数数组
   */
  pluginDispatchCommand: (commandId: string, args?: string[]) =>
    ipcRenderer.invoke('plugin:dispatchCommand', commandId, args ?? []) as Promise<{ ok: boolean; data?: unknown; error?: string }>,
  /**
   * 获取所有已注册的前端面板声明。
   * 插件通过 plugin.json 的 panel 字段声明面板，加载器注册到内核。
   * 前端据此动态添加右侧栏 tab。
   */
  pluginPanels: () =>
    ipcRenderer.invoke('plugin:panels') as Promise<{
      ok: boolean
      panels?: Array<{ id: string; title: string; icon: string; component: string }>
      sources?: Array<{ panelId: string; pluginName: string; pluginDisplayName: string }>
      error?: string
    }>,
}