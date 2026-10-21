/**
 * @category 核心
 * @summary 启动装配原子 ⑩a⑩c⑪d⑫⑬：API server、AI 协作心跳、api:port IPC、Supervisor 及其链路、监控与清单
 *
 * 为什么存在：这七项此前平铺在 `index.ts`（约 360 行），属「后端域装配」——把 HTTP 服务、
 * 协作心跳、监督者（记忆工作流/空闲门/令牌预算）与其激活/重启链路、健康检查与模块清单接到启动链上。
 * 抽成独立模块后，入口只保留编排（ADR-01 第 3 步）。
 *
 * 什么作用：导出七个 `initXxx`，由 `service-assembly.ts` 按序调用；`state` 与 `deps` 显式传入。
 *
 * 不删理由：删掉即这 360 行退回 `index.ts`，入口重新同时承担编排与后端域装配两种职责。
 *
 * 顺序约束（迁移后仍必须按此调用）：`initApiServer` → `initCollaborationScheduler` →
 * `initApiPortIpc` → `initSupervisor` → `initActivationLink` / `initRestartPendingConsumer`
 * → `initMonitoringAndCatalog`；其中 `initActivationLink` / `initRestartPendingConsumer`
 * 依赖 `initSupervisor` 的返回值非空，且 `initApiPortIpc` 必须在 `initApiServer` 之后
 * （端口已确定）。
 */
import type { AppState } from './app-state'
import type { BootstrapDeps } from './deps'
import type { BaseDataPaths } from '../models/paths'
import { app, ipcMain, nativeTheme } from 'electron'
import { join } from 'path'
import { IS_CUSTOM_INSTANCE } from './runtime-paths'
import { startApiServer, getApiToken } from '../api/server'
import { LLMClient } from '../api/llm'
import { ToolResultDistiller, DEFAULT_DISTILL_CONFIG } from '../services/tool-result-distiller'
import { InternalSessionStore } from '../services/internal-session-store'
import { initDataDirectory } from '../models/data-init'
import { UserStore } from '../models/user-store'
import { type MemoryScope } from '../models/paths'
import { createToolRegistry } from '../tools'
import type { ToolContext } from '../tools'
import { McpClientManager } from '../mcp/client-manager'
import { PluginLoader } from '../plugins'
import { Supervisor, PathSyncMonitor, ErrorLog } from '../monitor'
import type { SupervisorCallbacks } from '../monitor'
import { ModuleRegistry } from '../monitor/module-registry'
import { resolveMonitorConfigDir } from '../monitor/monitor-config'
import { ActivationManager } from '../api/activation-manager'
import { consumeRestartPending } from '../api/restart-pending'
import { safeSend } from '../services/crash-logger'
import { MultiInstanceService } from '../multi-instance/index'
import { AiCollaborationScheduler } from '../multi-instance/ai-collaboration-scheduler'
import { WorkflowManager } from '../workflow/manager'
import { buildCollaborationSelfCheckPrompt } from '../prompts/social'
import { regenerateSystemCatalog, resolveCatalogSourceRoot } from '../services/system-catalog'
import type { AppConfig } from '@shared/types'
import { resolveLlmConfig } from '../startup-helpers'

/** 启动编排原子 ⑩a：API server 启动 + 端口登记（创建主路由、注入 activation 上下文） */
export async function initApiServer(deps: BootstrapDeps, opts: {
  userStore: UserStore
  activationManager: ActivationManager
  baseCtx: ToolContext
  dataPaths: ReturnType<typeof initDataDirectory>
  mcpClientManager: McpClientManager | null
  pluginLoader: PluginLoader | null
  internalSessionStore: InternalSessionStore
  multiInstance: MultiInstanceService
}) {
  const { configStore, sessionStore, rootCtx } = deps
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

/** 启动编排原子 ⑩c：AI 协作心跳调度器（仅非主实例启用） */
export function initCollaborationScheduler(state: AppState, activationManager: ActivationManager | null, multiInstance: MultiInstanceService, userStore: UserStore | null) {
  // AI 协作心跳：周期唤醒 AI 让它主动去聊天室/私聊/公示板发起协作。
  // 走主会话激活事件（不占 headless 串行队列）；standalone 角色下 LAN 未启动，自动不启用。
  state.collaborationScheduler = new AiCollaborationScheduler({
    timerRegistry: state.timerRegistry,
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
  state.collaborationScheduler.start()
  return state.collaborationScheduler
}

/**
/** 启动编排原子 ⑪d：api:port / api:token IPC（渲染进程取端口与访问令牌） */
export function initApiPortIpc(port: number) {
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

/** 启动编排原子 ⑫a：记忆工作流 LLM + Supervisor（前端空闲判定/记忆工作流作用域/令牌预算注入/配置热跟随） */
export function initSupervisor(state: AppState, deps: BootstrapDeps, opts: {
  dataPaths: ReturnType<typeof initDataDirectory>
  config: AppConfig
  workflowToolRegistry: ReturnType<typeof createToolRegistry>
  baseCtx: ToolContext
  pathSyncMonitor: PathSyncMonitor | null
  userStore: UserStore
  workflowManager: WorkflowManager | null
  setWorkflowScope: (scope: MemoryScope | null) => void
}) {
  const { configStore, rootCtx } = deps
  const { dataPaths, config, baseCtx, pathSyncMonitor, userStore, workflowManager, setWorkflowScope } = opts
  // 真 fiber 化守卫（G3）：monitor 服务未挂载（禁用/挂载失败）时跳过 Supervisor，
  // 记忆工作流/前端空闲门/激活链路降级不可用；before-quit 清理链已容忍 null
  if (!rootCtx.featurePlugins.isEnabled('monitor')) {
    console.warn('[supervisor] monitor 功能已禁用，Supervisor 跳过（记忆工作流/前端空闲门不可用）')
    return null
  }
  const tools = Array.from(opts.workflowToolRegistry.tools.values())
  // 文档 15.4：记忆工作流的 LLM 独立配置不跟随前端 AI。记忆工作流用独立 LLMClient 实例，
  // 避免与前端 AI 抢占同一本地模型推理资源（Ollama 默认串行 NUM_PARALLEL=1）
  // 注意：前端 AI 的 LLMClient 由 server.ts 内部创建，此处不创建（原 llmClient 是死代码已删除）
  // workflowLlm 服务记忆工作流 + 工作流评测。
const workflowLlmClient = new LLMClient(resolveLlmConfig(config.workflowLlm, config.llm))
  if (!workflowLlmClient.isReady()) {
    console.info(
      '[index] 记忆工作流 LLM 未配置（model 为空且未跟随前端），记忆工作流后台任务不会执行 LLM 调用。请在设置中配置记忆工作流模型或开启「跟随前端 AI 配置」以启用记忆系统。'
    )
  }
  // 记忆工作流专用工具结果蒸馏器：独立于 server.ts 的 distiller（记忆工作流用独立 workflowLlmClient，
  // 与主会话/工作流隔离，避免 LLM 实例抢占与蒸馏递归回环）。语义与 server.ts 一致：
  // 用户配置优先、缺省回退单源默认；蒸馏失败重试一次仍失败保留原文。
  const workflowDistiller = new ToolResultDistiller(
    () => workflowLlmClient,
    () => ({ ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) })
  )
  // 记忆工作流/子 agent 蒸馏回调工厂：与 server.ts makeDistillCallbacks 同一合并形态，
  // 记忆工作流评估与子 agent 内部工具结果同样先提炼再进上下文（一视同仁，不折叠不截断的原则不变）。
  const workflowDistillCallbacks = (): {
    distillToolResult?: (toolName: string, toolCallId: string, result: string, intent?: string) => Promise<string | undefined>
    distillIntentTurnPairs?: number
  } => {
    const distillCfg = { ...DEFAULT_DISTILL_CONFIG, ...(configStore.get().toolResultDistill ?? {}) }
    return {
      distillToolResult: async (toolName: string, _toolCallId: string, result: string, intent?: string) =>
        (await workflowDistiller.distill(toolName, result, intent)) ?? undefined,
      distillIntentTurnPairs: distillCfg.intentTurnPairs
    }
  }
  const monitorConfigDir = resolveMonitorConfigDir(dataPaths.root)
  const supervisorCallbacks: SupervisorCallbacks = {
    onOutput: (taskId, text) => {
      console.log(`[memory-workflow ${taskId}] ${text}`)
      safeSend(state.mainWindow, 'memoryWorkflow:output', { taskId, text })
    },
    onWorkflowStart: (taskId) => {
      safeSend(state.mainWindow, 'memoryWorkflow:start', { taskId })
    },
    onWorkflowComplete: (taskId) => {
      safeSend(state.mainWindow, 'memoryWorkflow:complete', { taskId })
    },
    onCrash: (taskId, reason) => {
      console.error(`[memory-workflow ${taskId}] crash: ${reason}`)
      safeSend(state.mainWindow, 'memoryWorkflow:crash', { taskId, reason })
    },
    onContinueHint: (taskId) => {
      safeSend(state.mainWindow, 'memoryWorkflow:continueHint', { taskId })
    },
    onStopped: (taskId, reason) => {
      console.error(`[memory-workflow ${taskId}] stopped: ${reason}`)
      safeSend(state.mainWindow, 'memoryWorkflow:stopped', { taskId, reason })
    },
    onCycleStart: () => {
      safeSend(state.mainWindow, 'memoryWorkflow:cycleStart', {})
    },
    onCycleComplete: () => {
      safeSend(state.mainWindow, 'memoryWorkflow:cycleComplete', {})
    },
    onNoMemory: () => {
      safeSend(state.mainWindow, 'memoryWorkflow:noMemory', {})
    },
    onConditionWait: (reason) => {
      safeSend(state.mainWindow, 'memoryWorkflow:conditionWait', { reason })
    },
    onAskUser: (taskId, question, context, sessionId) => {
      safeSend(state.mainWindow, 'memoryWorkflow:askUser', {
        taskId,
        question,
        context,
        sessionId
      })
      // 文档 15.2.1：后端协作——记忆工作流事件注入激活队列
      state.activationManager?.pushDmnEvent(`记忆工作流-${taskId} 请求关注：${question}（上下文：${context}）`)
    }
  }

  state.supervisor = rootCtx.monitor.initSupervisor(
    dataPaths,
    workflowLlmClient,
    tools,
    baseCtx,
    monitorConfigDir,
    pathSyncMonitor?.getErrorLog() ?? new ErrorLog(dataPaths.fileMonitorErrorLog),
userStore,
    supervisorCallbacks,
    state.timerRegistry,
    workflowDistillCallbacks
  )

  // 工作流引擎：注入 WorkflowManager 提供者（延迟访问，避免构造时序依赖）
  // MemoryWorkflowScheduler 通过此 provider 订阅工作流事件 + 启动记忆处理流水线实例
  // 必须在 supervisor.start() 之前注入：start() 会立即订阅事件，
  // 若 provider 为空则订阅失败 → wf:completed 事件无人接收 →
  // 进度不更新 + running 卡死 → 流水线停摆
  state.supervisor.setWorkflowManagerProvider(() => workflowManager)

  // 分层改造：把 setWorkflowScope 注入调度器（处理 RAW 批次时设置作用域，
  // 工作流 ctx.paths 动态解析落 {uid}/{aiId}/ 目录）
  state.supervisor.setMemoryWorkflowScopeSetter(setWorkflowScope)

  state.supervisor.start()

// 记忆工作流与前端 AI 共用 tokenBudget，保证上下文管理一致
  // 记忆工作流跨批次累积上下文，达到 tokenBudget 时 FIFO 截断
  state.supervisor.setTokenBudgetProvider(() => configStore.get().tokenBudget ?? 0)

  // 订阅配置变更，更新 LLM 客户端（替代 2 秒轮询）
  configStore.subscribe((newConfig, oldConfig) => {
    // followMain：比较 resolve 后的生效值（跟随前端时前端 llm 变化也触发更新）
    const newWorkflowCfg = resolveLlmConfig(newConfig.workflowLlm, newConfig.llm)
    const oldWorkflowCfg = resolveLlmConfig(oldConfig.workflowLlm, oldConfig.llm)
    if (JSON.stringify(newWorkflowCfg) !== JSON.stringify(oldWorkflowCfg)) {
      workflowLlmClient.updateConfig(newWorkflowCfg)
      console.log('[index] 记忆工作流 LLMClient 已更新（配置变更）')
    }
    // 主题变更：同步 nativeTheme.themeSource，让原生 UI（滚动条/标题栏）匹配新主题
    // 浅色主题（霜璃/素笺）用 light，深色主题（夜幕/紫夜）用 dark
    if (newConfig.theme !== oldConfig.theme) {
      nativeTheme.themeSource =
        newConfig.theme === 'night' || newConfig.theme === 'violet-night' ? 'dark' : 'light'
    }
    // tokenBudget 变更：同步下发到记忆工作流调度器
    if (newConfig.tokenBudget !== oldConfig.tokenBudget) {
      state.supervisor?.setTokenBudgetProvider(() => newConfig.tokenBudget ?? 0)
    }
  })
  return state.supervisor
}

/** 启动编排原子 ⑫b：激活链路（前端空闲门 + 激活回调） */
export function initActivationLink(state: AppState, activationManager: ActivationManager | null, supervisor: Supervisor) {
  const supervisorRef = supervisor

  // 外部事件激活链路：前端 AI 空闲时，外部事件（cron/健康检查/重启续接）可触发 AI 运行
  activationManager?.setFrontendIdleProvider(() => supervisorRef.isFrontendIdle())
  activationManager?.setActivationCallback(() => {
    if (supervisorRef.isFrontendIdle()) {
      const content = activationManager?.peekActivationContent(supervisorRef.activeSessionId ?? undefined) ?? null
      safeSend(state.mainWindow, 'activation:trigger', { content })
    }
  })
}

/** 启动编排原子 ⑫c：重启待办消费（受限目录更新后自动重试） */
export function initRestartPendingConsumer(state: AppState, dataPaths: BaseDataPaths, supervisor: Supervisor) {
  const supervisorRef = supervisor
  // 重启待办消费：AI 自我重启前写入的持久化标记，启动后唤醒 AI 自动续接
  // （"重启后自己激活自己"——不依赖内存态自动续接，进程重启后也能续上）
  //
  // 修复：不能启动后立即消费。原因——重启后前端渲染进程此时
  // 大概率还没连上 WebSocket、currentSessionId 还没恢复（loadSessions→selectSession
  // 是异步的），activation:trigger 事件发过去被前端 triggerActivation 守卫
  // （!currentSessionId || !ws || ws.readyState !== OPEN 直接 return）静默丢弃，
  // 且标记已被 consumeRestartPending 删除 → 永不重试 → "重启后没再次激活"。
  // 方案：轮询等待 supervisor.activeSessionId 非空（前端 selectSession/createSession
  // 成功后通过 memoryWorkflow:setActiveSession 同步，意味着 ws 已连 + 会话已恢复），
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
        const uiEvents = state.uiHealthMonitor?.consumePendingEvents()

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
          state.activationManager?.pushExternalEvent(parts.join('\n'), true)
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
    state.timerRegistry.setTimeout(tryConsumeRestartPending, 1000, 'restart-pending-wait-frontend')
  }
  tryConsumeRestartPending()
}

/** 启动编排原子 ⑬：健康检查 + 模块注册 + 前端系统清单生成 */
export function initMonitoringAndCatalog(state: AppState, deps: BootstrapDeps, dataPaths: BaseDataPaths) {
  const { rootCtx } = deps
  // 健康检查（C 方案）：
  // 定时自检工作区代码（typecheck/test/lint/build），发现问题注入外部事件唤醒前端 AI 自主修复。
  // 防死循环：只在应用运行时启动（随主进程生命周期）、AlertGate 去重+冷却+连续失败上限、
  // 事件队列仅在 AI 空闲时触发。配置持久化到 {dataDir}/.health_check/config.json。
  // 模块注册表：全架构模块清单 + 运行时状态（健康检查报错同步标红，面板「模块监控」tab 展示）
  // 状态持久化到 {dataDir}/.health_check/module-status.json，AI 可直接 Read 文件查看模块监控状态
  state.moduleRegistry = new ModuleRegistry({
    statusFile: join(dataPaths.root, '.health_check', 'module-status.json')
  })
  if (rootCtx.featurePlugins.isEnabled('monitor')) {
    state.healthCheck = rootCtx.monitor.initHealthCheck({
      workDir: app.getAppPath(),
      // dataRoot：打包态 files 检查扫描目标 + dumpFullOutput 落盘目录（asar 内只读不可写）
      dataRoot: dataPaths.root,
      configDir: join(dataPaths.root, '.health_check'),
      activationManager: state.activationManager,
      timerRegistry: state.timerRegistry,
      moduleRegistry: state.moduleRegistry
    })
    state.healthCheck.start()
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
  return { moduleRegistry: state.moduleRegistry, healthCheck: state.healthCheck }
}
