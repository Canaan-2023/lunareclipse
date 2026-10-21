/**
 * Hook 配置加载器：为什么存在——钩子机制需要从磁盘读取用户配置（全局/项目两级）才知道
 * 启用哪些钩子及各自执行方式；本模块把"配置从哪来、如何解析、如何热更新"收敛到一处。
 * 作用：定位全局/项目 hooks 配置文件并解析为 ResolvedHook[]，支持监视文件变化热重载。
 * 不删理由：loadAllHooks / readHooksConfig / writeHooksConfig 是 IPC 与记忆工作流
 * 初始化读取 Hook 配置的唯一入口，删除后热重载与配置读写链路断裂。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, unlinkSync, watch, type FSWatcher } from 'fs'
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
 * - 全局：{userData}/hooks.json（userData=注入的 Electron userData 目录，与 config.json 并排，随项目走、不写 HOME）
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
 * 全局 Hook 配置所在目录（注入的 userData 优先；未注入回退 cwd）。
 * 为什么存在——全局 hooks 配置从 0.53 起随 Electron userData 收纳（{userData}/hooks.json，
 * 与 config.json 并排），不再落应用锚点/.lunareclipse/ 下；具名实例因 userData 已重定向到
 * instances/{name}，全局配置随实例天然隔离；
 * 什么作用——index.ts 启动时注入 app.getPath('userData')（dev=app/data/userdata、打包=exe 旁/data/userdata、
 * 具名实例=instances/{name}），cli.ts / cli-ui.ts 注入各自 data/userdata；运行时必注入；
 * 兜底用 process.cwd() 而非 HOME，保证兜底路径同样可移植；
 * 留存理由——单测场景可能先于注入调用本模块，兜底值必须存在且不能是 HOME。
 */
let injectedHooksUserData: string | null = null

/**
 * 注入全局 hooks 配置所在目录（Electron userData）。
 * 语义：全局配置直接存放于该目录下的 hooks.json（不再叠加 .lunareclipse/ 子目录）。
 * 三个入口分别注入：desktop=app.getPath('userData')（模块顶层已按 default/具名实例 setPath）、
 * cli.ts / cli-ui.ts=各自 data/userdata。须在任何 loadAllHooks / watchHooksConfig 之前调用。
 * 旧名 setHooksConfigRoot 已随 0.53 迁移废弃：注入的是 userData 目录而非"hooks 配置根"，
 * 且旧名残留 hooksRoot 词汇会误导维护者（全仓清理见任务记录）。
 */
export function setHooksUserDataDir(userDataDir: string): void {
  injectedHooksUserData = userDataDir
}

/**
 * 一次性迁移：旧全局 hooks 配置 {anchor}/.lunareclipse/hooks.json → 新位置 {userData}/hooks.json。
 * 为什么存在——0.53 起全局 hooks 配置随 Electron userData 收纳；历史上落在应用锚点/.lunareclipse/ 下，
 * 不迁移则老用户升级后全局 hooks 静默失效（loadAllHooks 只会读新位置）。
 * 迁移规则（仅桌面版 default 实例与 CLI 执行；具名实例有独立 userData，不迁移）：
 * - 旧文件不存在 → 跳过（首次安装 / 已迁移过）
 * - 新文件已存在 → 跳过（不覆盖用户已有新配置，旧文件原样保留）
 * - 旧存在且新不存在 → 先复制旧文件到同目录临时文件 hooks.json.tmp，原子改名到新位置
 *   （避免复制中途失败留下不完整的新文件导致下次启动误判"已迁移"），随后旧文件改名
 *   hooks.json.migrated 保留
 * - 复制/改名任一失败仅 catch 告警、不抛出（迁移失败不阻断启动）
 * 可回滚性：任一步失败时旧文件都保留原处；若失败发生在新文件落位之后（只剩旧文件改名
 * 那步失败），新位置已有完整副本、旧文件仍在，下次启动按"新文件已存在"跳过并保留旧文件，
 * 不会出现双写或覆盖，无数据丢失。
 */
export function migrateLegacyGlobalHooks(anchor: string, userDataDir: string): void {
  try {
    const legacyDir = join(anchor, '.lunareclipse')
    const legacyPath = join(legacyDir, 'hooks.json')
    const newPath = join(userDataDir, 'hooks.json')
    if (!existsSync(legacyPath) || existsSync(newPath)) return
    mkdirSync(userDataDir, { recursive: true })
    // 先写同目录临时文件再原子改名到新位置：直接 copyFileSync 到 newPath 中途失败会
    // 留下不完整新文件，下次启动因 existsSync(newPath) 为 true 而跳过迁移，坏文件永久生效。
    const tmpPath = `${newPath}.tmp`
    try {
      copyFileSync(legacyPath, tmpPath)
      renameSync(tmpPath, newPath)
    } catch (copyErr) {
      // 复制/落位失败：清掉可能残留的 tmp，旧文件保持原处，下次启动可完整重试
      try { unlinkSync(tmpPath) } catch { /* 清理失败不阻断（tmp 只是残留，不会误导迁移判定） */ }
      throw copyErr
    }
    // 新文件已完整落位，旧文件改名保留（不再被读取；保留以便回滚核对）。
    // 此步失败时新位置已有完整副本且旧文件仍在 → 下次按"新文件已存在"跳过，可回滚。
    renameSync(legacyPath, join(legacyDir, 'hooks.json.migrated'))
  } catch (err) {
    console.warn(
      `[hooks] 迁移旧全局 hooks 配置失败（跳过，旧配置保留原处）: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

function getGlobalHooksPath(): string {
  return join(injectedHooksUserData ?? process.cwd(), 'hooks.json')
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
 * - 自动创建目录（{userData}/ 或 {workspace}/.lunareclipse/）
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
