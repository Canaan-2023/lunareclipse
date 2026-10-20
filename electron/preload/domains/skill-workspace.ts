/**
 * SKILL 管理 + 工作区管理 preload 域（L3 知识层）。
 * 为什么存在：SKILL 由主进程从目录加载并热重载，工作区配置持久化在 userData，两者均须
 * 经主进程操作，前端只做管理与展示。
 * 作用：暴露 skill:list/get/toggle/delete/reload/status/errors、市场及 workspace:* 系列方法。
 */
import { ipcRenderer } from 'electron'
// SKILL 类型（仅类型标注用，运行时不引入主进程代码）
import type { SkillMetadata, Skill, SkillRuntimeStatus } from '../../main/skills'
import type { WorkspaceConfig, WorkspaceItem } from '@shared/types'

export const api = {
  // ===== SKILL 管理（L3 知识层，对齐 MCP 系统架构）=====
  skill: {
    /** 列出所有 SKILL 元数据（含禁用的；UI 管理用） */
    list: () =>
      ipcRenderer.invoke('skill:list') as Promise<SkillMetadata[]>,
    /** 加载指定 SKILL 的完整正文（含 body 字段，即 Markdown 指令） */
    get: (name: string) =>
      ipcRenderer.invoke('skill:get', name) as Promise<Skill | null>,
    /** 启用/禁用 SKILL（写入 .skills.json，触发热重载） */
    toggle: (name: string, enabled: boolean) =>
      ipcRenderer.invoke('skill:toggle', name, enabled) as Promise<{ ok: boolean; error?: string }>,
    /** 删除 SKILL（仅限 user / project 来源；builtin / plugin 不可删除） */
    delete: (name: string) =>
      ipcRenderer.invoke('skill:delete', name) as Promise<{ ok: boolean; error?: string }>,
    /** 手动重载所有 SKILL（强制重新扫描目录） */
    reload: () =>
      ipcRenderer.invoke('skill:reload') as Promise<{ ok: boolean; count?: number; errors?: Array<{ filePath: string; error: string }>; error?: string }>,
    /** 获取所有 SKILL 运行时状态（监控用） */
    status: () =>
      ipcRenderer.invoke('skill:status') as Promise<SkillRuntimeStatus[]>,
    /** 获取加载错误列表 */
    errors: () =>
      ipcRenderer.invoke('skill:errors') as Promise<Array<{ filePath: string; error: string }>>,
    /** 订阅技能变更事件（主进程热重载完成——SKILL.md/.skills.json 变动、市场安装/更新/卸载/同步等
     * 写盘后广播），用于前端自动刷新列表与市场；返回取消订阅函数。 */
    onSkillsChanged: (handler: () => void): (() => void) => {
      const listener = () => handler()
      ipcRenderer.on('skills:changed', listener)
      return () => void ipcRenderer.removeListener('skills:changed', listener)
    },
    // ===== 市场（2026-08-10） =====
    /** 市场源列表 */
    marketSources: () =>
      ipcRenderer.invoke('skill:market-sources') as Promise<{ ok: boolean; sources?: Array<{ id: string; name: string; url: string; type: string }>; error?: string }>,
    /** 添加市场源 */
    marketAddSource: (name: string, url: string) =>
      ipcRenderer.invoke('skill:market-add-source', name, url) as Promise<{ ok: boolean; error?: string }>,
    /** 移除市场源 */
    marketRemoveSource: (id: string) =>
      ipcRenderer.invoke('skill:market-remove-source', id) as Promise<{ ok: boolean; error?: string }>,
    /** 市场可安装 skill 列表 */
    marketList: () =>
      ipcRenderer.invoke('skill:market-list') as Promise<{
        ok: boolean
        // userModified：主进程已返回该字段（本地改过的 skill 更新会被拒绝并跳过），
        // 桥类型须与主进程返回类型对齐，前端 MarketTab 才拿得到"本地修改"徽章与更新禁用态
        items?: Array<{ name: string; description: string; repo: string; subdir?: string; version?: string; sha?: string; domain?: string; sourceId: string; installed: boolean; hasUpdate: boolean; userModified: boolean; uploaderUid?: number; canDelete?: boolean }>
        error?: string
      }>,
    /** 安装 skill（domain 为条目领域值，前端从条目 domain 传入；落位以「文件夹即领域」的目录判定为准） */
    marketInstall: (name: string, domain?: string) =>
      ipcRenderer.invoke('skill:market-install', name, domain) as Promise<{ ok: boolean; error?: string; lint?: { errors: number; warnings: number; infos: number }; config?: Array<{ key: string; description: string; default?: string }> }>,
    /** 更新 skill */
    marketUpdate: (name: string) =>
      ipcRenderer.invoke('skill:market-update', name) as Promise<{ ok: boolean; error?: string }>,
    /** 卸载 skill */
    marketRemove: (name: string) =>
      ipcRenderer.invoke('skill:market-remove', name) as Promise<{ ok: boolean; error?: string }>,
    /** 批量同步所有已安装 skill */
    marketSync: () =>
      ipcRenderer.invoke('skill:market-sync') as Promise<{ ok: boolean; updated?: string[]; errors?: string[] }>,
    /** 标记本地修改 */
    marketMarkModified: (name: string) =>
      ipcRenderer.invoke('skill:market-mark-modified', name) as Promise<{ ok: boolean }>,
    /** 上传 skill 到市场（目录由主进程弹原生对话框选择；上传后自动广播到局域网在线对端） */
    marketUpload: () =>
      ipcRenderer.invoke('skill:market-upload') as Promise<{ ok: boolean; error?: string; name?: string; lint?: { errors: number; warnings: number; infos: number } }>,
    /** 按技能名一键上传已安装 skill 到市场（免目录选择；领域落位按"文件夹即领域"判定，自动广播到局域网） */
    marketUploadByName: (name: string) =>
      ipcRenderer.invoke('skill:market-upload-by-name', name) as Promise<{ ok: boolean; error?: string; name?: string; lint?: { errors: number; warnings: number; infos: number } }>,
    /** 从市场下架一个上传的 skill（主系统/单机可删任意，分系统仅可删自己上传的） */
    marketUnpublish: (name: string) =>
      ipcRenderer.invoke('skill:market-unpublish', name) as Promise<{ ok: boolean; error?: string }>,
    // ===== lint =====
    /** 对指定 skill 运行 lint */
    lint: (name: string) =>
      ipcRenderer.invoke('skill:lint', name) as Promise<{ ok: boolean; issues?: Array<{ severity: string; category: string; message: string }>; summary?: { errors: number; warnings: number; infos: number }; error?: string }>
  },

  // ===== 工作区管理（AI 专属工作区，多工作区切换）=====
  workspace: {
    /** 列出所有工作区 + 当前激活 ID */
    list: () =>
      ipcRenderer.invoke('workspace:list') as Promise<WorkspaceConfig>,
    /** 添加工作区 */
    add: (name: string, path: string) =>
      ipcRenderer.invoke('workspace:add', name, path) as Promise<{ ok: boolean; config?: WorkspaceConfig; error?: string }>,
    /** 删除工作区（至少保留一个） */
    remove: (workspaceId: string) =>
      ipcRenderer.invoke('workspace:remove', workspaceId) as Promise<{ ok: boolean; config?: WorkspaceConfig; error?: string }>,
    /** 切换激活工作区 */
    setActive: (workspaceId: string) =>
      ipcRenderer.invoke('workspace:setActive', workspaceId) as Promise<{ ok: boolean; config?: WorkspaceConfig; error?: string }>,
    /** 重命名工作区 */
    rename: (workspaceId: string, newName: string) =>
      ipcRenderer.invoke('workspace:rename', workspaceId, newName) as Promise<{ ok: boolean; config?: WorkspaceConfig; error?: string }>,
    /** 获取当前激活工作区 */
    current: () =>
      ipcRenderer.invoke('workspace:current') as Promise<WorkspaceItem | null>,
    /** 打开目录选择对话框（前端"选择目录"按钮调用） */
    selectDir: () =>
      ipcRenderer.invoke('workspace:selectDir') as Promise<{ ok: boolean; path: string | null }>
  },
}