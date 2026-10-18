/**
 * @category 核心
 * @summary 启动装配原子 ⑭a~e：IPC 层、悬浮窗与浏览器视图、HumanGrader/工作区/沙箱 IPC、配置推送、窗口激活
 *
 * 为什么存在：这五项此前平铺在 `index.ts`（约 280 行），属「渲染进程接口装配」——把 IPC handler
 * 全量注册、悬浮窗、评测/工作区/沙箱通道、config 变化推送与 macOS 激活重建接到启动链上。
 * 抽成独立模块后，入口只保留编排（ADR-01 第 3 步）。
 *
 * 什么作用：导出五个 `initXxx`，由 `service-assembly.ts` 按序调用；`state` 与 `deps` 显式传入。
 *
 * 不删理由：删掉即这 280 行退回 `index.ts`；且 `initIpcLayer` 是**渲染进程全部能力的注册点**
 * （权限桥接、多实例、莉莉丝、cron、技能市场都经它接线），与启动编排混在一个文件里会持续冲突。
 *
 * 顺序约束（迁移后仍必须按此调用）：`initIpcLayer` 必须最后（它需要 `dataPaths` / `workflowManager` /
 * `skillMarket` / `pluginLoader` / `cronScheduler` / `internalSessionStore` 全部就绪）；
 * 其余四个可紧随其后（`initOverlayAndBrowserView` / `initConfigChangedPush` 需要 `mainWindow`）。
 */
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import { app, BrowserWindow, ipcMain } from 'electron'
import { initLilithAdapter, initLilithAutoStart, initLilithBridge, runLilithBridgeNow } from './lilith-setup'
import { createWindow } from '../window'
import { initUiZoom } from '../ui-zoom'
import { LLMClient } from '../api/llm'
import { InternalSessionStore } from '../services/internal-session-store'
import { registerAllIpcHandlers } from '../ipc/handlers'
import { initDataDirectory } from '../models/data-init'
import { createToolRegistry } from '../tools'
import { PluginLoader } from '../plugins'
import { SkillMarket } from '../skills/market'
import { lilithEnabled } from '../api/lilith-session'
import { registerOverlayIpc, setOverlayMainWindow } from '../overlay-window'
import { registerRoomIpc, setRoomMainWindow } from '../room-window'
import { browserViewManager, registerBrowserIpcHandlers } from '../tools/browser-view-manager'
import { setPreviewFile as setWorkspacePreviewFile, setSandboxState as setWorkspaceSandboxState } from '../services/workspace-state'
import { setRendererBridge } from '../services/renderer-bridge'
import { getDefaultWorkspaceConfigPath } from '../services/workspace-config'
import { logError } from '../services/crash-logger'
import type { CronScheduler } from '../cron/scheduler'
import { registerCodeSandboxIpcHandlers } from '../tools/code-sandbox'
import { createEvalHarness } from '../eval'
import { HumanGrader } from '../eval/graders/human-grader'
import { SkillLoader } from '../skills/loader'
import { WorkflowManager } from '../workflow/manager'
import { resolveLlmConfig } from '../startup-helpers'
import { defaultAuditFilePath } from '../tools/security-engine/audit-log'
import { getRoomAllowedTools } from '../room/runtime'

/** 启动编排原子 ⑭a：IPC handlers 巨型注入 + 多实例 IPC 注册 */
export function initIpcLayer(state: AppState, deps: BootstrapDeps, ipcDeps: {
  mainWindow: BrowserWindow
  dataPaths: ReturnType<typeof initDataDirectory>
  workflowManager: WorkflowManager | null
  memoryWorkflowSkillLoader: SkillLoader
  skillMarket: SkillMarket | null
  pluginLoader: PluginLoader | null
  cronScheduler: CronScheduler | null
  internalSessionStore: InternalSessionStore
}) {
  const { configStore, sessionStore, rootCtx } = deps
  const { mainWindow, dataPaths, workflowManager, memoryWorkflowSkillLoader, skillMarket, pluginLoader, cronScheduler, internalSessionStore } = ipcDeps
  // 记忆流水线保持恒并行：前端对话/后端续接时照常取批次跑记忆工作流。

  registerAllIpcHandlers(ipcMain, {
    configStore,
    sessionStore,
    mainWindow,
    getUserStore: () => state.userStore,
    getSupervisor: () => state.supervisor,
    getPathSyncMonitor: () => state.pathSyncMonitor,
    getHealthCheck: () => state.healthCheck,
    getModuleRegistry: () => state.moduleRegistry,
    getActivationManager: () => state.activationManager,
    getDataPaths: () => dataPaths,
    // 权限层审计文件（security:listAudit 读取）：路径单源在 audit-log，data/ 不进包（CODE-RULES §3.4）
    getSecurityAuditFilePath: () => defaultAuditFilePath(),
    // 局域网管理（lan:*）：多实例服务已由组合根构造
    getMultiInstance: () => state.multiInstance,
    // 工具区步骤工具的可用集合（ROOM 组合根注入；未装配时为空 = 一切步骤被拒）
    getToolZoneAllowedTools: () => getRoomAllowedTools(),
    getMcpClientManager: () => state.mcpClientManager,
    getWorkflowManager: () => workflowManager,
    // 复用 memoryWorkflowSkillLoader（与前端 AI / 记忆工作流共用同一套 Skills）
    getSkillLoader: () => memoryWorkflowSkillLoader,
    // Skill 市场（skill:market-* 通道用）
    getSkillMarket: () => skillMarket,
    // 莉莉丝：用户点「启动莉莉丝桌宠」前补同步一次 MOD 配置（见 runLilithBridgeNow 的不删理由）
    onLilithBeforeLaunch: () => runLilithBridgeNow(state, deps),
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
      void state.multiInstance.startSync()
      memoryWorkflowSkillLoader.load()
      memoryWorkflowSkillLoader.startWatching()
      if (!state.lilithStarted && lilithEnabled(configStore)) {
        state.lilithStarted = true
        const lilithConfig = configStore.get().lilith
        // 「随月蚀启动」开关（config.lilith.autoStart）同时管住桥接的冷启动执行：
        // 关闭时整条桥接（写 %APPDATA%\LilithAI\config.json + 探测/reload companion）一律不执行——
        // 关了开关却仍去改写外部程序的配置、并探测一个没在跑的进程，会打出「失败」这种假警报。
        // 用户主动启动桌宠时的补同步走 runLilithBridgeNow()。
        if (lilithConfig?.autoStart === true) void initLilithBridge(state, deps, state.apiPortForLilithBridge)
        initLilithAdapter(state, deps, configStore.get(), dataPaths)
        void initLilithAutoStart(configStore.get())
      }
    },
    // 评测：按需构造 EvalHarness（首次访问时创建，跟随 config 更新）
    // 按 suite 名选择：dmn-regression（记忆工作流回归，历史契约 id 保留）用后端记忆工作流
    // 配置（config.workflowLlm），其他用前端 AI 配置（config.llm）。
    // 注意：此前注释/分支里的 memory-workflow-regression 从未注册进 SUITE_REGISTRY，
    // loadSuite 遇之会 throw 且无调用方，已移除，避免误导。
    getEvalHarness: (suite?: string) => {
      // 记忆工作流评测：用后端记忆工作流的 LLM 配置和工具集，真正评测记忆工作流能力
      if (suite === 'dmn-regression') {
        if (!state.workflowEvalHarness) {
          const workflowEvalLlmClient = new LLMClient(
            resolveLlmConfig(configStore.get().workflowLlm, configStore.get().llm)
          )
          const evalConfig = configStore.get().eval
          const judgeConfig = evalConfig?.judge
          let judgeLlmClient: LLMClient | undefined
          if (judgeConfig?.baseURL && judgeConfig?.apiKey) {
            const baseLlm = resolveLlmConfig(configStore.get().workflowLlm, configStore.get().llm)
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
            const newCfg = resolveLlmConfig(newConfig.workflowLlm, newConfig.llm)
            const oldCfg = resolveLlmConfig(oldConfig.workflowLlm, oldConfig.llm)
            if (JSON.stringify(newCfg) !== JSON.stringify(oldCfg)) {
              workflowEvalLlmClient.updateConfig(newCfg)
            }
          })
          state.workflowEvalHarness = createEvalHarness({
            llmClient: workflowEvalLlmClient,
            configStore,
            // 记忆工作流评测用记忆工作流工具集（含 create_memory/nng_graph 等记忆工作流专属工具）
            // 直接注入：工具 schema 直接注入，无 call_tool 间接层（onDemand 已退役）
            createToolRegistry: (ctx) =>
              createToolRegistry(ctx, {
                mcpClientManager: state.mcpClientManager ?? undefined
              }),
            judgeLlmClient
          })
        }
        return state.workflowEvalHarness
      }
      // 前端 AI 评测（默认）
      if (!state.evalHarness) {
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
        state.evalHarness = createEvalHarness({
          llmClient: evalLlmClient,
          configStore,
          // 评测直接注入工具 schema（onDemand 两步机制已退役）
          createToolRegistry: (ctx) =>
            createToolRegistry(ctx, {
              mcpClientManager: state.mcpClientManager ?? undefined
            }),
          judgeLlmClient
        })
      }
      return state.evalHarness
    },
    workspaceConfigPath: () => getDefaultWorkspaceConfigPath(),
    // 共享内部会话存储（前端内部会话面板：列表/详情/CRUD）
    getInternalSessionStore: () => internalSessionStore
  })
  // 主分系统 IPC（角色状态/接入配置/管理窗口代理）
  state.multiInstance.registerIpc(ipcMain, {
    getUserStore: () => state.userStore,
    getMainWindow: () => mainWindow
  })
}

/** 启动编排原子 ⑭b：悬浮窗 + 浏览器视图面板 */
export function initOverlayAndBrowserView(deps: BootstrapDeps, mainWindow: BrowserWindow) {
  const { configStore } = deps
  // 聊天悬浮小窗（独立置顶 BrowserWindow，可拖到桌面）
  setOverlayMainWindow(mainWindow)
  registerOverlayIpc()
  // ROOM 自主模式主窗口（独立 BrowserWindow，非置顶；开关持久化到 config.room.enabled）
  setRoomMainWindow(mainWindow)
  registerRoomIpc(configStore)
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
export function initEndgameIpc(state: AppState) {
  // 验证层：实例化 HumanGrader（注册 eval:submitHumanGrade IPC handler）
  // 用于人工评分校准：前端 EvalPanel 调用 evalSubmitHumanGrade 提交人工标注
  state.humanGrader = new HumanGrader()
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
  ipcMain.handle('workspace:setSandboxState', (_e, sandboxState: {
    language: string
    code: string
    ok: boolean
    durationMs: number
    timedOut: boolean
    outputSummary: string
  } | null) => {
    try {
      setWorkspaceSandboxState(sandboxState)
      return { ok: true }
    } catch (err) {
      logError('ipc:workspace:setSandboxState', err)
      return { ok: false, error: (err as Error).message }
    }
  })
  // 代码沙箱：JS vm + Python 子进程 + 流式输出
  registerCodeSandboxIpcHandlers(ipcMain)
}

/** 启动编排原子 ⑭d：配置变化推前端 + 局域网启停随配置落地 */
export function initConfigChangedPush(state: AppState, deps: BootstrapDeps, mainWindow: BrowserWindow) {
  const { configStore } = deps
  // config 变化推送到前端：AI 通过 update_ai_name 等工具改 config 后，
  // 前端 appStore.config 需要同步刷新，否则 Settings 页显示旧值，用户保存还会覆盖 AI 的修改。
  // （update_abyss_md 改写 ABYSS AI.md 文件，不触发 config 变更推送）
  // ConfigStore.save 时触发 subscribe，主进程转发 'config:changed' 事件到渲染进程。
  let lastLanEnabled = configStore.get().lan?.enabled === true
  configStore.subscribe((newConfig) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config:changed', newConfig)
    }
    // 局域网启停随配置生效：AI 经 `lan_control` 工具改配置后由此落地（工具拿不到 userStore，
    // 不在工具内直连启停）；用户路径 `lan:setEnabled` 也只写配置，两条路径同一处生效。
    const enabled = newConfig.lan?.enabled === true
    if (enabled !== lastLanEnabled) {
      lastLanEnabled = enabled
      void state.multiInstance
        .setLanEnabled(enabled, state.userStore, () => configStore.get())
        .catch((err) => console.warn('[lan] 配置变更触发启停失败:', (err as Error).message))
    }
  })
}

/** 启动编排原子 ⑭e：窗口激活重建（macOS） */
export function initActivateHandler(state: AppState, deps: BootstrapDeps) {
  const { configStore } = deps
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
  state.mainWindow = createWindow()

  // 渲染进程桥接：让工具能向前端窗口发送 IPC 事件
  setRendererBridge((channel, data) => {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(channel, data)
    }
  })
      // 窗口重建后重新挂载 UI 缩放（新 webContents 实例，幂等重注册 IPC）
      try {
        initUiZoom(state.mainWindow, configStore)
      } catch (err) {
        logError('ui-zoom.attach', err)
      }
      // 窗口重建后重新挂载 UI 监控（新 webContents 实例）
      try {
        if (state.mainWindow && state.uiHealthMonitor) {
          state.uiHealthMonitor.attach(state.mainWindow)
        }
      } catch (err) {
        logError('ui-health.attach', err)
      }
    }
  })
}
