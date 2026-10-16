/**
 * 记忆处理工作流调度器（新架构：主调度器 → 并行子 AGENT → 审批）

 * 设计（既定架构）：
 * - RAW 按字符上限 + 会话实时追加（一对话对不再一文件），封口规则：今日最大序号（活跃写入中）不进工作流
 * - 每个封口 RAW：主调度器（dispatcher）读完整 RAW → 价值判断 → 有价值的批量生成记忆 →
 * 输出任务清单（每项 = 一条已建记忆）→ 每项派发一个子 AGENT 工作流（并行，只做 NNG：
 * 位置→命名→重复/矛盾/张力→高阶成对处理）→ 全部完成后主调度器审查（review）→ 更新进度
 * - 失败重试（用户原版设计）：跑失败不更新进度，下次重新输入同一 RAW。
 * 分层重试：dispatcher 失败→整体重跑；子 agent 失败→只重试该子 agent（不重复建记忆）；
 * review 失败→重跑 review。进度只在 dispatcher + 全部子 agent + review 全部完成才更新。

 * 崩溃恢复：未完成批次持久化（batch + nextProgress + stage + 任务清单 + 子实例追踪），
 * 重启后按 stage 恢复对应环节。
 */
import type { BaseDataPaths, DataPaths, MemoryScope } from '../models/paths'
import { resolveScopePaths, listExistingScopes } from '../models/paths'
import type { WorkflowManager } from '../workflow/manager'
import type { WorkflowEngineEvent } from '@shared/workflow/types'
import type { TimerRegistry, TimerHandle } from './timer-registry'
import { getNextRawMemoryBatch, updateRawMemoryProgress } from '../services/raw-memory-next-batch'
import type { RawMemoryEntry } from '../services/raw-memory-next-batch'
import { loadWorkflowSharedPrompts } from '../prompts/loader'
import {
  DEFAULT_CONFIG,
  MAX_CONCURRENT_AGENTS,
  type DispatcherTask,
  type DmnStatusValue,
  type MemoryWorkflowCallbacks,
  type MemoryWorkflowConfig,
  type PendingBatch,
} from './memory-workflow-types'
import {
  pendingBatchPathFor,
  readPendingBatchFile,
  writePendingBatchFile,
  clearPendingBatchFile,
  reloadBatchContents as reloadBatchContentsImpl,
} from './memory-workflow-persist'

export type {
  DmnStatusValue,
  MemoryWorkflowConfig,
  MemoryWorkflowCallbacks,
  DispatcherTask,
} from './memory-workflow-types'

export class MemoryWorkflowScheduler {
  private config: MemoryWorkflowConfig = DEFAULT_CONFIG
  private shouldStop = false
  /** 是否正在处理一批（整条流水线运行期间为 true） */
  private running = false
  private timerHandle: TimerHandle | null = null
  private frontendIdleProvider: () => boolean = () => true
  private dmnStatusProvider: (dmnId: string) => DmnStatusValue = () => 'idle'
  /** 日记工作流待处理提供者（协调：日记优先，记忆让路） */
  private diaryPendingProvider: () => boolean = () => false
  /** WorkflowManager 提供者（延迟访问，supervisor 构造时 workflowManager 可能未创建） */
  private workflowManagerProvider: (() => WorkflowManager | null) | null = null
  /** 事件订阅取消函数 */
  private unsubscribe: (() => void) | null = null
  /** 作用域设置回调（index.ts 注入：设置 currentWorkflowScope，工作流 ctx.paths 动态解析用） */
  private setScopeProvider: ((scope: MemoryScope | null) => void) | null = null

  constructor(
    private paths: BaseDataPaths,
    private callbacks: MemoryWorkflowCallbacks = {},
    private timerRegistry?: TimerRegistry
  ) {}

  /** 注入 WorkflowManager 提供者（延迟访问，避免构造时序依赖） */
  setWorkflowManagerProvider(provider: () => WorkflowManager | null): void {
    this.workflowManagerProvider = provider
    if (!this.shouldStop && !this.unsubscribe) {
      this.subscribeEvents()
    }
  }

  /** 注入作用域设置回调（index.ts 的 setWorkflowScope，工作流 ctx.paths 动态解析用） */
  setScopeSetter(setter: (scope: MemoryScope | null) => void): void {
    this.setScopeProvider = setter
  }

  updateConfig(config: Partial<MemoryWorkflowConfig>): void {
    this.config = { ...this.config, ...config }
  }

  setFrontendIdleProvider(provider: () => boolean): void {
    this.frontendIdleProvider = provider
  }

  /** 注入日记工作流待处理检查器（协调：日记有积压时记忆让路） */
  setDiaryPendingProvider(provider: () => boolean): void {
    this.diaryPendingProvider = provider
  }

  setDmnStatusProvider(provider: (dmnId: string) => DmnStatusValue): void {
    this.dmnStatusProvider = provider
  }

  isEnabled(): boolean {
    return this.config.enabled && !this.shouldStop
  }

  isRunning(): boolean {
    return this.running
  }

  start(): void {
    this.shouldStop = false
    this.subscribeEvents()
    if (this.config.enabled) {
      this.scheduleCheck(100)
    }
  }

  stop(): void {
    this.shouldStop = true
    this.clearTimer()
  }

  private subscribeEvents(): void {
    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
    const wm = this.workflowManagerProvider?.()
    if (wm) {
      this.unsubscribe = wm.onEvent((event) => this.handleWorkflowEvent(event))
    }
  }

  private clearTimer(): void {
    if (this.timerHandle) {
      if (this.timerRegistry) {
        this.timerRegistry.clearTimeout(this.timerHandle)
      } else {
        clearTimeout(this.timerHandle as unknown as ReturnType<typeof setTimeout>)
      }
      this.timerHandle = null
    }
  }

  private scheduleCheck(delayMs: number): void {
    if (this.shouldStop || !this.config.enabled) return
    this.clearTimer()
    const run = () => {
      void this.checkAndProcess()
    }
    this.timerHandle = this.timerRegistry
      ? this.timerRegistry.setTimeout(run, delayMs, 'memoryWorkflow.checkAndProcess')
      : (setTimeout(run, delayMs) as unknown as TimerHandle)
  }

  private checkStartConditions(): { ok: boolean; reason?: string } {
    if (!this.config.enabled) return { ok: false, reason: 'memory_workflow_disabled' }
    if (this.running) return { ok: false, reason: 'already_running' }
    if (!this.frontendIdleProvider()) return { ok: false, reason: 'frontend_ai_busy' }
    // 协调：日记工作流有积压时让路（日记优先，记忆在后）
    if (this.diaryPendingProvider()) return { ok: false, reason: 'diary_workflow_pending' }
    const wm = this.workflowManagerProvider?.()
    if (!wm) return { ok: false, reason: 'workflow_manager_not_ready' }
    return { ok: true }
  }

  private async checkAndProcess(): Promise<void> {
    const cond = this.checkStartConditions()
    if (!cond.ok) {
      this.callbacks.onConditionWait?.(cond.reason ?? 'unknown')
      this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
      return
    }
    const wm = this.workflowManagerProvider?.()
    if (!wm) {
      this.callbacks.onConditionWait?.('workflow_manager_not_ready')
      this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
      return
    }

    // ===== 崩溃恢复：检查未完成批次（按 stage 恢复） =====
    const pending = this.readPendingBatch()
    if (pending) {
      const recovered = await this.recoverPending(wm, pending)
      if (recovered) {
        this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
        return
      }
    }

    // ===== 正常路径：遍历所有记忆作用域（用户 × AI），取下一批封口 RAW =====
    // 分层改造：每个 (uid, aiId) 独立进度、独立取批，互不干扰
    const scopes = listExistingScopes(this.paths)
    for (const scope of scopes) {
      const scopedPaths = resolveScopePaths(this.paths, scope)
      const result = getNextRawMemoryBatch(scopedPaths, this.config.batchSize)
      if (result.batch.length === 0) {
        continue
      }
      // 设置当前工作流作用域：工作流 ctx.paths getter 据此落对应目录
      this.setScopeProvider?.(scope)
      await this.launchDispatcher(wm, result.batch, result.nextProgress, scope)
      return
    }
    this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
  }

  /** 崩溃恢复：按 stage 恢复对应环节。返回 true 表示已接管（本批继续处理中） */
  private async recoverPending(wm: WorkflowManager, pending: PendingBatch): Promise<boolean> {
    if (pending.stage === 'dispatcher' || pending.stage === 'review') {
      // 主实例阶段：检查实例状态
      if (pending.instanceId) {
        const instance = wm.getInstance(pending.instanceId)
        if (instance && (instance.status === 'running' || instance.status === 'paused')) {
          // 实例还活着 → 重新追踪
          this.running = true
          try {
            this.callbacks.onDmnStart?.('memory-workflow')
          } catch (e) {
            console.error('[memory-workflow] onDmnStart failed:', e)
            this.finishRun()
            return false
          }
          if (instance.status === 'paused') {
            try {
              await wm.modifyInstance({ instanceId: pending.instanceId, action: 'resume' })
            } catch (err) {
              console.error('[memory-workflow] 恢复 paused 实例失败:', err)
            }
          }
          return true
        }
        if (instance && instance.status === 'completed') {
          // 已完成但事件丢失 → 验证决策产物后再推进
          // 修复：dispatcher 阶段若 completed 但 decision 缺失
          //（LLM 空输出/解析失败的实例仍会 completed）——这不算成功：按失败重跑本批次。
          if (pending.stage === 'dispatcher') {
            const decision = instance?.context?.decision as string | undefined
            const tasksRaw = instance?.context?.tasks
            const hasDecision =
              decision === 'process'
                ? Array.isArray(tasksRaw) && tasksRaw.length > 0
                : decision === 'skip' || typeof decision === 'string'
            if (!hasDecision) {
              console.error(
                `[memory-workflow] dispatcher 实例 ${pending.instanceId} 已完成但无决策产物（LLM 空输出或解析失败），重跑本批次`
              )
              pending.instanceId = null
              this.writePendingBatch(pending)
              this.running = true
              if (pending.scope) this.setScopeProvider?.(pending.scope)
              await this.launchDispatcher(wm, pending.batch, pending.nextProgress, pending.scope)
              return true
            }
          }
          console.warn(
            `[memory-workflow] 恢复：实例 ${pending.instanceId} 已完成（事件丢失），推进阶段`
          )
          this.running = true
          await this.handleStageCompleted(wm, pending)
          return true
        }
        // failed / cancelled / 不存在 → 重跑当前阶段
        console.warn(
          `[memory-workflow] 恢复：实例 ${pending.instanceId} 状态=${instance?.status ?? '不存在'}，重跑 ${pending.stage} 阶段`
        )
        pending.instanceId = null
        this.writePendingBatch(pending)
        this.running = true
        // 分层：恢复时重新设置作用域（工作流 ctx.paths 依赖）
        if (pending.scope) this.setScopeProvider?.(pending.scope)
        if (pending.stage === 'dispatcher') {
          await this.launchDispatcher(wm, pending.batch, pending.nextProgress, pending.scope)
        } else {
          await this.launchReview(wm, pending)
        }
        return true
      }
      // 无实例（启动前崩溃）→ 重跑当前阶段
      this.running = true
      if (pending.stage === 'dispatcher') {
        const reloaded = this.reloadBatchContents(pending.batch)
        if (reloaded.length > 0) {
          if (pending.scope) this.setScopeProvider?.(pending.scope)
          await this.launchDispatcher(wm, reloaded, pending.nextProgress, pending.scope)
          return true
        }
      } else {
        await this.launchReview(wm, pending)
        return true
      }
    } else if (pending.stage === 'agents') {
      // 子 AGENT 阶段：检查各子实例，completed 的跳过，failed/不存在的重试
      this.running = true
      try {
        this.callbacks.onDmnStart?.('memory-workflow')
      } catch (e) {
        console.error('[memory-workflow] onDmnStart failed:', e)
        this.finishRun()
        return false
      }
      const ids = pending.agentInstanceIds ?? []
      for (const id of ids) {
        const instance = wm.getInstance(id)
        if (instance && (instance.status === 'running' || instance.status === 'paused')) {
          // 还活着 → 保留（agentInstanceIds 原样包含它，无需操作）
        } else if (instance && instance.status === 'completed') {
          // 修复：循环内完成/失败分支各自维护 agentInstanceIds
          // （handleAgentCompleted/Failed 内部 filter 移除旧 ID、launchAgent push 新 ID），
          // 循环结束后**不再整体覆盖过滤**——原实现 `filter(aliveIds.includes)` 用恢复前的
          // aliveIds 把重试/补位启动的新实例 ID 一并滤掉 → 新实例完成事件失联（isAgent 判断
          // 失败）→ 可能提前进 review 审查不完整状态。
          await this.handleAgentCompleted(wm, pending, id)
        } else {
          // failed / cancelled / 不存在 → 重试该子 agent
          const task = pending.agentTaskMap?.[id]
          if (task) {
            const retries = pending.agentRetries?.[id] ?? 0
            if (retries < this.config.agentMaxRetries) {
              console.warn(
                `[memory-workflow] 恢复：子 AGENT ${id} 未完成，重试（第 ${retries + 1} 次）`
              )
              await this.launchAgent(wm, pending, task, retries + 1)
            } else {
              // 重试超限 → 记录失败结果，交给 review 兜底
              pending.agentResults = [
                ...(pending.agentResults ?? []),
                `[子AGENT失败] 记忆 ${task.记忆路径}（重试超限）`
              ]
              pending.agentInstanceIds = pending.agentInstanceIds?.filter((x) => x !== id) ?? []
            }
          }
        }
      }
      this.writePendingBatch(pending)
      // 恢复后重新排水：启动排队中（并发限流未启动）的任务；队列空且无在跑 → drain 内部转入 review
      await this.drainAgentQueue(wm, pending)
      return true
    }
    return false
  }

  /** 启动主调度器实例（读 1 个封口 RAW → 价值判断 → 批量生成记忆 → 任务清单） */
  private async launchDispatcher(
    wm: WorkflowManager,
    batch: RawMemoryEntry[],
    nextProgress: { 最后处理日期: string; 最后处理序号: number },
    scope?: MemoryScope
  ): Promise<void> {
    const raw = batch[0]
    if (!raw) return
    // v2 架构每批只处理 1 个封口 RAW：dispatcher 一次读一个，多余的读入既浪费 token
    // 也不会被消费。若批次含多条（配置 batch_size>1 或历史 pending 遗留），只消费 batch[0]。
    // 为什么进度必须同步重算：升到 v2 之前 supervisor 浅合并 bug 曾把 batch_size 变 undefined、
    // getNextRawMemoryBatch 兜底 5，进度按整批最后一条推进 → batch[1..] 既没被处理、进度又已
    // 越过，RAW 永久丢失且无重试入口。这里把进度对齐到"实际处理的那一条"，剩余条目不消费
    // 进度、下一轮重新取到，从源头保证不重不漏。
    if (batch.length > 1) {
      console.warn(
        `[memory-workflow] ⚠️ batch_size=${batch.length} > 1：v2 架构每批仅处理 batch[0]（${raw.path}），` +
          `其余 ${batch.length - 1} 个 RAW 将留给下一轮。请将 batch_size 保持为 1（设置 → DMN 配置 → 记忆处理工作流）。`
      )
    }
    const singleRawBatch: RawMemoryEntry[] = batch.length > 1 ? [raw] : batch
    const alignedProgress = batch.length > 1
      ? { 最后处理日期: raw.date, 最后处理序号: raw.seq }
      : nextProgress
    const pending: PendingBatch = {
      batch: singleRawBatch,
      nextProgress: alignedProgress,
      instanceId: null,
      stage: 'dispatcher',
      rawPath: raw.path,
      rawContent: raw.content,
      scope
    }
    this.writePendingBatch(pending)
    this.persistInMemory(pending)

    const workflowPrompts = loadWorkflowSharedPrompts()
    try {
      this.callbacks.onDmnStart?.('memory-workflow')
      const instance = await wm.runInstance({
        templateId: 'wf_default_memory_dispatcher',
        input: {
          workflow_prompts: workflowPrompts,
          raw_path: raw.path,
          raw_content: raw.content
        }
      })
      pending.instanceId = instance.id
      this.writePendingBatch(pending)
      this.persistInMemory(pending)

      // 边界：实例立即完成/失败
      if (instance.status === 'completed') {
        await this.handleStageCompleted(wm, pending)
      } else if (instance.status === 'failed') {
        await this.handleStageFailed(wm, pending, instance.error ?? '主调度器立即失败')
      } else if (instance.status === 'cancelled') {
        this.handleCancelled()
      }
    } catch (err) {
      console.error('[memory-workflow] 启动主调度器失败:', (err as Error).message)
      // 不更新进度、保留 pendingBatch（下次重试本批次）
      this.callbacks.onCrash?.('memory-workflow', (err as Error).message)
      this.finishRun()
    }
  }

  /**
   * 启动全部子 AGENT（并发限流）：
   * 任务全部入队 agentQueue，由 drainAgentQueue 按 MAX_CONCURRENT_AGENTS=2 分批启动，
   * 完成一个补一个（handleAgentCompleted/Failed 尾部 drain），避免 N 路 LLM 并发互相覆盖 + API 限流。
   */
  private async launchAgents(wm: WorkflowManager, pending: PendingBatch): Promise<void> {
    const tasks = pending.taskList ?? []
    pending.agentQueue = [...tasks]
    pending.agentInstanceIds = []
    pending.agentTaskMap = {}
    pending.agentRetries = {}
    pending.agentResults = []
    this.writePendingBatch(pending)
    await this.drainAgentQueue(wm, pending)
  }

  /** 防重入标志（launchAgent 内部"立即完成"会同步触发 handleAgentCompleted → drain） */
  private draining = false

  /** 并发限流泵：启动排队任务直到并发数达上限；队列空且无在跑 → 全部完成 → review */
  private async drainAgentQueue(wm: WorkflowManager, pending: PendingBatch): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (
        (pending.agentQueue ?? []).length > 0 &&
        (pending.agentInstanceIds ?? []).length < MAX_CONCURRENT_AGENTS
      ) {
        const task = pending.agentQueue!.shift()!
        this.writePendingBatch(pending)
        await this.launchAgent(wm, pending, task, 0)
        // launchAgent 内部"立即完成"分支会同步移除实例，while 条件重新评估，不会死循环
      }
      // 队列空 + 无在跑 → 全部子 AGENT 完成（或超限放弃）→ review
      if (
        (pending.agentQueue ?? []).length === 0 &&
        (pending.agentInstanceIds ?? []).length === 0 &&
        pending.stage === 'agents'
      ) {
        pending.stage = 'review'
        pending.instanceId = null
        this.writePendingBatch(pending)
        await this.launchReview(wm, pending)
      }
    } finally {
      this.draining = false
    }
  }

  /** 启动单个子 AGENT 实例（NNG 定位与关联维护） */
  private async launchAgent(
    wm: WorkflowManager,
    pending: PendingBatch,
    task: DispatcherTask,
    retryCount: number
  ): Promise<void> {
    const workflowPrompts = loadWorkflowSharedPrompts()
    try {
      const instance = await wm.runInstance({
        templateId: 'wf_default_memory_agent',
        input: {
          workflow_prompts: workflowPrompts,
          记忆路径: task.记忆路径,
          描述: task.描述,
          主题: task.主题,
          对话时间: task.对话时间,
          RAW路径: task.RAW路径
        }
      })
      pending.agentInstanceIds = [...(pending.agentInstanceIds ?? []), instance.id]
      pending.agentTaskMap = { ...(pending.agentTaskMap ?? {}), [instance.id]: task }
      pending.agentRetries = { ...(pending.agentRetries ?? {}), [instance.id]: retryCount }
      this.writePendingBatch(pending)

      // 边界：立即完成/失败
      if (instance.status === 'completed') {
        await this.handleAgentCompleted(wm, pending, instance.id)
      } else if (instance.status === 'failed') {
        await this.handleAgentFailed(
          wm,
          pending,
          instance.id,
          instance.error ?? '子 AGENT 立即失败'
        )
      } else if (instance.status === 'cancelled') {
        await this.handleAgentFailed(wm, pending, instance.id, '子 AGENT 被取消')
      }
    } catch (err) {
      console.error(
        `[memory-workflow] 启动子 AGENT 失败（记忆 ${task.记忆路径}）:`,
        (err as Error).message
      )
      // 启动失败：按重试策略处理
      pending.agentRetries = {
        ...(pending.agentRetries ?? {}),
        [`__launch_${task.记忆路径}`]: retryCount
      }
      if (retryCount < this.config.agentMaxRetries) {
        await this.launchAgent(wm, pending, task, retryCount + 1)
      } else {
        pending.agentResults = [
          ...(pending.agentResults ?? []),
          `[子AGENT启动失败] 记忆 ${task.记忆路径}`
        ]
        this.writePendingBatch(pending)
      }
    }
  }

  /** 启动审查实例（子 AGENT 全部完成后） */
  private async launchReview(wm: WorkflowManager, pending: PendingBatch): Promise<void> {
    const workflowPrompts = loadWorkflowSharedPrompts()
    pending.stage = 'review'
    pending.instanceId = null
    this.writePendingBatch(pending)
    try {
      const instance = await wm.runInstance({
        templateId: 'wf_default_memory_review',
        input: {
          workflow_prompts: workflowPrompts,
          task_list: pending.dispatcherResult ?? '',
          agent_results: (pending.agentResults ?? []).join('\n\n'),
          raw_path: pending.rawPath ?? ''
        }
      })
      pending.instanceId = instance.id
      this.writePendingBatch(pending)

      if (instance.status === 'completed') {
        await this.handleStageCompleted(wm, pending)
      } else if (instance.status === 'failed') {
        await this.handleStageFailed(wm, pending, instance.error ?? '审查立即失败')
      } else if (instance.status === 'cancelled') {
        this.handleCancelled()
      }
    } catch (err) {
      console.error('[memory-workflow] 启动审查失败:', (err as Error).message)
      this.callbacks.onCrash?.('memory-workflow', (err as Error).message)
      this.finishRun()
    }
  }

  /** 处理 WorkflowManager 事件（匹配主实例 + 子 AGENT 实例） */
  private handleWorkflowEvent(event: WorkflowEngineEvent): void {
    if (event.type === 'wf:token' || event.type === 'wf:reasoning') {
      this.callbacks.onOutput?.('memory-workflow', event.token)
      return
    }
    const pending = this.readPendingBatch()
    if (!pending) return
    const id = 'instanceId' in event ? event.instanceId : ''
    const isMain = id === pending.instanceId
    const isAgent = pending.stage === 'agents' && (pending.agentInstanceIds ?? []).includes(id)
if (!isMain && !isAgent) return

    const wm = this.workflowManagerProvider?.()

    switch (event.type) {
      case 'wf:completed':
        if (!wm) return
        if (isAgent) {
          void this.handleAgentCompleted(wm, pending, id)
        } else {
          void this.handleStageCompleted(wm, pending)
        }
        break
      case 'wf:failed':
        if (!wm) return
        if (isAgent) {
          void this.handleAgentFailed(wm, pending, id, event.error)
        } else {
          void this.handleStageFailed(wm, pending, event.error)
        }
        break
      case 'wf:cancelled':
        if (isAgent) {
          if (!wm) return
          void this.handleAgentFailed(
            wm,
            pending,
            id,
            '子 AGENT 被取消'
          )
        } else {
          this.handleCancelled()
        }
        break
      case 'wf:tool_start':
        this.callbacks.onToolCall?.('memory-workflow', event.toolName, event.args)
        break
      case 'wf:tool_end': {
        let ok = true
        let error: string | undefined
        try {
          const parsed = JSON.parse(event.result) as { ok?: boolean; error?: string }
          ok = parsed.ok !== false
          error = parsed.error
        } catch {
          // non-JSON result treated as success
        }
        this.callbacks.onToolResult?.('memory-workflow', event.toolName, ok, event.result, error)
        break
      }
      default:
        break
    }
  }

  /** 主实例阶段完成（dispatcher 产出任务清单 / review 完成） */
  private async handleStageCompleted(wm: WorkflowManager, pending: PendingBatch): Promise<void> {
    if (!wm) {
      this.finishRun()
      return
    }
    if (pending.stage === 'dispatcher') {
      const instance = wm.getInstance(pending.instanceId ?? '')
      const decision = instance?.context?.decision as string | undefined
      const tasksRaw = instance?.context?.tasks

      if (decision === 'process' && Array.isArray(tasksRaw) && tasksRaw.length > 0) {
        // process：解析任务清单 → 进入 agents 阶段
        const tasks = tasksRaw as DispatcherTask[]
        pending.stage = 'agents'
        pending.instanceId = null
        pending.dispatcherResult = JSON.stringify(tasksRaw)
        pending.taskList = tasks
        this.writePendingBatch(pending)
        this.persistInMemory(pending)
        console.log(`[memory-workflow] 主调度器生成 ${tasks.length} 条记忆，派发子 AGENT 工作流`)
        await this.launchAgents(wm, pending)
        return
      }

      if (decision === undefined) {
        // 修复：decision 缺失 = outputVars 解析失败（extractOutputVars 静默
        // return，decision/tasks 没写入 context）——这不是 LLM 的 skip 判断，而是系统故障。
        // dispatcher 可能已用 create_memory 建好记忆、NNG 却无人处理——走失败路径重跑 dispatcher，
        // 不更新进度（进度只在整批完成后推进，避免"记忆建了 NNG 没建却显示完成"事故）。
        console.error(
          '[memory-workflow] 主调度器输出解析失败（decision/tasks 缺失），按失败重跑，不推进进度'
        )
        await this.handleStageFailed(wm, pending, '主调度器输出解析失败（decision/tasks 缺失）')
        return
      }

      // 合法 skip（LLM 明确判定无价值）或 process 但任务为空（异常形态——无记忆无孤儿，当 skip 无害）
      console.log(`[memory-workflow] 主调度器判定 ${decision ?? '无任务'}，RAW 处理完毕`)
      this.updateProgressAndNext(pending)
    } else if (pending.stage === 'review') {
      // 审查完成 → 读取审查结果（通过/修复项/遗留问题）→ 更新进度（整条流水线完成）
      // 之前只打"审查完成"一行日志，遗留问题（无法修复的缺陷）直接丢失、无追溯
      const instance = wm.getInstance(pending.instanceId ?? '')
      const 通过 = instance?.context?.['通过']
      const 修复项 = instance?.context?.['修复项']
      const 遗留问题 = instance?.context?.['遗留问题']
      const 修复项数 = Array.isArray(修复项) ? 修复项.length : 0
      const 遗留数 = Array.isArray(遗留问题) ? 遗留问题.length : 0
      console.log(
        `[memory-workflow] 审查完成：通过=${通过 === true ? '是' : '否'}，` +
          `修复 ${修复项数} 项，遗留问题 ${遗留数} 项` +
          (遗留数 > 0 ? `：${(遗留问题 as unknown[]).join('；')}` : '')
      )
      this.updateProgressAndNext(pending)
    }
  }

  /** 子 AGENT 完成：记录摘要，全部完成后进入 review */
  private async handleAgentCompleted(
    wm: WorkflowManager,
    pending: PendingBatch,
    agentId: string
  ): Promise<void> {
    const instance = wm.getInstance(agentId)
    const summary = instance
      ? JSON.stringify({
          记忆路径: instance.context?.['记忆路径'] ?? '',
          NNG路径: instance.context?.['NNG路径'] ?? '',
          操作: instance.context?.['操作'] ?? '',
          说明: instance.context?.['说明'] ?? ''
        })
      : `[子AGENT ${agentId}] (无上下文)`
    pending.agentResults = [...(pending.agentResults ?? []), summary]
    pending.agentInstanceIds = pending.agentInstanceIds?.filter((x) => x !== agentId) ?? []
    this.writePendingBatch(pending)

    // 补位启动排队的下一个；队列空且无在跑 → drain 内部转入 review
    await this.drainAgentQueue(wm, pending)
  }

  /** 子 AGENT 失败：分层重试（不重跑 dispatcher，不重复建记忆——子 agent 只做 NNG，重试安全） */
  private async handleAgentFailed(
    wm: WorkflowManager,
    pending: PendingBatch,
    agentId: string,
    error: string
  ): Promise<void> {
    console.error(`[memory-workflow] 子 AGENT ${agentId} 失败: ${error}`)
    const task = pending.agentTaskMap?.[agentId]
    const retries = pending.agentRetries?.[agentId] ?? 0
    pending.agentInstanceIds = pending.agentInstanceIds?.filter((x) => x !== agentId) ?? []
    this.writePendingBatch(pending)

    if (task && retries < this.config.agentMaxRetries) {
      console.warn(
        `[memory-workflow] 重试子 AGENT（第 ${retries + 1}/${this.config.agentMaxRetries} 次）`
      )
      await this.launchAgent(wm, pending, task, retries + 1)
    } else {
      // 重试超限：记录失败结果，交给 review 兜底修复（review 有 create_nng 等工具可补 NNG）
      pending.agentResults = [
        ...(pending.agentResults ?? []),
        `[子AGENT失败] 记忆 ${task?.记忆路径 ?? agentId}：${error.slice(0, 100)}`
      ]
      this.writePendingBatch(pending)
    }
    // 补位启动排队的下一个；队列空且无在跑 → drain 内部转入 review
    await this.drainAgentQueue(wm, pending)
  }

  /** 主实例阶段失败（dispatcher/review）：不更新进度，下次重试本批次 */
  private async handleStageFailed(
    wm: WorkflowManager,
    pending: PendingBatch,
    error: string
  ): Promise<void> {
    console.error(
      `[memory-workflow] ${pending.stage} 阶段失败: ${error} — 不更新进度，下次重试本批次`
    )
    this.callbacks.onCrash?.('memory-workflow', error)
    this.finishRun()
  }

  /** 取消：清理状态 + 调度下一批（进度不更新） */
  private handleCancelled(): void {
    this.finishRun()
  }

  /** 整批完成：更新进度 + 清理 + 调度下一批 */
  private updateProgressAndNext(pending: PendingBatch): void {
    try {
      // 分层：进度按作用域独立（resolveScopePaths 的 rawMemoryProgress）
      const progressPaths = pending.scope
        ? resolveScopePaths(this.paths, pending.scope)
        : (this.paths as DataPaths)
      updateRawMemoryProgress(progressPaths, pending.nextProgress)
    } catch (err) {
      console.error('[memory-workflow] 更新进度失败:', err)
    }
    this.clearPendingBatch()
    this.finishRun()
    if (!this.shouldStop && this.config.enabled) {
      this.scheduleCheck(100)
    }
  }

  /** 结束当前运行（保留 pendingBatch 时由下次 checkAndProcess 恢复重试） */
  private finishRun(): void {
    this.running = false
    this.callbacks.onDmnComplete?.('memory-workflow')
    if (!this.shouldStop && this.config.enabled) {
      this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
    }
  }

  /** 内存态同步（事件处理读磁盘 pending，这里保持磁盘为准即可；方法保留兼容） */
  private persistInMemory(_pending: PendingBatch): void {
    // 事件处理统一 readPendingBatch 读磁盘，无需内存态
  }

/** 记忆工作流 crash 兼容入口 */
  handleDmnCrash(dmnId: string, _reason: string): void {
    if (dmnId !== 'memory-workflow') return
    this.finishRun()
  }

// ===== 未完成批次持久化（崩溃恢复） =====
  // 实现已拆至 memory-workflow-persist.ts（纯函数），此处保留薄封装保持调用点不变

  private get pendingBatchPath(): string {
    return pendingBatchPathFor(this.paths)
  }

  private readPendingBatch(): PendingBatch | null {
    return readPendingBatchFile(this.pendingBatchPath)
  }

  private writePendingBatch(data: PendingBatch): void {
    writePendingBatchFile(this.pendingBatchPath, data)
  }

  private clearPendingBatch(): void {
    clearPendingBatchFile(this.pendingBatchPath)
  }

  /** 重新加载批次文件内容（崩溃恢复时文件内容可能已变） */
  private reloadBatchContents(batch: RawMemoryEntry[]): RawMemoryEntry[] {
    return reloadBatchContentsImpl(batch)
  }
}
