/**
 * @category 核心
 * @summary 主进程入口：应用生命周期、userData 重定向、模块组装与崩溃监听
 */
import { app, BrowserWindow, ipcMain, nativeTheme, dialog, session } from 'electron'
import { join, dirname } from 'path'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import http from 'http'
import { createWindow } from './window'
import { initUiZoom } from './ui-zoom'
import {
  startApiServer,
  closeApiServer,
  getApiToken,
  getHeadlessChatRunner,
  getGeoEnvText,
  SYSTEM_INJECTED_SESSION_ID
} from './api/server'
import { LLMClient } from './api/llm'
import { ToolResultDistiller, DEFAULT_DISTILL_CONFIG } from './services/tool-result-distiller'
import { InternalSessionStore } from './services/internal-session-store'
import { registerAllIpcHandlers } from './ipc/handlers'
import { createPermissionBridge } from './ipc/permission-bridge'
import { initDataDirectory } from './models/data-init'
import { UserStore } from './models/user-store'
import { readAiRegistry } from './models/ai-registry'
import { setPathContext, DEFAULT_AI_ID } from './models/path-context'
import { ensureUserScopeSkeleton } from './services/user-scope-skeleton'
import {
  resolveScopePaths,
  resolveDataDir,
  DATA_DIR_MARKER,
  type MemoryScope
} from './models/paths'
import { createToolRegistry } from './tools'
import { registerBuiltinToolsMeta } from './tools'
import type { ToolContext } from './tools'
import { createRegistrar, kernelRegistry, coeffectRegistry } from './kernel'
import type { CoeffectHandle } from './kernel'
import { createRootContext, mountFeatureServices } from './kernel/cordis-runtime'
import { buildConfigTreeLayers } from './kernel/config-layer'
import { McpClientManager } from './mcp/client-manager'
import { loadMcpConfig, watchMcpConfig, ensureMcpConfigExists } from './mcp/config-loader'

import { PluginLoader, getDomainPluginsDir } from './plugins'
import { mountCordisPlugins } from './plugins/cordis-mounter'
import { SkillMarket } from './skills/market'
import { LilithAdapter } from './services/lilith-adapter'
// lilithEnabled：莉莉丝模块总开关判定（config.lilith.enabled !== false 才启用）。
// 分发默认关闭（DEFAULT_CONFIG.lilith.enabled=false），此处作为启动编排守卫，
// 与 lilith-endpoints/lilith-session 内的业务守卫共用同一判定，保证默认不加载任何莉莉丝链路。
import { lilithEnabled } from './api/lilith-session'
// lilith-launcher 已由 IPC handler（ipc/handlers/lilith.ts）静态导入，此处静态导入消除
// 「同模块静态+动态混合导入」的 vite 构建警告（动态导入不会产生独立 chunk，无延迟加载收益）
import { hasMod as lilithHasMod, launch as lilithLaunch } from './services/lilith-launcher'
import { mergeDmnToolPolicies } from '@shared/tools/registry'
import { Supervisor, PathSyncMonitor, HealthCheck, ErrorLog } from './monitor'
import type { SupervisorCallbacks } from './monitor'
import { ModuleRegistry } from './monitor/module-registry'
import { UiHealthMonitor } from './monitor/ui-health-monitor'
import { getGlobalTimerRegistry } from './monitor/timer-registry'
import { registerOverlayIpc, setOverlayMainWindow, closeOverlayWindow } from './overlay-window'
import { ActivationManager } from './api/activation-manager'
import {
  writeRestartPending,
  consumeRestartPending,
  recordStartup,
  recordShutdown
} from './api/restart-pending'
import { browserViewManager, registerBrowserIpcHandlers } from './tools/browser-view-manager'
import { browserManager } from './tools/browser-manager'
import { registerMediaScheme, initMediaProtocol } from './api/gen/media-protocol'
import { setPreviewFile as setWorkspacePreviewFile, setSandboxState as setWorkspaceSandboxState } from './services/workspace-state'
import { initSandboxEnv } from './services/sandbox-env'
import { setRendererBridge, sendToRenderer } from './services/renderer-bridge'
import { getDefaultWorkspaceConfigPath, setDefaultWorkspacePath } from './services/workspace-config'
import { startCrashReporter, logError, safeSend } from './services/crash-logger'
import { registerCodeSandboxIpcHandlers, runJavaScript, runPython, runCode, type SandboxExecService } from './tools/code-sandbox'
import { createEvalHarness } from './eval'
import { MultiInstanceService } from './multi-instance/index'
import { AiCollaborationScheduler } from './multi-instance/ai-collaboration-scheduler'
import { setAuthService } from './multi-instance/auth/registry'
import type { EvalHarness } from './eval'
import { HumanGrader } from './eval/graders/human-grader'
import { HookManager } from './hooks'
import { CronScheduler } from './cron/scheduler'
import { loadAllHooks, watchHooksConfig, setHooksConfigRoot } from './hooks'
import { SkillLoader, getDomainSkillsDir } from './skills/loader'
import { getDefaultSkillsConfigPath } from './skills/skill-config'
import { WorkflowManager } from './workflow/manager'
import { createWorkflowEventBridge } from './ipc/handlers/workflow'
import { dynamicWorkflowPool } from './performance/dynamic-pool'
import { deviceManager } from './device/device-manager'
import { AutoCleanupService } from './services/auto-cleanup'
// 多实例 AI 社交提示词统一集中管理（prompts/social.ts）：生成器只准备数据，文案组装全部委托
import {
  buildChatRoomPrompt,
  buildFriendDirectChatPrompt,
  buildAiSocialPrompt,
  buildPublishBoardPrompt,
  buildCollaborationSelfCheckPrompt
} from './prompts/social'

import { regenerateSystemCatalog, resolveCatalogSourceRoot } from './services/system-catalog'
import { ensureNodeOnPath } from './utils/node-runtime'
import { resolveLlmConfig, syncMcpToolMetas, getAppAnchor, cleanStaleCaches, restartApp } from './startup-helpers'
import { parseInstanceArg, instanceUserData, instanceDataDir } from './multi-instance/instance-args'
import { initInstanceRuntime, setBaseDataDir } from './multi-instance/instance-runtime'
// 独立面板窗口（panel-window.ts）已移除：前端实际走 RightPanelTabs，该文件无任何调用者；
// versions/0.47 归档保留副本，未来需要独立面板窗口时可从归档恢复并接线。

// ===== 多实例 --instance <name> 支持（P5）=====
// 非 default 实例：userData 重定向到 {userData}/instances/{name}，dataDir 拼入实例名，API 走动态端口。
// default 实例（未传 --instance / --instance=default）完全不走本分支，行为逐字节不变。
// 必须在任何 app.getPath('userData') 消费点（崩溃目录/缓存清理/config/session/browser 状态/单实例锁）之前执行；
// Electron 单实例锁按 userData 目录计算——重定向后不同实例自动获得不同锁，多开机制成立。
const instanceArg = parseInstanceArg(process.argv)
/** 当前实例名（'default' 或具名实例），供 IPC/UI/端口逻辑读取 */
export const CURRENT_INSTANCE_NAME = instanceArg.name
/** 是否具名实例（非 default） */
export const IS_CUSTOM_INSTANCE = !instanceArg.isDefault
/** 重定向前默认 userData（instances/ 目录父级，供扫描已建实例与 spawn 新实例）。
 * 【为什么保留】统一随应用锚点落项目文件夹内（dev=app/data/userdata、打包=exe 旁/data/userdata），
 * 不写 %APPDATA% 系统目录——随项目整体搬迁、可移植；
 * 运行时只在项目根产生 data/ 一个数据目录（业务数据 data/abyssac_data + Electron
 * 运行时数据 data/userdata 统一收纳其下），无 .userdata 顶层目录；
 * 【不删理由】删除会退回 Electron 默认 %APPDATA%\lunareclipse，多实例数据散落系统目录，
 * 打包分发后各机器行为不一致。 */
export const BASE_USER_DATA = app.isPackaged
  ? join(getAppAnchor(), 'data', 'userdata')
  : join(app.getAppPath(), 'data', 'userdata')

// ===== 一次性数据目录迁移：旧 .userdata → data/userdata（0.50 起，去特殊化） =====
// 历史版本把 Electron userData（配置/会话/浏览器状态/Chromium 缓存）落在项目根的 .userdata/。
// 0.50 起统一并入 data/ 数据根（业务数据 data/abyssac_data + 运行时数据 data/userdata），
// 项目根只产生 data/ 一个数据目录。首次启动旧版本目录时整体平移，避免用户配置/会话丢失。
const LEGACY_USER_DATA = app.isPackaged
  ? join(getAppAnchor(), '.userdata')
  : join(app.getAppPath(), '.userdata')

/**
 * 日志路径脱敏：抹除真实用户目录段（C:\Users\<名>、/Users/<名>、/home/<名> 等）。
 * 隐私红线：日志/错误信息不得包含本机真实用户名与绝对路径，统一替换为 [user]。
 */
function redactUserPath(text: string): string {
  if (!text) return text
  return text
    .replace(/[A-Za-z]:[\\/]Users[\\/][^\\s\\]\\"']+/gi, '[user]')
    .replace(/\/(Users|home)\/[^\\s\\]\\"']+/gi, '/$1/[user]')
}
try {
  if (existsSync(LEGACY_USER_DATA) && !existsSync(BASE_USER_DATA)) {
    mkdirSync(dirname(BASE_USER_DATA), { recursive: true })
    // 同盘 rename 原子且快（旧目录可能上百 MB，复制会拖慢首次启动）；跨盘/占用失败则跳过，不阻塞启动
    renameSync(LEGACY_USER_DATA, BASE_USER_DATA)
    console.log(
      `[userdata] 已迁移旧数据目录 ${redactUserPath(LEGACY_USER_DATA)} → ${redactUserPath(BASE_USER_DATA)}`
    )
  }
} catch (err) {
  console.warn(
    `[userdata] 旧数据目录迁移失败（跳过，重新冷启动数据）: ${redactUserPath(err instanceof Error ? err.message : String(err))}`
  )
}

initInstanceRuntime(instanceArg.name, BASE_USER_DATA)

if (instanceArg.invalidReason) {
  console.warn(`[instance] ${instanceArg.invalidReason}`)
}
if (IS_CUSTOM_INSTANCE) {
  const customUserData = instanceUserData(BASE_USER_DATA, instanceArg.name)
  app.setPath('userData', customUserData)
  console.log(`[instance] 实例 "${instanceArg.name}" userData → ${redactUserPath(customUserData)}`)
} else {
// default 实例：userData 重定向到项目本地 data/userdata（随 data/ 数据根统一收纳，
  // 与 README「data/ 用户数据（业务数据 abyssac_data + 运行时数据 userdata，不进版本库）」一致），
  // dev 与打包统一走同一路径，不再回落 %APPDATA%。
  // dev 下 app.getAppPath() 实测返回 app 目录（package.json 所在处），
  // 与 getAppAnchor()（out/main → app 目录）一致，故用同一表达式；
  // 曾因多实例改造回归丢失此重定向，导致读到 %APPDATA% 下全新默认配置（parchment 素笺），
  // UI 与用户原配置（data/userdata → eclipse 月蚀深色）天差地别。
  // 【为什么保留】配置/会话/日志随项目带走，多实例隔离与单实例锁都依赖
  // userData 路径，改回 %APPDATA% 会让本地开发配置漂移、多开逻辑失效。
  // 【安全约束（0.47 打包门禁配套）】data/userdata/config.json 可能含用户在本机保存的
  // 明文 LLM API key（llm/apiKey、dmnLlm/apiKey、feishu appSecret 等）——
  // 这是开发机本地数据，已被 electron-builder files 白名单、
  // 出包前的本机自动检查（归档/门禁脚本）多重排除，
  // 任何情况都不得把 data/ 复制进打包产物或分发目录。
  const defaultUserData = BASE_USER_DATA
  app.setPath('userData', defaultUserData)
  console.log(`[userdata] default 实例 userData → ${redactUserPath(defaultUserData)}`)
}

let mainWindow: BrowserWindow | null = null
let supervisor: Supervisor | null = null
let pathSyncMonitor: PathSyncMonitor | null = null
let userStore: UserStore | null = null
let lilithAdapter: LilithAdapter | null = null
let multiInstance: MultiInstanceService
/** 莉莉丝三件套是否已在登录成功后启动过（幂等守卫：重复登录/切换用户只启动一次） */
let lilithStarted = false

/** 莉莉丝适配器专用 LLM 客户端（懒创建，跟随 config.llm） */
let lilithLlmClient: LLMClient | null = null
let activationManager: ActivationManager | null = null
/** AI 协作心跳（周期唤醒 AI 主动发起跨实例协作；随局域网启停） */
let collaborationScheduler: AiCollaborationScheduler | null = null
let mcpClientManager: McpClientManager | null = null
let evalHarness: EvalHarness | null = null
let dmnEvalHarness: EvalHarness | null = null
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- humanGrader 是副作用构造（new HumanGrader() 注册 eval:submitHumanGrade IPC），变量本身仅作持有引用
let humanGrader: HumanGrader | null = null
let healthCheck: HealthCheck | null = null
let moduleRegistry: ModuleRegistry | null = null
let uiHealthMonitor: UiHealthMonitor | null = null
let autoCleanup: AutoCleanupService | null = null
const timerRegistry = getGlobalTimerRegistry()
/** 沙箱 coeffect 句柄（onBeforeQuit 时 dispose 回滚） */
let sandboxCoeffectHandle: CoeffectHandle<SandboxExecService> | null = null
/** Cordis 模块卸载函数（onBeforeQuit 时逆序卸载，模块级声明供 onBeforeQuit 访问）。
 * async 原因：mountCordisPlugins 现在返回 async detach（卸载全部 fiber 需 await 落定，
 * 论文"依赖 key 在被依赖者完整卸载前保持可读"要求卸载动作完成才能退出）。 */
let detachCordis: (() => void | Promise<void>) | null = null

// GPU 策略：恢复硬件加速。
// 历史：曾全局 disable-gpu 规避 Windows 下 Chromium 创建/迁移 GPU 缓存目录的权限问题，
// 但 cleanStaleCaches()（本文件上方）已在启动时清理缓存目录，权限问题主因已兜住。
// 保留 shader/program 磁盘缓存禁用（不让 Chromium 写缓存目录，继续规避权限问题），
// 移除 disable-gpu 与 enable-unsafe-swiftshader：
// ①硬件 GPU（本机 RTX 4060）可用，主窗口合成走硬件加速，内存稳定；
// ②实测 enable-unsafe-swiftshader 全局开启会让 GPU 进程整条合成管线走软件渲染，
// 主窗口 2D 合成/CSS 动画全吃进程内存，11 分钟暴涨 13GB → renderer OOM（15:43/15:57/16:06 三连崩），
// webPreferences.webgl=false 只禁 JS WebGL API、禁不了合成管线，挡不住；
// ③各窗口 WebGL 上下文在硬件加速下正常创建，不再需要 swiftshader 软渲染。
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
app.commandLine.appendSwitch('disable-gpu-program-cache')

// 禁用网络服务沙箱：Chromium 网络服务沙箱在 Windows 上对自定义 userData 路径下的
// Network/Cache/Shared Dictionary 目录设置 ACL 时报 0x5（拒绝访问），即使 cleanStaleCaches
// 清理了残留文件仍可能因父目录权限继承失败。禁用沙箱后网络服务以进程级权限运行，
// 对本地桌面应用安全风险可接受。
app.commandLine.appendSwitch('disable-features', 'NetworkServiceSandbox')

// 启用原生崩溃捕获（必须在 app.ready 前调用）：dump 写入 {userData}/crashes
// 解决原生层崩溃（segfault/OOM/Chromium 级）无 dump、无线索的"静默闪退"问题
startCrashReporter()

// 全局异常处理器：捕获未处理的异常和 Promise rejection，避免进程静默崩溃
// 长时间运行的应用中，定时器回调、WebSocket 处理、DMN 工具执行都可能抛出异步错误，
// 没有这些处理器会导致进程直接退出（闪退）
// 持久化到 {userData}/logs/main-errors.log，重启后可回溯崩溃原因
// 注意：必须最先注册（早于 cleanStaleCaches 等启动期有副作用的调用），
// 否则启动早期抛出的异常（如缓存目录被占用 EBUSY）无人兜底 → Electron 弹框且进程退出
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err)
  // 接入健康检查：指纹去重 + 冷却 + 事件唤醒 AI（healthCheck 在 whenReady 后初始化，此前触发走可选链安全跳过）
  healthCheck?.reportRuntimeEvent(
    'uncaughtException',
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
  )
})
process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason)
  healthCheck?.reportRuntimeEvent(
    'unhandledRejection',
    reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)
  )
})

// 清理上次运行残留的 Chromium 缓存目录（GPUCache/Network/Cache 等）。
// 必须在异常处理器注册之后执行：rmSync 遇文件被占用（已有实例仍在运行）时抛 EBUSY，
// 若无人兜底会直接弹 "A JavaScript error occurred" 并退出（"打不开"）。已实例级容错 + handler 双保险。
cleanStaleCaches(app.getPath('userData'))

// 月蚀 Cordis 运行时（阶段 2/3：ctx 服务容器 + 基础/核心服务，架构重构总闸）
// 后续新增的 ctx 服务从这里挂载；index.ts/server.ts 逐步改走 ctx 取服务（薄壳化）
export const rootCtx = createRootContext()
const configStore = rootCtx.config.init(join(app.getPath('userData'), 'config.json'))
const sessionStore = rootCtx.sessions.init(join(app.getPath('userData'), 'sessions'))

// 浏览器登录态持久化（storageState 存 {userData}/browser-state.json，模式 B）
browserManager.setStorageStatePath(join(app.getPath('userData'), 'browser-state.json'))

// 权限绿通模式：AI 自我重启标记 + 绿通判定（模块级，before-quit 也需访问）
// AI 调用 app_restart 工具 → aiRestarting=true → app.relaunch()+app.quit()
// before-quit 时若 aiRestarting=false（用户完全关闭）→ 重置绿通为 false（保底防死循环）
// AI 自我重启后新进程读 config，绿通保留
let aiRestarting = false
const isGreenlight = (): boolean => configStore.get().permissionGreenlight === true

// 生命周期记录目录（模块级，whenReady 赋值 / before-quit 读取）
// lifecycle.json 记录启动/关闭时间，AI 通过提示词末尾静默感知自身生命周期
let lifecycleActivationDir: string | null = null

// ===== 单实例锁：防止多开导致 62002 端口冲突 → 新实例 API 起不来 → 前端显示登录界面 =====
// 事故根因：无锁时可开多个实例，旧实例占 62002，新实例监听失败，
// 前端连不上 WebSocket → authGetCurrentUser 失败 → 显示登录界面（无任何提示）。
// 第二个实例启动时自动聚焦已有窗口并退出自身。
// lune-media:// 特权 scheme 注册：必须在 app ready 之前（registerSchemesAsPrivileged 硬性要求）
registerMediaScheme()
/** 单实例锁结果：false = 已有实例在运行（本进程仅负责唤醒已有窗口后退出） */
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

/** 当前工作流作用域：记忆调度器处理某 (uid, aiId) 的 RAW 批次时设置，
 * workflow ctx 的 paths getter 据此解析作用域路径（工作流无登录态，靠 RAW 路径推断归属）。
 * 模块级声明：whenReady 内的 setWorkflowScope 与 initWorkflowEngine 跨函数共享同一绑定 */
let currentWorkflowScope: MemoryScope | null = null


/** 启动编排原子 ①：config 加载 + 数据目录解析 + 媒体协议 + 主题 */
async function initRuntime() {
  // 子进程 PATH 兜底：无全局 Node 的机器上，Hook 命令 / run_command 裸调 node|npm 会 ENOENT
  // （项目自备 .tools\node.exe 但不进系统 PATH）。启动时并入一次，后续子进程继承。
  ensureNodeOnPath(app.getAppPath())
  const config = configStore.load()
  // dataDir 解析：config 不存机器绑定绝对路径，存相对标记 + 锚点推导
  // - 相对标记（默认 ./data）→ 按锚点（打包=exe 目录 / dev=app 目录）解析成绝对路径，配置不动
  // - 配置里是绝对路径且恰等于锚点默认位置（早期版本自动写回的）→ 迁移回 ./data 可移植标记
  // - 用户自定义绝对路径 → 尊重，原样使用不回写
  // 保护：配置加载失败（文件损坏）时禁止写回——否则默认值会覆盖磁盘原文件（用户配置丢失事故根因）
  const dataDirAnchor = getAppAnchor()
  // 默认工作区锚定应用目录（默认工作区=项目文件夹/应用所在目录，随项目走、不进系统目录）；
  // 未注入时 workspace-config 回退 HOME 目录（仅单测场景）。initRuntime 在 registerWorkspaceHandlers
  // （whenReady 内 ensureWorkspaceConfigExists）之前执行，注入时序安全。
  setDefaultWorkspacePath(dataDirAnchor)
  // 全局 hooks 配置同样锚定应用目录（~/.lunareclipse 会写用户 HOME，随项目走更可移植）
  setHooksConfigRoot(dataDirAnchor)
  const { dir: resolvedBaseDataDir, shouldMigrateToMarker } = resolveDataDir(
    config.dataDir,
    dataDirAnchor
  )
  // 多实例（P5）：非 default 实例在解析出的 dataDir 下再拼 instances/{name} 子目录，彻底隔离数据；
  // default 实例保持原有目录逐字节不变。迁移写回仅作用于 default（具名实例 config 是新生成的，不写回）
  const resolvedDataDir = IS_CUSTOM_INSTANCE
    ? instanceDataDir(resolvedBaseDataDir, CURRENT_INSTANCE_NAME)
    : resolvedBaseDataDir
  // 已解析的 dataDir 基目录注入 runtime：删除/改名实例需在 {baseDataDir}/instances/{name} 上同步操作
  // （initRuntime 晚于 initInstanceRuntime，故用独立 setter；IPC 注册在 whenReady 之后，时序安全）
  setBaseDataDir(resolvedBaseDataDir)
  if (!configStore.isLoadFailed() && shouldMigrateToMarker && !IS_CUSTOM_INSTANCE) {
    config.dataDir = DATA_DIR_MARKER
    configStore.save(config)
  }
  // 运行时用锚点解析出的绝对路径；config.dataDir 保持可移植标记（./data 或用户自定义），不写回绝对路径
  // lune-media:// 协议处理器：只服务 abyssac_data/generated/ 下的生成产物（图片/视频/音频/文稿）
  initMediaProtocol(() => join(resolvedDataDir, 'abyssac_data'))
  // 浅色主题（霜璃/素笺）用 light，深色主题（夜幕/紫夜）用 dark
  nativeTheme.themeSource =
    config.theme === 'night' || config.theme === 'violet-night' ? 'dark' : 'light'
  return { config, resolvedDataDir }
}

/** 启动编排原子 ②：主窗口创建与事件接线（崩溃自恢复/最大化状态推送）。mainWindow 模块级赋值保持（render-process-gone 等回调读模块级绑定） */
function initMainWindow() {
  mainWindow = createWindow()

  // UI 缩放：分辨率自动适配（人眼最佳）+ 手动缩放（控件/快捷键/持久化）
  initUiZoom(mainWindow, configStore)

  // 主窗口关闭时一并关闭聊天小窗，避免孤儿置顶窗口残留
  mainWindow.on('closed', () => {
    closeOverlayWindow()
  })

  // 渲染进程崩溃处理：记录原因 + 自动恢复
  // 策略：首次崩溃 reload 页面；短时间内连续崩溃（GPU/原生层不稳定）则 relaunch 整个 app
  // 限频防死循环：60 秒内崩溃超 3 次不再自动重启，避免确定性崩溃无限循环
  let renderCrashTimes: number[] = []
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const goneMsg = `reason=${details.reason} exitCode=${details.exitCode}`
    logError('render-process-gone', goneMsg)
    // 接入健康检查：指纹去重 + 冷却 + 事件唤醒 AI（面板修复记录时间线可见）
    healthCheck?.reportRuntimeEvent('render-process-gone', goneMsg)
    const now = Date.now()
    // 清理 60 秒前的记录
    renderCrashTimes = renderCrashTimes.filter((t) => now - t < 60_000)
    renderCrashTimes.push(now)

    if (renderCrashTimes.length > 3) {
      // 连续崩溃超阈值：可能是确定性崩溃，不再无限 relaunch（设计依据：无限 relaunch 会
      // 陷入崩溃循环且掩盖根因）。
      // 原实现拉起「安全模式」独立修复窗口（绕过登录门控的第二个入口）——与
      // 「系统不登录不可用、无兜底」的强制登录约束冲突，已删除；连续崩溃统一
      // 重启应用并记录日志，由 AI 依据日志修复（系统仍保持登录态，无绕过登录入口）。
      const relaunchMsg = `连续崩溃 ${renderCrashTimes.length} 次，重启应用`
      logError('render-process-gone', relaunchMsg)
      healthCheck?.reportRuntimeEvent('render-process-gone', relaunchMsg)
      restartApp(relaunchMsg)
      return
    }

    // 首次/偶发崩溃：1 秒后 reload 恢复界面
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload()
        // reload 成功执行即标记恢复（面板时间线显示「已恢复」；若再次崩溃指纹仍会重新提醒）
        healthCheck?.markRuntimeRecovered('render-process-gone')
      }
    }, 1000)
  })

  // 窗口最大化状态变化：推送到渲染进程，TitleBar 据此切换图标
  mainWindow.on('maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:state', { maximized: true })
    }
  })
  mainWindow.on('unmaximize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:state', { maximized: false })
    }
  })
  return mainWindow!
}

/** 启动编排原子 ③：数据目录 + 用户存储 + 多实例底座（LAN/卫星同步） + 配置覆盖层注入 */
async function initUserDirsAndMulti(resolvedDataDir: string) {
      // dev: app.getAppPath() = 项目 app 目录，prompts 在 electron/main/prompts
      // packaged: prompts 通过 extraResources 复制到 resources/prompts（asar 外，可读）
      const devPromptsDir = join(app.getAppPath(), 'electron', 'main', 'prompts')
      const packagedPromptsDir = join(process.resourcesPath, 'prompts')
      const promptsDir = existsSync(devPromptsDir) ? devPromptsDir : packagedPromptsDir
  const dataPaths = initDataDirectory(resolvedDataDir, promptsDir)
      userStore = new UserStore(dataPaths.usersJson)
      // 主分系统：按 instance.json 装配角色（standalone/master/satellite）
      multiInstance = new MultiInstanceService(dataPaths.root)
      setAuthService(multiInstance.createAuthService(userStore))
      // 路径上下文：skills/config 按 U{uid}/AI{aiId} 组合隔离；plugins 完全本地化（全局共享，不分层）
      // aiId 动态解析：跟随当前活跃会话所属 AI（对齐 server.ts resolveSessionAiId 语义，
      // 会话 aiId 合法正整数则用之，否则回退 1=月蚀）；修复历史硬编码 ()=>1 导致
      // 「会话切到 AI{n} 后技能/配置仍读写 AI{1} 作用域」的错位。
      // 懒执行安全：闭包只在 getScopedPath 被调用时求值，彼时 supervisor/sessionStore 均已初始化。
      setPathContext(
        dataPaths.root,
        () => userStore?.getCurrentUser()?.UID ?? null,
        () => {
          const sessionId = supervisor?.activeSessionId
          if (!sessionId) return DEFAULT_AI_ID
          try {
            const aiId = sessionStore?.get(sessionId)?.aiId
            return typeof aiId === 'number' && Number.isInteger(aiId) && aiId >= 1 ? aiId : DEFAULT_AI_ID
} catch {
            return DEFAULT_AI_ID
          }
        }
      )
      // 插件全局根目录（插件 = {root}/plugins/{插件名}/，不随用户/AI 分层，建一次即可）
      mkdirSync(join(dataPaths.root, 'plugins'), { recursive: true })
      mkdirSync(join(dataPaths.root, 'plugins_domains'), { recursive: true })
      // 注册/登录时建用户目录骨架（每个已注册 AI 一份）
      // {domain}/U{uid}/AI{aiId}/（sessions/skills/config/memory，每个 AI 独立；plugins 已全局化）
      // 实现收敛到 services/user-scope-skeleton.ts（ai:register / create_ai 创建新 AI 后也复用同一入口）
      userStore.setScopeInitializer((uid: number) => {
        ensureUserScopeSkeleton(dataPaths, uid)
      })
  // 启动时若已有 last_login_uid（自动恢复登录），同步建骨架 + 切会话目录
      try {
        const restored = userStore.getCurrentUser()
        if (restored) {
          userStore.ensureScope(restored.UID)
          const scoped = resolveScopePaths(dataPaths, { uid: restored.UID, aiId: DEFAULT_AI_ID })
          sessionStore.switchUser(scoped.sessions)
        }
      } catch (err) {
        console.error('[index] 恢复登录态会话目录失败:', err)
      }
      // 分系统模式：启动免密恢复（缓存令牌刷新/离线沿用），切会话目录
      try {
        const satelliteUser = await multiInstance.restoreSatellite(userStore)
        if (satelliteUser) {
          userStore.ensureScope(satelliteUser.UID)
          const scoped = resolveScopePaths(dataPaths, { uid: satelliteUser.UID, aiId: DEFAULT_AI_ID })
          sessionStore.switchUser(scoped.sessions)
          // 隐私：不输出具体用户名，只记录恢复动作本身
          console.log('[multi-instance] 分系统登录恢复成功（用户名已设置）')
        }
      } catch (err) {
        console.error('[multi-instance] 分系统登录恢复失败:', err)
      }
      // 分系统模式：启动 oplog 采集 → outbox → 单向推送主系统（持久化补偿，断网不丢）
      try {
        await multiInstance.startSync()
      } catch (err) {
        console.error('[multi-instance] 分系统同步启动失败:', err)
      }
// 局域网协作底座（L0）：master 上报本机地址、satellite 上报在线+拉名册，终端直连聊天
      // 中继异步传输（L1.5）的下载位置/保留天数读 AppConfig.relay（用户可在设置页或 config.json 调整）
      try {
        const lan = await multiInstance.startLan(userStore, () => configStore.get())
        console.log(
          lan.ok
            ? `[lan] 局域网直连服务已启动（端口 ${lan.port}）`
            : `[lan] 局域网直连服务未启动：${lan.error ?? ''}`
        )
      } catch (err) {
        console.error('[lan] 局域网直连服务启动失败:', err)
      }
      // 修复：注册表后加的 AI（如莉莉丝）没有机会触发建目录——
      // 启动时对所有已注册用户补建骨架（ensureScope 幂等，已存在的目录跳过）
      try {
        for (const u of userStore.listUsers()) {
          userStore.ensureScope(u.UID)
        }
      } catch (err) {
        console.error('[index] 全量用户骨架补建失败:', err)
      }

      // 配置树覆盖层注入（阶段 5）：profile（具名）→ bundle（组合）→ patch 文件（AI 可写）
      // + 插件 config.patch（内核注册表）。无 profile/bundle 激活时行为与旧版完全一致。
      // 消费方用 configStore.getEffective() 读取合并结果；get() 仍返回核心真相
      configStore.setPatchProvider(() => [
        ...buildConfigTreeLayers(dataPaths.root).map((l) => l.content),
        ...kernelRegistry.get<Record<string, unknown>>('configPatch')
      ])
  return { dataPaths, userStore, multiInstance }
}

/** 启动编排原子 ④a：路径同步监控（会话路径变动 -> 通知多实例） */
async function initPathSync(dataPaths: ReturnType<typeof initDataDirectory>, multiInstance: MultiInstanceService) {
  // 真 fiber 化守卫（G3）：monitor 功能未挂载（被禁用/挂载失败）时跳过降级，
  // 后续 pathSyncMonitor?. 可选链与 before-quit 清理链均已容忍 null
  if (!rootCtx.featurePlugins.isEnabled('monitor')) {
    console.warn('[path-sync] monitor 功能已禁用，路径同步监控跳过')
    return null
  }
  pathSyncMonitor = rootCtx.monitor.initPathSync(dataPaths, {}, timerRegistry, (uid) => multiInstance?.isSatelliteUid(uid) ?? false)
  await pathSyncMonitor.start()
  return pathSyncMonitor
}

/** 启动编排原子 ④b：沙箱执行器 + coeffect 注册 */
function initSandboxCoeffect(dataPaths: ReturnType<typeof initDataDirectory>) {
  // 文件工坊执行器配置系统初始化
  initSandboxEnv(dataPaths)

  // 沙箱执行服务注册为 coeffect（按需注入：只有声明 deps: ['sandbox:exec'] 的插件才拿到）
  const sandboxService: SandboxExecService = { runJavaScript, runPython, runCode }
  sandboxCoeffectHandle = coeffectRegistry.provide('sandbox:exec', sandboxService, { kind: 'builtin' })
  return sandboxCoeffectHandle
}

/** 启动编排原子 ④c：激活管理器 + 生命周期目录 + 启动埋点 */
function initActivation(dataPaths: ReturnType<typeof initDataDirectory>) {
  // 文档 15.2.1：激活管理器（倒计时/外部事件/反思循环/后端协作）
  activationManager = new ActivationManager(join(dataPaths.root, '.activation'), timerRegistry)

  // 生命周期记录：AI 感知自身开/关时间
  // 启动写 startedAt/mode 到 lifecycle.json；关闭时（before-quit）写 lastShutdownAt/reason。
  // 注入方式：buildInjectedMessages 末尾直接读 lifecycle.json 拼 system 消息——
  // AI 每次醒来在提示词最后面看到「上次何时关闭、本次何时启动」，不触发激活事件。
  try {
    lifecycleActivationDir = join(dataPaths.root, '.activation')
    recordStartup(lifecycleActivationDir, app.isPackaged ? 'packaged' : 'dev')
  } catch (err) {
    console.error('[lifecycle] 写入启动记录失败:', err)
  }
  return activationManager
}

/** 启动编排原子 ⑤：UI 健康监控 + Cron 调度器 + 自动清理 */
function initMonitorsAndCron(dataPaths: ReturnType<typeof initDataDirectory>, activationManager: ActivationManager) {
  // UI 运行状态监控：渲染进程卡死/崩溃/GPU 崩溃/主进程事件循环延迟
  // 事件落盘 logs/ui-events.log，严重事件实时推送给 AI（运行中即可感知），
  // 同时写 pending 标记兜底（实时推送失败或主进程在事件后立即退出时，下次启动补报）
  try {
    uiHealthMonitor = new UiHealthMonitor(
      app.getPath('userData'),
      join(dataPaths.root, '.activation'),
      timerRegistry,
      (text) => {
        // 严重事件实时注入激活链路（与健康检查同通道，forceActivate 保证 AI 空闲时唤醒）
        if (!activationManager) return false
        activationManager.pushExternalEvent(
          `【运行监控】UI 异常事件：${text}\n—— 完整时间线见 logs/ui-events.log。若与工具调用/定时任务相关，考虑是 CPU 被密集任务打满导致；若崩溃前无卡死，可能是渲染进程 OOM 或 GPU 问题。`,
          true
        )
        return true
      }
    )
    if (mainWindow) {
      uiHealthMonitor.attach(mainWindow)
    }
    uiHealthMonitor.watchChildProcessGone()
    uiHealthMonitor.start()
    console.log('[ui-health] UI 运行状态监控已启动')
  } catch (err) {
    logError('ui-health.init', err)
  }

  // Cron 定时任务调度器（cron/scheduler.ts——间隔型/cron/ISO 三格式）
  // 配置 {paths.cron}/jobs.json，30s tick 检查，到点注入激活事件唤醒 AI
  let cronScheduler: CronScheduler | null = null
  try {
    if (rootCtx.featurePlugins.isEnabled('cron')) {
      cronScheduler = rootCtx.cron.create(dataPaths.cron, activationManager, timerRegistry)
      cronScheduler.start()
      console.log(`[cron] 已启动（${cronScheduler.listJobs().length} 个任务）`)
    } else {
      console.warn('[cron] cron 功能已禁用，定时任务调度器跳过')
    }
  } catch (err) {
    // cron 调度失败属非核心服务，降级不中断启动（工具按时区/激活事件仍可用）
    logError('cron.init', err)
  }

// 自动清理服务：启动 60s 后首轮，之后每 24h 一轮
  // 清崩溃转储/Chromium 缓存/运行日志/npm 日志，不碰业务数据，不唤醒 AI
  try {
    autoCleanup = new AutoCleanupService(app.getPath('userData'), app.getAppPath(), timerRegistry)
    autoCleanup.start()
    console.log('[auto-cleanup] 自动清理服务已启动（首轮 60s 后，之后每 24h）')
  } catch (err) {
    logError('auto-cleanup.init', err)
  }
  return { uiHealthMonitor, cronScheduler, autoCleanup }
}

/** 启动编排原子 ⑥：MCP 客户端 + 插件/Cordis 挂载 + 内置工具登记 + 治理机制 */
async function initKernelExtensions() {
  // MCP 客户端管理器初始化
  // 加载 .mcp.json 配置，连接所有已启用的 MCP server，注册工具元数据到 shared registry
  if (rootCtx.featurePlugins.isEnabled('mcp')) {
    try {
      ensureMcpConfigExists()
      // 阶段 4：经 ctx.mcp 统一构造点（与 server.ts 内引用共享同一实例）
      mcpClientManager = rootCtx.mcp.init()
      const mcpConfig = loadMcpConfig()
      // 连接所有已启用的 server（allSettled 不阻塞：单个失败不影响其他）
      const connectPromises = Object.values(mcpConfig.mcpServers)
        .filter((c) => c.enabled)
        .map((c) => mcpClientManager!.connectServer(c))
      await Promise.allSettled(connectPromises)
      // 同步 MCP 工具元数据到 shared registry（buildToolDescription 会动态读取）
      syncMcpToolMetas(mcpClientManager)
      // 监听 .mcp.json 变化（热重载：增删 server 后工具列表自动更新）
      watchMcpConfig(async (newConfig) => {
        if (!mcpClientManager) return
        await mcpClientManager.reloadFromConfig(newConfig)
        syncMcpToolMetas(mcpClientManager)
      })
    } catch (err) {
      console.error('[MCP] 初始化失败:', err)
    }
  } else {
    console.warn('[MCP] mcp 功能已禁用，MCP 客户端跳过（工具池不再含 MCP 工具）')
  }

  // 模块系统初始化
  // 扫描 abyssac_data/plugins/，动态加载插件工具进统一工具池（与 MCP 同机制）
  let pluginLoader: PluginLoader | null = null
  try {
    // 内置插件层（bundled）：开发走源码目录，打包走 resources/plugins/bundled
    // （electron-builder extraResources 已把 electron/main/plugins/bundled → plugins/bundled）
    const bundledPluginsRoot = app.isPackaged
      ? join(process.resourcesPath, 'plugins', 'bundled')
      : join(app.getAppPath(), 'electron', 'main', 'plugins', 'bundled')
    pluginLoader = new PluginLoader(
      getDomainPluginsDir,
      () => (existsSync(bundledPluginsRoot) ? bundledPluginsRoot : null)
    )
    await pluginLoader.reload()
    console.log(
      `[plugins] 已加载 ${pluginLoader.list().length} 个插件，${pluginLoader.getTools().length} 个工具`
    )
  } catch (err) {
    console.error('[plugins] 初始化失败:', err)
  }

  // Cordis 模块挂载（阶段 5a）：把声明 cordis.entry 的插件挂载进 rootCtx
  // 沙箱按需注入在此发生：声明 deps: ['sandbox:exec'] 的模块拿到沙箱服务
  // detachCordis 在模块级声明（line 104），onBeforeQuit 可访问
  if (pluginLoader) {
    try {
      detachCordis = await mountCordisPlugins(rootCtx, pluginLoader)
      console.log(`[cordis-mounter] Cordis 模块挂载完成`)
    } catch (err) {
      console.error('[cordis-mounter] 挂载失败:', err)
    }
  }

  // 内置工具登记（LXK 自我检视）：kernel_inspect 能看到完整工具面
  try {
    registerBuiltinToolsMeta()
  } catch (err) {
    console.error('[kernel] 内置工具登记失败:', err)
  }

  // 治理机制（LXK governance）：空转抑制/查证提醒/收尾反思/失败止损——确定性 hook，不靠 AI 自觉。
  // 可经 config 覆盖层关闭（governance.idleSuppression 等 = false，config_patch 工具操作）。
  // 阶段 4：统一入口改为 rootCtx.governance.installAll（原逐个 install 调用收敛为一次性安装）
  if (rootCtx.featurePlugins.isEnabled('governance')) {
    try {
      const { reg: govReg } = createRegistrar(kernelRegistry, { kind: 'builtin' })
      rootCtx.governance.installAll(govReg)
      console.log('[kernel] 治理机制已启用：空转抑制/查证提醒/收尾反思/失败止损/运行时评论家')
    } catch (err) {
      console.error('[kernel] 治理机制初始化失败:', err)
    }
  } else {
    console.warn('[kernel] governance 功能已禁用，治理机制未安装')
  }
  return { mcpClientManager, pluginLoader, detachCordis }
}

/** 启动编排原子 ⑦：Hook 管理器 + Skill 加载器 + Skill 市场 */
function initHooksSkills(dataPaths: ReturnType<typeof initDataDirectory>) {
  // DMN 共享 HookManager（与前端 AI 共用同一套 hooks 配置）
  // 加载 AppConfig.hooks + 内置 defaults.ts，监听热重载
  const dmnHookManager = new HookManager()
  try {
    const dmnHookConfigs = loadAllHooks()
    dmnHookManager.loadHooks(dmnHookConfigs)
    watchHooksConfig(() => {
      const newHooks = loadAllHooks()
      dmnHookManager.loadHooks(newHooks)
      console.log(`[hooks] DMN hooks 热重载，加载 ${newHooks.length} 个 hook`)
    })
  } catch (err) {
    // hooks 配置损坏/监听失败属非核心初始化，降级不中断启动
    console.error('[hooks] Hook 配置加载或监听失败，降级为无 hooks:', err)
  }

  // 知识层：DMN 共享 SkillLoader（与前端 AI 共用同一套 Skills）
  // 领域级目录 getter 修复：原实现指向 global 父目录永远扫不到领域级 skill，
  // 统一用 loader 的 getDomainSkillsDir（领域级 skills 目录）
  // configPath 传函数引用延迟求值：若在构造时固化字符串，路径会锁死，
  // 登录后 load() 无法按 U{uid}/AI{aiId} 前缀分层解析——配置错位（技能安装不显示的根因同源）。
  // 系统强制登录后才可用：load()/startWatching() 只在登录成功回调（onAuthSuccess）中
  // 统一驱动（见 initIpcLayer），未登录态不调用、无可访问的未登录路径。
  const dmnSkillLoader = new SkillLoader(getDomainSkillsDir, () => getDefaultSkillsConfigPath())
  // SKILL 变动 → 前端自动刷新：磁盘热重载（SKILL.md/.skills.json 变化、市场安装/更新/卸载、
  // AI 工具经 IPC 安装等任何写盘动作）完成后广播 'skills:changed'，渲染侧订阅后重拉列表/市场。
  // 切换 AI 会话不触发本回调（无磁盘变动），由前端会话切换逻辑（chatSlice.selectSession 等）另行刷新。
  // sendToRenderer 的发送函数在窗口创建时注入（setRendererBridge）；桥未就绪时静默跳过，
  // 面板打开时 init 兜底拉取最新列表。
  dmnSkillLoader.setChangeCallback(() => {
    try {
      sendToRenderer('skills:changed', {})
    } catch {
      /* 渲染桥未就绪时忽略：面板打开时 init 兜底拉取最新列表 */
    }
  })

  // Skill 市场
  // 数据在 {userData}/skill-market/，市场来源安装到用户级 skills（dmnSkillLoader 共享用户级目录）
  // 内置市场仓库（electron/main/skills/market-repo → resources/skills/market-repo）：
  // 开发走源码目录，打包走 resources/skills/market-repo（electron-builder extraResources 已配置）；
  // 传给 SkillMarket 后首次启动自动注册为内置 dir 源，用户开箱即见 10 个可分发技能。
  // 留存理由：与 bundled 插件同款双路径探测，避免打包后找不到仓库导致空市场。
  let skillMarket: SkillMarket | null = null
  try {
    const builtinMarketRepo = app.isPackaged
      ? join(process.resourcesPath, 'skills', 'market-repo')
      : join(app.getAppPath(), 'electron', 'main', 'skills', 'market-repo')
    skillMarket = new SkillMarket(
      join(dataPaths.root, 'skill-market'),
      dmnSkillLoader,
      undefined,
      existsSync(builtinMarketRepo) ? builtinMarketRepo : undefined
    )
  } catch (err) {
    console.error('[skill-market] 初始化失败:', err)
  }
  return { dmnHookManager, dmnSkillLoader, skillMarket }
}

/** 启动编排原子 ⑧：工作流引擎（独立 LLM/上下文/工具池/桥接/蒸馏器）+ 工具池重建订阅 */
function initWorkflowEngine(opts: {
  dataPaths: ReturnType<typeof initDataDirectory>
  mcpClientManager: McpClientManager | null
  pluginLoader: PluginLoader | null
  dmnSkillLoader: SkillLoader
}) {
  const { dataPaths, mcpClientManager, pluginLoader, dmnSkillLoader } = opts
  let workflowManager: WorkflowManager | null = null
  // L8 工作流引擎：WorkflowManager 初始化
  //
  //
  // 依赖说明：
  // - LLMClient：独立实例（与 server.ts 内部的 llmClient 分离，避免 stream 抢占）
  // 记忆工作流用后端 LLM（config.dmnLlm），
  // 不再跟随前端 AI 的 config.llm。用 updateConfig 跟随 configStore.dmnLlm 变化（保持引用有效）
  // - ToolRegistry：独立实例，复用 baseCtx 但不注入 hookManager（工作流有自己的 HOOK 系统）
  // - SkillLoader：复用 dmnSkillLoader（与前端 AI 共用同一套 Skills）
  // - McpClientManager：复用 mcpClientManager（MCP 工具走现有路径）
  // - emit：事件桥接器，通过 webContents.send 推到前端
  const workflowLlmClient = new LLMClient(resolveLlmConfig(configStore.get().dmnLlm, configStore.get().llm))
configStore.subscribe((newConfig, oldConfig) => {
    // followMain：比较 resolve 后的生效值——dmnLlm.followMain 时前端 llm 变化也要触发更新
    const newCfg = resolveLlmConfig(newConfig.dmnLlm, newConfig.llm)
    const oldCfg = resolveLlmConfig(oldConfig.dmnLlm, oldConfig.llm)
    if (JSON.stringify(newCfg) !== JSON.stringify(oldCfg)) {
      workflowLlmClient.updateConfig(newCfg)
      console.log('[workflow] LLMClient 配置已更新（后端 DMN LLM）')
    }
  })
  // 工作流专用工具结果蒸馏器：独立于 server.ts 的 distiller（server 用 llmClientRef.current，
  // 工作流用 workflowLlmClient——复用 server 实例会与主会话 LLM 抢占且带回环风险）。
  // 与 server.ts 同构：失败重试一次仍失败保留原文；配置跟随 toolResultDistill。
  const workflowDistiller = new ToolResultDistiller(
    () => workflowLlmClient,
    () => ({ ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) })
  )
  // 工作流 LLM 节点蒸馏回调工厂：语义与 server.ts makeDistillCallbacks 一致——
  // 工作流节点（记忆流水线/日记生成等无人值守自动化）也用同一蒸馏器。
  const workflowDistillCallbacks = (): {
    distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
    distillIntentTurnPairs?: number
  } => {
    // 与 server.ts makeDistillCallbacks 同一合并形态：用户配置优先、缺省回退单源默认
    const distillCfg = { ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) }
    return {
      distillToolResult: async (toolName: string, _toolCallId: string, result: string, intent?: string) =>
        (await workflowDistiller.distill(toolName, result, intent)) ?? undefined,
      distillIntentTurnPairs: distillCfg.intentTurnPairs
    }
  }
  // L8 修复：工作流工具池缺 user 上下文，导致记忆流水线 create_memory 被拒
  // （create-memory.ts 要求 normal 类型记忆必须有 ctx.user，实例 sessionId=null 时 user 丢失）
  // 参考 supervisor.ts 的 Object.defineProperty getter 写法：user 动态从 userStore 取，
  // 避免 {...baseCtx} 展开时把 getter 固化成静态值（getCurrentUser 可能为 null）
  // 分层改造：paths 动态 getter——工作流处理某个 (uid, aiId) 的 RAW 时，
  // 调度器设置 currentWorkflowScope，工具自动落对应作用域（不依赖登录态）。
  const workflowCtx: ToolContext = {
    skillLoader: dmnSkillLoader
  }
  Object.defineProperty(workflowCtx, 'user', {
    get: () => userStore?.getCurrentUser() ?? undefined,
    enumerable: true,
    configurable: true
  })
  Object.defineProperty(workflowCtx, 'paths', {
    get: () => {
      // 调度器在处理某作用域 RAW 时设置；无则回退全局（启动早期/非记忆工作流场景，属正常降级）
      if (!currentWorkflowScope) console.debug('[wf-scope-diag] paths getter: scope=NULL (fallback BaseDataPaths)')
      return currentWorkflowScope ? resolveScopePaths(dataPaths, currentWorkflowScope) : dataPaths
    },
    enumerable: true,
    configurable: true
  })
  const workflowToolRegistry = createToolRegistry(
    workflowCtx,
    // 工作流执行记忆处理任务，需要 DMN 工具集（create_memory/create_nng 等标记为 agents:['dmn']）
    // 不传 agent 会默认推断为 'frontend'，导致 DMN 专属工具被过滤掉
    // toolsPolicy 传全部 DMN 默认策略的并集：否则 DeleteFile 等 defaultEnabled=false 的
    // 高风险工具被 isToolEnabled 回退逻辑过滤，工作流 LLM 节点报"未注册"且工具不可用
    {
      agent: 'dmn',
      mcpClientManager: mcpClientManager ?? undefined,
      toolsPolicy: mergeDmnToolPolicies(),
      pluginTools: pluginLoader?.getTools() ?? [],
      // 传入生效配置：visible 条件（如 image_gen 需 imageGen.enabled、素材生成工作流的
      // video_gen/audio_gen 需 generation.*.enabled）不传 config 时恒判 false，工具被整池滤掉
      config: configStore.getEffective()
    }
  )
const workflowEmit = createWorkflowEventBridge(() => mainWindow)
  try {
    if (rootCtx.featurePlugins.isEnabled('workflow')) {
      workflowManager = rootCtx.workflow.init({
        paths: dataPaths,
        llmClient: workflowLlmClient,
        toolRegistry: workflowToolRegistry,
        skillLoader: dmnSkillLoader,
        mcpClientManager: mcpClientManager ?? undefined,
        emit: workflowEmit,
        // 工作流 LLM 节点（记忆流水线/日记等无人值守自动化）与主会话一视同仁：
        // 工具结果先蒸馏再进上下文（失败保原文），按工具名挂消息来源护栏
        makeDistillCallbacks: workflowDistillCallbacks,
        // 动态性能优化：工作流实例级并发闸门——上限随当前设备参数/负载实时变化
        concurrencyGate: dynamicWorkflowPool
      })
      // 崩溃恢复：扫描 paused/running 实例，恢复执行
      void workflowManager.recoverInstances()
      console.log('[workflow] WorkflowManager 已初始化')
    } else {
      console.warn('[workflow] workflow 功能已禁用，工作流引擎跳过（记忆流水线/WF 节点不可用）')
    }
  } catch (err) {
    console.error('[workflow] WorkflowManager 初始化失败:', err)
  }

  // 生成模态配置变更 → 原地重建工作流工具池：
  // createToolRegistry 的 visible 条件在创建时一次性求值（config 快照），
  // 用户在设置页开/关 imageGen、generation.* 后若不重建，工作流（素材生成模板）
  // 仍拿旧快照判定工具不可见。WorkflowManager 持有 registry 对象引用，
  // 清空并重填同一个 tools Map 即可让后续 filter/executeTool 读到新集合。
  configStore.subscribe((newConfig, oldConfig) => {
    const genChanged =
      JSON.stringify(oldConfig.imageGen) !== JSON.stringify(newConfig.imageGen) ||
      JSON.stringify(oldConfig.generation) !== JSON.stringify(newConfig.generation)
    if (!genChanged) return
    const fresh = createToolRegistry(workflowCtx, {
      agent: 'dmn',
      mcpClientManager: mcpClientManager ?? undefined,
      toolsPolicy: mergeDmnToolPolicies(),
      pluginTools: pluginLoader?.getTools() ?? [],
      config: newConfig
    })
    workflowToolRegistry.tools.clear()
    for (const [id, t] of fresh.tools) {
      workflowToolRegistry.tools.set(id, t)
    }
    console.log('[workflow] 工具池已重建（生成配置变更）')
  })
  return { workflowManager }
}

/** 启动编排原子 ⑨：内部会话存储（旧块树清理已随 M2 删除面移除：
 * *.blocks.json 由 session-store 加载层防御性跳过，不再需要启动期物理清扫） */
function initInternalSessionStore() {
  // 共享内部会话存储：server（AI 两写）和 IPC handler（前端内部会话面板）使用同一实例，
  // 单实例内 writeChains 串行化统一，避免跨实例并发写盘竞争。
  return new InternalSessionStore(() => sessionStore.getDir())
}

/** 启动编排原子 ⑩a：API server 启动 + 端口登记（创建主路由、注入 activation 上下文） */
async function initApiServer(opts: {
  userStore: UserStore
  activationManager: ActivationManager
  baseCtx: ToolContext
  dataPaths: ReturnType<typeof initDataDirectory>
  mcpClientManager: McpClientManager | null
  pluginLoader: PluginLoader | null
  internalSessionStore: InternalSessionStore
  multiInstance: MultiInstanceService
}) {
  const { userStore, activationManager, baseCtx, dataPaths, mcpClientManager, pluginLoader, internalSessionStore, multiInstance } = opts
  const port = await startApiServer(
        configStore,
        sessionStore,
        userStore,
        activationManager,
        baseCtx,
        dataPaths,
        mcpClientManager ?? undefined,
        pluginLoader ?? undefined,
        rootCtx,
        internalSessionStore,
        // 历史 BUG（打包版）：启动时 standalone → createMasterRouter 返回 null → /api/v1 永不挂载；
        // 注册成为主系统是运行时动作，静态传值不会补挂。改为惰性取路由：每次请求动态创建
        // （createMasterRouter 内部 ensureMasterAssets 幂等，升级后立即返回路由），免重启热升级。
        // masterRouter 位置仍传启动时路由，供 server-assembly 判定 0.0.0.0 监听地址（启动时定，不热切换）。
        multiInstance.createMasterRouter(userStore!) ?? undefined,
        () => multiInstance.createMasterRouter(userStore!),
        IS_CUSTOM_INSTANCE ? 0 : undefined
      )
      console.log(`API server on http://localhost:${port}`)
      multiInstance.setApiPort(port)
  return port
}

/** 启动编排原子 ⑩b：多实例 AI 自动回复生成器 + 定时归档清理 */
function initMultiInstanceAi(multiInstance: MultiInstanceService) {
  // 泛化：身份约定按注册表动态生成，不再写死"1=月蚀、2=莉莉丝"。
  // 自定义 AI 顺延编号后，各生成器提示词能正确描述本机全部 AI 实体。
  const buildAiIdConvention = (): string => {
    const registries =
      multiInstance.getAiSocial()?.allAi() ??
      // ai-registry.json 动态读取兜底（避免 getAiSocial 未初始化时退化为写死文案）
      (() => {
        try {
          return readAiRegistry(join(app.getPath('userData'), 'abyssac_data', 'ai-registry.json')).ais
        } catch {
          return []
        }
      })()
const parts = registries
      .slice()
      .sort((a, b) => a.id - b.id)
      .map((a) => `${a.id} 是 ${a.name}`)
    return parts.length > 0 ? parts.join('、') : '本机暂无已编号的 AI'
  }
// 聊天室 AI 自动回复：注入生成器（走完整月蚀链路：独立会话 + 工具循环），
  // 使不同月蚀实例可在聊天室内自动互相交流。开关由 ai-agent-config.json 控制。
  multiInstance.setAiReplyGenerator(async ({ ai, room, history }) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    const recent = history.slice(-20)
    const transcript = recent
      .map((m) => {
        const who = m.isAi ? `${m.from}-${m.aiId ?? DEFAULT_AI_ID}` : String(m.from)
        return `[${who} ${m.isAi ? 'AI' : '真人'}] ${m.fromName ?? (m.isAi ? 'AI' : `UID${m.from}`)}：${m.text}`
      })
      .join('\n')
    // 身份路由：从注册表取该 aiId 的专属档案，让不同 AI 以各自身份参与聊天室交流
    const profile = multiInstance.getAiSocial()?.allAi().find((r) => r.id === ai.aiId) ?? null
    const personaLine = profile
      ? `你的身份档案：名字「${profile.name}」${profile.description ? `，简介：${profile.description}` : ''}${profile.systemPrompt ? `，个性设定：${profile.systemPrompt.slice(0, 200)}` : ''}。`
      : ''
const prompt = buildChatRoomPrompt({
      roomName: room.name,
      aiName: ai.name,
      aiUid: ai.uid,
      aiAiId: ai.aiId,
      personaLine,
      conventionText: buildAiIdConvention(),
      transcript
    })
    const reply = await runner(prompt, `lan-chat-room-${room.gid}`, ai.aiId)
    return reply?.trim() || null
  })
  // 私聊 AI 自动回复：注入生成器（同样走完整月蚀链路），使好友之间的月蚀可自动互相应答。
  // 回复以本机用户身份发出并标记 isAiGenerated；开关由 ai-agent-config.json 的 directChats 控制。
  multiInstance.setFriendAiReplyGenerator(async (peerUid, msg) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    const friends = multiInstance.getFriends()
    const transcript = (friends?.messages(peerUid) ?? [])
      .slice(-20)
      .map((m) => {
        const side = m.from === peerUid ? '对方' : '本机'
        const kind = m.isAiGenerated ? `AI代答(${m.from}-${m.aiId ?? DEFAULT_AI_ID})` : '真人'
        return `[${side} ${kind}] ${m.text}`
      })
      .join('\n')
const prompt = buildFriendDirectChatPrompt({
      peerUid,
      conventionText: buildAiIdConvention(),
      transcript,
      triggerText: msg.text
    })
    const reply = await runner(prompt, `lan-direct-chat-${peerUid}`)
    return reply?.trim() || null
  })
  // AI 社交回复生成器：本机账号下真人/其他 AI 发给某 AI 的消息触发该 AI 回复。
  // 按 aiId 路由：AIID=1 月蚀走 headless 主链路；其余 AI 使用同一链路但提示词声明自身身份
  // （ 完善为按注册表 systemPrompt/llm 差异化路由）。会话记录在 federation/ai-chats。
  multiInstance.setAiSocialReplyGenerator(async (peer, trigger, history) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    const transcript = history.slice(-20)
      .map((m) => {
        const who = m.fromAiId !== undefined ? `${m.from}-${m.fromAiId}` : String(m.from)
        const kind = m.fromAiId !== undefined ? 'AI' : '真人'
        return `[${who} ${kind}] ${m.text}`
      })
      .join('\n')
    // 身份路由：从注册表取该 aiId 的专属档案，不同 AI 以各自身份参与 AI 社交会话
    const profile = multiInstance.getAiSocial()?.allAi().find((r) => r.id === peer.aiId) ?? null
    const personaLine = profile
      ? `你的身份档案：名字「${profile.name}」${profile.description ? `，简介：${profile.description}` : ''}${profile.systemPrompt ? `，个性设定：${profile.systemPrompt.slice(0, 200)}` : ''}。`
      : ''
const prompt = buildAiSocialPrompt({
      peerName: peer.name,
      peerUid: peer.uid,
      peerAiId: peer.aiId,
      personaLine,
      conventionText: buildAiIdConvention(),
      transcript,
      triggerText: trigger.text
    })
    const reply = await runner(prompt, `ai-social-${peer.uid}-${peer.aiId}`, peer.aiId)
    return reply?.trim() || null
  })
  // 公示板 AI 参与生成器：真人发帖/评论后，本机 AI 以各自身份（UID-AIID）在公示板发言。
  // 开关由 ai-agent-config.json 的全局 enabled 控制（aiConfig.isBoardEnabled）。
  multiInstance.setPublishBoardAiReplyGenerator(async (ai, trigger, history) => {
    const runner = getHeadlessChatRunner()
    if (!runner) return null
    // 身份路由：从注册表取该 aiId 的专属档案，让不同 AI 以各自身份参与公示板交流
    const profile = multiInstance.getAiSocial()?.allAi().find((r) => r.id === ai.aiId) ?? null
    const personaLine = profile
      ? `你的身份档案：名字「${profile.name}」${profile.description ? `，简介：${profile.description}` : ''}${profile.systemPrompt ? `，个性设定：${profile.systemPrompt.slice(0, 200)}` : ''}。`
      : ''
    const article = history[0] && 'boardId' in history[0] ? history[0] : null
    const boardId = article?.boardId ?? ''
    const articleLine = trigger.kind === 'article'
      ? `帖子《${trigger.article?.title ?? ''}》：${trigger.article?.summary?.slice(0, 300) ?? ''}`
      : `帖子《${article && 'title' in article ? article.title : ''}》：${article && 'summary' in article ? String(article.summary).slice(0, 300) : ''}`
    const recentComments = history
      .filter((h): h is import('./multi-instance/publish-board/publish-board-types').PublishComment => 'commentId' in h)
      .slice(-8)
      .map((c) => `${c.fromAiId !== undefined ? `UID${c.from}-AI${c.fromAiId}` : `UID${c.from}`}（${c.fromName}）：${c.text}`)
      .join('\n')
const prompt = buildPublishBoardPrompt({
      boardId,
      aiName: ai.name,
      aiUid: ai.uid,
      aiAiId: ai.aiId,
      personaLine,
      conventionText: buildAiIdConvention(),
      articleLine,
      recentComments,
      triggerMessageLine:
        trigger.kind === 'article'
          ? `真人发布帖子「${trigger.article?.title ?? ''}」`
          : `UID${trigger.comment?.from}`
    })
    const reply = await runner(prompt, `lan-publish-board-${trigger.kind === 'article' ? trigger.article?.articleId ?? '' : trigger.comment?.articleId ?? ''}`, ai.aiId)
    return reply?.trim() || null
  })
  // master 启动补扫：按此前推数据评估被动日归档（无变化零 IO）
  multiInstance.runArchiveSweep()
}

/** 启动编排原子 ⑩c：AI 协作心跳调度器（仅非主实例启用） */
function initCollaborationScheduler(activationManager: ActivationManager | null, multiInstance: MultiInstanceService, userStore: UserStore | null) {
  // AI 协作心跳：周期唤醒 AI 让它主动去聊天室/私聊/公示板发起协作。
  // 走主会话激活事件（不占 headless 串行队列）；standalone 角色下 LAN 未启动，自动不启用。
  collaborationScheduler = new AiCollaborationScheduler({
    timerRegistry,
    activationManager: activationManager!,
    isEnabled: () => multiInstance.getAiAgentConfig().isProactiveEnabled(),
    isLanActive: () => multiInstance.getRole() !== 'standalone' && multiInstance.getLanStatus().running,
    intervalMs: () => multiInstance.getAiAgentConfig().getProactiveIntervalMs(),
buildPrompt: () => {
      const uid = userStore?.getCurrentUser()?.UID
      // 动态线路清单由本函数按当前状态生成；固定骨架与收尾纪律行在 prompts/social.ts
      const lines: string[] = []
      const rooms = multiInstance.getChatRooms()
      if (rooms) {
        const mine = rooms
          .list()
          .map((r) => ({ gid: r.gid, detail: rooms.detail(r.gid) }))
          .filter((r) => r.detail?.members.some((m) => m.isAi && m.uid === uid))
        if (mine.length > 0) {
          lines.push(
            `聊天室（你已以 AI 发言身份在场，可用 chat_room_manage send 发言）：${mine.map((r) => `${r.detail!.name}(${r.gid})`).join('、')}`
          )
        }
      }
      const friends = multiInstance.getFriends()
      const friendList = friends?.list() ?? []
      if (friendList.length > 0) {
        lines.push(
          `好友私聊（可用 friend_manage send 发起）：${friendList.map((f) => `${f.昵称}(UID${f.uid})`).join('、')}`
        )
      }
      const board = multiInstance.getPublishBoard()
      const boards = board?.listBoards() ?? []
      if (boards.length > 0) {
        lines.push(
          `公示板（可用 publish_board_manage publish/comment 发帖评论）：${boards.map((b) => `${b.name}(${b.boardId})`).join('、')}`
        )
      }
return buildCollaborationSelfCheckPrompt(lines)
    }
  })
  collaborationScheduler.start()
  return collaborationScheduler
}

/**
 * 进程是否存活（signal 0 只做存在性探测、不真的发信号）。
 * 为什么需要：莉莉丝的 runtime.json 是 companion 上次运行时写下的，进程退出时**不会**清它，
 * 于是「文件存在」与「进程在跑」是两件事。只凭文件就发 reload，会把「本来就没开」误报成
 * 「reload 失败」，每次冷启动打一行假失败（实测：文件里的 pid 早已死亡、端口无监听）。
 * EPERM 表示进程存在但当前进程无权操作（如系统级进程）——按存活处理，不误判成未运行。
 */
function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// 莉莉丝桥接用的 API 端口。为什么存成模块级：桥接的冷启动执行挂在「随月蚀启动」开关上，
// 开关关闭时冷启动完全不碰莉莉丝；而用户仍可能手动点「启动莉莉丝桌宠」，那一刻需要补同步一次，
// 此时端口早已确定（startApiServer 之后），故存下来供 IPC 启动路径按需取用。
let apiPortForLilithBridge = 0

/**
 * 莉莉丝桥接的按需触发（用户主动启动桌宠时由 IPC 调用）。
 * 为什么存在：桥接 = 「写 MOD 配置 + 通知已运行的 companion 重读」，两者是一次原子动作
 * （companion 在游戏启动时把 config 缓存在内存里，只写文件它读不到，必须 reload 才生效），
 * 所以整条一起受「随月蚀启动」开关控制；但关闭开关的用户手动启动桌宠/直接开游戏时，
 * companion 仍需读到指向月蚀的 provider，否则游戏内莉莉丝连不上月蚀。此时补同步一次。
 * 不删理由：删掉则「关掉随月蚀启动 + 手动启动」这条正常用法会静默断链。
 */
function runLilithBridgeNow(): void {
  if (!lilithEnabled(configStore)) return
  if (!apiPortForLilithBridge) return
  initLilithBridge(apiPortForLilithBridge)
}

/** 启动编排原子 ⑪a：莉莉丝 MOD 桥接（纯 TCP + MOD 协议，不吃 AI） */
function initLilithBridge(port: number) {
  // ===== 莉莉丝 MOD 桥接：把月蚀 API 端口写入 MOD 配置 =====
  // MOD companion 的 provider.base_url 指向月蚀 → 游戏内莉莉丝的对话走月蚀上下文
  // MOD 配置路径：%APPDATA%\LilithAI\config.json（MOD 运行时会读）
  // 【为什么不删/不改落点】该路径是与其他应用（莉莉丝 MOD）的跨应用契约，写在哪由 MOD 侧
  // 读取逻辑决定，不属于本项目"统一落项目文件夹"范围；改动只会让 MOD 读不到配置而断链。
  // 失败不阻塞：MOD 未安装/路径变动时仅打日志
  try {
    const modConfigPath = join(app.getPath('appData'), 'LilithAI', 'config.json')
    if (existsSync(modConfigPath)) {
      const modCfg = JSON.parse(readFileSync(modConfigPath, 'utf-8'))
      const llmCfg = configStore.get().llm
      modCfg.mock_mode = false
      modCfg.provider = {
        ...(modCfg.provider ?? {}),
        kind: 'custom',
        base_url: `http://127.0.0.1:${port}`,
        api_key: 'lunareclipse', // health-scan: ignore-secret 本地回环 mock 服务的固定占位 token，非真实凭据
        model: llmCfg.model || 'lunareclipse',
        wire_api: 'chat_completions',
        thinking_mode: 'default'
      }
      writeFileSync(modConfigPath, JSON.stringify(modCfg, null, 2), 'utf-8')
      console.log(
        `[lilith-bridge] MOD 配置已写入 base_url=http://127.0.0.1:${port}（${redactUserPath(modConfigPath)}）`
      )

      // 关键：companion 在游戏启动时缓存了 config（server.js 的 let config = loadConfig()），
      // 只会在 POST /v1/control {action:'reload'} 时重新加载。若游戏先于月蚀启动，
      // companion 的 base_url 仍是旧端口 → 链路断。这里主动触发 reload 热更新。
      // 注意：这一步只在 companion **确实在跑**时才有意义（reload 的目的是修「先开游戏后开月蚀」）；
      // 没在跑时无物可 reload，静默跳过——不打印任何「失败」，因为那不是失败、是正常状态。
      const runtimePath = join(app.getPath('appData'), 'LilithAI', 'runtime.json')
      if (existsSync(runtimePath)) {
        try {
          const rt = JSON.parse(readFileSync(runtimePath, 'utf-8')) as {
            pid?: number
            port?: number
            token?: string
          }
          if (rt?.port && isPidAlive(rt.pid)) {
            const payload = JSON.stringify({ action: 'reload' })
            const req = http.request(
              {
                host: '127.0.0.1',
                port: rt.port,
                path: '/v1/control',
                method: 'POST',
                headers: {
                  ...(rt.token ? { Authorization: `Bearer ${rt.token}` } : {}),
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload)
                }
              },
              (res) => {
                let raw = ''
                res.on('data', (c) => {
                  raw += c
                })
                res.on('end', () => {
                  const ok = res.statusCode === 200 && raw.includes('"ok":true')
                  console.log(
                    `[lilith-bridge] companion reload ${ok ? '成功' : `失败(status ${res.statusCode})`}（端口 ${rt.port}）`
                  )
                })
              }
            )
            req.on('error', (err) =>
              console.warn(
                `[lilith-bridge] companion reload 失败（companion 未运行?）: ${err.message}`
              )
            )
            req.setTimeout(3000, () => req.destroy(new Error('reload timeout')))
            req.end(payload)
          }
        } catch (err) {
          console.warn(`[lilith-bridge] 触发 companion reload 失败: ${(err as Error).message}`)
        }
      }
    } else {
      console.warn(`[lilith-bridge] MOD 配置不存在，跳过：${redactUserPath(modConfigPath)}`)
    }
  } catch (err) {
    console.error('[lilith-bridge] MOD 配置写入失败:', redactUserPath(err instanceof Error ? err.message : String(err)))
  }
}

/** 启动编排原子 ⑪b：莉莉丝适配器（lorina 守护服务模式，端口随机避开 MOD 冲突） */
function initLilithAdapter(config: ReturnType<typeof configStore['load']>, dataPaths: ReturnType<typeof initDataDirectory>) {
  // ===== 莉莉丝连接：默认走 companion 桥接链路（LilithMod 原生支持）=====
  // 实测结论：LilithMod.dll 的 EnsureCompanionRunning 是"先 spawn companion 进程"，
  // spawn 失败（端口被占）就判定 companion unavailable → 游戏内莉莉丝断连。
  // 因此月蚀适配器"占 6186 伪装 companion"的方案与 LilithMod 启动逻辑冲突（EADDRINUSE 死循环）。
  // 正确路径：让 LilithMod 正常 spawn 真 companion（占 6186），companion 的 provider.base_url
  // 指向月蚀 62002（上面已写入 config.json）→ 对话经 companion → 月蚀 /chat/completions → lilith_chat。
  // 适配器保留为可选（config.lilith.useAdapter=true 时启用，用于无 MOD companion 的场景）。
  const appDataDir = app.getPath('appData')
  // 真 fiber 化守卫（G3）：lilith 服务未挂载时视为使用默认 companion 桥接链路
  const useAdapter = config.lilith?.useAdapter === true && rootCtx.featurePlugins.isEnabled('lilith')
  if (useAdapter) {
    lilithAdapter = rootCtx.lilith.create({
      port: 6186,
      dataRoot: dataPaths.root,
      appDataDir,
      sessionStore,
      getLlmClient: () => {
        if (!lilithLlmClient) {
          lilithLlmClient = new LLMClient(config.llm)
        }
        return lilithLlmClient
      },
      // 当前环境注入（地理位置/天气）：与主链路同构，适配器模式的莉莉丝同样感知时间/地区
      getEnvText: () => getGeoEnvText(),
      // 系统注入/健康检查消息：不发给莉莉丝，转交月蚀大脑处理（完整工具链），不吞消息。
      // 月蚀大脑未就绪（server 未启动）时返回明确占位，拒绝静默吞掉。
      onSystemInjected: (message) => {
        const runner = getHeadlessChatRunner()
        if (!runner) {
          console.warn('[lilith-adapter] 月蚀大脑未就绪，无法转交系统消息:', message.slice(0, 60))
          return '（系统消息已拦截，但月蚀大脑未就绪，请稍后重试）'
        }
        return runner(message, SYSTEM_INJECTED_SESSION_ID)
      }
    })
    lilithAdapter
      .start()
      .then((adapterPort) => {
        console.log(
          `[lilith-adapter] 适配器模式启用（端口 ${adapterPort}）——注意：此模式与 LilithMod 的 companion spawn 逻辑冲突，仅用于无 MOD 场景`
        )
      })
  } else {
    console.log(
      '[lilith-adapter] 使用 companion 桥接链路（默认）：LilithMod spawn 真 companion → provider 指向月蚀 62002'
    )
    // 清理月蚀可能残留的 runtime.json（避免干扰 LilithMod 的 companion 启动判断）
    // 注意：不删——真 companion 启动后会自己写。仅确保没有月蚀写的旧 runtime 残留。
    const rtPath = join(appDataDir, 'LilithAI', 'runtime.json')
    if (existsSync(rtPath)) {
      const rt = JSON.parse(readFileSync(rtPath, 'utf-8')) as { pid?: number }
      if (rt.pid === process.pid) {
        // 上次月蚀适配器写的残留 → 删除让 LilithMod 正常 spawn companion
        writeFileSync(rtPath, '{}', 'utf-8')
        console.log(
          '[lilith-adapter] 已清理月蚀残留 runtime.json（让 LilithMod 正常 spawn companion）'
        )
      }
    }
  }
  return lilithAdapter
}

/** 启动编排原子 ⑪c：莉莉丝 MOD 自启动（有游戏路径时拉起） */
async function initLilithAutoStart(config: ReturnType<typeof configStore['load']>) {
  // ===== 莉莉丝 autoStart：启动月蚀时自动拉起桌宠（配置开启 + MOD 完整时） =====
  // 设计来源：raw_memory 46.md 规划第 5 条（主进程启动钩子），此前未实现。
  // 游戏目录无效/MOD 缺失时静默跳过；launch 不等进程启动完成，故不阻塞月蚀启动。
  const lilithCfg = config.lilith
  if (lilithCfg?.autoStart && lilithCfg.gamePath) {
    if (lilithHasMod(lilithCfg.gamePath)) {
      // 原实现是 setTimeout(…, 3000) 才拉——但「等主窗口创建完再拉」这个理由不成立：
      // 主窗口在 initMainWindow 时就已经建好，这里早已在它之后，那 3 秒纯属固定白等
      // （用户感知就是「开月蚀后桌宠愣三秒才出」）。launch 本身不等进程启动完成、不阻塞月蚀启动，直接拉即可。
      void lilithLaunch(lilithCfg.gamePath)
        .then((r) => {
          if (r.ok) {
            console.log(
              r.alreadyRunning
                ? '[lilith-autoStart] 莉莉丝已在运行，跳过'
                : '[lilith-autoStart] 已自动启动莉莉丝桌宠'
            )
          } else {
            console.warn(`[lilith-autoStart] 启动失败: ${r.error ?? '未知错误'}`)
          }
        })
    } else {
      console.warn(`[lilith-autoStart] MOD 缺失，跳过自动启动（${redactUserPath(lilithCfg.gamePath)}）`)
    }
  }
}

/** 启动编排原子 ⑪d：api:port / api:token IPC（渲染进程取端口与访问令牌） */
function initApiPortIpc(port: number) {
  // 同步 IPC：渲染进程启动时需要立即拿到 API 端口建立 WebSocket
  ipcMain.on('api:port', (event) => {
    event.returnValue = port
  })
  // 同步 IPC：渲染进程连接 WS / fetch 受保护 HTTP API 需要令牌。
  // 为什么存在：WS 握手与 HTTP 鉴权都基于本进程随机令牌，只有主进程能签发；渲染进程
  // 经 preload 唯一合法获取，避免把令牌写进任何能被网页读取的全局存储。
  // 作用：把 server.ts 生成的 apiToken 原样回给调用方（API server 未启动时为空串）。
  ipcMain.on('api:token', (event) => {
    event.returnValue = getApiToken()
  })
}

/** 启动编排原子 ⑫a：DMN LLM + Supervisor（前端空闲判定/记忆工作流作用域/令牌预算注入/配置热跟随） */
function initSupervisor(opts: {
  dataPaths: ReturnType<typeof initDataDirectory>
  config: ReturnType<typeof configStore['load']>
  dmnToolRegistry: ReturnType<typeof createToolRegistry>
  baseCtx: ToolContext
  pathSyncMonitor: PathSyncMonitor | null
  userStore: UserStore
  workflowManager: WorkflowManager | null
  setWorkflowScope: (scope: MemoryScope | null) => void
}) {
  const { dataPaths, config, baseCtx, pathSyncMonitor, userStore, workflowManager, setWorkflowScope } = opts
  // 真 fiber 化守卫（G3）：monitor 服务未挂载（禁用/挂载失败）时跳过 Supervisor，
  // 记忆工作流/前端空闲门/激活链路降级不可用；before-quit 清理链已容忍 null
  if (!rootCtx.featurePlugins.isEnabled('monitor')) {
    console.warn('[supervisor] monitor 功能已禁用，Supervisor 跳过（记忆工作流/前端空闲门不可用）')
    return null
  }
  const tools = Array.from(opts.dmnToolRegistry.tools.values())
  // 文档 15.4：DMN 的 LLM 独立配置不跟随前端 AI。DMN 用独立 LLMClient 实例，
  // 避免与前端 AI 抢占同一本地模型推理资源（Ollama 默认串行 NUM_PARALLEL=1）
  // 注意：前端 AI 的 LLMClient 由 server.ts 内部创建，此处不创建（原 llmClient 是死代码已删除）
  // dmnLlm 服务记忆工作流 + DMN 评测。
const dmnLlmClient = new LLMClient(resolveLlmConfig(config.dmnLlm, config.llm))
  if (!dmnLlmClient.isReady()) {
    console.info(
      '[index] DMN LLM 未配置（model 为空且未跟随前端），DMN 后台任务不会执行 LLM 调用。请在设置中配置 DMN 模型或开启「跟随前端 AI 配置」以启用记忆系统。'
    )
  }
  // DMN 专用工具结果蒸馏器：独立于 server.ts 的 distiller（DMN 用独立 dmnLlmClient，
  // 与主会话/工作流隔离，避免 LLM 实例抢占与蒸馏递归回环）。语义与 server.ts 一致：
  // 用户配置优先、缺省回退单源默认；蒸馏失败重试一次仍失败保留原文。
  const dmnDistiller = new ToolResultDistiller(
    () => dmnLlmClient,
    () => ({ ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) })
  )
  // DMN/子 agent 蒸馏回调工厂：与 server.ts makeDistillCallbacks 同一合并形态，
  // DMN 评估与子 agent 内部工具结果同样先提炼再进上下文（一视同仁，不折叠不截断的原则不变）。
  const dmnDistillCallbacks = (): {
    distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
    distillIntentTurnPairs?: number
  } => {
    const dmnDistillCfg = { ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) }
    return {
      distillToolResult: async (toolName: string, _toolCallId: string, result: string, intent?: string) =>
        (await dmnDistiller.distill(toolName, result, intent)) ?? undefined,
      distillIntentTurnPairs: dmnDistillCfg.intentTurnPairs
    }
  }
  const monitorConfigDir = join(dataPaths.root, '.dmn_monitor')
  const supervisorCallbacks: SupervisorCallbacks = {
    onOutput: (dmnId, text) => {
      console.log(`[DMN ${dmnId}] ${text}`)
      safeSend(mainWindow, 'dmn:output', { dmnId, text })
    },
    onDmnStart: (dmnId) => {
      safeSend(mainWindow, 'dmn:start', { dmnId })
    },
    onDmnComplete: (dmnId) => {
      safeSend(mainWindow, 'dmn:complete', { dmnId })
    },
    onCrash: (dmnId, reason) => {
      console.error(`[DMN ${dmnId}] crash: ${reason}`)
      safeSend(mainWindow, 'dmn:crash', { dmnId, reason })
    },
    onContinueHint: (dmnId) => {
      safeSend(mainWindow, 'dmn:continueHint', { dmnId })
    },
    onStopped: (dmnId, reason) => {
      console.error(`[DMN ${dmnId}] stopped: ${reason}`)
      safeSend(mainWindow, 'dmn:stopped', { dmnId, reason })
    },
    onCycleStart: () => {
      safeSend(mainWindow, 'dmn:cycleStart', {})
    },
    onCycleComplete: () => {
      safeSend(mainWindow, 'dmn:cycleComplete', {})
    },
    onNoMemory: () => {
      safeSend(mainWindow, 'dmn:noMemory', {})
    },
    onConditionWait: (reason) => {
      safeSend(mainWindow, 'dmn:conditionWait', { reason })
    },
    onAskUser: (dmnId, question, context, sessionId) => {
      safeSend(mainWindow, 'dmn:askUser', {
        dmnId,
        question,
        context,
        sessionId
      })
      // 文档 15.2.1：后端协作——DMN 事件注入激活队列
      activationManager?.pushDmnEvent(`DMN-${dmnId} 请求关注：${question}（上下文：${context}）`)
    }
  }

  supervisor = rootCtx.monitor.initSupervisor(
    dataPaths,
    dmnLlmClient,
    tools,
    baseCtx,
    monitorConfigDir,
    pathSyncMonitor?.getErrorLog() ?? new ErrorLog(dataPaths.fileMonitorErrorLog),
userStore,
    supervisorCallbacks,
    timerRegistry,
    dmnDistillCallbacks
  )

  // 工作流引擎：注入 WorkflowManager 提供者（延迟访问，避免构造时序依赖）
  // MemoryWorkflowScheduler 通过此 provider 订阅工作流事件 + 启动记忆处理流水线实例
  // 必须在 supervisor.start() 之前注入：start() 会立即订阅事件，
  // 若 provider 为空则订阅失败 → wf:completed 事件无人接收 →
  // 进度不更新 + running 卡死 → 流水线停摆
  supervisor.setWorkflowManagerProvider(() => workflowManager)

  // 分层改造：把 setWorkflowScope 注入调度器（处理 RAW 批次时设置作用域，
  // 工作流 ctx.paths 动态解析落 {uid}/{aiId}/ 目录）
  supervisor.setMemoryWorkflowScopeSetter(setWorkflowScope)

  supervisor.start()

// 记忆工作流与前端 AI 共用 tokenBudget，保证上下文管理一致
  // 记忆工作流跨批次累积上下文，达到 tokenBudget 时 FIFO 截断
  supervisor.setTokenBudgetProvider(() => configStore.get().tokenBudget ?? 0)

  // 订阅配置变更，更新 LLM 客户端（替代 2 秒轮询）
  configStore.subscribe((newConfig, oldConfig) => {
    // followMain：比较 resolve 后的生效值（跟随前端时前端 llm 变化也触发更新）
    const newDmnCfg = resolveLlmConfig(newConfig.dmnLlm, newConfig.llm)
    const oldDmnCfg = resolveLlmConfig(oldConfig.dmnLlm, oldConfig.llm)
    if (JSON.stringify(newDmnCfg) !== JSON.stringify(oldDmnCfg)) {
      dmnLlmClient.updateConfig(newDmnCfg)
      console.log('[index] DMN LLMClient 已更新（配置变更）')
    }
    // 主题变更：同步 nativeTheme.themeSource，让原生 UI（滚动条/标题栏）匹配新主题
    // 浅色主题（霜璃/素笺）用 light，深色主题（夜幕/紫夜）用 dark
    if (newConfig.theme !== oldConfig.theme) {
      nativeTheme.themeSource =
        newConfig.theme === 'night' || newConfig.theme === 'violet-night' ? 'dark' : 'light'
    }
    // tokenBudget 变更：同步下发到记忆工作流调度器
    if (newConfig.tokenBudget !== oldConfig.tokenBudget) {
      supervisor?.setTokenBudgetProvider(() => newConfig.tokenBudget ?? 0)
    }
  })
  return supervisor
}

/** 启动编排原子 ⑫b：激活链路（前端空闲门 + 激活回调） */
function initActivationLink(activationManager: ActivationManager | null, supervisor: Supervisor) {
  const supervisorRef = supervisor

  // 外部事件激活链路：前端 AI 空闲时，外部事件（cron/健康检查/重启续接）可触发 AI 运行
  // 注：持续激活自动续接已移除，仅保留外部事件激活
  activationManager?.setFrontendIdleProvider(() => supervisorRef.isFrontendIdle())
  activationManager?.setActivationCallback(() => {
    if (supervisorRef.isFrontendIdle()) {
      const content = activationManager?.peekActivationContent(supervisorRef.activeSessionId ?? undefined) ?? null
      safeSend(mainWindow, 'activation:trigger', { content })
    }
  })
}

/** 启动编排原子 ⑫c：重启待办消费（受限目录更新后自动重试） */
function initRestartPendingConsumer(dataPaths: ReturnType<typeof initDataDirectory>, supervisor: Supervisor) {
  const supervisorRef = supervisor
  // 重启待办消费：AI 自我重启前写入的持久化标记，启动后唤醒 AI 自动续接
  // （"重启后自己激活自己"——不依赖内存态持续激活，进程重启后也能续上）
  //
  // 修复：不能启动后立即消费。原因——重启后前端渲染进程此时
  // 大概率还没连上 WebSocket、currentSessionId 还没恢复（loadSessions→selectSession
  // 是异步的），activation:trigger 事件发过去被前端 triggerActivation 守卫
  // （!currentSessionId || !ws || ws.readyState !== OPEN 直接 return）静默丢弃，
  // 且标记已被 consumeRestartPending 删除 → 永不重试 → "重启后没再次激活"。
  // 方案：轮询等待 supervisor.activeSessionId 非空（前端 selectSession/createSession
  // 成功后通过 dmn:setActiveSession 同步，意味着 ws 已连 + 会话已恢复），
  // 就绪后再消费注入；最多等 30s（30×1s），超时保留标记下次启动再试。
  const pendingDir = join(dataPaths.root, '.activation')
  let pendingWaitAttempts = 0
  const tryConsumeRestartPending = (): void => {
    if (supervisorRef.activeSessionId) {
      try {
        // 消费持久化标记，合成激活事件注入 AI：
        // 1. AI 自我重启待办（有则说明本次是 AI 重启续接）：待续接任务
        // 2. UI 运行监控 pending（上次运行有严重卡死/崩溃）：异常时间线
        // 注：启动感知不再走激活事件——lifecycle.json 由 buildInjectedMessages
        // 直接注入提示词末尾（静默信息，不打扰），见 restart-pending.ts。
        const pendingReason = consumeRestartPending(pendingDir)
        const uiEvents = uiHealthMonitor?.consumePendingEvents()

        if (pendingReason || uiEvents) {
          const parts: string[] = []
          if (pendingReason) {
            console.log(`[restart-pending] 检测到重启待办，注入激活事件: ${pendingReason}`)
            parts.push(`【重启续接】上次为 AI 自我重启，待续接：${pendingReason}`)
          }
          if (uiEvents) {
            console.log('[ui-health] 检测到上次运行 UI 异常事件，注入激活')
            parts.push(uiEvents)
          }
          activationManager?.pushExternalEvent(parts.join('\n'), true)
        }
      } catch (err) {
        console.error('[restart-pending] 消费标记失败:', err)
      }
      return
    }
    pendingWaitAttempts += 1
    if (pendingWaitAttempts >= 30) {
      console.warn('[restart-pending] 等待前端就绪超时（30s），保留标记下次启动再试')
      return
    }
    timerRegistry.setTimeout(tryConsumeRestartPending, 1000, 'restart-pending-wait-frontend')
  }
  tryConsumeRestartPending()
}

/** 启动编排原子 ⑬：健康检查 + 模块注册 + 前端系统清单生成 */
function initMonitoringAndCatalog(dataPaths: ReturnType<typeof initDataDirectory>) {
  // 健康检查（C 方案）：
  // 定时自检工作区代码（typecheck/test/lint/build），发现问题注入外部事件唤醒前端 AI 自主修复。
  // 防死循环：只在应用运行时启动（随主进程生命周期）、AlertGate 去重+冷却+连续失败上限、
  // 事件队列仅在 AI 空闲时触发。配置持久化到 {dataDir}/.health_check/config.json。
  // 模块注册表：全架构模块清单 + 运行时状态（健康检查报错同步标红，面板「模块监控」tab 展示）
  // 状态持久化到 {dataDir}/.health_check/module-status.json，AI 可直接 Read 文件查看模块监控状态
  moduleRegistry = new ModuleRegistry({
    statusFile: join(dataPaths.root, '.health_check', 'module-status.json')
  })
  if (rootCtx.featurePlugins.isEnabled('monitor')) {
    healthCheck = rootCtx.monitor.initHealthCheck({
      workDir: app.getAppPath(),
      // dataRoot：打包态 files 检查扫描目标 + dumpFullOutput 落盘目录（asar 内只读不可写）
      dataRoot: dataPaths.root,
      configDir: join(dataPaths.root, '.health_check'),
      activationManager,
      timerRegistry,
      moduleRegistry
    })
    healthCheck.start()
    console.log('[health-check] 已初始化')
  } else {
    console.warn('[health-check] monitor 功能已禁用，健康检查跳过')
  }

  // 系统构造清单：每次启动自动扫描内置模块文件头 @category/@summary 注释与插件 plugin.json，
  // 覆盖生成纯 MD 文档到 {dataDir}/system-catalog/，AI 可直接 Read 了解系统全貌。
  // 新增模块只需在新入口文件头写 @category/@summary，下次启动自动进清单；失败不影响启动。
  // 源码根解析：dev 用 app.getAppPath()（含 electron/main 源码），打包环境无源码时自动降级
  // （模块清单不可用、插件清单照常），与 promptsDir 的 dev/packaged 探测思路一致。
  try {
    regenerateSystemCatalog(resolveCatalogSourceRoot(app.getAppPath()), dataPaths.root)
  } catch (err) {
    console.error('[system-catalog] 生成失败:', (err as Error).message)
  }
  return { moduleRegistry, healthCheck }
}

/** 启动编排原子 ⑭a：IPC handlers 巨型注入 + 多实例 IPC 注册 */
function initIpcLayer(state: {
  mainWindow: BrowserWindow
  dataPaths: ReturnType<typeof initDataDirectory>
  workflowManager: WorkflowManager | null
  dmnSkillLoader: SkillLoader
  skillMarket: SkillMarket | null
  pluginLoader: PluginLoader | null
  cronScheduler: ReturnType<typeof rootCtx['cron']['create']> | null
  internalSessionStore: InternalSessionStore
}) {
  const { mainWindow, dataPaths, workflowManager, dmnSkillLoader, skillMarket, pluginLoader, cronScheduler, internalSessionStore } = state
  // 记忆流水线保持恒并行：前端对话/持续激活时照常取批次跑记忆工作流。

  registerAllIpcHandlers(ipcMain, {
    configStore,
    sessionStore,
    mainWindow,
    getUserStore: () => userStore,
    getSupervisor: () => supervisor,
    getPathSyncMonitor: () => pathSyncMonitor,
    getHealthCheck: () => healthCheck,
    getModuleRegistry: () => moduleRegistry,
    getActivationManager: () => activationManager,
    getDataPaths: () => dataPaths,
    getMcpClientManager: () => mcpClientManager,
    getWorkflowManager: () => workflowManager,
    // 复用 dmnSkillLoader（与前端 AI / DMN 共用同一套 Skills）
    getSkillLoader: () => dmnSkillLoader,
    // Skill 市场（skill:market-* 通道用）
    getSkillMarket: () => skillMarket,
    // 莉莉丝：用户点「启动莉莉丝桌宠」前补同步一次 MOD 配置（见 runLilithBridgeNow 的不删理由）
    onLilithBeforeLaunch: runLilithBridgeNow,
    // 模块系统：PluginLoader（plugin:list/toggle 用）
    getPluginLoader: () => pluginLoader,
    // 阶段 4：内核功能插件对象表（featurePlugins:list/toggle 用）
    getFeaturePlugins: () => rootCtx.featurePlugins,
    // Cron 调度器（cron:list/upsert/delete/toggle 用，新版 cron/scheduler.ts）
    getCronService: () => cronScheduler,
    // 认证成功后：分系统注册/登录完成 → 补启同步（幂等；启动时已启则跳过）
    // 同时加载并监听技能：SkillLoader/SkillMarket 在启动早期（未登录阶段）仅构造，
    // 未登录不调用 load()/startWatching()（系统强制登录后才可用，无守卫回退）；
    // 登录成功后在此按当前 uid/aiId 分层路径统一加载并热监听，
    // 保证已装技能立即可见（路径分层/未登录兜底修复）。
    // 莉莉丝三件套也在此启动（原在 whenReady 登录前启动）：
    // 系统强制登录后才可用，未登录阶段不拉起桌宠/不写 MOD 配置/不建适配器，
    // 登录成功后才允许触发这些外部副作用；lilithStarted 幂等守卫防止重复登录重复启动。
    onAuthSuccess: () => {
      void multiInstance.startSync()
      dmnSkillLoader.load()
      dmnSkillLoader.startWatching()
      if (!lilithStarted && lilithEnabled(configStore)) {
        lilithStarted = true
        const lilithConfig = configStore.get().lilith
        // 「随月蚀启动」开关（config.lilith.autoStart）同时管住桥接的冷启动执行：
        // 关闭时整条桥接（写 %APPDATA%\LilithAI\config.json + 探测/reload companion）一律不执行——
        // 关了开关却仍去改写外部程序的配置、并探测一个没在跑的进程，会打出「失败」这种假警报。
        // 用户主动启动桌宠时的补同步走 runLilithBridgeNow()。
        if (lilithConfig?.autoStart === true) void initLilithBridge(apiPortForLilithBridge)
        lilithAdapter = initLilithAdapter(configStore.get(), dataPaths)
        void initLilithAutoStart(configStore.get())
      }
    },
    // 评测：按需构造 EvalHarness（首次访问时创建，跟随 config 更新）
    // 按 suite 名选择：dmn-regression 用后端 DMN 配置（config.dmnLlm），
    // 其他用前端 AI 配置（config.llm）
    getEvalHarness: (suite?: string) => {
      // DMN 评测：用后端 DMN 的 LLM 配置和工具集，真正评测 DMN 能力
      if (suite === 'dmn-regression') {
        if (!dmnEvalHarness) {
          const dmnEvalLlmClient = new LLMClient(
            resolveLlmConfig(configStore.get().dmnLlm, configStore.get().llm)
          )
          const evalConfig = configStore.get().eval
          const judgeConfig = evalConfig?.judge
          let judgeLlmClient: LLMClient | undefined
          if (judgeConfig?.baseURL && judgeConfig?.apiKey) {
            const baseLlm = resolveLlmConfig(configStore.get().dmnLlm, configStore.get().llm)
            judgeLlmClient = new LLMClient({
              ...baseLlm,
              provider: judgeConfig.provider ?? baseLlm.provider,
              baseURL: judgeConfig.baseURL,
              apiKey: judgeConfig.apiKey,
              model: judgeConfig.model ?? baseLlm.model,
              temperature: 0
            })
          }
          configStore.subscribe((newConfig, oldConfig) => {
            // followMain：比较 resolve 后的生效值
            const newCfg = resolveLlmConfig(newConfig.dmnLlm, newConfig.llm)
            const oldCfg = resolveLlmConfig(oldConfig.dmnLlm, oldConfig.llm)
            if (JSON.stringify(newCfg) !== JSON.stringify(oldCfg)) {
              dmnEvalLlmClient.updateConfig(newCfg)
            }
          })
          dmnEvalHarness = createEvalHarness({
            llmClient: dmnEvalLlmClient,
            configStore,
            // DMN 评测用 DMN 工具集（含 create_memory/nng_graph 等 DMN 专属工具）
            // 直接注入：工具 schema 直接注入，无 call_tool 间接层（onDemand 已退役）
            createToolRegistry: (ctx) =>
              createToolRegistry(ctx, {
                mcpClientManager: mcpClientManager ?? undefined
              }),
            judgeLlmClient
          })
        }
        return dmnEvalHarness
      }
      // 前端 AI 评测（默认）
      if (!evalHarness) {
        // 评测前端 AI 能力，用前端 AI 的 LLM 配置构造独立 LLMClient
        // 不复用 server.ts 内部实例（那里是私有的且与 WS 流式耦合）
        const evalLlmClient = new LLMClient(configStore.get().llm)
        // judge 独立 provider 配置：配置了 baseURL+apiKey 时创建独立 LLMClient 防 SPB
        // 未配置则回退到 evalLlmClient（仅 model 名不同，provider 相同）
        // 注：judgeLlmClient 在 Harness 首次构造时确定，后续 judge provider 从无到有
        // 需重启应用生效（updateConfig 仅更新已有实例，不能从 undefined 创建）
        const evalConfig = configStore.get().eval
        const judgeConfig = evalConfig?.judge
        let judgeLlmClient: LLMClient | undefined
        if (judgeConfig?.baseURL && judgeConfig?.apiKey) {
          const baseLlm = configStore.get().llm
          judgeLlmClient = new LLMClient({
            ...baseLlm,
            // 显式覆盖：避免 judgeConfig.provider=undefined 覆盖 baseLlm.provider
            provider: judgeConfig.provider ?? baseLlm.provider,
            baseURL: judgeConfig.baseURL,
            apiKey: judgeConfig.apiKey,
            model: judgeConfig.model ?? baseLlm.model,
            temperature: 0
          })
        }
        // 配置变更时同步更新 LLMClient
        configStore.subscribe((newConfig, oldConfig) => {
          if (JSON.stringify(newConfig.llm) !== JSON.stringify(oldConfig.llm)) {
            evalLlmClient.updateConfig(newConfig.llm)
          }
          // judge provider 独立配置变更时同步更新 judgeLlmClient
          // 仅更新已有实例（从有到有），从无到有需重启应用
          const oldJudge = oldConfig.eval?.judge
          const newJudge = newConfig.eval?.judge
          if (
            JSON.stringify({ ...oldJudge }) !== JSON.stringify({ ...newJudge }) &&
            judgeLlmClient &&
            newJudge?.baseURL
          ) {
            // 显式过滤 undefined，避免 newJudge.provider=undefined 覆盖 newConfig.llm.provider
            judgeLlmClient.updateConfig({
              ...newConfig.llm,
              ...(newJudge.provider ? { provider: newJudge.provider } : {}),
              ...(newJudge.baseURL ? { baseURL: newJudge.baseURL } : {}),
              ...(newJudge.apiKey ? { apiKey: newJudge.apiKey } : {}),
              model: newJudge.model ?? newConfig.llm.model,
              temperature: 0
            })
          }
        })
        evalHarness = createEvalHarness({
          llmClient: evalLlmClient,
          configStore,
          // 评测直接注入工具 schema（onDemand 两步机制已退役）
          createToolRegistry: (ctx) =>
            createToolRegistry(ctx, {
              mcpClientManager: mcpClientManager ?? undefined
            }),
          judgeLlmClient
        })
      }
      return evalHarness
    },
    workspaceConfigPath: () => getDefaultWorkspaceConfigPath(),
    // 共享内部会话存储（前端内部会话面板：列表/详情/CRUD）
    getInternalSessionStore: () => internalSessionStore
  })
  // 主分系统 IPC（角色状态/接入配置/管理窗口代理）
  multiInstance.registerIpc(ipcMain, {
    getUserStore: () => userStore,
    getMainWindow: () => mainWindow
  })
}

/** 启动编排原子 ⑭b：悬浮窗 + 浏览器视图面板 */
function initOverlayAndBrowserView(mainWindow: BrowserWindow) {
  // 聊天悬浮小窗（独立置顶 BrowserWindow，可拖到桌面）
  setOverlayMainWindow(mainWindow)
  registerOverlayIpc()
  // 浏览器面板：WebContentsView 嵌入主窗口 + IPC 控制接口
  browserViewManager.attachWindow(mainWindow)
  // useSystemBrowser：把 config.browser.useSystemBrowser 接进浏览器单例——
  // true 时弃内置浏览器视图，导航/外链一律转系统默认浏览器（openExternal，不注入/不操作）
  browserViewManager.useSystemBrowserGetter = () =>
    !!configStore.getEffective().browser?.useSystemBrowser
  // 内置浏览器外部网页定位策略：读 config.browser.geolocationPolicy（undefined/'deny'=拒绝，
  // 'allow'=用户显式开启后放行 geolocation）。策略变化后新建的外部网页视图立即生效。
  browserViewManager.geolocationPolicyGetter = () =>
    configStore.getEffective().browser?.geolocationPolicy ?? 'deny'
  registerBrowserIpcHandlers(ipcMain, configStore)
}

/** 启动编排原子 ⑭c：HumanGrader + 工作区 IPC + 代码沙箱 IPC */
function initEndgameIpc() {
  // 验证层：实例化 HumanGrader（注册 eval:submitHumanGrade IPC handler）
  // 用于人工评分校准：前端 EvalPanel 调用 evalSubmitHumanGrade 提交人工标注
  humanGrader = new HumanGrader()
  // 工作区状态：前端文件预览打开/关闭时推送路径，供 AI 上下文注入
  ipcMain.handle('workspace:setPreviewFile', (_e, path: string | null) => {
    try {
      setWorkspacePreviewFile(path)
      return { ok: true }
    } catch (err) {
      logError('ipc:workspace:setPreviewFile', err)
      return { ok: false, error: (err as Error).message }
    }
  })
  // 工作区状态：前端文件工坊代码执行完成后推送结果，供 AI 上下文注入
  ipcMain.handle('workspace:setSandboxState', (_e, state: {
    language: string
    code: string
    ok: boolean
    durationMs: number
    timedOut: boolean
    outputSummary: string
  } | null) => {
    try {
      setWorkspaceSandboxState(state)
      return { ok: true }
    } catch (err) {
      logError('ipc:workspace:setSandboxState', err)
      return { ok: false, error: (err as Error).message }
    }
  })
  // 代码沙箱：JS vm + Python 子进程 + 流式输出
  registerCodeSandboxIpcHandlers(ipcMain)
}

/** 启动编排原子 ⑭d：配置变化推前端 */
function initConfigChangedPush(mainWindow: BrowserWindow) {
  // config 变化推送到前端：AI 通过 update_ai_name 等工具改 config 后，
  // 前端 appStore.config 需要同步刷新，否则 Settings 页显示旧值，用户保存还会覆盖 AI 的修改。
  // （update_abyss_md 改写 ABYSS AI.md 文件，不触发 config 变更推送）
  // ConfigStore.save 时触发 subscribe，主进程转发 'config:changed' 事件到渲染进程。
  configStore.subscribe((newConfig) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config:changed', newConfig)
    }
  })
}

/** 启动编排原子 ⑭e：窗口激活重建（macOS） */
function initActivateHandler() {
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
  mainWindow = createWindow()

  // 渲染进程桥接：让工具能向前端窗口发送 IPC 事件
  setRendererBridge((channel, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
  })
      // 窗口重建后重新挂载 UI 缩放（新 webContents 实例，幂等重注册 IPC）
      try {
        initUiZoom(mainWindow, configStore)
      } catch (err) {
        logError('ui-zoom.attach', err)
      }
      // 窗口重建后重新挂载 UI 监控（新 webContents 实例）
      try {
        if (mainWindow && uiHealthMonitor) {
          uiHealthMonitor.attach(mainWindow)
        }
      } catch (err) {
        logError('ui-health.attach', err)
      }
    }
  })
}

app
  .whenReady()
  .then(async () => {
    // 单实例锁屏保：非主实例（已有实例在运行）不执行任何启动初始化。
    // 关键约束：app.quit()（上方 lock 失败分支）不会阻止 ready 事件触发，
    // 若 here 继续跑 initRuntime/initMainWindow/LAN 等，会在退出过程中
    // 留下未收尾的原生句柄 → `FATAL ERROR: Error::ThrowAsJavaScriptException`（exit 134）。
    // 主实例（primaryInstance=true）流程逐字节不变。
    if (!primaryInstance) {
      console.log('[single-instance] 已有实例在运行，本进程不初始化并退出')
      app.exit(0)
      return
    }

    // ===== 启动编排：服务初始化按域收敛（每个 initXxx 返回该域句柄，
    // 模块级 let 由返回值在下方赋值——onBeforeQuit / IPC 等模块级闭包绑定不变） =====

    const { config, resolvedDataDir } = await initRuntime()

    // 权限请求默认拒绝；仅对「受信的应用本地窗口」放行 geolocation。
    // 系统级定位（navigator.geolocation → Windows 定位服务）由 GeoLocationService 的
    // system-position 提供者在主窗口渲染层调用，是唯一需要该权限的合法路径。
    // 隐私红线：不得全局放行 geolocation——内置浏览器面板承载的外部网页使用独立
    // partition（见 browser-view-manager），不落 defaultSession，且此处按 webContents
    // 的身份（本地渲染层 origin）而非权限名判定，任何外部网页都拿不到系统定位。
    const isTrustedAppWebContents = (wc?: Electron.WebContents): boolean => {
      if (!wc || wc.isDestroyed()) return false
      const url = wc.getURL()
      // 生产态本地渲染层（主窗口 / overlay 浮层），origin 为 file://
      if (url.startsWith('file://')) return true
      // 开发态 vite dev server（ELECTRON_RENDERER_URL 指向本机渲染层入口）
      const devUrl = process.env['ELECTRON_RENDERER_URL']
      return !!devUrl && url.startsWith(devUrl)
    }
    // 防御式调用（可选增强）：session/defaultSession 缺失时（如单测 mock 环境）静默跳过，不阻断启动链。
    try {
      session?.defaultSession?.setPermissionRequestHandler?.((wc, permission, callback) => {
        callback(permission === 'geolocation' && isTrustedAppWebContents(wc))
      })
    } catch {
      // 权限 handler 设置失败不影响启动（无系统定位时 GeoLocationService 保留既有缓存、不触网）
    }

    mainWindow = initMainWindow()

    const userState = await initUserDirsAndMulti(resolvedDataDir)
    const dataPaths = userState.dataPaths
    userStore = userState.userStore
    multiInstance = userState.multiInstance

    // 真 fiber 化（P1-A G3）：功能服务异步挂载为独立 Cordis fiber。
    // 位置约束：必须在 setPathContext（initUserDirsAndMulti 内）之后——mountAll 需重读状态文件；
    // 必须在 initPathSync 之前——该处及以下调用点依赖功能服务已就绪。
    // 按状态文件逐项 `ctx.plugin()` 挂载；禁用项不挂载，以下各 initXxx 内守卫跳过/降级。
    const mountResults = await mountFeatureServices(rootCtx)
    if (mountResults.some((r) => !r.ok)) {
      console.error(
        '[cordis-runtime] 部分功能服务挂载失败：',
        mountResults.filter((r) => !r.ok).map((r) => `${r.id}(${r.error})`).join(', ')
      )
    } else {
      console.log(`[cordis-runtime] 功能服务挂载完成（${mountResults.length} 项）`)
    }

    try {
      pathSyncMonitor = await initPathSync(dataPaths, multiInstance)
    } catch (err) {
      // 路径同步监控失败非致命：会话切换/记忆同步依赖它的功能降级，不影响主启动链
      logError('path-sync.init', err)
    }
    initSandboxCoeffect(dataPaths)
    activationManager = initActivation(dataPaths)

    const monitorState = initMonitorsAndCron(dataPaths, activationManager)
    const cronScheduler = monitorState.cronScheduler
    uiHealthMonitor = monitorState.uiHealthMonitor
    autoCleanup = monitorState.autoCleanup

    const kernelState = await initKernelExtensions()
    const pluginLoader = kernelState.pluginLoader
    mcpClientManager = kernelState.mcpClientManager
    detachCordis = kernelState.detachCordis

const hookSkillState = initHooksSkills(dataPaths)
    const dmnHookManager = hookSkillState.dmnHookManager
    const dmnSkillLoader = hookSkillState.dmnSkillLoader
    const skillMarket = hookSkillState.skillMarket

    // 市场 × 局域网接线：主/分系统与单机共享同一个上传市场 ——
    // 上传/下架经本地 manifest 落位后广播给在线对端，离线对端上线时经
    // syncWant/replay 增量补齐；分系统删除权限按上传者本人收敛（见 market.ts
    // canDeleteUpload：主系统/单机可删任意，分系统仅可删自己上传的）。
    // registerLanCallbacks 为单槽回调，这里只注册一次；standalone 无 LAN 时
    // getLanStatus().peers 为空、sendLan 未启动，setLanDeps 的三个注入仍安全。
    if (skillMarket) {
      skillMarket.setLanDeps({
        getRole: () => multiInstance.getRole(),
        sendLan: (uid, type, payload) => multiInstance.sendLan(uid, type, payload),
        listPeers: () => multiInstance.getLanStatus().peers
      })
      multiInstance.registerLanCallbacks({
        onMessage: (env) => skillMarket?.handleLanEnvelope(env),
        onPeerStatus: (ev) => skillMarket?.handlePeerStatus(ev)
      })
    }

    // ---- 组合点 A：工作流作用域声明（baseCtx / workflow ctx 闭包延迟引用） ----
    // L8 工作流引擎：workflowManager 声明提前（baseCtx 需注入 getter，闭包延迟引用）
    // 实际初始化在下方 WorkflowManager 构造时赋值
    let workflowManager: WorkflowManager | null = null

    // 当前工作流作用域：记忆调度器处理某 (uid, aiId) 的 RAW 批次时设置，
    // workflowCtx.paths getter 据此解析作用域路径（工作流无登录态，靠 RAW 路径推断归属）
    // 提供给调度器设置（避免循环依赖：调度器在下方构造，此处闭包引用）
    const setWorkflowScope = (scope: MemoryScope | null): void => {
      console.debug(`[wf-scope-diag] SET scope=${scope ? scope.uid + '/' + scope.aiId : 'null'}`)
      currentWorkflowScope = scope
    }
    // ---- 权限桥接（组合点 B 的前置）：协议实现已抽到 ipc/permission-bridge.ts ----
    // 为什么在编排内构造：窗口/AI 重启标记/落盘根目录/重启入口都是 index.ts 持有的
    // 进程级状态与路径，必须以 getter/setter 注入；桥接自身不持有任何状态。
    // 不删理由：baseCtx 的 requestPermission / requestAppRestart 两个字段由它提供，
    // 删除则所有需用户授权的工具（灰名单命令 / 系统设置 / 读剪贴板 / 技能与插件管理）
    // 的 fail-closed 判断失效——它们以「回调是否存在」判定是否需要授权。
    const permissionBridge = createPermissionBridge({
      // 取「当前主窗口自己的 IPC 通道」：窗口不存在/已销毁 → 返回 null，桥接立即 fail-closed。
      // 为什么用 webContents.ipc 而不是全局 ipcMain：WebContents.ipc 天然把应答监听限定在本
      // 窗口的 webContents 上，既不会跨窗口串话，也不会随多次授权在 ipcMain 上累积监听器。
      // （依据 Electron 官方 security 指南第 17 条：必须校验 IPC 发送方；配合桥接内的
      // 主 frame 守卫构成两层防线。详见 ipc/permission-bridge.ts 文件头「安全约束」）
      getChannel: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return null
        const wc = mainWindow.webContents
        return { send: (channel, payload) => wc.send(channel, payload), ipc: wc.ipc }
      },
      isGreenlight,
      setAiRestarting: (restarting) => {
        aiRestarting = restarting
      },
      // 重启待办落盘位置由 index.ts 决定（dataPaths 派生），待办文本由桥接给出
      writePending: (text) => writeRestartPending(join(dataPaths.root, '.activation'), text),
      // 重启入口沿用既有标签文案（restartApp 内部据此记日志并区分 dev/打包分支）
      restartApp: (reason) => restartApp(`AI 自我重启: ${reason}`)
    })

    // ---- 组合点 B：前端 AI 工具上下文（baseCtx，服务间引用密集，保留在编排内组装） ----
    // 前端 AI 工具作用域：paths 动态 getter——每次访问按
    // 「当前登录用户 + AI 编号 1（月蚀）」解析，工具自动落
    // memory/U{uid}/AI{aiId}、NNG/AI{aiId}/U{uid}、cache/AI{aiId}/U{uid} 各域。
    // 系统强制登录后才可用：未登录（getCurrentUser 为 null）时禁止解析（抛错）。
    const baseCtx: ToolContext = {
      skillLoader: dmnSkillLoader,
      // 注入 WorkflowManager getter，workflow_* 工具通过此访问
      getWorkflowManager: () => workflowManager,
      // 注入 hookManager，DMN 工具执行经 executeTool 触发 PreToolUse/PostToolUse
      hookManager: dmnHookManager,
      // 注入插件加载器 getter，plugin_manage 工具通过此访问
      getPluginLoader: () => pluginLoader,
      getModuleRegistry: () => moduleRegistry,
      // 注入 cron 调度器 getter：复用 index.ts 已创建的实例（单例），
      // 避免 server.ts 再创建第二个实例导致双 tick + fs.watch 不可靠 → 删任务后仍触发
      getCronScheduler: () => cronScheduler,
      // 注入局域网多实例服务 getter：friend_manage / chat_room_manage / publish_board_manage
      // 三个工具据此读写好友簿/聊天室/公示板（不同月蚀实例之间互相交流）
getMultiInstance: () => multiInstance ?? null,
      // 注入设备管理器 getter（ 设备接入基底：device_scan/device_register/device_call 访问）
      getDeviceManager: () => deviceManager,
      // 注入 skillLoader，DMN 可通过 use_skill 工具加载 Skills
      handleAccessed: (path: string) => {
        pathSyncMonitor?.handleAccessed(path)
      },
      // 权限请求：协议实现见 ipc/permission-bridge.ts（本文件只做装配）
      requestPermission: permissionBridge.requestPermission,
      // AI 自我重启授权：协议实现见 ipc/permission-bridge.ts（本文件只做装配）
      requestAppRestart: permissionBridge.requestAppRestart
    }

    // 前端 AI 工具作用域：paths 动态 getter——每次访问按
    // 「当前登录用户 + 当前活跃会话所属 AI」解析，工具自动落相应记忆域。
    // aiId 动态解析（对齐 server.resolveSessionAiId：会话 aiId 合法则用之，否则回退 1=月蚀）。
    // 未登录（getCurrentUser 为 null）即程序错误：系统强制登录后才可用，抛错暴露。
    // ⚠️ 必须用 Object.defineProperty（构造字面量里写 paths 会固化成静态值）
    Object.defineProperty(baseCtx, 'paths', {
      get: () => {
        const u = userStore?.getCurrentUser()
        if (!u) {
          throw new Error('[paths] 未登录态禁止解析工具作用域 paths：系统要求先登录')
        }
        const sessionId = supervisor?.activeSessionId
        let aiId = DEFAULT_AI_ID
        if (sessionId) {
          try {
            const sAiId = sessionStore?.get(sessionId)?.aiId
            aiId = typeof sAiId === 'number' && Number.isInteger(sAiId) && sAiId >= 1 ? sAiId : DEFAULT_AI_ID
          } catch {
            /* 会话不可读时回退 1=月蚀 */
          }
        }
        return resolveScopePaths(dataPaths, { uid: u.UID, aiId })
      },
      enumerable: true,
      configurable: true
    })
    // ---- 组合点 C：统一工具池（DMN 全量工具注册） ----
    // 统一工具池：DMN 与前端 AI 共用 createToolRegistry，按 policy 配置差异化启用
    // DMN 直接注入工具 schema（onDemand 两步机制已退役：AI 反复出现 call_tool 参数错误，
    // 直接注入让 AI 直接调用工具，每次调用从 2 轮降到 1 轮）
      // 传入 mcpClientManager，MCP 工具合并到统一工具池；pluginLoader 提供插件工具
    const dmnToolRegistry = createToolRegistry(baseCtx, {
      agent: 'dmn',
      mcpClientManager: mcpClientManager ?? undefined,
      pluginTools: pluginLoader?.getTools() ?? []
    })

const wfState = initWorkflowEngine({ dataPaths, mcpClientManager, pluginLoader, dmnSkillLoader })
    workflowManager = wfState.workflowManager

    // 设备接入基底：初始化注册表持久化目录（{root}/device-registry.json），
    // device_scan/device_register/device_call 经 baseCtx.getDeviceManager() 访问同一单例
    deviceManager.init(dataPaths.root)

    const internalSessionStore = initInternalSessionStore()

    const port = await initApiServer({
      userStore,
      activationManager,
      baseCtx,
      dataPaths,
      mcpClientManager,
      pluginLoader,
      internalSessionStore,
      multiInstance
    })
    initMultiInstanceAi(multiInstance)
    collaborationScheduler = initCollaborationScheduler(activationManager, multiInstance, userStore)
    // 莉莉丝链路已移至 onAuthSuccess（登录成功后）启动——系统强制登录后才可用，
    // 未登录阶段不写 MOD 桥接、不启适配器、不拉起桌宠；此处仅保留端口记录供桥接使用。
    apiPortForLilithBridge = port
    initApiPortIpc(port)

    supervisor = initSupervisor({
      dataPaths,
      config,
      dmnToolRegistry,
      baseCtx,
      pathSyncMonitor,
      userStore,
      workflowManager,
      setWorkflowScope
    })
    if (supervisor) {
      initActivationLink(activationManager, supervisor)
      initRestartPendingConsumer(dataPaths, supervisor)
    } else {
      console.warn('[index] supervisor 未初始化，激活链路/重启待办消费跳过')
    }

    const monCat = initMonitoringAndCatalog(dataPaths)
    moduleRegistry = monCat.moduleRegistry
    healthCheck = monCat.healthCheck

    initIpcLayer({
      mainWindow,
      dataPaths,
      workflowManager,
      dmnSkillLoader,
      skillMarket,
      pluginLoader,
      cronScheduler,
      internalSessionStore
    })
    initOverlayAndBrowserView(mainWindow)
    initEndgameIpc()
    initConfigChangedPush(mainWindow)
    initActivateHandler()
  })
  .catch((err) => {
    // M7：初始化失败时不能静默——窗口可能已打开但无 API server / 无 IPC handler，
    // 应用处于不可用的残破状态。记录日志 + 弹窗告知用户 + 退出，避免用户面对无响应界面。
    logError('app.whenReady', err)
    console.error('[main] app.whenReady initialization failed:', err)
    dialog.showErrorBox(
      '月蚀启动失败',
      `应用初始化过程中发生错误，无法继续运行：\n\n${(err as Error)?.message ?? String(err)}\n\n请查看日志文件：{userData}/logs/main-errors.log\n请联系开发者或重启应用。`
    )
    app.quit()
  })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let quitting = false
async function onBeforeQuit(event: Electron.Event): Promise<void> {
  // 防重入：用户快速连点关闭或系统重复触发时，避免清理逻辑并发执行
  if (quitting) {
    event.preventDefault()
    return
  }
  quitting = true
  // 文档 15.5：应用退出时清理所有资源，避免端口/句柄泄漏
  // 阻止默认退出流程，等异步清理完成后再退出（避免定时器/句柄泄漏）
  event.preventDefault()

  // 每个清理步骤独立 try/catch：任一步骤抛错不阻塞后续步骤，
  // 确保 app.quit() 必执行（原实现无 try/catch，单步抛错会导致应用永久挂死）
  const safe = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      logError('onBeforeQuit:' + label, err)
    }
  }

  // 生命周期记录：关闭时间 + 原因（AI 自我重启 vs 用户关闭）
  // 必须最先写——即使后续清理失败，AI 也能从提示词知道上次何时关闭
  try {
    if (lifecycleActivationDir) {
      recordShutdown(lifecycleActivationDir, aiRestarting ? 'ai-restart' : 'user-quit')
    }
  } catch (err) {
    console.error('[lifecycle] 写入关闭记录失败:', err)
  }

  // 权限绿通保底：用户完全关闭（非 AI 自我重启）→ 重置绿通为 false
  // AI 自我重启（aiRestarting=true）→ 保留绿通（新进程继续可用）
  // 这样即使 AI 抽风无限重启，只要用户手动关闭应用，下次打开绿通自动关闭
  if (!aiRestarting && isGreenlight()) {
    await safe('greenlight.reset', () => {
      const cfg = configStore.get()
      configStore.save({ ...cfg, permissionGreenlight: false })
      console.log('[greenlight] 用户完全关闭应用，权限绿通已重置为 false')
    })
  }

  await safe('supervisor.stop', () => supervisor?.stop())
  await safe('multiInstance.stopSync', () => multiInstance?.stopSync())
  await safe('multiInstance.stopLan', () => multiInstance?.stopLan())
  await safe('healthCheck.stop', () => healthCheck?.stop())
  await safe('uiHealthMonitor.stop', () => uiHealthMonitor?.stop())
  await safe('pathSyncMonitor.stop', () => pathSyncMonitor?.stop())
  await safe('collaborationScheduler.stop', () => collaborationScheduler?.stop())
  await safe('activationManager.stop', () => activationManager?.stop())
  await safe('autoCleanup.stop', () => autoCleanup?.stop())
  await safe('sessionStore.flush', () => sessionStore.flush())
  // 关闭 API server（HTTP + WebSocket）
  await safe('closeApiServer', () => closeApiServer())
  // 关闭莉莉丝协议适配器（释放 6186 端口）
  if (lilithAdapter) {
    await safe('lilithAdapter.stop', () => lilithAdapter!.stop())
    lilithAdapter = null
  }
  // 销毁浏览器视图（关闭 webContents 防止泄漏）
  await safe('browserViewManager.destroyView', () => browserViewManager.destroyView())
  // 断开所有 MCP server 连接（关闭子进程 / HTTP 连接）
  await safe('mcpClientManager.disconnectAll', () => mcpClientManager?.disconnectAll())
  // 沙箱 coeffect 句柄回滚（移除服务提供，触发依赖方重载回退）
  await safe('sandboxCoeffect.dispose', () => sandboxCoeffectHandle?.dispose())
  // 卸载全部已挂载 Cordis 模块（逆序卸载，清理 fiber 副作用）
  await safe('detachCordis', () => detachCordis?.())

  // 统一清理所有定时器（带 5 秒超时保护，避免某个 stop 卡住退出流程）
  await safe('timerRegistry.stopAll', () => timerRegistry.stopAll())

  // 清理完成，移除监听器并退出（避免循环触发 before-quit）
  app.removeListener('before-quit', onBeforeQuit)
  app.quit()
}

app.on('before-quit', onBeforeQuit)