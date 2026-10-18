/**
 * MCP 服务 + Hooks 管理 preload 域。
 * 为什么存在：MCP server 进程的启停与 Hooks 配置的热重载都发生在主进程，渲染进程只能经
 * IPC 读配置、下发管理指令与订阅状态。
 * 作用：暴露 mcp:getConfig/saveConfig/getStatuses/connect/disconnect 与 hooks:getPaths/read/write 等系列方法。
 */
import { ipcRenderer } from 'electron'
// Hooks 纯数据类型走 shared；HookContext 含 ToolResult 留主进程，仅 preload 类型标注用
import type { HooksConfig, HookEvent, HookScope } from '@shared/types'
import type { HookContext } from '../../main/hooks/types'

export const api = {
  // ===== MCP 管理 =====
  mcpGetConfig: () =>
    ipcRenderer.invoke('mcp:getConfig'),
  mcpSaveConfig: (config: unknown) =>
    ipcRenderer.invoke('mcp:saveConfig', config) as Promise<{ ok: boolean; error?: string }>,
  mcpGetStatuses: () =>
    ipcRenderer.invoke('mcp:getStatuses'),
  mcpConnect: (name: string) =>
    ipcRenderer.invoke('mcp:connect', name) as Promise<{ ok: boolean; error?: string }>,
  mcpDisconnect: (name: string) =>
    ipcRenderer.invoke('mcp:disconnect', name) as Promise<{ ok: boolean; error?: string }>,

  // ===== Hooks 管理 =====
  /** 查询配置文件路径（全局 + 项目） */
  hooksGetPaths: () =>
    ipcRenderer.invoke('hooks:getPaths') as Promise<{ global: string; project: string | null }>,
  /** 读取指定作用域的配置（原三层嵌套结构） */
  hooksRead: (scope: HookScope) =>
    ipcRenderer.invoke('hooks:read', scope) as Promise<HooksConfig>,
  /** 写入指定作用域的配置（写入后自动触发热重载） */
  hooksWrite: (scope: HookScope, config: HooksConfig) =>
    ipcRenderer.invoke('hooks:write', scope, config) as Promise<{ ok: boolean; error?: string }>,
  /** 查询已解析的 Hook 列表（合并后，调试用） */
  hooksListResolved: () => ipcRenderer.invoke('hooks:listResolved') as Promise<unknown>,
  /** 生效 Hook 三源合并清单（config/内核治理/插件，Hook 检视面板用） */
  hooksEffective: () =>
    ipcRenderer.invoke('hooks:effective') as Promise<{ ok: boolean; total?: number; rows?: Array<{ event: string; matcher: string; type: string; source: string }>; error?: string }>,
  /** 测试 Hook 执行（不实际触发工具调用） */
  hooksTest: (event: HookEvent, ctx: HookContext) =>
    ipcRenderer.invoke('hooks:test', event, ctx) as Promise<{ ok: boolean; result?: unknown; error?: string }>,
  /** 检测项目级 Hook 是否存在且是否已获用户授权 */
  hooksHasProject: () =>
    ipcRenderer.invoke('hooks:hasProject') as Promise<{ hasProject: boolean; allowed: boolean }>,
  /** 用户确认后授权加载项目级 Hook */
  hooksConfirmProject: () =>
    ipcRenderer.invoke('hooks:confirmProject') as Promise<{ ok: boolean; error?: string }>,
}