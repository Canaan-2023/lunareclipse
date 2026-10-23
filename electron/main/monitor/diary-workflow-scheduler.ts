/**
 * 日记工作流调度器
 *
 * 为什么存在：整个时间轴记忆依赖"每天一篇 diary.md"——原始对话沉淀在大块 RAW 里，
 * AI 按时间回忆的第一入口是日记与索引表（diary/{年}/{月}/index.json），无此调度器
 * 就没有日记可查，日记检索线彻底失效。
 * 作用：后台周期性扫描 raw_memory 下所有日期，找"有对话原文但缺 diary.md"的缺口，
 * 启动单 LLM 节点工作流（wf_default_diary_writer）读当天 RAW 提炼写日记并维护索引。
 *
 * 设计：
 * - 替代原 AI 侧 cron diary-daily-write + server.ts 启动补写检查
 * - 后台周期性扫描 raw_memory 下所有日期，找出"有对话原文但缺 diary.md"的日期
 * - 对每个缺失日期，启动一个单 LLM 节点工作流（wf_default_diary_writer）：
 * 读当天 RAW 全文 → 提炼 → 写 diary.md
 * - 索引按年月目录分层：diary/{YYYY}/{MM}/index.json（与记忆系统 raw_memory/年/月/日 同构），AI 查阅先读当月表再按 file 定位日记
 * - 崩溃恢复：未完成日期持久化，重启后继续

 * 与记忆工作流的协调（既定约定：冲突时日记优先）：
 * - 日记调度器启动前检查记忆工作流是否在跑 → 在跑则等待
 * - 记忆工作流启动前检查日记调度器是否在跑 → 在跑则等待
 * - 两者检查间隔不同（日记 30s、记忆 10s），但日记通过 yieldToDiary 机制获得优先权：
 * 记忆工作流 checkStartConditions 检查 diaryHasPendingWork()，若日记有积压则让路
 *
 * 不删掉的理由：日记检索线（先查日记→再查对应日期 RAW）依赖本调度器把对话沉淀为
 * 每天一篇 diary.md 并维护索引表；无此调度则无日记可查，整条时间轴检索线失效。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { BaseDataPaths, MemoryScope } from '../models/paths'
import { resolveScopePaths, listExistingScopes } from '../models/paths'
import type { WorkflowManager } from '../workflow/manager'
import type { WorkflowEngineEvent } from '@shared/workflow/types'
import type { TimerRegistry, TimerHandle } from './timer-registry'
import { loadWorkflowSharedPrompts } from '../prompts/loader'
import { computeBackoffDelay } from '@shared/utils/backoff'

export interface DiaryWorkflowConfig {
  enabled: boolean
  checkIntervalSeconds: number
}

export interface DiaryWorkflowCallbacks {
  onOutput?: (text: string) => void
  onToolCall?: (toolName: string, params: Record<string, unknown>) => void
  onToolResult?: (toolName: string, ok: boolean, data?: unknown, error?: string) => void
  onStart?: () => void
  onComplete?: () => void
  onCrash?: (reason: string) => void
  onConditionWait?: (reason: string) => void
}

const DEFAULT_CONFIG: DiaryWorkflowConfig = {
  enabled: true,
  checkIntervalSeconds: 30
}

/** 扫描结果：一个缺失日记的日期 */
interface MissingDiary {
  date: string
  scope: MemoryScope
  rawDir: string
  rawFiles: string[]
}

/** 未完成批次持久化（崩溃恢复用） */
interface PendingDiary {
  date: string
  scope: MemoryScope
  rawDir: string
  rawContents: string
  diaryPath: string
  /** 当月索引表（{root}/memory/{uid}/{aiId}/diary/{年}/{月}/index.json，AI 先读它定位日记） */
  indexPath: string
  instanceId: string | null
}

export class DiaryWorkflowScheduler {
  private config: DiaryWorkflowConfig = DEFAULT_CONFIG
  private shouldStop = false
  private running = false
  private timerHandle: TimerHandle | null = null
  private pendingScan: MissingDiary[] = []
  private workflowManagerProvider: (() => WorkflowManager | null) | null = null
  private unsubscribe: (() => void) | null = null
  private setScopeProvider: ((scope: MemoryScope | null) => void) | null = null
  private memoryRunningProvider: () => boolean = () => false
  private failedDates = new Map<string, { count: number; nextRetryAt: number }>()
  private static readonly MAX_RETRY_COUNT = 5
  private static readonly BASE_BACKOFF_MS = 60_000
  private static readonly MAX_BACKOFF_MS = 24 * 60 * 60_000

  constructor(
    private paths: BaseDataPaths,
    private callbacks: DiaryWorkflowCallbacks = {},
    private timerRegistry?: TimerRegistry
  ) {}

  setWorkflowManagerProvider(provider: () => WorkflowManager | null): void {
    this.workflowManagerProvider = provider
    if (!this.shouldStop && !this.unsubscribe) {
      this.subscribeEvents()
    }
  }

  setScopeSetter(setter: (scope: MemoryScope | null) => void): void {
    this.setScopeProvider = setter
  }

  setMemoryRunningProvider(provider: () => boolean): void {
    this.memoryRunningProvider = provider
  }

  updateConfig(config: Partial<DiaryWorkflowConfig>): void {
    this.config = { ...this.config, ...config }
  }

  isEnabled(): boolean {
    return this.config.enabled && !this.shouldStop
  }

  isRunning(): boolean {
    return this.running
  }

  /** 快速判断是否有待处理的日记（供记忆工作流让路用） */
  hasPendingWork(): boolean {
    return this.running || this.pendingScan.length > 0 || this.readPendingDiary() !== null
  }

  start(): void {
    this.shouldStop = false
    this.subscribeEvents()
    if (this.config.enabled) {
      this.scheduleCheck(2000) // 启动后 2s 首检
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
      ? this.timerRegistry.setTimeout(run, delayMs, 'diaryWorkflow.checkAndProcess')
      : (setTimeout(run, delayMs) as unknown as TimerHandle)
  }

  private checkStartConditions(): { ok: boolean; reason?: string } {
    if (!this.config.enabled) return { ok: false, reason: 'diary_workflow_disabled' }
    if (this.running) return { ok: false, reason: 'already_running' }
    // 协调：记忆工作流在跑时让路（等记忆完成后再检查）
    if (this.memoryRunningProvider()) return { ok: false, reason: 'memory_workflow_running' }
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

    // ===== 崩溃恢复：检查未完成的日记 =====
    const pending = this.readPendingDiary()
    if (pending) {
      const recovered = await this.recoverPending(wm, pending)
      if (recovered) return
    }

    // ===== 正常路径：扫描缺失日记 =====
    const missing = this.scanMissingDiaries()
    this.pendingScan = missing

    if (missing.length === 0) {
      this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
      return
    }

    // 取最旧的日期先处理
    const target = missing[0]
    await this.launchDiaryWriter(wm, target)
  }

  /** 扫描所有作用域，找出有 RAW 但缺 diary.md 的日期（一年内，非今天） */
  private scanMissingDiaries(): MissingDiary[] {
    const results: MissingDiary[] = []
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const oneYearAgo = new Date()
    oneYearAgo.setDate(oneYearAgo.getDate() - 365)
    const oneYearAgoStr = `${oneYearAgo.getFullYear()}-${String(oneYearAgo.getMonth() + 1).padStart(2, '0')}-${String(oneYearAgo.getDate()).padStart(2, '0')}`

    const scopes = listExistingScopes(this.paths)
    for (const scope of scopes) {
      const scopedPaths = resolveScopePaths(this.paths, scope)
      const rawRoot = scopedPaths.rawMemory ?? join(this.paths.root, 'memory', `U${scope.uid}`, `AI${scope.aiId}`, 'raw_memory')
      if (!existsSync(rawRoot)) continue

      try {
        for (const y of readdirSync(rawRoot)) {
          if (!/^\d{4}$/.test(y)) continue
          const yDir = join(rawRoot, y)
          for (const m of readdirSync(yDir)) {
            if (!/^\d{2}$/.test(m)) continue
            const mDir = join(yDir, m)
            for (const day of readdirSync(mDir)) {
              if (!/^\d{2}$/.test(day)) continue
              const dateStr = `${y}-${m}-${day}`
              if (dateStr >= todayStr || dateStr < oneYearAgoStr) continue
              const dayDir = join(mDir, day)
              const diaryFile = join(dayDir, 'diary.md')
              if (existsSync(diaryFile)) continue
              const failEntry = this.failedDates.get(dateStr)
              if (failEntry && Date.now() < failEntry.nextRetryAt) continue
              if (failEntry && Date.now() >= failEntry.nextRetryAt) {
                this.failedDates.delete(dateStr)
              }
              try {
                const rawFiles = readdirSync(dayDir)
                  .filter((f) => f !== 'diary.md' && f.endsWith('.md'))
                  .map((f) => join(dayDir, f))
                if (rawFiles.length > 0) {
                  results.push({ date: dateStr, scope, rawDir: dayDir, rawFiles })
                }
              } catch {
                // dayDir 不可读，跳过
              }
            }
          }
        }
      } catch {
        // rawRoot 遍历失败，跳过该作用域
      }
    }

    results.sort((a, b) => a.date.localeCompare(b.date))
    return results
  }

  /** 启动日记撰写工作流 */
  private async launchDiaryWriter(wm: WorkflowManager, target: MissingDiary): Promise<void> {
    // 读取所有 RAW 文件内容
    const rawContents = target.rawFiles
      .map((f) => {
        try {
          return readFileSync(f, 'utf-8')
        } catch {
          return null
        }
      })
      .filter((c): c is string => c !== null)
      .join('\n\n---\n\n')

    if (!rawContents.trim()) {
      // RAW 内容为空，跳过
      console.log(`[diary-workflow] ${target.date} RAW 内容为空，跳过`)
      this.scheduleCheck(100)
      return
    }

    const diaryPath = join(target.rawDir, 'diary.md')
    // 索引按年月目录分层：diary/{年}/{月}/index.json（与记忆系统 raw_memory/年/月/日 同构）
    const scoped = resolveScopePaths(this.paths, target.scope)
    const indexPath = join(scoped.diary ?? join(scoped.memoryScope!, 'diary'), target.date.slice(0, 4), target.date.slice(5, 7), 'index.json')
    mkdirSync(dirname(indexPath), { recursive: true })

    const pending: PendingDiary = {
      date: target.date,
      scope: target.scope,
      rawDir: target.rawDir,
      rawContents,
      diaryPath,
      indexPath,
      instanceId: null
    }
    this.writePendingDiary(pending)
    this.setScopeProvider?.(target.scope)

    const workflowPrompts = loadWorkflowSharedPrompts()
    this.callbacks.onStart?.()
    this.running = true

    try {
      const instance = await wm.runInstance({
        templateId: 'wf_default_diary_writer',
        input: {
          workflow_prompts: workflowPrompts,
          date: target.date,
          raw_dir: target.rawDir,
          raw_contents: rawContents,
          diary_path: diaryPath,
          index_path: indexPath
        }
      })
      pending.instanceId = instance.id
      this.writePendingDiary(pending)

      // 边界：实例立即完成/失败
      if (instance.status === 'completed') {
        await this.handleCompleted(wm, pending)
      } else if (instance.status === 'failed') {
        await this.handleFailed(wm, pending, instance.error ?? '日记撰写立即失败')
      } else if (instance.status === 'cancelled') {
        this.handleCancelled()
      }
    } catch (err) {
      console.error('[diary-workflow] 启动日记撰写失败:', (err as Error).message)
      this.callbacks.onCrash?.((err as Error).message)
      this.finishRun()
    }
  }

  /** 崩溃恢复 */
  private async recoverPending(wm: WorkflowManager, pending: PendingDiary): Promise<boolean> {
    if (!pending.instanceId) {
      // 无实例（启动前崩溃）→ 重新启动
      this.running = true
      this.callbacks.onStart?.()
      const workflowPrompts = loadWorkflowSharedPrompts()
      this.setScopeProvider?.(pending.scope)
      try {
        const instance = await wm.runInstance({
          templateId: 'wf_default_diary_writer',
          input: {
            workflow_prompts: workflowPrompts,
            date: pending.date,
            raw_dir: pending.rawDir,
            raw_contents: pending.rawContents,
            diary_path: pending.diaryPath,
            index_path: pending.indexPath
          }
        })
        pending.instanceId = instance.id
        this.writePendingDiary(pending)
        if (instance.status === 'completed') {
          await this.handleCompleted(wm, pending)
        } else if (instance.status === 'failed') {
          await this.handleFailed(wm, pending, instance.error ?? '日记撰写恢复后立即失败')
        }
        return true
      } catch (err) {
        console.error('[diary-workflow] 恢复启动失败:', (err as Error).message)
        this.clearPendingDiary()
        this.finishRun()
        return false
      }
    }

    const instance = wm.getInstance(pending.instanceId)
    if (instance && (instance.status === 'running' || instance.status === 'paused')) {
      this.running = true
      this.callbacks.onStart?.()
      if (instance.status === 'paused') {
        try {
          await wm.modifyInstance({ instanceId: pending.instanceId, action: 'resume' })
        } catch (err) {
          console.error('[diary-workflow] 恢复 paused 实例失败:', err)
        }
      }
      return true
    }
    if (instance && instance.status === 'completed') {
      this.running = true
      this.callbacks.onStart?.()
      await this.handleCompleted(wm, pending)
      return true
    }
    // failed / cancelled / 不存在 → 清理，重新扫描
    console.warn(
      `[diary-workflow] 恢复：实例 ${pending.instanceId} 状态=${instance?.status ?? '不存在'}，清理后重新扫描`
    )
    this.clearPendingDiary()
    return false
  }

  /** 处理工作流事件 */
  private handleWorkflowEvent(event: WorkflowEngineEvent): void {
    // 性能优化：token/tool 事件只需转发，不必读磁盘 pending
    if (event.type === 'wf:token') {
      this.callbacks.onOutput?.(event.token)
      return
    }
    if (event.type === 'wf:tool_start') {
      this.callbacks.onToolCall?.(event.toolName, event.args)
      return
    }
    if (event.type === 'wf:tool_end') {
      let ok = true
      let error: string | undefined
      try {
        const parsed = JSON.parse(event.result) as { ok?: boolean; error?: string }
        ok = parsed.ok !== false
        error = parsed.error
      } catch {
        // 非 JSON 结果视为成功
      }
      this.callbacks.onToolResult?.(event.toolName, ok, event.result, error)
      return
    }

    // completed/failed/cancelled 需要读 pending 确认实例归属
    const pending = this.readPendingDiary()
    if (!pending) return
    const id = 'instanceId' in event ? event.instanceId : ''
    if (id !== pending.instanceId) return

    const wm = this.workflowManagerProvider?.()
    if (!wm) {
      console.error('[diary-workflow] handleWorkflowEvent: workflowManager 不可用')
      return
    }

    switch (event.type) {
      case 'wf:completed':
        void this.handleCompleted(wm, pending)
        break
      case 'wf:failed':
        void this.handleFailed(wm, pending, event.error)
        break
      case 'wf:cancelled':
        this.handleCancelled()
        break
      default:
        break
    }
  }

  /** 日记撰写完成 */
  private async handleCompleted(wm: WorkflowManager, pending: PendingDiary): Promise<void> {
    const instance = wm.getInstance(pending.instanceId ?? '')
    const skipped = instance?.context?.['skipped'] as boolean | undefined
    const summary = instance?.context?.['summary'] as string | undefined

    if (skipped) {
      console.log(`[diary-workflow] ${pending.date} 日记跳过：${instance?.context?.['reason'] ?? '未知原因'}`)
    } else {
      console.log(`[diary-workflow] ${pending.date} 日记撰写完成：${summary ?? ''}`)
    }

    this.clearPendingDiary()
    this.finishRun()
    // 立即检查下一个（不等 checkInterval）
    if (!this.shouldStop && this.config.enabled) {
      this.scheduleCheck(100)
    }
  }

  /** 日记撰写失败 */
  private async handleFailed(
    _wm: WorkflowManager,
    pending: PendingDiary,
    error: string
  ): Promise<void> {
    console.error(`[diary-workflow] ${pending.date} 日记撰写失败: ${error}`)
    this.callbacks.onCrash?.(error)

    const entry = this.failedDates.get(pending.date)
    const count = entry ? entry.count + 1 : 1
    if (count >= DiaryWorkflowScheduler.MAX_RETRY_COUNT) {
      console.warn(`[diary-workflow] ${pending.date} 已达最大重试次数 ${DiaryWorkflowScheduler.MAX_RETRY_COUNT}，停止重试`)
      this.failedDates.set(pending.date, { count, nextRetryAt: Number.MAX_SAFE_INTEGER })
    } else {
      const backoffMs = computeBackoffDelay({
        attempt: count - 1,
        baseDelayMs: DiaryWorkflowScheduler.BASE_BACKOFF_MS,
        maxDelayMs: DiaryWorkflowScheduler.MAX_BACKOFF_MS
      })
      this.failedDates.set(pending.date, { count, nextRetryAt: Date.now() + backoffMs })
      console.warn(`[diary-workflow] ${pending.date} 第 ${count} 次失败，${Math.round(backoffMs / 1000)}s 后重试`)
    }

    this.clearPendingDiary()
    this.finishRun()
  }

  private handleCancelled(): void {
    this.clearPendingDiary()
    this.finishRun()
  }

  private finishRun(): void {
    this.running = false
    this.callbacks.onComplete?.()
    if (!this.shouldStop && this.config.enabled) {
      this.scheduleCheck(this.config.checkIntervalSeconds * 1000)
    }
  }

  // ===== 持久化（崩溃恢复） =====

  private get pendingDiaryPath(): string {
    return join(this.paths.workflowPending, 'diary_pending.json')
  }

  private readPendingDiary(): PendingDiary | null {
    if (!existsSync(this.pendingDiaryPath)) return null
    try {
      const raw = readFileSync(this.pendingDiaryPath, 'utf-8')
      const obj = JSON.parse(raw) as PendingDiary
      if (!obj.date || !obj.scope) return null
      return obj
    } catch {
      return null
    }
  }

  private writePendingDiary(data: PendingDiary): void {
    try {
      writeFileSync(this.pendingDiaryPath, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[diary-workflow] 持久化未完成日记失败:', err)
    }
  }

  private clearPendingDiary(): void {
    if (!existsSync(this.pendingDiaryPath)) return
    try {
      unlinkSync(this.pendingDiaryPath)
    } catch {
      // 忽略删除失败
    }
  }
}
