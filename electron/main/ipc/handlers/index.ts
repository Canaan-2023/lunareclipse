/**
 * @category 核心
 * @summary IPC 处理器：渲染进程请求分发到各领域模块

 * 为什么存在：渲染进程不能直接访问主进程服务，需要统一的 IPC 注册
 * 入口集中装载各领域 handler，并一次性注入共享依赖（store / manager 等），
 * 避免通道注册散落各处、依赖在各模块间漂移——
 */
import { ipcMain, BrowserWindow, dialog } from 'electron'
import type { ConfigStore } from '../../api/config-store'
import type { SessionStore } from '../../api/session-store'
import type { UserStore } from '../../models/user-store'
import type { BaseDataPaths } from '../../models/paths'
import type { Supervisor, PathSyncMonitor } from '../../monitor'
import type { HealthCheck } from '../../monitor/health-check'
import type { ModuleRegistry } from '../../monitor/module-registry'
import type { ActivationManager } from '../../api/activation-manager'
import type { McpClientManager } from '../../mcp/client-manager'
import type { EvalHarness } from '../../eval/harness'
import type { WorkflowManager } from '../../workflow/manager'
import type { SkillLoader } from '../../skills/loader'
import type { SkillMarket } from '../../skills/market'
import type { PluginLoader } from '../../plugins'
import type { CronScheduler } from '../../cron/scheduler'
import type { FeaturePluginsService } from '../../kernel/feature-plugins'
import type { InternalSessionStore } from '../../services/internal-session-store'
import { registerConfigHandlers } from './config'
import { registerSessionHandlers } from './session'
import { registerWindowHandlers } from './window'
import { registerDmnHandlers } from './dmn'
import { registerAuthHandlers } from './auth'
import { registerVisualizationHandlers } from './visualization'
import { registerShellHandlers } from './shell'
import { registerMcpHandlers } from './mcp'
import { registerHooksHandlers } from './hooks'
import { registerEvalHandlers } from './eval'
import { registerWorkflowHandlers } from './workflow'
import { registerSkillHandlers } from './skill'
import { registerWorkspaceHandlers } from './workspace'
import { registerLilithHandlers } from './lilith'
import { registerMessagingHandlers } from './messaging'
import { registerPluginHandlers } from './plugin'
import { registerCronHandlers } from './cron'
import { registerTodoHandlers } from './todo'
import { registerCalendarHandlers } from './calendar'
import { registerDiaryHandlers } from './diary'
import { registerAiHandlers } from './ai'
import { registerInstanceHandlers } from './instance'
import { registerProfileHandlers } from './profile'

export interface IpcHandlerDeps {
  configStore: ConfigStore
  sessionStore: SessionStore
  mainWindow: BrowserWindow | null
  /** getter 形式：handler 调用时读取最新值，避免初始化时序依赖 */
  getUserStore: () => UserStore | null
  getSupervisor: () => Supervisor | null
  getPathSyncMonitor: () => PathSyncMonitor | null
  /** 健康检查模块（主进程常驻自检，viz:getAll / viz:healthCheckRun 用） */
  getHealthCheck: () => HealthCheck | null
  /** 模块注册表（全架构模块清单 + 运行时状态，viz:getAll 附带返回） */
  getModuleRegistry: () => ModuleRegistry | null
  /** 激活管理器（AI 活跃倒计时可视化，viz:getAll 附带返回） */
  getActivationManager: () => ActivationManager | null
  getDataPaths: () => BaseDataPaths | null
  getMcpClientManager: () => McpClientManager | null
  /** 验证层：EvalHarness getter（按需构造，按 suite 名选择前端/后端 harness） */
  getEvalHarness: (suite?: string) => EvalHarness | null
  /** L8 工作流引擎：WorkflowManager getter（按需构造，避免初始化时序依赖） */
  getWorkflowManager: () => WorkflowManager | null
  /** SkillLoader getter（DMN 共享，热重载由 SkillLoader 内部处理） */
  getSkillLoader: () => SkillLoader | null
  /** Skill 市场 getter（skill:market-* 通道用） */
  getSkillMarket: () => SkillMarket | null
  /**
   * 莉莉丝：用户点「启动莉莉丝桌宠」前的 MOD 配置补同步。
   * 为什么是回调而不是直接在 handler 里写文件：桥接的冷启动执行受「随月蚀启动」开关控制，
   * 关着的时候冷启动完全不碰莉莉丝，手动启动这一刻必须补一次，否则 companion 读到旧 provider。
   * 可选（缺省 undefined）——测试与最小装配场景下不接桥接也能注册 handler。
   */
  onLilithBeforeLaunch?: () => void
/** 模块系统：PluginLoader getter（plugin:list/toggle 用） */
  getPluginLoader: () => PluginLoader | null
  /** 内核功能插件对象表 getter（featurePlugins:list/toggle 用，阶段 4） */
  getFeaturePlugins: () => FeaturePluginsService | null
  /** Cron 调度器 getter（cron:list/upsert/delete/toggle 用，新版 cron/scheduler.ts） */
  getCronService: () => CronScheduler | null
/** 工作区配置文件路径 getter：{userData}/.workspaces.json，运行期求值（未登录态禁止解析分层路径） */
  workspaceConfigPath: () => string
/** 内部会话存储（前端树块挂载位原位替换：列表/详情/CRUD） */
  getInternalSessionStore: () => InternalSessionStore | null
  /** 认证成功后回调（主分系统：登录/注册成功时补启分系统同步） */
  onAuthSuccess?: () => void
}

/**
 * 统一注册所有 IPC handler。
 *
 * 各域 handler 拆分到独立文件（config/session/window/dmn/auth/visualization/shell/mcp/hooks/eval/workflow/skill），
 * 本函数按依赖顺序聚合调用。getter 形式的依赖（supervisor/userStore 等）在
 * handler 回调执行时才读取，避免初始化时序问题。
 *
 * hooks handler 无外部依赖（直接走文件系统），不需要从 deps 注入。
 * eval handler 依赖 EvalHarness（按需构造），通过 getter 注入。
 * workflow handler 依赖 WorkflowManager（按需构造），通过 getter 注入。
 * skill handler 依赖 SkillLoader（DMN 共享），通过 getter 注入。
 */
export function registerAllIpcHandlers(ipc: typeof ipcMain, deps: IpcHandlerDeps): void {
  registerConfigHandlers(ipc, deps.configStore, deps.mainWindow)
  registerSessionHandlers(ipc, deps.sessionStore, deps.configStore, deps.getInternalSessionStore)
  registerWindowHandlers(ipc, deps.mainWindow)
  registerDmnHandlers(ipc, deps.getSupervisor, deps.getDataPaths, deps.configStore)
  registerAuthHandlers(ipc, deps.getUserStore, () => deps.sessionStore, deps.getDataPaths, deps.onAuthSuccess)
  registerVisualizationHandlers(ipc, deps.getDataPaths, deps.getPathSyncMonitor, deps.getHealthCheck, deps.getModuleRegistry, deps.getActivationManager, deps.getUserStore)
  registerShellHandlers(ipc)
  registerMcpHandlers(ipc, deps.getMcpClientManager, deps.mainWindow)
  registerHooksHandlers(ipc, deps.getUserStore, dialog)
  registerEvalHandlers(ipc, deps.getEvalHarness)
  registerWorkflowHandlers(ipc, deps.getWorkflowManager, () => deps.mainWindow)
  // skill 通道强制登录（createAuthGuard），未登录抛 Unauthorized；skill 数据按 U{uid}/AI{aiId} 前缀分层
  registerSkillHandlers(ipc, deps.getSkillLoader, deps.getSkillMarket, deps.getUserStore)
  // 莉莉丝桌宠连接（检测/保存/启动/状态）
  registerLilithHandlers(ipc, deps.configStore, deps.onLilithBeforeLaunch)
  // 消息接入（飞书等外部平台 → 月蚀大脑：配置/状态/重启）
  registerMessagingHandlers(ipc, deps.configStore, deps.getUserStore)
  // 工作区配置（AI 专属工作区，类似 .mcp.json 的配置层设计）
  registerWorkspaceHandlers(ipc, dialog, deps.workspaceConfigPath)
// 模块系统（plugin:list/toggle/openDir + featurePlugins:list/toggle）
  registerPluginHandlers(ipc, deps.getPluginLoader, deps.getUserStore, deps.getFeaturePlugins)
// Cron 定时任务（cron:list/upsert/delete/toggle/openJobs）
  registerCronHandlers(ipc, deps.getCronService)
  // 任务清单（计划面板读取 .activation/todos.json）
  registerTodoHandlers(ipc, deps.getDataPaths)
  // 日历系统（日历面板读写 {root}/memory/U{uid}/AI{aiId}/calendar/entries.json，uid/aiId 隔离）
  registerCalendarHandlers(ipc, deps.getDataPaths, deps.getUserStore)
  // 日记系统（日历面板按日期读当天日记 {root}/memory/U{uid}/AI{aiId}/raw_memory/YYYY/MM/DD/diary.md）
  registerDiaryHandlers(ipc, deps.getDataPaths, deps.getUserStore)
  // AI 管理（多 AI 子系统：注册表接线，ai:list/register/update/deactivate/reactivate/getPrompt/savePrompt/remove）
  registerAiHandlers(ipc, deps.getDataPaths, () => deps.sessionStore, deps.getUserStore)
  // 多实例多开（P5：instance:info 当前实例 + instance:launch spawn 新实例）
  registerInstanceHandlers(ipc)
  // 个人中心（：昵称/头像 + USER.md 用户资料文件读写）
  registerProfileHandlers(ipc, deps.getUserStore, deps.getDataPaths)
}

// 保持向后兼容：原 registerIpcHandlers 导出名
export { registerAllIpcHandlers as registerIpcHandlers }

// 类型再导出，方便外部使用
export type { Supervisor, PathSyncMonitor } from '../../monitor'
