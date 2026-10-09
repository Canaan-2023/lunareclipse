/**
 * 为什么存在：运行器、互斥、冻结、状态持久化、看门狗、工作流调度相互依赖，需要一个总控统一组装配对与生命周期。
 * 作用：Supervisor 装配 DMN 运行器与子代理，持有调度器/看门狗/状态存储，聚合任务日志与错误处理并对外暴露回调。
 */

import { existsSync } from 'fs'
import { readdir } from 'fs/promises'
import type { Dirent } from 'fs'
import type { BaseDataPaths, DataPaths } from '../models/paths'
import type { AnyTool, ToolContext, DmnSupervisor } from '../tools/base-tool'
import type { LLMClient } from '../api/llm'
import type { UserStore } from '../models/user-store'
import { DmnRunner } from './dmn-runner'
import { DmnMutex } from './mutex'
import { StateStore } from './state-store'
import { FreezeManagerImpl, type FreezeManagerCallbacks } from './freeze-manager'
import {
  MemoryWorkflowScheduler,
  type MemoryWorkflowCallbacks
} from './memory-workflow-scheduler'
import {
  DiaryWorkflowScheduler,
  type DiaryWorkflowCallbacks
} from './diary-workflow-scheduler'
import { Watchdog } from './watchdog'
import { ToolCallLogger } from './tool-call-logger'
import { SubAgentLauncher, type MakeDistillCallbacks } from './sub-agent-launcher'
import {
  findLastCompleteAt,
  pushTaskLog,
  type TaskLogEntry
} from './supervisor-state'
import type { ErrorLog } from './error-log'
import type { WorkflowManager } from '../workflow/manager'
import type { TimerRegistry } from './timer-registry'
import {
  loadMonitorConfig,
  saveMonitorConfig,
  mergeConfig,
  type MonitorConfig
} from './monitor-config'

export interface SupervisorCallbacks {
  onOutput?: (dmnId: string, text: string) => void
  onToolCall?: (dmnId: string, toolName: string, params: Record<string, unknown>) => void
  onToolResult?: (
    dmnId: string,
    toolName: string,
    ok: boolean,
    data?: unknown,
    error?: string
  ) => void
  onDmnStart?: (dmnId: string) => void
  onDmnComplete?: (dmnId: string) => void
  onCrash?: (dmnId: string, reason: string) => void
  onContinueHint?: (dmnId: string) => void
  onStopped?: (dmnId: string, reason: string) => void
  onCycleStart?: () => void
  onCycleComplete?: () => void
  onNoMemory?: () => void
  onConditionWait?: (reason: string) => void
  onAskUser?: (
    dmnId: string,
    question: string,
    context: string | undefined,
    sessionId: string | null
  ) => void
}

export interface DmnStatus {
  dmnId: string
  status: 'idle' | 'running' | 'frozen' | 'crashed' | 'stopped'
  retryCount: number
  lastActivityAt: number | null
  isHeartbeatLocked: boolean
  currentTaskId?: string | null
  startedAt?: number | null
  lastCompleteAt?: number | null
  frozenAt?: number | null
}

export class Supervisor {
  private mutex: DmnMutex
  private runner: DmnRunner
  private stateStore: StateStore
private freezeManager: FreezeManagerImpl
  private memoryWorkflowScheduler: MemoryWorkflowScheduler
  private diaryWorkflowScheduler: DiaryWorkflowScheduler
  private watchdog: Watchdog
  private logger: ToolCallLogger

  private config: MonitorConfig
  private started = false
  private frontendIdle = true
  /** 当前活跃会话 ID（前端切换会话时同步），供中断恢复等机制查询持续激活状态 */
  activeSessionId: string | null = null
  private taskLog: TaskLogEntry[] = []
  /** 文档 16.2：各 DMN 当前任务 ID（DMN 启动时设置，完成时清除） */
  private currentTaskIds = new Map<string, string>()
  private tokenBudgetProvider: () => number = () => 0

  constructor(
    private paths: BaseDataPaths,
    private llmClient: LLMClient,
    private tools: AnyTool[],
    private baseCtx: ToolContext,
    private configDir: string,
    private errorLog: ErrorLog,
    private userStore: UserStore,
    private callbacks: SupervisorCallbacks = {},
    private timerRegistry?: TimerRegistry,
    /**
     * 工具结果蒸馏回调工厂（可选）：DMN/子 agent 路径与主会话一视同仁——大体积工具结果
     * 先经 LLM 提炼摘要再进上下文（失败重试一次仍失败保留原文）。由 index.ts 装配时注入
     * （DMN 专用 distiller，独立于 server.ts / 工作流，避免与前端 LLM 抢占与回环）。
     */
    private makeDistillCallbacks?: MakeDistillCallbacks
  ) {
    this.config = loadMonitorConfig(this.configDir)

    this.mutex = new DmnMutex()
    // 活跃对象勿删：SubAgentLauncher 经 runner.run 执行子 agent 任务（monitor/sub-agent-launcher.ts），
    // watchdog/freeze 经 isRunning/getLastActivityAt/injectSystemMessage 追踪运行态；记忆处理另走工作流引擎。
    this.runner = new DmnRunner(this.llmClient)
    this.stateStore = new StateStore(this.paths.sessions)
    this.freezeManager = new FreezeManagerImpl(this.stateStore)
    this.logger = new ToolCallLogger()

    const supervisor: DmnSupervisor = {
      freeze_manager: this.freezeManager
    }
    const subAgentLauncher = new SubAgentLauncher(
      this.tools,
      this.runner,
      this.baseCtx,
      this.paths,
      supervisor,
      () => this.config.watchdog.tool_timeout_seconds,
      this.makeDistillCallbacks
    )
    // 安全展开 baseCtx：paths 是动态 getter，未登录访问抛「未登录态禁止解析工具作用域 paths」；
    // 对象展开会强制求值该 getter，干净环境首次启动（打包版无登录数据）在构造期即崩。
    // 本构造器随后用固定 this.paths 覆盖 paths，展开时跳过它语义完全等价。
    // 留存理由：与 server.ts safePaths/spreadToolCtx 同源——未登录启动必须能进登录页。
    const spreadBaseCtx = (ctx: ToolContext): Record<string, unknown> => {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(ctx)) {
        if (key === 'paths') continue
        out[key] = (ctx as Record<string, unknown>)[key]
      }
      return out
    }
    const ctxWithSupervisor: ToolContext = {
      ...spreadBaseCtx(this.baseCtx),
      supervisor,
      // runner 活跃用途：SubAgentLauncher 内部调用 runner.run 执行子 agent 任务（sub-agent-launcher.ts），
      // watchdog/freeze 用 isRunning/getLastActivityAt/injectSystemMessage 追踪运行态。
      // 记忆处理不再走 DmnRunner（已迁移 L8 工作流引擎）。
      paths: this.paths as DataPaths,
      launchSubAgent: (tasks, mode) => subAgentLauncher.launch(tasks, mode)
    }
    Object.defineProperty(ctxWithSupervisor, 'user', {
      get: () => this.userStore.getCurrentUser() ?? undefined,
      enumerable: true,
      configurable: true
    })

    const freezeCallbacks: FreezeManagerCallbacks = {
      onFreeze: (dmnId: string) => this.handleDmnFrozen(dmnId),
      onUnfreeze: (dmnId: string) => this.handleDmnUnfrozen(dmnId),
      onAskUser: (
        dmnId: string,
        question: string,
        context: string | undefined,
        sessionId: string | null
      ) => this.callbacks.onAskUser?.(dmnId, question, context, sessionId),
      onInjectContinuation: (dmnId: string, systemMessage: string) => {
        this.runner.injectSystemMessage(dmnId, systemMessage)
      }
    }
    this.freezeManager.setCallbacks(freezeCallbacks)

// 记忆处理工作流调度器（替代旧 DMN 调度体系）
    // 由 raw_memory 驱动 L8 工作流引擎，记忆处理统一为流水线
    const memoryWorkflowCallbacks: MemoryWorkflowCallbacks = {
      onOutput: this.callbacks.onOutput,
      onToolCall: (dmnId: string, toolName: string, params: Record<string, unknown>) => {
        this.logger.log(dmnId, toolName, params)
        this.callbacks.onToolCall?.(dmnId, toolName, params)
      },
      onToolResult: this.callbacks.onToolResult,
      onDmnStart: (dmnId: string) => this.handleDmnStart(dmnId),
      onDmnComplete: (dmnId: string) => this.handleDmnComplete(dmnId),
      onCrash: (dmnId: string, reason: string) => {
        console.error(`[DMN ${dmnId}] crash: ${reason}`)
        // 重置 watchdog 状态为 idle，否则 checkStartConditions 会因 memory-workflow_busy 永远跳过
        this.watchdog.markIdle(dmnId)
        this.callbacks.onCrash?.(dmnId, reason)
      },
      onConditionWait: (_reason: string) => {
        // 工作流等待条件不推到前端（避免刷屏）
      }
    }

    this.memoryWorkflowScheduler = new MemoryWorkflowScheduler(
      this.paths,
      memoryWorkflowCallbacks,
      this.timerRegistry
    )
    this.propagateMemoryWorkflowConfig()
    // 2025-08-05 用户需求：记忆流水线与前端对话并行，不再等前端空闲。
    // 前端 busy（普通对话/stream/持续激活）时流水线照常取批次跑记忆处理工作流，
    // 前端对话与记忆流水线并行，不再等前端空闲。
    // 历史教训：曾尝试"持续激活开启时流水线让路"，导致 raw_memory 大量积压、
    // 记忆归档断档（49 条从未进记忆库）——已撤销该设计，恢复恒并行。
    this.memoryWorkflowScheduler.setFrontendIdleProvider(() => true)
    this.memoryWorkflowScheduler.setDmnStatusProvider(
      (dmnId: string) => this.watchdog.getStatus(dmnId)
    )

    // 日记工作流调度器（替代 AI 侧 cron diary-daily-write + server.ts 启动补写检查）
    // 后台扫描 raw_memory 下缺 diary.md 的日期，启动 wf_default_diary_writer 工作流
    const diaryCallbacks: DiaryWorkflowCallbacks = {
      onOutput: (text: string) => {
        this.callbacks.onOutput?.('diary', text)
      },
      onToolCall: (toolName: string, params: Record<string, unknown>) => {
        this.logger.log('diary', toolName, params)
        this.callbacks.onToolCall?.('diary', toolName, params)
      },
      onToolResult: (toolName: string, ok: boolean, data?: unknown, error?: string) => {
        this.callbacks.onToolResult?.('diary', toolName, ok, data, error)
      },
      onStart: () => {
        // 日记工作流启动时不走 handleDmnStart（不占用 DMN 状态机）
      },
      onComplete: () => {
        // 日记工作流完成
      },
      onCrash: (reason: string) => {
        console.error(`[diary-workflow] crash: ${reason}`)
      },
      onConditionWait: (_reason: string) => {
        // 等待条件不推到前端
      }
    }
    this.diaryWorkflowScheduler = new DiaryWorkflowScheduler(
      this.paths,
      diaryCallbacks,
      this.timerRegistry
    )
    this.propagateDiaryWorkflowConfig()
    // 协调：日记优先，记忆让路
    // 日记检查记忆是否在跑 → 在跑则等
    // 记忆检查日记是否有积压 → 有积压则让路
    this.diaryWorkflowScheduler.setMemoryRunningProvider(
      () => this.memoryWorkflowScheduler.isRunning()
    )
    this.memoryWorkflowScheduler.setDiaryPendingProvider(
      () => this.diaryWorkflowScheduler.hasPendingWork()
    )
    this.watchdog = new Watchdog(
      this.runner,
      this.mutex,
      this.freezeManager,
      this.config,
      this.errorLog,
      {
        onCrash: this.callbacks.onCrash,
        onContinueHint: this.callbacks.onContinueHint,
        onStopped: this.callbacks.onStopped,
        onRestart: (dmnId: string) => this.handleDmnRestart(dmnId)
      },
      this.timerRegistry
    )
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.restoreFrozenStates()
    this.watchdog.start()
    this.memoryWorkflowScheduler.start()
    this.diaryWorkflowScheduler.start()
  }

  private async restoreFrozenStates(): Promise<void> {
    try {
      const sessionsDir = this.paths.sessions
      if (!existsSync(sessionsDir)) return
      const entries = await readdir(sessionsDir, { withFileTypes: true }) as Dirent[]
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        // sessions 分层后顶层含账号目录（U{uid}）：其下无 dmn状态.jsonl（冻结状态按会话 ID
        // 直挂 sessions 全局根），跳过避免把账号目录当会话枚举产生空遍历
        if (/^U\d+$/.test(entry.name)) continue
        const sessionId = entry.name
        const freezes = this.stateStore.loadAllFreezes(sessionId)
        for (const record of freezes) {
          const dmnId = record.冻结DMN
          if (!dmnId) continue
          if (this.runner.isRunning(dmnId)) continue
          this.freezeManager.restoreFrozen(dmnId, record)
          this.watchdog.markFrozen(dmnId)
          this.callbacks.onAskUser?.(
            dmnId,
            record.冻结问题,
            record.冻结原因,
            sessionId
          )
        }
      }
    } catch (err) {
      console.error('[supervisor] restoreFrozenStates failed:', err)
    }
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    this.memoryWorkflowScheduler.stop()
    this.diaryWorkflowScheduler.stop()
    this.watchdog.stop()
    this.logger.clearAll()
  }

  answerDmnQuestion(dmnId: string, answer: string | null): void {
    this.freezeManager.unfreeze(dmnId, answer)
  }

  isDmnFrozen(dmnId: string): boolean {
    return this.freezeManager.isFrozen(dmnId)
  }

  /**
   * 记忆处理工作流开关（替代旧的 updateHeartbeatEnabled + memory-workflow 开关）
   * 关闭即停止当前工作（完成当前批次后停止），再开从上次进度继续
   */
  updateMemoryWorkflowEnabled(enabled: boolean): void {
    this.config.memoryWorkflow.enabled = enabled
    this.propagateMemoryWorkflowConfig()
    saveMonitorConfig(this.configDir, this.config)
    if (enabled) {
      this.memoryWorkflowScheduler.start()
    } else {
      this.memoryWorkflowScheduler.stop()
    }
  }

  isMemoryWorkflowEnabled(): boolean {
    return this.memoryWorkflowScheduler.isEnabled()
  }

  isMemoryWorkflowRunning(): boolean {
    return this.memoryWorkflowScheduler.isRunning()
  }

  /** 日记工作流开关 */
  updateDiaryWorkflowEnabled(enabled: boolean): void {
    this.config.diaryWorkflow.enabled = enabled
    this.propagateDiaryWorkflowConfig()
    saveMonitorConfig(this.configDir, this.config)
    if (enabled) {
      this.diaryWorkflowScheduler.start()
    } else {
      this.diaryWorkflowScheduler.stop()
    }
  }

  isDiaryWorkflowEnabled(): boolean {
    return this.diaryWorkflowScheduler.isEnabled()
  }

  isDiaryWorkflowRunning(): boolean {
    return this.diaryWorkflowScheduler.isRunning()
  }

  updateConfig(partial: Partial<MonitorConfig>): void {
    // 修复：原实现浅合并（{ ...this.config, ...partial }）——partial 带
    // memoryWorkflow: { enabled } 时整个子对象被替换，batch_size/check_interval_seconds 变
    // undefined → 下发到调度器 → getNextRawMemoryBatch 兜底 5 → 每批 4/5 RAW 静默漏处理。
    // 改用 mergeConfig 深合并各子段（memoryWorkflow/diaryWorkflow/sessionSummary）：
    // 只覆盖 partial 显式给出的字段，其余保留现有值
    // （sessionSummary 同理：设置页只改 summaryBudgetChars 不得丢掉
    // enabled/summaryMaxChars/routerMaxSessions/userShardMaxBytes/routePreviewTurnPairs）。
    this.config = mergeConfig(this.config, partial)
    this.propagateMemoryWorkflowConfig()
    this.propagateDiaryWorkflowConfig()
    this.watchdog.updateConfig(this.config)
    saveMonitorConfig(this.configDir, this.config)
  }

  /** 将记忆工作流配置统一下发到 MemoryWorkflowScheduler */
  private propagateMemoryWorkflowConfig(): void {
    this.memoryWorkflowScheduler.updateConfig({
      enabled: this.config.memoryWorkflow.enabled,
      checkIntervalSeconds: this.config.memoryWorkflow.check_interval_seconds,
      batchSize: this.config.memoryWorkflow.batch_size
    })
  }

  /** 将日记工作流配置统一下发到 DiaryWorkflowScheduler */
  private propagateDiaryWorkflowConfig(): void {
    this.diaryWorkflowScheduler.updateConfig({
      enabled: this.config.diaryWorkflow.enabled,
      checkIntervalSeconds: this.config.diaryWorkflow.check_interval_seconds
    })
  }

  setFrontendIdle(idle: boolean): void {
    this.frontendIdle = idle
  }

  setTokenBudgetProvider(provider: () => number): void {
    this.tokenBudgetProvider = provider
  }

  /** 设置当前活跃会话 ID（前端切换会话时调用） */
  setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId
  }

  /**
   * 注入 WorkflowManager 提供者（延迟访问，避免构造时序依赖）。
   * 由 index.ts 在 WorkflowManager 创建后调用：
   * supervisor.setWorkflowManagerProvider(() => workflowManager)
   * MemoryWorkflowScheduler 通过此 provider 订阅工作流事件 + 启动实例。
   */
  setWorkflowManagerProvider(provider: () => WorkflowManager | null): void {
    this.memoryWorkflowScheduler.setWorkflowManagerProvider(provider)
    this.diaryWorkflowScheduler.setWorkflowManagerProvider(provider)
  }

  /**
   * 注入记忆工作流作用域设置回调（分层改造）。
   * index.ts 的 setWorkflowScope：调度器处理某 (uid, aiId) 批次时设置，
   * workflowCtx.paths getter 据此解析作用域路径。
   */
  setMemoryWorkflowScopeSetter(setter: (scope: import('../models/paths').MemoryScope | null) => void): void {
    this.memoryWorkflowScheduler.setScopeSetter(setter)
    this.diaryWorkflowScheduler.setScopeSetter(setter)
  }

  isFrontendIdle(): boolean {
    return this.frontendIdle
  }

  getConfig(): MonitorConfig {
    return this.config
  }

  getStatus(dmnId: string): DmnStatus {
    // 从 taskLog 聚合 lastCompleteAt（找该 DMN 最后一条完成记录）
    const lastCompleteAt = findLastCompleteAt(this.taskLog, dmnId)
    // 从 freezeManager 获取冻结开始时间
    const frozenAt = this.freezeManager?.getFrozenAt(dmnId) ?? null
    // 当前任务 ID（DMN 启动时设置）
    const currentTaskId = this.currentTaskIds.get(dmnId) ?? null
    // startedAt 使用 lastActivityAt 作为近似值（runner 在 DMN 开始执行时更新）
    const lastActivity = this.runner.getLastActivityAt(dmnId)
    const startedAt = this.watchdog.getStatus(dmnId) === 'running' ? lastActivity : null
    return {
      dmnId,
      status: this.watchdog.getStatus(dmnId),
      retryCount: this.watchdog.getRetryCount(dmnId),
      lastActivityAt: lastActivity,
      isHeartbeatLocked: this.mutex.isHeartbeatLocked(dmnId),
      currentTaskId,
      startedAt,
      lastCompleteAt,
      frozenAt
    }
  }

  getTaskLog(): typeof this.taskLog {
    return [...this.taskLog]
  }

  handleDmnComplete(dmnId: string): void {
    this.watchdog.markIdle(dmnId)
    this.currentTaskIds.delete(dmnId)
    const maxLog = this.config.task_log_max_entries
    this.taskLog = pushTaskLog(
      this.taskLog,
      { dmnId, completedAt: new Date().toISOString() },
      maxLog
    )
    // 记忆已迁移到工作流引擎，进度推进由 MemoryWorkflowScheduler.handleWorkflowEvent 处理
    this.callbacks.onDmnComplete?.(dmnId)
  }

  handleDmnStart(dmnId: string): void {
    this.logger.reset(dmnId)
    this.watchdog.markRunning(dmnId)
    this.currentTaskIds.set(dmnId, `${dmnId}_${Date.now()}`)
    this.callbacks.onDmnStart?.(dmnId)
  }

  handleDmnFrozen(dmnId: string): void {
    this.watchdog.markFrozen(dmnId)
  }

  handleDmnUnfrozen(dmnId: string): void {
    if (this.runner.isRunning(dmnId)) {
      this.watchdog.markRunning(dmnId)
    } else {
      this.watchdog.markIdle(dmnId)
    }
  }

  /**
   * 文档 16.11.2：DMN 崩溃后 retryCount < max_retry 时触发重启。
   * 记忆已迁移到工作流引擎（不经过 DmnRunner，watchdog 不会触发 forceRestart）。
   */
  handleDmnRestart(_dmnId: string): void {
    // no-op：工作流引擎自行处理崩溃恢复
  }

}
