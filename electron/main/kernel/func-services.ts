/**
 * 月蚀功能服务（阶段 4）

 * 功能模块的 ctx 服务形态。与核心服务（core-services.ts）同模式：
 * 真单例由服务持有（init 幂等，index.ts/server.ts 逐步改走 ctx），
 * 工厂/能力统一入口。本层放「独立性强、可整体服务化」的功能模块，
 * 逐步收编 index.ts/server.ts 里散落的构造点。
 */

import { Context, Service } from '../vendor/cordis/index.ts'
import { SkillLoader } from '../skills/loader'
import { McpClientManager } from '../mcp/client-manager'
import { browserManager } from '../tools/browser-manager'
import { LilithAdapter, type LilithAdapterOptions } from '../services/lilith-adapter'
import { SubAgentManager } from '../sub-agent'
import type { NamedTool, ConcurrencyConfig, SubAgentExecuteFn, SubAgentEvent } from '../sub-agent'
import { CronScheduler } from '../cron/scheduler'
import { WorkflowManager, type WorkflowManagerDeps } from '../workflow/manager'
import { Supervisor, PathSyncMonitor, HealthCheck, type HealthCheckOptions } from '../monitor'
import type { ActivationManager } from '../api/activation-manager'
import type { TimerRegistry } from '../monitor/timer-registry'
import type { ToolContext } from '../tools/base-tool'
import {
  installIdleSuppression,
  installFactCheckReminder,
  installClosingReflection,
  installFailureCircuitBreaker
} from './governance'
import type { ExtensionRegistrar } from './extension'

// ─── 声明合并：功能服务登记进 Context 类型 ───
declare module '../vendor/cordis/context.ts' {
  interface Context {
    /** 治理机制（governance：空转抑制/查证提醒/收尾反思/失败止损） */
    governance: GovernanceService
    /** 技能池加载器（真单例） */
    skills: SkillsService
    /** MCP 客户端管理器（真单例） */
    mcp: McpService
    /** 浏览器管理器（模块级单例包装） */
    browser: BrowserService
    /** 莉莉丝适配器工厂（多实例；仅链路 B 可选开关启用） */
    lilith: LilithService
    /** 子 agent 管理器工厂（多实例：前端 AI / DMN 各一） */
    subagent: SubAgentService
    /** 定时任务调度器工厂（多实例：前端 / DMN 各一） */
    cron: CronService
    /** 工作流引擎（真单例，index.ts 注入依赖） */
    workflow: WorkflowService
    /** 监视器组（PathSync/Supervisor/HealthCheck，真单例） */
    monitor: MonitorService
  }
}

/** ctx.governance：确定性治理 hook 组（不靠 AI 自觉的机制兜底） */
export class GovernanceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'governance')
  }

  /** 批量安装全部治理机制到给定 registrar（kernelRegistry 的 builtin 注册） */
  installAll(reg: ExtensionRegistrar): void {
    installIdleSuppression(reg)
    installFactCheckReminder(reg)
    installClosingReflection(reg)
    installFailureCircuitBreaker(reg)
  }
}

/** ctx.skills：技能池加载器（真单例，与 server.ts 的 skillLoader 共享同一实例） */
export class SkillsService extends Service {
  private _loader: SkillLoader | null = null

  constructor(ctx: Context) {
    super(ctx, 'skills')
  }

  /**
   * 初始化（幂等）：创建 SkillLoader。
   * 参数与 server.ts 的构造点一致（getDomainSkillsDir/getDefaultSkillsConfigPath）。
   * configPath 支持字符串或 (() => string)：生产传函数引用延迟求值（登录后按
   * uid/aiId 分层解析），测试传字符串行为不变。
   */
  init(
    getDomainSkillsDir: () => string | null,
    configPath: string | (() => string)
  ): SkillLoader {
    if (!this._loader) {
      this._loader = new SkillLoader(getDomainSkillsDir, configPath)
    }
    return this._loader
  }

  /** 当前 SkillLoader 实例（未 init 时抛错——防止绕过启动链） */
  get loader(): SkillLoader {
    if (!this._loader) {
      throw new Error('ctx.skills 未初始化：请先在启动链调用 skills.init(...)')
    }
    return this._loader
  }
}

/** ctx.mcp：MCP 客户端管理器（真单例，与 index.ts 的 mcpClientManager 共享同一实例） */
export class McpService extends Service {
  private _manager: McpClientManager | null = null

  constructor(ctx: Context) {
    super(ctx, 'mcp')
  }

  /** 初始化（幂等）：创建 McpClientManager */
  init(): McpClientManager {
    if (!this._manager) {
      this._manager = new McpClientManager()
    }
    return this._manager
  }

  /** 当前 McpClientManager 实例（未 init 时抛错——防止绕过启动链） */
  get manager(): McpClientManager {
    if (!this._manager) {
      throw new Error('ctx.mcp 未初始化：请先在启动链调用 mcp.init()')
    }
    return this._manager
  }
}

/** ctx.browser：浏览器管理器（模块级单例浏览器实例的 ctx 门面） */
export class BrowserService extends Service {
  /** 模块级单例（tools/browser-manager.ts 创建，全进程共享） */
  readonly manager = browserManager

  constructor(ctx: Context) {
    super(ctx, 'browser')
  }
}

/** ctx.lilith：莉莉丝适配器工厂（多实例——仅 config.lilith.useAdapter 的链路 B 启用） */
export class LilithService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'lilith')
  }

  /** 创建 LilithAdapter（统一构造点） */
  create(options: LilithAdapterOptions): LilithAdapter {
    return new LilithAdapter(options)
  }
}

/** ctx.subagent：子 agent 管理器工厂（多实例——前端 AI 与 DMN 各持一实例） */
export class SubAgentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'subagent')
  }

  /** 创建 SubAgentManager（统一构造点，参数与 server.ts / monitor 构造点一致） */
  create<T extends NamedTool>(
    executeFn: SubAgentExecuteFn<T>,
    allTools: T[],
    baseCtx: ToolContext,
    concurrency?: ConcurrencyConfig,
    onEvent?: (evt: SubAgentEvent) => void
  ): SubAgentManager<T> {
    return new SubAgentManager(executeFn, allTools, baseCtx, concurrency, onEvent)
  }
}

/** ctx.cron：定时任务调度器工厂（多实例——前端 / DMN 各一） */
export class CronService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'cron')
  }

  /** 创建 CronScheduler（统一构造点，参数与 index.ts / server.ts 构造点一致） */
  create(
    jobsPath: string,
    activationManager: ActivationManager,
    timerRegistry: TimerRegistry
  ): CronScheduler {
    return new CronScheduler(jobsPath, activationManager, timerRegistry)
  }
}

/** ctx.workflow：工作流引擎（真单例，index.ts 注入依赖） */
export class WorkflowService extends Service {
  private _manager: WorkflowManager | null = null

  constructor(ctx: Context) {
    super(ctx, 'workflow')
  }

  /** 初始化（幂等）：创建 WorkflowManager（deps 与 index.ts 构造点一致） */
  init(deps: WorkflowManagerDeps): WorkflowManager {
    if (!this._manager) {
      this._manager = new WorkflowManager(deps)
    }
    return this._manager
  }

  /** 当前 WorkflowManager 实例 */
  get manager(): WorkflowManager {
    if (!this._manager) {
      throw new Error('ctx.workflow 未初始化：请先在启动链调用 workflow.init(deps)')
    }
    return this._manager
  }
}

/** ctx.monitor：监视器组（PathSync/Supervisor/HealthCheck，真单例） */
export class MonitorService extends Service {
  private _pathSync: PathSyncMonitor | null = null
  private _supervisor: Supervisor | null = null
  private _healthCheck: HealthCheck | null = null

  constructor(ctx: Context) {
    super(ctx, 'monitor')
  }

  /** 初始化 PathSyncMonitor（幂等） */
  initPathSync(...args: ConstructorParameters<typeof PathSyncMonitor>): PathSyncMonitor {
    if (!this._pathSync) {
      this._pathSync = new PathSyncMonitor(...args)
    }
    return this._pathSync
  }

  /** 初始化 Supervisor（幂等） */
  initSupervisor(...args: ConstructorParameters<typeof Supervisor>): Supervisor {
    if (!this._supervisor) {
      this._supervisor = new Supervisor(...args)
    }
    return this._supervisor
  }

  /** 初始化 HealthCheck（幂等） */
  initHealthCheck(options: HealthCheckOptions): HealthCheck {
    if (!this._healthCheck) {
      this._healthCheck = new HealthCheck(options)
    }
    return this._healthCheck
  }

  /** 当前 PathSyncMonitor 实例 */
  get pathSync(): PathSyncMonitor {
    if (!this._pathSync) {
      throw new Error('ctx.monitor 未初始化 pathSync：请先调用 initPathSync(...)')
    }
    return this._pathSync
  }

  /** 当前 Supervisor 实例 */
  get supervisor(): Supervisor {
    if (!this._supervisor) {
      throw new Error('ctx.monitor 未初始化 supervisor：请先调用 initSupervisor(...)')
    }
    return this._supervisor
  }

  /** 当前 HealthCheck 实例 */
  get healthCheck(): HealthCheck {
    if (!this._healthCheck) {
      throw new Error('ctx.monitor 未初始化 healthCheck：请先调用 initHealthCheck(...)')
    }
    return this._healthCheck
  }
}
