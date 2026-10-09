/**
 * 批次 A4：app.whenReady() 启动链装配断言
 *
 * 目标（计划书 A4）：断言每个服务都被初始化，且 before-quit 时 closeApiServer 后能全部释放
 * （顺序不必断言，存在性与释放必须断言）。
 *
 * 实现方式：mock electron 与全部重型/副作用模块（playwright、MCP、multi-instance、monitor、
 * plugins、cron、workflow、eval、timer-registry 等），仅保留零副作用或纯 fs 模块真实运行
 * （ConfigStore / SessionStore / UserStore / paths / restart-pending / kernel / internal-session-store），
 * import 真实的 electron/main/index.ts 触发模块级代码与 whenReady 装配链，
 * 用 vi.fn 记录每个服务的构造与启动调用，随后触发 before-quit 断言释放链。
 *
 * 注意：calls 全部键必须平铺在顶层（不要嵌套 services），否则 mock 工厂
 * 引用 mockState.calls.xxx 拿到 undefined。装配只发生一次（模块加载时），
 * 因此禁止在 beforeEach 中 clearAllMocks（会清空装配记录）。
 *
 * 满足批次 A 完成定义：故意在 index.ts 里删除任一服务装配（如 healthCheck.start()）
 * 或删除 closeApiServer() 释放调用，本文件对应断言即变红。
 */
import { describe, it, expect, vi } from 'vitest'

// ===== 顶层共享 mock 状态（hoisted，供 vi.mock 工厂引用） =====
const mockState = vi.hoisted(() => {
  // node 测试环境没有 process.resourcesPath，index.ts 内部
  // join(process.resourcesPath, 'prompts') 会抛 TypeError —— 这里兜底赋值为 cwd
  ;(process as NodeJS.Process & { resourcesPath?: string }).resourcesPath = process.cwd()

  const appEvents = new Map<string, (...args: unknown[]) => void>()
  const ipcOn = new Map<string, (...args: unknown[]) => void>()
  const ipcHandle = new Map<string, (...args: unknown[]) => unknown>()
  const calls = {
    // ---- API server ----
    startApiServer: vi.fn(async () => 62002),
    closeApiServer: vi.fn(async () => {}),
    getHeadlessChatRunner: vi.fn(() => null),
    // ---- 媒体协议 / 启动辅助 ----
    registerMediaScheme: vi.fn(),
    initMediaProtocol: vi.fn(),
    ensureNodeOnPath: vi.fn(),
    cleanStaleCaches: vi.fn(),
    getAppAnchor: vi.fn(() => '/tmp/lunareclipse-anchor'),
    resolveLlmConfig: vi.fn((a: unknown, b: unknown) => (b ?? a ?? {})),
    syncMcpToolMetas: vi.fn(),
    restartApp: vi.fn(() => ({ ok: true })),
    regenerateSystemCatalog: vi.fn(),
    resolveCatalogSourceRoot: vi.fn(() => ''),
    // ---- crash-logger / sandbox / renderer-bridge / workspace ----
    startCrashReporter: vi.fn(),
    logError: vi.fn(),
    safeSend: vi.fn(),
    initSandboxEnv: vi.fn(),
    setRendererBridge: vi.fn(),
    setWorkspacePreviewFile: vi.fn(),
    setWorkspaceSandboxState: vi.fn(),
    // 默认工作区路径注入（index.ts initRuntime 调用）
    setDefaultWorkspacePath: vi.fn(),
    // ---- restart-pending / lifecycle ----
    consumeRestartPending: vi.fn(() => null),
    writeRestartPending: vi.fn(),
    lifecycleStartup: vi.fn(),
    lifecycleShutdown: vi.fn(),
    // ---- monitor 三件套 ----
    supervisorStart: vi.fn(),
    supervisorStop: vi.fn(async () => {}),
    pathSyncStart: vi.fn(),
    pathSyncStop: vi.fn(async () => {}),
    healthCheckStart: vi.fn(),
    healthCheckStop: vi.fn(async () => {}),
    uiHealthStart: vi.fn(),
    uiHealthStop: vi.fn(async () => {}),
    // ---- cron ----
    cronStart: vi.fn(),
    cronStop: vi.fn(async () => {}),
    cronListJobs: vi.fn(() => []),
    // ---- workflow ----
    workflowRecover: vi.fn(async () => {}),
    workflowStop: vi.fn(async () => {}),
    // ---- MCP ----
    mcpConnect: vi.fn(async () => {}),
    mcpDisconnectAll: vi.fn(async () => {}),
    // ---- plugins / cordis ----
    pluginReload: vi.fn(async () => {}),
    pluginList: vi.fn(() => []),
    pluginGetTools: vi.fn(() => []),
    mountCordis: vi.fn(async () => mockState.calls.detachCordis),
    detachCordis: vi.fn(async () => {}),
    registerBuiltinToolsMeta: vi.fn(),
    governanceInstallAll: vi.fn(),
    // ---- window / browser-view / overlay / ipc / sandbox-ipc ----
    attachWindow: vi.fn(),
    browserDestroyView: vi.fn(async () => {}),
    registerBrowserIpc: vi.fn(),
    // 捕获 deps：用于断言「启动链有没有把该接的回调接进 IPC」（如莉莉丝启动前补同步）
    registerAllIpc: vi.fn((_ipc: unknown, deps: Record<string, unknown>) => {
      mockState.calls.ipcDeps = deps
    }),
    /** registerAllIpcHandlers 实参 deps（装配时写入） */
    ipcDeps: null as Record<string, unknown> | null,
    registerOverlayIpc: vi.fn(),
    setOverlayMainWindow: vi.fn(),
    registerCodeSandboxIpc: vi.fn(),
    sandboxDispose: vi.fn(async () => {}),
    // ---- multi-instance ----
    multiStartSync: vi.fn(async () => {}),
    multiStopSync: vi.fn(async () => {}),
    multiStopLan: vi.fn(async () => {}),
    multiStartLan: vi.fn(async () => ({ ok: false, error: 'mock' })),
    multiRestoreSatellite: vi.fn(async () => null),
    multiSetApiPort: vi.fn(),
    multiRunArchiveSweep: vi.fn(),
    multiSetAiReplyGenerator: vi.fn(),
    multiSetFriendAiReplyGenerator: vi.fn(),
    multiSetAiSocialReplyGenerator: vi.fn(),
    multiSetPublishBoardAiReplyGenerator: vi.fn(),
    multiRegisterIpc: vi.fn(),
    multiCreateMasterRouter: vi.fn(() => undefined),
    multiIsSatelliteUid: vi.fn(() => false),
    multiGetRole: vi.fn(() => 'standalone'),
    multiGetLanStatus: vi.fn(() => ({ running: false, port: 0, pendingCount: 0, peers: [], roster: [] })),
    multiSendLan: vi.fn(),
    multiRegisterLanCallbacks: vi.fn(),
    multiGetChatRooms: vi.fn(() => null),
    multiGetFriends: vi.fn(() => null),
    multiGetPublishBoard: vi.fn(() => null),
    multiGetAiAgentConfig: vi.fn(() => ({
      isProactiveEnabled: () => false,
      getProactiveIntervalMs: () => 60_000
    })),
    // ---- 协作心跳 / 激活 / 自动清理 / skill 市场 ----
    collabStart: vi.fn(),
    collabStop: vi.fn(async () => {}),
    activationStop: vi.fn(async () => {}),
    autoCleanupStart: vi.fn(),
    autoCleanupStop: vi.fn(async () => {}),
    lilithStop: vi.fn(async () => {}),
    skillMarketInit: vi.fn(),
    // ---- sessions flush / timerRegistry ----
    sessionFlush: vi.fn(async () => {}),
    timerStopAll: vi.fn(async () => {}),
    setAuthOfMulti: vi.fn(),
// ---- 二次窗口重建（createWindow 意外重入安全兜底）----
    createWindowCount: 0
  }

  // electron app mock
  const appMock = {
    commandLine: { appendSwitch: vi.fn() },
    getPath: vi.fn((name: string) =>
      name === 'userData' || name === 'appData' ? '/tmp/lunareclipse-userdata' : '/tmp/lunareclipse-path'
    ),
    getAppPath: vi.fn(() => process.cwd()),
    setPath: vi.fn(() => undefined),
    requestSingleInstanceLock: vi.fn(() => true),
    on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
      appEvents.set(ev, cb)
    }),
    removeListener: vi.fn((ev: string) => {
      appEvents.delete(ev)
    }),
    whenReady: vi.fn(async () => {}),
    quit: vi.fn(),
    relaunch: vi.fn(),
    isPackaged: false,
    getAllWindows: vi.fn(() => [])
  }
  return { appEvents, ipcOn, ipcHandle, calls, appMock }
})

// ===== mock electron：module-level 与 whenReady 全部依赖收敛到这里 =====
vi.mock('electron', () => {
  const state = mockState
  return {
    app: state.appMock,
    ipcMain: {
      on: vi.fn((ch: string, cb: (...args: unknown[]) => void) => {
        state.ipcOn.set(ch, cb)
      }),
handle: vi.fn((ch: string, cb: (...args: unknown[]) => unknown) => {
        state.ipcHandle.set(ch, cb)
      }),
      removeListener: vi.fn((ch: string) => {
        state.ipcOn.delete(ch)
      }),
      removeHandler: vi.fn((ch: string) => {
        state.ipcHandle.delete(ch)
      })
    },
    screen: {
      getDisplayMatching: vi.fn(() => ({ id: 0, workArea: { height: 1080 } })),
      getPrimaryDisplay: vi.fn(() => ({ id: 0, workArea: { height: 1080 } })),
      on: vi.fn(),
      removeListener: vi.fn()
    },
    nativeTheme: { themeSource: 'dark' },
    dialog: { showErrorBox: vi.fn() },
    shell: { openExternal: vi.fn(async () => {}) },
    BrowserWindow: {
      getAllWindows: vi.fn(() => [])
    }
  }
})

// ===== mock 重型/副作用模块（保持 index.ts 装配链可真实执行） =====
vi.mock('../electron/main/window', () => ({
  createWindow: vi.fn(() => {
    mockState.calls.createWindowCount += 1
const wc = {
      on: vi.fn(),
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      reload: vi.fn(),
      setZoomFactor: vi.fn(),
      // 0.30 权限桥接改从 webContents.ipc 取应答总线（原为全局 ipcMain），mock 需具备该字段
      ipc: { on: vi.fn(), removeListener: vi.fn() }
    }
return {
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      getBounds: vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 800 })),
      webContents: wc,
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn(),
      reload: vi.fn()
    }
  })
}))

vi.mock('../electron/main/api/server', () => ({
  startApiServer: mockState.calls.startApiServer,
  closeApiServer: mockState.calls.closeApiServer,
  getHeadlessChatRunner: mockState.calls.getHeadlessChatRunner
}))

vi.mock('../electron/main/api/gen/media-protocol', () => ({
  registerMediaScheme: mockState.calls.registerMediaScheme,
  initMediaProtocol: mockState.calls.initMediaProtocol
}))

vi.mock('../electron/main/services/crash-logger', () => ({
  startCrashReporter: mockState.calls.startCrashReporter,
  logError: mockState.calls.logError,
  safeSend: mockState.calls.safeSend
}))

vi.mock('../electron/main/services/sandbox-env', () => ({
  initSandboxEnv: mockState.calls.initSandboxEnv
}))

vi.mock('../electron/main/services/renderer-bridge', () => ({
  setRendererBridge: mockState.calls.setRendererBridge
}))

vi.mock('../electron/main/services/workspace-state', () => ({
  setPreviewFile: mockState.calls.setWorkspacePreviewFile,
  setSandboxState: mockState.calls.setWorkspaceSandboxState
}))

vi.mock('../electron/main/services/workspace-config', () => ({
  getDefaultWorkspaceConfigPath: () => '/tmp/lunareclipse-workspace-config.json',
  // index.ts initRuntime 会注入默认工作区路径（应用锚点），mock 需承接该调用
  setDefaultWorkspacePath: mockState.calls.setDefaultWorkspacePath
}))

vi.mock('../electron/main/services/tool-result-distiller', () => ({
  ToolResultDistiller: class {
    distill = vi.fn(async () => 'distilled')
  },
  DEFAULT_DISTILL_CONFIG: {}
}))

vi.mock('../electron/main/services/auto-cleanup', () => ({
  AutoCleanupService: class {
    start = mockState.calls.autoCleanupStart
    stop = mockState.calls.autoCleanupStop
  }
}))

vi.mock('../electron/main/services/lilith-adapter', () => ({
  LilithAdapter: class {
    start = vi.fn(async () => 6186)
    stop = vi.fn(async () => {})
  }
}))

vi.mock('../electron/main/services/system-catalog', () => ({
  regenerateSystemCatalog: mockState.calls.regenerateSystemCatalog,
  resolveCatalogSourceRoot: mockState.calls.resolveCatalogSourceRoot
}))

vi.mock('../electron/main/utils/node-runtime', () => ({
  ensureNodeOnPath: mockState.calls.ensureNodeOnPath
}))

vi.mock('../electron/main/startup-helpers', () => ({
  resolveLlmConfig: mockState.calls.resolveLlmConfig,
  syncMcpToolMetas: mockState.calls.syncMcpToolMetas,
  getAppAnchor: mockState.calls.getAppAnchor,
  cleanStaleCaches: mockState.calls.cleanStaleCaches,
  restartApp: mockState.calls.restartApp
}))

// api/activation-manager：只 mock 类本身（ActivationManager 由 index.ts new）
vi.mock('../electron/main/api/activation-manager', () => ({
  ActivationManager: class {
    constructor(..._args: unknown[]) {}
    start = vi.fn()
    stop = mockState.calls.activationStop
    setFrontendIdleProvider = vi.fn()
    setActivationCallback = vi.fn()
    pushExternalEvent = vi.fn()
    pushDmnEvent = vi.fn()
    pushActivation = vi.fn()
    peekActivationContent = vi.fn(() => null)
  }
}))

vi.mock('../electron/main/api/restart-pending', () => ({
  writeRestartPending: mockState.calls.writeRestartPending,
  consumeRestartPending: mockState.calls.consumeRestartPending,
  recordStartup: mockState.calls.lifecycleStartup,
  recordShutdown: mockState.calls.lifecycleShutdown
}))

vi.mock('../electron/main/api/llm', () => ({
  LLMClient: class {
    constructor(..._args: unknown[]) {}
    updateConfig = vi.fn()
    isReady = vi.fn(() => false)
    generate = vi.fn()
  }
}))

// multi-instance：全部网络/fs 副作用收敛为 vi.fn
vi.mock('../electron/main/multi-instance/index', () => ({
  MultiInstanceService: class {
    constructor(..._args: unknown[]) {}
    createAuthService = vi.fn(() => ({ verify: vi.fn() }))
    createMasterRouter = mockState.calls.multiCreateMasterRouter as unknown
    restoreSatellite = mockState.calls.multiRestoreSatellite
    startSync = mockState.calls.multiStartSync
    stopSync = mockState.calls.multiStopSync
    startLan = mockState.calls.multiStartLan
    stopLan = mockState.calls.multiStopLan
    setApiPort = mockState.calls.multiSetApiPort
    setAiReplyGenerator = mockState.calls.multiSetAiReplyGenerator
    setFriendAiReplyGenerator = mockState.calls.multiSetFriendAiReplyGenerator
    setAiSocialReplyGenerator = mockState.calls.multiSetAiSocialReplyGenerator
    setPublishBoardAiReplyGenerator = mockState.calls.multiSetPublishBoardAiReplyGenerator
    runArchiveSweep = mockState.calls.multiRunArchiveSweep
    getRole = mockState.calls.multiGetRole
    getLanStatus = mockState.calls.multiGetLanStatus
    sendLan = mockState.calls.multiSendLan
    registerLanCallbacks = mockState.calls.multiRegisterLanCallbacks
    getFriends = mockState.calls.multiGetFriends
    getChatRooms = mockState.calls.multiGetChatRooms
    getPublishBoard = mockState.calls.multiGetPublishBoard
    getAiAgentConfig = mockState.calls.multiGetAiAgentConfig
    isSatelliteUid = mockState.calls.multiIsSatelliteUid
    registerIpc = mockState.calls.multiRegisterIpc
  }
}))

vi.mock('../electron/main/multi-instance/auth/registry', () => ({
  setAuthService: mockState.calls.setAuthOfMulti
}))

vi.mock('../electron/main/multi-instance/ai-collaboration-scheduler', () => ({
  AiCollaborationScheduler: class {
    start = mockState.calls.collabStart
    stop = mockState.calls.collabStop
  }
}))

// monitor：Supervisor/PathSyncMonitor/HealthCheck/UiHealthMonitor/ModuleRegistry
vi.mock('../electron/main/monitor', () => ({
  Supervisor: class {
    start = mockState.calls.supervisorStart
    stop = mockState.calls.supervisorStop
    isFrontendIdle = vi.fn(() => true)
    activeSessionId = null
    setWorkflowManagerProvider = vi.fn()
    setMemoryWorkflowScopeSetter = vi.fn()
    setTokenBudgetProvider = vi.fn()
  },
  PathSyncMonitor: class {
    start = mockState.calls.pathSyncStart
    stop = mockState.calls.pathSyncStop
    handleAccessed = vi.fn()
    getErrorLog = vi.fn(() => [])
  },
  HealthCheck: class {
    start = mockState.calls.healthCheckStart
    stop = mockState.calls.healthCheckStop
    reportRuntimeEvent = vi.fn()
    markRuntimeRecovered = vi.fn()
  },
  DEFAULT_PATH_SYNC_CONFIG: {},
  DEFAULT_HEALTH_CHECK_CONFIG: {},
  hashFingerprint: vi.fn(() => 'fp'),
  truncate: vi.fn((s: string) => s),
  AlertGate: class {}
}))

// timer-registry：真实实现会收集 1s 轮询定时器（restart-pending 等待前端就绪），
// 测试环境不能真跑 30s 轮询 —— mock 掉，stopAll 挂到 calls 供 before-quit 断言
vi.mock('../electron/main/monitor/timer-registry', () => ({
  getGlobalTimerRegistry: () => ({
    setTimeout: vi.fn(() => 1),
    setInterval: vi.fn(() => 2),
    clearTimeout: vi.fn(),
    clearInterval: vi.fn(),
    stopAll: mockState.calls.timerStopAll,
    size: 0
  })
}))

vi.mock('../electron/main/monitor/module-registry', () => ({
  ModuleRegistry: class {
    constructor(..._args: unknown[]) {}
    setStatus = vi.fn()
    report = vi.fn()
  }
}))

vi.mock('../electron/main/monitor/ui-health-monitor', () => ({
  UiHealthMonitor: class {
    attach = vi.fn()
    watchChildProcessGone = vi.fn()
    start = mockState.calls.uiHealthStart
    stop = mockState.calls.uiHealthStop
    consumePendingEvents = vi.fn(() => undefined)
  }
}))

// mcp：真实 client-manager 会连接 server —— 收敛为 mock
vi.mock('../electron/main/mcp/client-manager', () => ({
  McpClientManager: class {
    init = vi.fn(() => this)
    connectServer = mockState.calls.mcpConnect
    reloadFromConfig = vi.fn(async () => {})
    disconnectAll = mockState.calls.mcpDisconnectAll
  }
}))

vi.mock('../electron/main/mcp/config-loader', () => ({
  // 返回一个 enabled 的 MCP server：真实逻辑会对 enabled server 逐个 connectServer
  loadMcpConfig: vi.fn(() => ({ mcpServers: { 'test-server': { enabled: true } } })),
  watchMcpConfig: vi.fn(),
  ensureMcpConfigExists: vi.fn()
}))

// plugins：真实 loader 会扫描磁盘 plugins 目录 —— 收敛为 mock
vi.mock('../electron/main/plugins', () => ({
  PluginLoader: class {
    constructor(..._args: unknown[]) {}
    reload = mockState.calls.pluginReload
    list = mockState.calls.pluginList
    getTools = mockState.calls.pluginGetTools
  },
  getDomainPluginsDir: vi.fn(() => null)
}))

vi.mock('../electron/main/plugins/cordis-mounter', () => ({
  mountCordisPlugins: mockState.calls.mountCordis
}))

// skills：真实 loader 会 fs.watch —— 收敛为 mock
vi.mock('../electron/main/skills/loader', () => ({
  SkillLoader: class {
    startWatching = vi.fn()
    load = vi.fn()
    // SKILL 变动→前端自动刷新：index.ts initHooksSkills 会调用 setChangeCallback 注册
    // 热重载回调（磁盘 SKILL.md 变动/市场装拆后广播 'skills:changed'），mock 需承接该调用
    setChangeCallback = vi.fn()
  },
  getDomainSkillsDir: vi.fn(() => null)
}))

vi.mock('../electron/main/skills/skill-config', () => ({
  getDefaultSkillsConfigPath: vi.fn(() => '/tmp/lunareclipse-skills-config.json')
}))

vi.mock('../electron/main/skills/market', () => ({
  SkillMarket: class {
    constructor(..._args: unknown[]) {
      mockState.calls.skillMarketInit()
    }
    listAll = vi.fn(() => [])
    // 市场×局域网接线（index.ts whenReady 内调用）：mock 空实现，防启动链中断
    setLanDeps = vi.fn()
    handleLanEnvelope = vi.fn()
    handlePeerStatus = vi.fn()
  }
}))

// workflow：真实 manager 依赖 LLM/registry —— 收敛为 mock
vi.mock('../electron/main/workflow/manager', () => ({
  WorkflowManager: class {
    recoverInstances = mockState.calls.workflowRecover
  }
}))

vi.mock('../electron/main/ipc/handlers', () => ({
  registerAllIpcHandlers: mockState.calls.registerAllIpc
}))

vi.mock('../electron/main/ipc/handlers/workflow', () => ({
  createWorkflowEventBridge: vi.fn(() => vi.fn())
}))

// tools：真实 createToolRegistry 会注册全部工具（含 fs/网络）—— 收敛为 mock
vi.mock('../electron/main/tools', () => ({
  createToolRegistry: vi.fn(() => ({ tools: new Map() })),
  registerBuiltinToolsMeta: mockState.calls.registerBuiltinToolsMeta
}))

vi.mock('../electron/main/tools/code-sandbox', () => ({
  runJavaScript: vi.fn(),
  runPython: vi.fn(),
  runCode: vi.fn(),
  registerCodeSandboxIpcHandlers: mockState.calls.registerCodeSandboxIpc
}))

vi.mock('../electron/main/tools/browser-view-manager', () => {
  const browserViewManager = {
    attachWindow: mockState.calls.attachWindow,
    destroyView: mockState.calls.browserDestroyView,
    useSystemBrowserGetter: null
  }
  return {
    browserViewManager,
    registerBrowserIpcHandlers: mockState.calls.registerBrowserIpc
  }
})

vi.mock('../electron/main/tools/browser-manager', () => ({
  browserManager: {
    setStorageStatePath: vi.fn(),
    getBrowser: vi.fn()
  }
}))

vi.mock('../electron/main/overlay-window', () => ({
  registerOverlayIpc: mockState.calls.registerOverlayIpc,
  setOverlayMainWindow: mockState.calls.setOverlayMainWindow,
  closeOverlayWindow: vi.fn()
}))

vi.mock('../electron/main/eval', () => ({
  createEvalHarness: vi.fn(() => ({ run: vi.fn() }))
}))

// HumanGrader 从独立子路径导入（new HumanGrader() 会注册 eval:submitHumanGrade IPC）
vi.mock('../electron/main/eval/graders/human-grader', () => ({
  HumanGrader: class {
    constructor(..._args: unknown[]) {}
  }
}))

// hooks：真实 loader 会 fs.watch —— 收敛为 mock
vi.mock('../electron/main/hooks', () => ({
  HookManager: class {
    loadHooks = vi.fn()
  },
  loadAllHooks: vi.fn(() => []),
  watchHooksConfig: vi.fn(),
  // index.ts initRuntime 注入 hooks 根目录（应用锚点），mock 承接
  setHooksConfigRoot: vi.fn()
}))

// kernel：真实 createRegistrar 是纯内存注册表，但 sandboxCoeffect dispose 需可断言 —— mock
vi.mock('../electron/main/kernel', () => ({
  createRegistrar: vi.fn(() => ({
    reg: {},
    handles: []
  })),
  kernelRegistry: {
    get: vi.fn(() => undefined),
    register: vi.fn(() => ({ disposed: false, dispose: vi.fn() }))
  },
  coeffectRegistry: {
    provide: vi.fn(() => ({ key: 'sandbox:exec', disposed: false, dispose: mockState.calls.sandboxDispose })),
    get: vi.fn(() => undefined),
    has: vi.fn(() => false),
    onChanged: vi.fn(() => () => {}),
    listKeys: vi.fn(() => []),
    inspect: vi.fn(() => [])
  }
}))

// kernel/cordis-runtime：ctx 服务容器的全部服务工厂收敛为 vi.fn。
// mountFeatureServices 是 G3 真 fiber 化装配入口：mock 返回空数组，
// 使 whenReady 里的 `await mountFeatureServices(rootCtx)` 同步放行，不阻塞后续装配步骤。
vi.mock('../electron/main/kernel/cordis-runtime', () => ({
  createRootContext: vi.fn(() => ({
    config: {
      init: vi.fn(() => ({
        load: vi.fn(() => ({ permissionGreenlight: false, theme: 'night', llm: {}, dmnLlm: {}, lilith: { useAdapter: true } })),
        get: vi.fn(() => ({ permissionGreenlight: false, theme: 'night', llm: {}, dmnLlm: {}, tokenBudget: 0 })),
        // 为什么 getEffective 也要给 lilith：index.ts 的启动编排改用 lilithEnabled(configStore) 守卫，
        // 而该函数读的是 getEffective().lilith（生产实现 = 核心配置 + 覆盖层，必然含 lilith 段），
        // 不是 load()。若此处漏给 lilith，守卫判定为「模块关闭」→ 整条莉莉丝链路被跳过，
        // 「before-quit 释放链」里的 lilithAdapter.stop 断言就会假失败（mock 缺口，非生产缺陷）。
        getEffective: vi.fn(() => ({ permissionGreenlight: false, theme: 'night', llm: {}, dmnLlm: {}, tokenBudget: 0, browser: {}, lilith: { useAdapter: true } })),
        save: vi.fn(),
        isLoadFailed: vi.fn(() => false),
        subscribe: vi.fn(),
        setPatchProvider: vi.fn()
      })),
      initUsers: vi.fn()
    },
    sessions: {
      init: vi.fn(() => ({
        getDir: vi.fn(() => '/tmp/lunareclipse-sessions'),
        flush: mockState.calls.sessionFlush,
        switchUser: vi.fn()
      }))
    },
    monitor: {
      initPathSync: vi.fn(() => ({
        start: mockState.calls.pathSyncStart,
        stop: mockState.calls.pathSyncStop,
        handleAccessed: vi.fn(),
        getErrorLog: vi.fn(() => [])
      })),
      initSupervisor: vi.fn(() => ({
        start: mockState.calls.supervisorStart,
        stop: mockState.calls.supervisorStop,
        isFrontendIdle: vi.fn(() => true),
        activeSessionId: null,
        setWorkflowManagerProvider: vi.fn(),
        setMemoryWorkflowScopeSetter: vi.fn(),
        setTokenBudgetProvider: vi.fn()
      })),
      initHealthCheck: vi.fn(() => ({
        start: mockState.calls.healthCheckStart,
        stop: mockState.calls.healthCheckStop,
        reportRuntimeEvent: vi.fn(),
        markRuntimeRecovered: vi.fn()
      }))
    },
    cron: {
      create: vi.fn(() => ({
        start: mockState.calls.cronStart,
        stop: mockState.calls.cronStop,
        listJobs: mockState.calls.cronListJobs,
        upsertJob: vi.fn(),
        deleteJob: vi.fn(),
        toggleJob: vi.fn()
      }))
    },
    mcp: {
      init: vi.fn(() => ({
        connectServer: mockState.calls.mcpConnect,
        disconnectAll: mockState.calls.mcpDisconnectAll,
        reloadFromConfig: vi.fn(async () => {}),
        listServers: vi.fn(() => [])
      }))
    },
    workflow: {
      init: vi.fn(() => ({
        recoverInstances: mockState.calls.workflowRecover,
        run: vi.fn(),
        stop: mockState.calls.workflowStop
      }))
    },
    lilith: {
      create: vi.fn(() => ({
        start: vi.fn(async () => 6186),
        stop: mockState.calls.lilithStop
      }))
    },
    governance: {
      installAll: mockState.calls.governanceInstallAll
    },
    skills: {
      init: vi.fn()
    },
    featurePlugins: {
      isEnabled: vi.fn(() => true),
      list: vi.fn(() => []),
      mountAll: vi.fn(async () => [])
    }
  })),
  mountFeatureServices: vi.fn(async () => [])
}))

// 真 fiber 化（P1-A G3）：功能服务异步挂载。mock 工厂需同时导出 mountFeatureServices，
// 否则 index.ts 的 `await mountFeatureServices(rootCtx)` 拿到 undefined 抛 TypeError，装配链中断。
vi.mock('../electron/main/kernel/feature-plugins', () => ({
  FEATURE_PLUGINS: [],
  FeaturePluginsService: class {}
}))

// ===== 被测对象：真实主进程入口（模块级副作用经 mock 收敛） =====
// 注意：index 导入必须在所有 vi.mock 之后（vitest 的 vi.mock 是 hoisted 的，此处位置安全）
import '../electron/main/index'

describe('批次 A4：app.whenReady() 启动链装配断言', () => {
  it('whenReady 装配链：核心服务全部被初始化（存在性断言）', async () => {
    // import index 时 whenReady 已触发（app.whenReady = async () => {}），
    // 等微任务队列消化完整条装配链（均为同步/await mock）
    await vi.waitFor(
      () => {
        expect(mockState.calls.startApiServer).toHaveBeenCalled()
      },
      { timeout: 5000 }
    )

    // ---- API server 装配 ----
    expect(mockState.calls.startApiServer).toHaveBeenCalledTimes(1)
    expect(mockState.calls.multiSetApiPort).toHaveBeenCalledWith(62002)

    // ---- 服务存在性（每个都应有初始化/启动调用） ----
    // 监控三件套
    expect(mockState.calls.supervisorStart).toHaveBeenCalled()
    expect(mockState.calls.pathSyncStart).toHaveBeenCalled()
    expect(mockState.calls.healthCheckStart).toHaveBeenCalled()
    // UI 健康监控
    expect(mockState.calls.uiHealthStart).toHaveBeenCalled()
    // Cron 调度器
    expect(mockState.calls.cronStart).toHaveBeenCalled()
    expect(mockState.calls.cronListJobs).toHaveBeenCalled()
    // MCP 客户端
    expect(mockState.calls.mcpConnect).toHaveBeenCalled()
    // 插件加载器 + Cordis 挂载
    expect(mockState.calls.pluginReload).toHaveBeenCalled()
    expect(mockState.calls.mountCordis).toHaveBeenCalled()
    // 内置工具登记 + 治理机制
    expect(mockState.calls.registerBuiltinToolsMeta).toHaveBeenCalled()
    expect(mockState.calls.governanceInstallAll).toHaveBeenCalled()
    // 工作流引擎
    expect(mockState.calls.workflowRecover).toHaveBeenCalled()
    // 自动清理服务
    expect(mockState.calls.autoCleanupStart).toHaveBeenCalled()
    // Skill 市场
    expect(mockState.calls.skillMarketInit).toHaveBeenCalled()
    // 多实例底座
    expect(mockState.calls.multiStartSync).toHaveBeenCalled()
    expect(mockState.calls.multiStartLan).toHaveBeenCalled()
    expect(mockState.calls.multiRestoreSatellite).toHaveBeenCalled()
    // 协作心跳
    expect(mockState.calls.collabStart).toHaveBeenCalled()
    // 覆盖层 / 浏览器面板 / IPC
    expect(mockState.calls.registerOverlayIpc).toHaveBeenCalled()
    expect(mockState.calls.setOverlayMainWindow).toHaveBeenCalled()
    expect(mockState.calls.attachWindow).toHaveBeenCalled()
    expect(mockState.calls.registerBrowserIpc).toHaveBeenCalled()
    expect(mockState.calls.registerAllIpc).toHaveBeenCalled()
    expect(mockState.calls.registerCodeSandboxIpc).toHaveBeenCalled()
    // 生命周期记录
    expect(mockState.calls.lifecycleStartup).toHaveBeenCalled()
  })

  it('莉莉丝「随月蚀启动」关闭时，手动启动桌宠仍有补同步 MOD 配置的通道', async () => {
    // 为什么断言这条：桥接的冷启动执行挂在 config.lilith.autoStart 上——
    // 开关关闭时冷启动完全不碰莉莉丝（不写 MOD 配置、不探测 companion），
    // 因此「用户手动点启动莉莉丝桌宠」这一刻的补同步回调必须真的接进 IPC 依赖，
    // 否则 companion 会读到旧 provider → 游戏内莉莉丝连不上月蚀（静默断链）。
    await vi.waitFor(
      () => {
        expect(mockState.calls.registerAllIpc).toHaveBeenCalled()
      },
      { timeout: 5000 }
    )
    expect(mockState.calls.ipcDeps?.onLilithBeforeLaunch).toBeTypeOf('function')
  })

  it('启动链设置 api:port IPC 供渲染进程取端口', async () => {
    await vi.waitFor(
      () => {
        expect(mockState.calls.startApiServer).toHaveBeenCalled()
      },
      { timeout: 5000 }
    )
    expect(mockState.ipcOn.has('api:port')).toBe(true)
    const handler = mockState.ipcOn.get('api:port')!
    const fakeEvent: { returnValue: number | null } = { returnValue: null }
    handler(fakeEvent)
    expect(fakeEvent.returnValue).toBe(62002)
  })

  it('before-quit：closeApiServer 后被完整释放（释放链断言）', async () => {
    await vi.waitFor(
      () => {
        expect(mockState.calls.startApiServer).toHaveBeenCalled()
      },
      { timeout: 5000 }
    )

    const quitHandler = mockState.appEvents.get('before-quit')!
    expect(quitHandler).toBeDefined()

    const event = { preventDefault: vi.fn() }
    await quitHandler(event)
    expect(event.preventDefault).toHaveBeenCalled()

    // 关闭 API server（核心释放点）
    expect(mockState.calls.closeApiServer).toHaveBeenCalled()
    // 监控三件套释放
    expect(mockState.calls.supervisorStop).toHaveBeenCalled()
    expect(mockState.calls.pathSyncStop).toHaveBeenCalled()
    expect(mockState.calls.healthCheckStop).toHaveBeenCalled()
    expect(mockState.calls.uiHealthStop).toHaveBeenCalled()
    // 多实例 / 协作 / 激活 / 自动清理
    expect(mockState.calls.multiStopSync).toHaveBeenCalled()
    expect(mockState.calls.multiStopLan).toHaveBeenCalled()
    expect(mockState.calls.collabStop).toHaveBeenCalled()
    expect(mockState.calls.activationStop).toHaveBeenCalled()
    expect(mockState.calls.autoCleanupStop).toHaveBeenCalled()
    // 会话刷盘
    expect(mockState.calls.sessionFlush).toHaveBeenCalled()
    // 莉莉丝协议适配器：延后到登录成功（onAuthSuccess）后启动，本场景未登录
    // 不创建适配器，before-quit 不应触发 stop（避免「未启动却停止」的假断言）
    expect(mockState.calls.lilithStop).not.toHaveBeenCalled()
    // 浏览器视图销毁 / MCP 断开 / 沙箱 coeffect 回滚 / Cordis 卸载 / 生命周期收尾
    expect(mockState.calls.browserDestroyView).toHaveBeenCalled()
    expect(mockState.calls.mcpDisconnectAll).toHaveBeenCalled()
    expect(mockState.calls.sandboxDispose).toHaveBeenCalled()
    expect(mockState.calls.detachCordis).toHaveBeenCalled()
    expect(mockState.calls.lifecycleShutdown).toHaveBeenCalled()
    // 定时器统一清理（cron/激活/UI 监控等全部定时器，5 秒超时保护）
    expect(mockState.calls.timerStopAll).toHaveBeenCalled()
    // 最终退出
    expect(mockState.appMock.quit).toHaveBeenCalled()
  })
})