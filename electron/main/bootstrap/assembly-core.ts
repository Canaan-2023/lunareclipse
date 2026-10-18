/**
 * @category 核心
 * @summary 启动装配原子 ①②③④⑤：运行期基础、主窗口、用户域与多实例、路径同步、沙箱、激活、监控与 cron
 *
 * 为什么存在：这七个原子此前平铺在 `index.ts`（约 315 行），是「基础域装配」——窗口 / 用户域 /
 * 多实例 / 沙箱 / 激活 / 监控与定时器，彼此有**严格先后**（见各原子头注释里的位置约束）。
 * 抽成独立模块后，装配顺序作为模块内的阅读顺序显式可见，而入口只保留编排（ADR-01 第 3 步）。
 *
 * 什么作用：导出七个 `initXxx`，由 `service-assembly.ts` 按序调用；`state` 与 `deps` 显式传入。
 *
 * 不删理由：删掉即这 315 行退回 `index.ts`，入口重新同时承担「编排」与「域装配」两种职责。
 *
 * 顺序约束（迁移后仍必须按此调用，判据见各原子注释）：
 * `initRuntime` → `initMainWindow` → `initUserDirsAndMulti` → （`mountFeatureServices`）→
 * `initPathSync` → `initSandboxCoeffect` → `initActivation` → `initMonitorsAndCron`。
 */
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import { CURRENT_INSTANCE_NAME, IS_CUSTOM_INSTANCE } from './runtime-paths'
import type { BaseDataPaths } from '../models/paths'
import { app, nativeTheme } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { resolveBundledAsset } from '../utils/app-root'
import { createWindow } from '../window'
import { initUiZoom } from '../ui-zoom'
import { initDataDirectory } from '../models/data-init'
import { UserStore } from '../models/user-store'
import { setPathContext, DEFAULT_AI_ID } from '../models/path-context'
import { ensureUserScopeSkeleton } from '../services/user-scope-skeleton'
import { resolveScopePaths, resolveDataDir, DATA_DIR_MARKER } from '../models/paths'
import { kernelRegistry, coeffectRegistry } from '../kernel'
import { buildConfigTreeLayers } from '../kernel/config-layer'
import { UiHealthMonitor } from '../monitor/ui-health-monitor'
import { closeOverlayWindow } from '../overlay-window'
import { closeRoomWindow } from '../room-window'
import { ActivationManager } from '../api/activation-manager'
import { recordStartup } from '../api/restart-pending'
import { initMediaProtocol } from '../api/gen/media-protocol'
import { initSandboxEnv } from '../services/sandbox-env'
import { setDefaultWorkspacePath } from '../services/workspace-config'
import { logError } from '../services/crash-logger'
import { runJavaScript, runPython, runCode, type SandboxExecService } from '../tools/code-sandbox'
import { MultiInstanceService } from '../multi-instance/index'
import { setAuthService } from '../multi-instance/auth/registry'
import { CronScheduler } from '../cron/scheduler'
import { setHooksUserDataDir, migrateLegacyGlobalHooks } from '../hooks'
import { AutoCleanupService } from '../services/auto-cleanup'
import { ensureNodeOnPath } from '../utils/node-runtime'
import { getAppAnchor, restartApp } from '../startup-helpers'
import { instanceDataDir } from '../multi-instance/instance-args'
import { setBaseDataDir } from '../multi-instance/instance-runtime'

/** 启动编排原子 ①：config 加载 + 数据目录解析 + 媒体协议 + 主题 */
export async function initRuntime(deps: BootstrapDeps) {
  const { configStore } = deps
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
  // 全局 hooks 配置随 Electron userData 收纳（{userData}/hooks.json，与 config.json 并排）；
  // app.getPath('userData') 已在模块顶层按 default/具名实例分别 setPath（190/173 行），此处取当前实例目录：
  // default=data/userdata（随项目走、可移植），具名实例=instances/{name}（随实例隔离，不做旧迁移）。
  // 0.53 一次性迁移：旧位置 {anchor}/.lunareclipse/hooks.json → 新位置 {userData}/hooks.json（仅 default，失败不阻断）
  if (!IS_CUSTOM_INSTANCE) {
    migrateLegacyGlobalHooks(dataDirAnchor, app.getPath('userData'))
  }
  setHooksUserDataDir(app.getPath('userData'))
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
export function initMainWindow(state: AppState, deps: BootstrapDeps) {
  const { configStore } = deps
  state.mainWindow = createWindow()

  // UI 缩放：分辨率自动适配（人眼最佳）+ 手动缩放（控件/快捷键/持久化）
  initUiZoom(state.mainWindow, configStore)

  // 主窗口关闭时一并关闭聊天小窗与 ROOM 房间，避免孤儿窗口残留
  state.mainWindow.on('closed', () => {
    closeOverlayWindow()
    closeRoomWindow()
  })

  // 渲染进程崩溃处理：记录原因 + 自动恢复
  // 策略：首次崩溃 reload 页面；短时间内连续崩溃（GPU/原生层不稳定）则 relaunch 整个 app
  // 限频防死循环：60 秒内崩溃超 3 次不再自动重启，避免确定性崩溃无限循环
  let renderCrashTimes: number[] = []
  state.mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const goneMsg = `reason=${details.reason} exitCode=${details.exitCode}`
    logError('render-process-gone', goneMsg)
    // 接入健康检查：指纹去重 + 冷却 + 事件唤醒 AI（面板修复记录时间线可见）
    state.healthCheck?.reportRuntimeEvent('render-process-gone', goneMsg)
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
      state.healthCheck?.reportRuntimeEvent('render-process-gone', relaunchMsg)
      restartApp(relaunchMsg)
      return
    }

    // 首次/偶发崩溃：1 秒后 reload 恢复界面
    setTimeout(() => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.reload()
        // reload 成功执行即标记恢复（面板时间线显示「已恢复」；若再次崩溃指纹仍会重新提醒）
        state.healthCheck?.markRuntimeRecovered('render-process-gone')
      }
    }, 1000)
  })

  // 窗口最大化状态变化：推送到渲染进程，TitleBar 据此切换图标
  state.mainWindow.on('maximize', () => {
    if (state.mainWindow && !state.mainWindow.isDestroyed() && !state.mainWindow.webContents.isDestroyed()) {
      state.mainWindow.webContents.send('window:state', { maximized: true })
    }
  })
  state.mainWindow.on('unmaximize', () => {
    if (state.mainWindow && !state.mainWindow.isDestroyed() && !state.mainWindow.webContents.isDestroyed()) {
      state.mainWindow.webContents.send('window:state', { maximized: false })
    }
  })
  return state.mainWindow!
}

/** 启动编排原子 ③：数据目录 + 用户存储 + 多实例底座（LAN/卫星同步） + 配置覆盖层注入 */
export async function initUserDirsAndMulti(state: AppState, deps: BootstrapDeps, resolvedDataDir: string) {
  const { configStore, sessionStore } = deps
      // dev: 源码树 electron/main/prompts；packaged: extraResources 复制到 resources/prompts（asar 外，可读）
      // 形状统一由 utils/app-root 的 resolveBundledAsset 提供（ADR-10 第 3 步，避免逐站重推 dev/packaged）
      const promptsDir = resolveBundledAsset('prompts', { onMissing: 'dev' })
  const dataPaths = initDataDirectory(resolvedDataDir, promptsDir)
      state.userStore = new UserStore(dataPaths.usersJson)
      // 主分系统：按 instance.json 装配角色（standalone/master/satellite）
      state.multiInstance = new MultiInstanceService(dataPaths.root)
      setAuthService(state.multiInstance.createAuthService(state.userStore))
      // 路径上下文：skills/config 按 U{uid}/AI{aiId} 组合隔离；plugins 完全本地化（全局共享，不分层）
      // aiId 动态解析：跟随当前活跃会话所属 AI（对齐 server.ts resolveSessionAiId 语义，
      // 会话 aiId 合法正整数则用之，否则回退 1=月蚀）；修复历史硬编码 ()=>1 导致
      // 「会话切到 AI{n} 后技能/配置仍读写 AI{1} 作用域」的错位。
      // 懒执行安全：闭包只在 getScopedPath 被调用时求值，彼时 supervisor/sessionStore 均已初始化。
      setPathContext(
        dataPaths.root,
        () => state.userStore?.getCurrentUser()?.UID ?? null,
        () => {
          const sessionId = state.supervisor?.activeSessionId
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
      state.userStore.setScopeInitializer((uid: number) => {
        ensureUserScopeSkeleton(dataPaths, uid)
      })
  // 启动时若已有 last_login_uid（自动恢复登录），同步建骨架 + 切会话目录
      try {
        const restored = state.userStore.getCurrentUser()
        if (restored) {
          state.userStore.ensureScope(restored.UID)
          const scoped = resolveScopePaths(dataPaths, { uid: restored.UID, aiId: DEFAULT_AI_ID })
          await sessionStore.switchUser(scoped.sessions)
        }
      } catch (err) {
        console.error('[index] 恢复登录态会话目录失败:', err)
      }
      // 分系统模式：启动免密恢复（缓存令牌刷新/离线沿用），切会话目录
      try {
        const satelliteUser = await state.multiInstance.restoreSatellite(state.userStore)
        if (satelliteUser) {
          state.userStore.ensureScope(satelliteUser.UID)
          const scoped = resolveScopePaths(dataPaths, { uid: satelliteUser.UID, aiId: DEFAULT_AI_ID })
          await sessionStore.switchUser(scoped.sessions)
          // 隐私：不输出具体用户名，只记录恢复动作本身
          console.log('[multi-instance] 分系统登录恢复成功（用户名已设置）')
        }
      } catch (err) {
        console.error('[multi-instance] 分系统登录恢复失败:', err)
      }
      // 分系统模式：启动 oplog 采集 → outbox → 单向推送主系统（持久化补偿，断网不丢）
      try {
        await state.multiInstance.startSync()
      } catch (err) {
        console.error('[multi-instance] 分系统同步启动失败:', err)
      }
// 局域网协作底座（L0）：master 上报本机地址、satellite 上报在线+拉名册，终端直连聊天
      // 中继异步传输（L1.5）的下载位置/保留天数读 AppConfig.relay（用户可在设置页或 config.json 调整）
      try {
        const lan = await state.multiInstance.startLan(state.userStore, () => configStore.get())
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
        for (const u of state.userStore.listUsers()) {
          state.userStore.ensureScope(u.UID)
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
  return { dataPaths, userStore: state.userStore, multiInstance: state.multiInstance }
}

/** 启动编排原子 ④a：路径同步监控（会话路径变动 -> 通知多实例） */
export async function initPathSync(state: AppState, deps: BootstrapDeps, dataPaths: BaseDataPaths, multiInstance: MultiInstanceService) {
  const { rootCtx } = deps
  // 真 fiber 化守卫（G3）：monitor 功能未挂载（被禁用/挂载失败）时跳过降级，
  // 后续 pathSyncMonitor?. 可选链与 before-quit 清理链均已容忍 null
  if (!rootCtx.featurePlugins.isEnabled('monitor')) {
    console.warn('[path-sync] monitor 功能已禁用，路径同步监控跳过')
    return null
  }
  state.pathSyncMonitor = rootCtx.monitor.initPathSync(dataPaths, {}, state.timerRegistry, (uid) => multiInstance?.isSatelliteUid(uid) ?? false)
  await state.pathSyncMonitor.start()
  return state.pathSyncMonitor
}

/** 启动编排原子 ④b：沙箱执行器 + coeffect 注册 */
export function initSandboxCoeffect(state: AppState, dataPaths: BaseDataPaths) {
  // 文件工坊执行器配置系统初始化
  initSandboxEnv(dataPaths)

  // 沙箱执行服务注册为 coeffect（按需注入：只有声明 deps: ['sandbox:exec'] 的插件才拿到）
  const sandboxService: SandboxExecService = { runJavaScript, runPython, runCode }
  state.sandboxCoeffectHandle = coeffectRegistry.provide('sandbox:exec', sandboxService, { kind: 'builtin' })
  return state.sandboxCoeffectHandle
}

/** 启动编排原子 ④c：激活管理器 + 生命周期目录 + 启动埋点 */
export function initActivation(state: AppState, dataPaths: BaseDataPaths) {
  // 文档 15.2.1：激活管理器（倒计时/外部事件/后端协作）
  state.activationManager = new ActivationManager(join(dataPaths.root, '.activation'), state.timerRegistry)

  // 生命周期记录：AI 感知自身开/关时间
  // 启动写 startedAt/mode 到 lifecycle.json；关闭时（before-quit）写 lastShutdownAt/reason。
  // 注入方式：buildInjectedMessages 末尾直接读 lifecycle.json 拼 system 消息——
  // AI 每次醒来在提示词最后面看到「上次何时关闭、本次何时启动」，不触发激活事件。
  try {
    state.lifecycleActivationDir = join(dataPaths.root, '.activation')
    recordStartup(state.lifecycleActivationDir, app.isPackaged ? 'packaged' : 'dev')
  } catch (err) {
    console.error('[lifecycle] 写入启动记录失败:', err)
  }
  return state.activationManager
}

/** 启动编排原子 ⑤：UI 健康监控 + Cron 调度器 + 自动清理 */
export function initMonitorsAndCron(state: AppState, deps: BootstrapDeps, dataPaths: BaseDataPaths, activationManager: ActivationManager) {
  const { rootCtx } = deps
  // UI 运行状态监控：渲染进程卡死/崩溃/GPU 崩溃/主进程事件循环延迟
  // 事件落盘 logs/ui-events.log，严重事件实时推送给 AI（运行中即可感知），
  // 同时写 pending 标记兜底（实时推送失败或主进程在事件后立即退出时，下次启动补报）
  try {
    state.uiHealthMonitor = new UiHealthMonitor(
      app.getPath('userData'),
      join(dataPaths.root, '.activation'),
      state.timerRegistry,
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
    if (state.mainWindow) {
      state.uiHealthMonitor.attach(state.mainWindow)
    }
    state.uiHealthMonitor.watchChildProcessGone()
    state.uiHealthMonitor.start()
    console.log('[ui-health] UI 运行状态监控已启动')
  } catch (err) {
    logError('ui-health.init', err)
  }

  // Cron 定时任务调度器（cron/scheduler.ts——间隔型/cron/ISO 三格式）
  // 配置 {paths.cron}/jobs.json，30s tick 检查，到点注入激活事件唤醒 AI
  let cronScheduler: CronScheduler | null = null
  try {
    if (rootCtx.featurePlugins.isEnabled('cron')) {
      cronScheduler = rootCtx.cron.create(dataPaths.cron, activationManager, state.timerRegistry)
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
    state.autoCleanup = new AutoCleanupService(app.getPath('userData'), app.getAppPath(), state.timerRegistry)
    state.autoCleanup.start()
    console.log('[auto-cleanup] 自动清理服务已启动（首轮 60s 后，之后每 24h）')
  } catch (err) {
    logError('auto-cleanup.init', err)
  }
  return { uiHealthMonitor: state.uiHealthMonitor, cronScheduler, autoCleanup: state.autoCleanup }
}
