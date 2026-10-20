/**
 * @category 核心
 * @summary 启动装配编排：whenReady 之后把各域服务按序接上（窗口 → 用户域 → 功能服务 → 内核 → 后端 → IPC）
 *
 * 为什么存在：`index.ts` 的 `app.whenReady().then(...)` 此前内联约 260 行编排体，与入口的
 * 生命周期注册（单实例守卫、退出链、window-all-closed）混在一个文件里。抽成 `runServiceAssembly`
 * 后入口只负责「何时启动 / 何时退出」，装配顺序在本文件内作为阅读顺序显式可见（ADR-01 第 4 步）。
 *
 * 什么作用：导出 `runServiceAssembly(state, deps)`；由 `index.ts` 在 `whenReady` 且通过单实例守卫后调用。
 *
 * 不删理由：删掉即这 260 行退回入口，装配顺序与生命周期注册再次耦合——而顺序约束恰恰是本启动链
 * 最容易改坏的地方（见下方「顺序约束」）。
 *
 * 顺序约束（改动前必读，判据见各调用点注释）：
 * 1. `initRuntime` → `initMainWindow` → `initUserDirsAndMulti`（用户域先就绪）；
 * 2. `mountFeatureServices` 必须**晚于** `initUserDirsAndMulti`（要重读状态文件）、**早于** `initPathSync`
 *    及其后所有调用点（它们依赖功能服务已挂载）；
 * 3. 组合点 A（`setWorkflowScope`）→ 组合点 B（`baseCtx` + 权限桥接）→ 组合点 C（统一工具池）按此序：
 *    baseCtx 的工具池依赖 A 的声明，权限桥接依赖 B 的窗口 getter；
 * 4. `initIpcLayer` **最后**——它需要 dataPaths / workflowManager / skillMarket / pluginLoader /
 *    cronScheduler / internalSessionStore 全部就绪。
 */
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import { isGreenlight } from './deps'
import { session } from 'electron'
import { join } from 'path'
import { initRuntime, initMainWindow, initUserDirsAndMulti, initPathSync, initSandboxCoeffect, initActivation, initMonitorsAndCron } from './assembly-core'
import { initKernelExtensions, initHooksSkills, initWorkflowEngine, initInternalSessionStore } from './assembly-kernel'
import { initApiServer, initCollaborationScheduler, initApiPortIpc, initSupervisor, initActivationLink, initRestartPendingConsumer, initMonitoringAndCatalog } from './assembly-backend'
import { initIpcLayer, initOverlayAndBrowserView, initEndgameIpc, initConfigChangedPush, initActivateHandler } from './assembly-ipc'
import { initRoomRuntime } from './room-runtime'
import { initMultiInstanceAi } from './multi-instance-ai'
import { createPermissionBridge } from '../ipc/permission-bridge'
import { DEFAULT_AI_ID } from '../models/path-context'
import { resolveScopePaths, type BaseDataPaths, type MemoryScope } from '../models/paths'
import { createToolRegistry } from '../tools'
import type { ToolContext } from '../tools'
import { mountFeatureServices } from '../kernel/cordis-runtime'
import { writeRestartPending } from '../api/restart-pending'
import { logError } from '../services/crash-logger'
import { WorkflowManager } from '../workflow/manager'
import { deviceManager } from '../device/device-manager'
import { registerRoomDeviceIpc } from '../room/device-ipc'
import { installRoomAssetProtocol } from '../room/asset-protocol'
import { seedRoomAssets } from '../room/seed-assets'
import { restartApp } from '../startup-helpers'

export async function runServiceAssembly(state: AppState, deps: BootstrapDeps): Promise<void> {
  // ===== 启动编排：服务初始化按域收敛（每个 initXxx 返回该域句柄，
  // 模块级 let 由返回值在下方赋值——onBeforeQuit / IPC 等模块级闭包绑定不变） =====

  const { config, resolvedDataDir } = await initRuntime(deps)

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

  // ROOM 本地资源协议（Live2D）：**必须在创建主窗口之前安装**——
  // 渲染进程一旦开始加载，再注册的 protocol.handle 不会进入它已有的网络上下文
  // （表现为 `net::ERR_UNKNOWN_URL_SCHEME`，只有 reload 才恢复）。
  // dataPaths 在窗口创建之后才就绪，这里用可变引用；渲染侧真正请求资源时早已赋值。
  let roomAssetDataPaths: BaseDataPaths | null = null
  installRoomAssetProtocol(() => roomAssetDataPaths)

  state.mainWindow = initMainWindow(state, deps)

  const userState = await initUserDirsAndMulti(state, deps, resolvedDataDir)
  const dataPaths = userState.dataPaths
  roomAssetDataPaths = dataPaths

  // 随包素材（Live2D 模型 + 核心 + 分区背景）：首次启动写入 `<data>/room/`。
  // **只增不改**——用户改过的外观/背景不会被覆盖；只在打包态执行。
  try {
    const seeded = seedRoomAssets(dataPaths)
    if (seeded != null) console.log(`[room] 随包素材已写入：${seeded} 个文件（已存在的跳过）`)
  } catch (err) {
    logError('room.seed-assets', err)
  }

  state.userStore = userState.userStore
  state.multiInstance = userState.multiInstance

  // 真 fiber 化（P1-A G3）：功能服务异步挂载为独立 Cordis fiber。
  // 位置约束：必须在 setPathContext（initUserDirsAndMulti 内）之后——mountAll 需重读状态文件；
  // 必须在 initPathSync 之前——该处及以下调用点依赖功能服务已就绪。
  // 按状态文件逐项 `ctx.plugin()` 挂载；禁用项不挂载，以下各 initXxx 内守卫跳过/降级。
  const mountResults = await mountFeatureServices(deps.rootCtx)
  if (mountResults.some((r) => !r.ok)) {
    console.error(
      '[cordis-runtime] 部分功能服务挂载失败：',
      mountResults.filter((r) => !r.ok).map((r) => `${r.id}(${r.error})`).join(', ')
    )
  } else {
    console.log(`[cordis-runtime] 功能服务挂载完成（${mountResults.length} 项）`)
  }

  try {
    state.pathSyncMonitor = await initPathSync(state, deps, dataPaths, state.multiInstance)
  } catch (err) {
    // 路径同步监控失败非致命：会话切换/记忆同步依赖它的功能降级，不影响主启动链
    logError('path-sync.init', err)
  }
  initSandboxCoeffect(state, dataPaths)
  state.activationManager = initActivation(state, dataPaths)

  const monitorState = initMonitorsAndCron(state, deps, dataPaths, state.activationManager)
  const cronScheduler = monitorState.cronScheduler
  state.uiHealthMonitor = monitorState.uiHealthMonitor
  state.autoCleanup = monitorState.autoCleanup

  const kernelState = await initKernelExtensions(state, deps)
  const pluginLoader = kernelState.pluginLoader
  state.mcpClientManager = kernelState.mcpClientManager
  state.detachCordis = kernelState.detachCordis

const hookSkillState = initHooksSkills(dataPaths)
  const memoryWorkflowHookManager = hookSkillState.workflowHookManager
  const memoryWorkflowSkillLoader = hookSkillState.workflowSkillLoader
  const skillMarket = hookSkillState.skillMarket

  // 市场 × 局域网接线：主/分系统与单机共享同一个上传市场 ——
  // 上传/下架经本地 manifest 落位后广播给在线对端，离线对端上线时经
  // syncWant/replay 增量补齐；分系统删除权限按上传者本人收敛（见 market.ts
  // canDeleteUpload：主系统/单机可删任意，分系统仅可删自己上传的）。
  // registerLanCallbacks 为单槽回调，这里只注册一次；standalone 无 LAN 时
  // getLanStatus().peers 为空、sendLan 未启动，setLanDeps 的三个注入仍安全。
  if (skillMarket) {
    skillMarket.setLanDeps({
      getRole: () => state.multiInstance.getRole(),
      sendLan: (uid, type, payload) => state.multiInstance.sendLan(uid, type, payload),
      listPeers: () => state.multiInstance.getLanStatus().peers
    })
    state.multiInstance.registerLanCallbacks({
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
    state.currentWorkflowScope = scope
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
      if (!state.mainWindow || state.mainWindow.isDestroyed()) return null
      const wc = state.mainWindow.webContents
      return { send: (channel, payload) => wc.send(channel, payload), ipc: wc.ipc }
    },
    isGreenlight: () => isGreenlight(deps.configStore),
    setAiRestarting: (restarting) => {
      state.aiRestarting = restarting
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
    skillLoader: memoryWorkflowSkillLoader,
    // 注入 WorkflowManager getter，workflow_* 工具通过此访问
    getWorkflowManager: () => workflowManager,
    // 注入 hookManager，记忆工作流工具执行经 executeTool 触发 PreToolUse/PostToolUse
    hookManager: memoryWorkflowHookManager,
    // 注入插件加载器 getter，plugin_manage 工具通过此访问
    getPluginLoader: () => pluginLoader,
    getModuleRegistry: () => state.moduleRegistry,
    // 注入 cron 调度器 getter：复用 index.ts 已创建的实例（单例），
    // 避免 server.ts 再创建第二个实例导致双 tick + fs.watch 不可靠 → 删任务后仍触发
    getCronScheduler: () => cronScheduler,
    // 注入局域网多实例服务 getter：friend_manage / chat_room_manage / publish_board_manage
    // 三个工具据此读写好友簿/聊天室/公示板（不同月蚀实例之间互相交流）
getMultiInstance: () => state.multiInstance ?? null,
    // 注入设备管理器 getter（ 设备接入基底：device_scan/device_register/device_call 访问）
    getDeviceManager: () => deviceManager,
    // 注入 skillLoader，记忆工作流可通过 use_skill 工具加载 Skills
    handleAccessed: (path: string) => {
      state.pathSyncMonitor?.handleAccessed(path)
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
      const u = state.userStore?.getCurrentUser()
      if (!u) {
        throw new Error('[paths] 未登录态禁止解析工具作用域 paths：系统要求先登录')
      }
      const sessionId = state.supervisor?.activeSessionId
      let aiId = DEFAULT_AI_ID
      if (sessionId) {
        try {
          const sAiId = deps.sessionStore?.get(sessionId)?.aiId
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
  // ---- 组合点 C：统一工具池（记忆工作流全量工具注册） ----
  // 统一工具池：记忆工作流与前端 AI 共用 createToolRegistry，按 policy 配置差异化启用
  // 记忆工作流直接注入工具 schema（onDemand 两步机制已退役：AI 反复出现 call_tool 参数错误，
  // 直接注入让 AI 直接调用工具，每次调用从 2 轮降到 1 轮）
    // 传入 mcpClientManager，MCP 工具合并到统一工具池；pluginLoader 提供插件工具
  const memoryWorkflowToolRegistry = createToolRegistry(baseCtx, {
    agent: 'dmn',
    mcpClientManager: state.mcpClientManager ?? undefined,
    pluginTools: pluginLoader?.getTools() ?? []
  })

const wfState = initWorkflowEngine(state, deps, { dataPaths, mcpClientManager: state.mcpClientManager, pluginLoader, workflowSkillLoader: memoryWorkflowSkillLoader })
  workflowManager = wfState.workflowManager

  // 设备接入基底：初始化注册表持久化目录（{root}/device-registry.json），
  // device_scan/device_register/device_call 经 baseCtx.getDeviceManager() 访问同一单例
  deviceManager.init(dataPaths.root)

  // ROOM 设备管理区 IPC（ADR-29 裁决6）：发现=只读；**交互路径**控制走 requestPermission（fail-closed）。
  // 自主路径（AI 自己调设备）不走这里——它走 device_call 工具 → 执行器 `t1.executor-high-risk`。
  registerRoomDeviceIpc({ requestPermission: permissionBridge.requestPermission })

  const internalSessionStore = initInternalSessionStore(deps)

  const port = await initApiServer(deps, {
    userStore: state.userStore,
    activationManager: state.activationManager,
    baseCtx,
    dataPaths,
    mcpClientManager: state.mcpClientManager,
    pluginLoader,
    internalSessionStore,
    multiInstance: state.multiInstance
  })
  initMultiInstanceAi(state.multiInstance)
  state.collaborationScheduler = initCollaborationScheduler(state, state.activationManager, state.multiInstance, state.userStore)
  // 莉莉丝链路已移至 onAuthSuccess（登录成功后）启动——系统强制登录后才可用，
  // 未登录阶段不写 MOD 桥接、不启适配器、不拉起桌宠；此处仅保留端口记录供桥接使用。
  state.apiPortForLilithBridge = port
  initApiPortIpc(port)
  // ROOM 自主运行时（B8/B10）：必须在 API server 起好后装配（规划依赖无头对话链路）
  // 每个 AI 一个房间实例（ADR-25 L3）：按 (uid, aiId) 分实例，会话 id 含 AI
  initRoomRuntime(state, deps, {
    internalSessionStore,
    toolRegistry: memoryWorkflowToolRegistry,
    toolZoneDir: join(dataPaths.root, 'room'),
    aiRegistryJson: dataPaths.aiRegistryJson,
    // 「监控看到了」唤醒源：工作流事件只上报，是否唤醒由 ROOM 的唤醒仲裁器决定（主进程单 owner）
    workflowManager
  })

  state.supervisor = initSupervisor(state, deps, {
    dataPaths,
    config,
    workflowToolRegistry: memoryWorkflowToolRegistry,
    baseCtx,
    pathSyncMonitor: state.pathSyncMonitor,
    userStore: state.userStore,
    workflowManager,
    setWorkflowScope
  })
  if (state.supervisor) {
    initActivationLink(state, state.activationManager, state.supervisor)
    initRestartPendingConsumer(state, dataPaths, state.supervisor)
  } else {
    console.warn('[index] supervisor 未初始化，激活链路/重启待办消费跳过')
  }

  const monCat = initMonitoringAndCatalog(state, deps, dataPaths)
  state.moduleRegistry = monCat.moduleRegistry
  state.healthCheck = monCat.healthCheck

  initIpcLayer(state, deps, {
    mainWindow: state.mainWindow,
    dataPaths,
    workflowManager,
    memoryWorkflowSkillLoader,
    skillMarket,
    pluginLoader,
    cronScheduler,
    internalSessionStore
  })
  initOverlayAndBrowserView(deps, state.mainWindow)
  initEndgameIpc(state)
  initConfigChangedPush(state, deps, state.mainWindow)
  initActivateHandler(state, deps)
}
