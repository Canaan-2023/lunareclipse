/**
 * 为什么存在：多工作区需要持久化清单，且配置文件可能被外部修改（如用户手编），需要自动感知刷新。
 * 作用：管理 .workspaces.json：确保默认工作区、增删查改工作区、防抖回调通知外部变更。
 * 数据驻留（月蚀）：.workspaces.json 的落点由 getDefaultWorkspaceConfigPath() 统一决定
 * （dataDir/abyssac_data 下的 config 作用域，随项目走、不进用户系统目录）；
 * 默认工作区路径默认指向应用锚点（文件默认存的项目文件夹，随项目整体搬迁），
 * 由 index.ts 启动时 setDefaultWorkspacePath(getAppAnchor()) 注入；未注入时回退
 * process.cwd()（不写 HOME——旧实现回退 homedir 会把本机用户名带进配置文件，
 * 分发可移植性受损，见 getDefaultWorkspacePath 注释）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'
import { getScopedPath } from '../models/path-context'
import type { WorkspaceConfig, WorkspaceItem } from '@shared/types'

/**
 * 工作区配置加载层

 * 默认配置：默认工作区指向应用锚点（index.ts 注入）；未注入时回退 cwd 而非 HOME
 * 配置文件变化触发热重载
 */

let debounceTimer: NodeJS.Timeout | null = null
let changeCallback: (() => void) | null = null
let configWatcher: FSWatcher | null = null
/** 注入的默认工作区路径（应用锚点；null = 未注入） */
let injectedDefaultWorkspacePath: string | null = null

/** 注入默认工作区路径（index.ts 启动时调用，运行时必注入；留 setter 便于单测） */
export function setDefaultWorkspacePath(path: string): void {
  injectedDefaultWorkspacePath = path
}

/**
 * 默认工作区路径：注入值优先，未注入回退进程当前工作目录。
 * 为什么存在——旧实现未注入时回退 homedir()，会把默认工作区写到用户 HOME
 * （C:\Users\<用户>），随包分发后别人机器上路径指向陌生人目录、且开发机
 * 用户名泄漏进配置文件；
 * 什么作用——运行时 index.ts 必注入应用锚点（随项目走的目录）；兜底用
 * process.cwd()（打包后双击 exe 时 cwd 即 exe 所在目录）而非 HOME，
 * 确保任何路径都不依赖本机用户名；
 * 留存理由——单测场景可能先于注入调用本模块，必须有个不写 HOME 的兜底值；
 * 同时保留 setter 供 index.ts 显式锚定，行为与月蚀「数据随项目走」一致。
 */
function getDefaultWorkspacePath(): string {
  return injectedDefaultWorkspacePath ?? process.cwd()
}

export function getDefaultWorkspaceConfigPath(): string {
  return join(getScopedPath('config'), '.workspaces.json')
}

/** 创建默认工作区（指向应用锚点/项目文件夹，随项目走） */
function createDefaultWorkspace(): WorkspaceItem {
  return {
    id: randomUUID(),
    name: '默认工作区',
    path: getDefaultWorkspacePath(),
    createdAt: new Date().toISOString()
  }
}

/** 确保配置文件存在（首次启动创建默认配置） */
export function ensureWorkspaceConfigExists(configPath: string): void {
  if (existsSync(configPath)) return
  const defaultWs = createDefaultWorkspace()
  const defaultConfig: WorkspaceConfig = {
    workspaces: [defaultWs],
    activeWorkspaceId: defaultWs.id
  }
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8')
  } catch (err) {
    console.error('[workspace-config] 创建默认配置失败:', err)
  }
}

/** 加载配置（文件不存在或解析失败时返回默认配置） */
export function loadWorkspaceConfig(configPath: string): WorkspaceConfig {
  if (!existsSync(configPath)) {
    const defaultWs = createDefaultWorkspace()
    return { workspaces: [defaultWs], activeWorkspaceId: defaultWs.id }
  }
  const raw = readFileSync(configPath, 'utf-8')
  const parsed = JSON.parse(raw) as Partial<WorkspaceConfig>
  if (!parsed.workspaces || parsed.workspaces.length === 0) {
    const defaultWs = createDefaultWorkspace()
    return { workspaces: [defaultWs], activeWorkspaceId: defaultWs.id }
  }
  // 校验 activeWorkspaceId 指向存在的工作区
  const activeExists = parsed.workspaces.some((w) => w.id === parsed.activeWorkspaceId)
  if (!activeExists) {
    parsed.activeWorkspaceId = parsed.workspaces[0].id
  }
  return {
    workspaces: parsed.workspaces,
    activeWorkspaceId: parsed.activeWorkspaceId!
  }
}

/** 保存配置（写入前确保父目录存在：骨架可能尚未预建，如运行期新注册 AI 的作用域） */
export function saveWorkspaceConfig(configPath: string, config: WorkspaceConfig): void {
  try {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  } catch (err) {
    console.error('[workspace-config] 保存配置失败:', err)
  }
}

/** 添加工作区 */
export function addWorkspace(
  configPath: string,
  name: string,
  path: string
): WorkspaceConfig {
  const config = loadWorkspaceConfig(configPath)
  const newWs: WorkspaceItem = {
    id: randomUUID(),
    name: name.trim() || '未命名工作区',
    path,
    createdAt: new Date().toISOString()
  }
  config.workspaces.push(newWs)
  saveWorkspaceConfig(configPath, config)
  return config
}

/** 删除工作区（至少保留一个，最后一个不允许删除） */
export function removeWorkspace(
  configPath: string,
  workspaceId: string
): { ok: boolean; config?: WorkspaceConfig; error?: string } {
  const config = loadWorkspaceConfig(configPath)
  if (config.workspaces.length <= 1) {
    return { ok: false, error: '至少保留一个工作区' }
  }
  config.workspaces = config.workspaces.filter((w) => w.id !== workspaceId)
  // 如果删除的是激活工作区，切到第一个
  if (config.activeWorkspaceId === workspaceId) {
    config.activeWorkspaceId = config.workspaces[0].id
  }
  saveWorkspaceConfig(configPath, config)
  return { ok: true, config }
}

/** 设置激活工作区 */
export function setActiveWorkspace(
  configPath: string,
  workspaceId: string
): { ok: boolean; config?: WorkspaceConfig; error?: string } {
  const config = loadWorkspaceConfig(configPath)
  const exists = config.workspaces.some((w) => w.id === workspaceId)
  if (!exists) {
    return { ok: false, error: '工作区不存在' }
  }
  config.activeWorkspaceId = workspaceId
  saveWorkspaceConfig(configPath, config)
  return { ok: true, config }
}

/** 重命名工作区 */
export function renameWorkspace(
  configPath: string,
  workspaceId: string,
  newName: string
): { ok: boolean; config?: WorkspaceConfig; error?: string } {
  const config = loadWorkspaceConfig(configPath)
  const ws = config.workspaces.find((w) => w.id === workspaceId)
  if (!ws) {
    return { ok: false, error: '工作区不存在' }
  }
  ws.name = newName.trim() || ws.name
  saveWorkspaceConfig(configPath, config)
  return { ok: true, config }
}

/** 获取当前激活工作区（不存在时返回 null） */
export function getActiveWorkspace(configPath: string): WorkspaceItem | null {
  const config = loadWorkspaceConfig(configPath)
  return config.workspaces.find((w) => w.id === config.activeWorkspaceId) ?? null
}

/** 确保工作区目录存在（用户配置的路径可能不存在） */
export function ensureWorkspaceDir(path: string): void {
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { recursive: true })
    } catch (err) {
      console.error(`[workspace-config] 创建工作区目录失败 ${path}:`, err)
    }
  }
}

/** 监听配置文件变化（热重载） */
export function watchWorkspaceConfig(
  configPath: string,
  callback: () => void
): void {
  if (configWatcher) {
    configWatcher.close()
  }
  changeCallback = callback
  if (!existsSync(configPath)) return
  try {
    configWatcher = watch(configPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        console.log('[workspace-config] 检测到配置变化，触发热重载')
        changeCallback?.()
      }, 500)
    })
  } catch (err) {
    console.error('[workspace-config] 监听配置失败:', err)
  }
}

/** 停止监听 */
export function stopWatchingWorkspaceConfig(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (configWatcher) {
    configWatcher.close()
    configWatcher = null
  }
  changeCallback = null
}
