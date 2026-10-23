/**
 * @category 核心
 * @summary 组合根状态容器：主进程启动期跨原子共享的 26 个进程级引用的唯一类型化归属
 *
 * 为什么存在：`index.ts` 此前以 26 个裸模块级 `let` 承载启动状态（主窗口、各服务句柄、
 * 生命周期标志），`whenReady` 装配链与 `onBeforeQuit` 清理链分别读写同一批变量——
 * 「谁先声明谁先赢」决定模块边界，新增启动步骤只能继续往同一文件堆（CODE-RULES §三 R1/R3 根因）。
 * 本模块把该批状态收进单一类型化容器：字段可枚举、可传参、可测试，装配函数签名从
 * 「隐式读模块级变量」变为「显式收 state」（ADR-01 第 1 步）。
 *
 * 什么作用：导出 `AppState` 接口与 `createAppState()` 工厂。**本模块不含任何副作用**
 * （唯一例外是 `timerRegistry` 的 `getGlobalTimerRegistry()`——它返回进程级单例，无 IO）。
 *
 * 不删理由：容器是「启动期跨原子共享状态」的唯一 owner。删掉它，26 个引用重新散落为裸
 * 模块级变量，装配函数与清理链的隐式耦合立即回归（ADR-01 的全部后续步序都以此为地基）。
 *
 * 时序语义（与拆分前逐字一致）：字段初始值 = 拆分前各 `let` 的声明初值；
 * `multiInstance` 原为**无初值声明**（赋值前读得 `undefined`），此处保留该「声明即承诺」的
 * 类型语义（见字段注释），以免 50 处使用点被迫加可选链而改变行为。
 */
import type { BrowserWindow } from 'electron'
import type { Supervisor, PathSyncMonitor, HealthCheck } from '../monitor'
import type { ModuleRegistry } from '../monitor/module-registry'
import type { UiHealthMonitor } from '../monitor/ui-health-monitor'
import type { AutoCleanupService } from '../services/auto-cleanup'
import type { UserStore } from '../models/user-store'
import type { LilithAdapter } from '../services/lilith-adapter'
import type { MultiInstanceService } from '../multi-instance/index'
import type { AiCollaborationScheduler } from '../multi-instance/ai-collaboration-scheduler'
import type { McpClientManager } from '../mcp/client-manager'
import type { EvalHarness } from '../eval'
import type { HumanGrader } from '../eval/graders/human-grader'
import type { ActivationManager } from '../api/activation-manager'
import type { LLMClient } from '../api/llm'
import type { CoeffectHandle } from '../kernel'
import type { SandboxExecService } from '../tools/code-sandbox'
import type { MemoryScope } from '../models/paths'
import { getGlobalTimerRegistry } from '../monitor/timer-registry'

/**
 * 启动期跨原子共享状态。
 *
 * 字段分三类：
 * ① **句柄**（装配期赋值、退出链读取）：`mainWindow` / `supervisor` / `pathSyncMonitor` /
 *    `userStore` / `lilithAdapter` / `multiInstance` / `activationManager` / `collaborationScheduler` /
 *    `mcpClientManager` / `healthCheck` / `moduleRegistry` / `uiHealthMonitor` / `autoCleanup` /
 *    `sandboxCoeffectHandle` / `detachCordis` / `evalHarness` / `workflowEvalHarness` / `humanGrader` /
 *    `lilithLlmClient`；
 * ② **标志位**：`lilithStarted` / `aiRestarting` / `quitting`；
 * ③ **进程级单例 / 简单值**：`timerRegistry` / `lifecycleActivationDir` / `currentWorkflowScope` /
 *    `apiPortForLilithBridge`。
 */
export interface AppState {
  /** 主窗口（未创建为 null；崩溃重建链与 IPC 层读取） */
  mainWindow: BrowserWindow | null
  /** 监督者（空闲门 / 记忆工作流调度；未装配为 null） */
  supervisor: Supervisor | null
  /** 路径同步监控（多实例数据同步；未装配为 null） */
  pathSyncMonitor: PathSyncMonitor | null
  /** 用户存储（登录态；未装配为 null） */
  userStore: UserStore | null
  /** 莉莉丝适配器（桌宠链路；未装配为 null） */
  lilithAdapter: LilithAdapter | null
  /**
   * 多实例 / 局域网服务。**原声明无初值**（`let multiInstance: MultiInstanceService`），
   * 运行期在装配链内赋值，赋值前读得 `undefined`——这是既有行为。
   * 用断言保留「声明即承诺」的类型语义：50 处使用点因此无需可选链，行为零变更。
   */
  multiInstance: MultiInstanceService
  /** 莉莉丝三件套是否已在登录成功后启动过（幂等守卫：重复登录/切换用户只启动一次） */
  lilithStarted: boolean
  /** 莉莉丝适配器专用 LLM 客户端（懒创建，跟随 config.llm） */
  lilithLlmClient: LLMClient | null
  /** 激活管理（激活码 / 生命周期记录；未装配为 null） */
  activationManager: ActivationManager | null
  /** AI 协作心跳（周期唤醒 AI 主动发起跨实例协作；随局域网启停） */
  collaborationScheduler: AiCollaborationScheduler | null
  /** MCP 客户端管理器（未装配为 null） */
  mcpClientManager: McpClientManager | null
  /** 评测台（eval:* 通道；未装配为 null） */
  evalHarness: EvalHarness | null
  /** 工作流评测台（未装配为 null） */
  workflowEvalHarness: EvalHarness | null
  /** 人工评分器（构造即注册 eval:submitHumanGrade IPC；变量仅作持有引用） */
  humanGrader: HumanGrader | null
  /** 健康检查（未装配为 null） */
  healthCheck: HealthCheck | null
  /** 模块注册表（未装配为 null） */
  moduleRegistry: ModuleRegistry | null
  /** UI 健康监控（未装配为 null） */
  uiHealthMonitor: UiHealthMonitor | null
  /** 自动清理服务（未装配为 null） */
  autoCleanup: AutoCleanupService | null
  /** 沙箱 coeffect 句柄（退出链 dispose 回滚） */
  sandboxCoeffectHandle: CoeffectHandle<SandboxExecService> | null
  /**
   * Cordis 模块卸载函数（退出链逆序卸载）。
   * async 原因：mountCordisPlugins 返回 async detach（卸载全部 fiber 需 await 落定，
   * 论文「依赖 key 在被依赖者完整卸载前保持可读」要求卸载动作完成才能退出）。
   */
  detachCordis: (() => void | Promise<void>) | null
  /** AI 自我重启标记（`app_restart` 工具置位 → 绿通保留；退出链据此记 'ai-restart'） */
  aiRestarting: boolean
  /** 生命周期记录目录（装配期赋值 / 退出链读取；未赋值为 null） */
  lifecycleActivationDir: string | null
  /**
   * 当前工作流作用域：记忆调度器处理某 (uid, aiId) 的 RAW 批次时设置，
   * workflow ctx 的 paths getter 据此解析作用域路径（工作流无登录态，靠 RAW 路径推断归属）。
   */
  currentWorkflowScope: MemoryScope | null
  /** 莉莉丝桥接面所用 API 端口（API server 起好后回填；0 = 未就绪） */
  apiPortForLilithBridge: number
  /** 是否正在退出（退出链重入守卫） */
  quitting: boolean
  /** 全局定时器注册表（进程级单例；退出链 stopAll） */
  timerRegistry: ReturnType<typeof getGlobalTimerRegistry>
}

/**
 * 创建启动状态容器。**无副作用**（`timerRegistry` 取进程级单例，不产生 IO / 监听）。
 *
 * 何时用：`index.ts` 顶层创建一次（`const state = createAppState()`），此后由各装配模块
 * 以参数形式接收（`initXxx(state, ...)`），不再有模块级可变绑定。
 */
export function createAppState(): AppState {
  return {
    mainWindow: null,
    supervisor: null,
    pathSyncMonitor: null,
    userStore: null,
    lilithAdapter: null,
    // 断言依据见字段注释：保留原「无初值声明」的类型语义，赋值前读得 undefined
    multiInstance: undefined as unknown as MultiInstanceService,
    lilithStarted: false,
    lilithLlmClient: null,
    activationManager: null,
    collaborationScheduler: null,
    mcpClientManager: null,
    evalHarness: null,
    workflowEvalHarness: null,
    humanGrader: null,
    healthCheck: null,
    moduleRegistry: null,
    uiHealthMonitor: null,
    autoCleanup: null,
    sandboxCoeffectHandle: null,
    detachCordis: null,
    aiRestarting: false,
    lifecycleActivationDir: null,
    currentWorkflowScope: null,
    apiPortForLilithBridge: 0,
    quitting: false,
    timerRegistry: getGlobalTimerRegistry()
  }
}
