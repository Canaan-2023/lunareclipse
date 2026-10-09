/**
 * Hook 配置加载器：为什么存在——钩子机制需要从磁盘读取用户配置（全局/项目两级）才知道
 * 启用哪些钩子及各自执行方式；本模块把"配置从哪来、如何解析、如何热更新"收敛到一处。
 * 作用：定位全局/项目 hooks 配置文件并解析为 ResolvedHook[]，支持监视文件变化热重载。
 * 不删理由：loadAllHooks / readHooksConfig / writeHooksConfig 是 IPC 与 DMN
 * 初始化读取 Hook 配置的唯一入口，删除后热重载与配置读写链路断裂。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, watch, type FSWatcher } from 'fs'
import { basename, join, sep } from 'path'
import type {
  HooksConfig,
  HookEvent,
  ResolvedHook,
  HookScope
} from './types'
import { getPreviewFile } from '../services/workspace-state'
import { getDefaultHooks, shouldUseDefaultHooks } from './defaults'

/** 向上搜索工作区根目录的最大层数（防无限遍历到磁盘根） */
const WORKSPACE_ROOT_SEARCH_MAX_DEPTH = 10

/**
 * Hook 配置加载器

 * 三级作用域配置：
 * - 全局：{hooksRoot}/.lunareclipse/hooks.json（hooksRoot=注入锚点或 cwd，随项目走，不写 HOME）
 * - 项目：{workspace}/.lunareclipse/hooks.json（当前项目）

 * 月蚀简化为两级（去掉 local，桌面应用无需本地覆盖）。
 * 优先级：项目级 > 全局级（后加载的追加到列表末尾，同事件+matcher 时项目级先生效）

 * 配置格式（三层嵌套）：
 * ```json
 * {
 * "hooks": {
 * "PreToolUse": [
 * {
 * "matcher": "Bash",
 * "hooks": [
 * { "type": "command", "command": ".hooks/check.sh" }
 * ]
 * }
 * ]
 * }
 * }
 * ```
 */

/**
 * 全局 Hook 配置根（注入锚点优先；未注入回退 cwd）。
 * 为什么存在——旧实现未注入时回退 homedir()，全局 hooks 配置会写到
 * C:\Users\<用户>\.lunareclipse\，随项目打包分发后把本机用户名带进用户环境、
 * 且换机后配置"跟人走"而非"跟项目走"；
 * 什么作用——index.ts 启动时注入应用锚点（dev=app 目录 / 打包=exe 旁），
 * 运行时必注入；兜底用 process.cwd() 而非 HOME，保证兜底路径同样可移植；
 * 留存理由——单测场景可能先于注入调用本模块，兜底值必须存在且不能是 HOME。
 */
let injectedHooksRoot: string | null = null

/** 注入 hooks 根目录（index.ts 启动时注入应用锚点：dev=app 目录 / 打包=exe 旁，随项目走，不写 HOME） */
export function setHooksConfigRoot(root: string): void {
  injectedHooksRoot = root
}

function getGlobalHooksPath(): string {
  return join(injectedHooksRoot ?? process.cwd(), '.lunareclipse', 'hooks.json')
}

/** 项目级 Hook 配置路径：{workspace}/.lunareclipse/hooks.json */
function getProjectHooksPath(): string | null {
  const root = getWorkspaceRoot()
  if (!root) return null
  return join(root, '.lunareclipse', 'hooks.json')
}

/** 工作区根目录检测（复用 context-md.ts / loader.ts 策略） */
function getWorkspaceRoot(): string | null {
  const previewFile = getPreviewFile()
  if (previewFile) {
    const dir = previewFile.substring(0, previewFile.lastIndexOf(sep))
    if (dir && existsSync(dir)) return dir
  }
  let cwd = process.cwd()
  for (let i = 0; i < WORKSPACE_ROOT_SEARCH_MAX_DEPTH; i++) {
    if (existsSync(join(cwd, 'package.json'))) {
      return cwd
    }
    const parent = cwd.substring(0, cwd.lastIndexOf(sep))
    if (!parent || parent === cwd) break
    cwd = parent
  }
  return process.cwd()
}

/** 读取并解析单个配置文件 */
function loadConfigFile(filePath: string, scope: HookScope): ResolvedHook[] {
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, 'utf-8')
  const parsed = JSON.parse(content) as HooksConfig
  return resolveHooks(parsed, scope, filePath)
}

/** 将三层嵌套配置展开为 ResolvedHook 列表 */
function resolveHooks(config: HooksConfig, scope: HookScope, sourceFile: string): ResolvedHook[] {
  const result: ResolvedHook[] = []
  if (!config.hooks) return result

  const events = Object.keys(config.hooks) as HookEvent[]
  for (const event of events) {
    const groups = config.hooks[event]
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      if (!group.hooks || !Array.isArray(group.hooks)) continue
      for (const handler of group.hooks) {
        // 跳过无效配置
        if (handler.type === 'command' && !handler.command) {
          console.warn(`[hooks] 跳过无效配置（command 类型缺 command）: ${basename(sourceFile)}`)
          continue
        }
        if (handler.type === 'javascript' && !handler.handler) {
          console.warn(`[hooks] 跳过无效配置（javascript 类型缺 handler）: ${basename(sourceFile)}`)
          continue
        }
        result.push({
          event,
          handler,
          matcher: group.matcher,
          scope,
          sourceFile
        })
      }
    }
  }
  return result
}

/** 加载所有 Hook 配置（全局 + 项目级 + 内置默认）
 * @param allowProjectHooks 项目级 Hook 需用户 UI 确认后才激活，默认 false（安全优先）
 */
let projectHooksAllowed = false

export function setProjectHooksAllowed(allowed: boolean): void {
  projectHooksAllowed = allowed
}

export function isProjectHooksAllowed(): boolean {
  return projectHooksAllowed
}

export function loadAllHooks(allowProjectHooks = projectHooksAllowed): ResolvedHook[] {
  const globalPath = getGlobalHooksPath()
  const projectPath = getProjectHooksPath()

  const globalHooks = loadConfigFile(globalPath, 'global')
  const defaultHooks = shouldUseDefaultHooks(globalHooks) ? getDefaultHooks() : []
  const projectHooks = allowProjectHooks && projectPath
    ? loadConfigFile(projectPath, 'project')
    : []

  return [...globalHooks, ...defaultHooks, ...projectHooks]
}

/** 检测项目级 Hook 是否存在（供 UI 提示用户确认，不执行 Hook） */
export function hasProjectHooks(): boolean {
  const projectPath = getProjectHooksPath()
  return projectPath !== null && existsSync(projectPath)
}

/** 监听 Hook 配置文件变化，触发回调（热重载）。返回取消监听函数 */
export function watchHooksConfig(onChange: () => void): () => void {
  const watchers: FSWatcher[] = []
  const watchTargets = [getGlobalHooksPath()]
  const projectPath = getProjectHooksPath()
  if (projectPath) watchTargets.push(projectPath)

  let debounceTimer: NodeJS.Timeout | null = null
  const trigger = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => onChange(), 500)
  }

  for (const p of watchTargets) {
    const dir = p.substring(0, p.lastIndexOf(sep))
    const baseName = p.substring(p.lastIndexOf(sep) + 1)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    if (!existsSync(dir)) continue
    const watcher = watch(dir, { recursive: false }, (_eventType, filename) => {
      if (filename === baseName) trigger()
    })
    watchers.push(watcher)
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const w of watchers) {
      try { w.close() } catch { /* 忽略 */ }
    }
  }
}

/** 获取配置文件路径（调试/UI 用） */
export function getHooksPaths(): { global: string; project: string | null } {
  return {
    global: getGlobalHooksPath(),
    project: getProjectHooksPath()
  }
}

/**
 * 读取指定作用域的原始配置（UI 用，返回原三层嵌套结构）

 * 文件不存在时返回空结构 { hooks: {} }，避免 UI 处理 null。
 */
export function readHooksConfig(scope: HookScope): HooksConfig {
  const filePath = scope === 'global' ? getGlobalHooksPath() : getProjectHooksPath()
  if (!filePath || !existsSync(filePath)) return { hooks: {} }
  const content = readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as HooksConfig
}

/**
 * 写入指定作用域的配置（UI 保存用）
 *
 * - 自动创建目录（~/.lunareclipse/ 或 {workspace}/.lunareclipse/）
 * - 写入后文件 watch 会触发 loadAllHooks 热重载
 * - scope=project 但无工作区时返回 false
 */
export function writeHooksConfig(scope: HookScope, config: HooksConfig): { ok: boolean; error?: string } {
  try {
    const filePath = scope === 'global' ? getGlobalHooksPath() : getProjectHooksPath()
    if (!filePath) {
      return { ok: false, error: '当前无工作区，无法保存项目级配置' }
    }
    const dir = filePath.substring(0, filePath.lastIndexOf(sep))
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(filePath, JSON.stringify(config, null, 2), 'utf-8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
