/**
 * @category 记忆
 * @summary scope 级调度队列：同 scope 串行 / 跨 scope 公平轮转 / 排队等待不丢弃（ADR-25 §3.5.3）
 *
 * 为什么存在：记忆工作流的**并发单位 = 一个 (uid, aiId) scope**（用户要求「个算个的，不能混在一起」
 * + 「做好并发处理和排队等待」）。此前 `MemoryWorkflowScheduler.checkAndProcess()` 逐 scope 取批、
 * 取到第一个有批次的就 `return`——**没有队列概念**，于是：
 *   ① 没有「同一 scope 绝不并发」的显式保证（靠「一次只跑一批」隐式成立）；
 *   ② **不公平**：scope 按 uid/aiId 升序扫描，只要第一个 scope 一直有封口 RAW，后面的 scope 永远饿死。
 * 本模块把这两件事显式化：scope 键入队 → FIFO 取槽 → 跑完释放。
 *
 * 不删理由：删掉即退回「按序扫描 + 首个命中即返回」，饿死与并发语义重新变成隐式约定。
 *
 * **为什么不放开并行度（`SCOPE_CONCURRENCY = 1`，重要，勿盲调）**：
 * 工作流工具读路径走的是 `workflowCtx.paths`，而它的作用域来自**全局单值** `state.currentWorkflowScope`
 * （`bootstrap/assembly-kernel.ts` 的 getter）。若两个 scope 的批次同时跑，后启动的那次会覆盖全局作用域
 * → 先启动的实例后续工具调用会写进**别的 scope** 的目录——正是用户要消灭的「串味」。
 * 所以并行度恒为 1；要放开必须先让作用域**随实例**（`workflowCtx.paths` 按当前实例解析）而不是全局，
 * 那是本模块之外的改动。`ScopeQueue` 的 `limit` 参数已就位，届时传值即可。
 *
 * 何时用：调度器每轮 tick 调 `collectScopedBatches` 入队，`take()` 取到就启动该 scope 的批次，
 * 批次整条流水线跑完（或失败/取消）后 `releaseActive()`。
 */
import type { BaseDataPaths, MemoryScope } from '../models/paths'
import { resolveScopePaths, listExistingScopes } from '../models/paths'
import { getNextRawMemoryBatch, type RawMemoryEntry } from '../services/raw-memory-next-batch'

/** 全局 scope 并行度。为什么是 1：见文件头「为什么不放开并行度」。 */
export const SCOPE_CONCURRENCY = 1

/** scope 键（`{uid}_{aiId}`）；uid/aiId 都是数字段，后缀匹配即精确命中 */
export function scopeKeyOf(scope: { uid: number; aiId: number }): string {
  return `${scope.uid}_${scope.aiId}`
}

/** 一个待跑 scope 批次（队列 payload） */
export interface ScopedBatch {
  scope: MemoryScope
  batch: RawMemoryEntry[]
  nextProgress: { 最后处理日期: string; 最后处理序号: number }
}

/**
 * 枚举全部 (uid, aiId) scope，把**有封口 RAW 的**入队（已入队/在跑的跳过）。
 * 为什么把这段放在本模块：它是「分开处理」的入口语义（逐 scope 独立取批），
 * 且 `memory-workflow-scheduler.ts` 在体量棘轮台账内，不得增行。
 */
export function collectScopedBatches(paths: BaseDataPaths, batchSize: number, queue: ScopeQueue): void {
  for (const scope of listExistingScopes(paths)) {
    const key = scopeKeyOf(scope)
    if (queue.has(key)) continue
    const result = getNextRawMemoryBatch(resolveScopePaths(paths, scope), batchSize)
    if (result.batch.length > 0) {
      queue.offer(key, { scope, batch: result.batch, nextProgress: result.nextProgress })
    }
  }
}

/**
 * scope 级队列（带 payload，避免调用方另存一份待跑批次）。
 * 语义：
 * - `offer(key, payload)`：入队待跑；**同一 key 已在跑或已排队时忽略**（同 scope 串行）。
 * - `take()`：按 FIFO 取最多「全局并行度 − 在跑数」个，并即刻计入在跑。
 * - `releaseActive()`：跑完释放（并行度 1 → 释放全部在跑项）。
 * - 排队项在队列里保留（**不丢弃**），下轮 tick 继续参与取槽。
 */
export class ScopeQueue {
  private active = new Set<string>()
  private waiting: Array<{ key: string; payload: ScopedBatch }> = []

  constructor(private readonly limit: number = SCOPE_CONCURRENCY) {}

  /** 入队；同 key 已在跑/已排队 → 忽略（不重复叠加） */
  offer(key: string, payload: ScopedBatch): void {
    if (this.active.has(key) || this.waiting.some((w) => w.key === key)) return
    this.waiting.push({ key, payload })
  }

  /** 取可启动的项（FIFO，受全局并行度约束）；取到的项即刻计入「在跑」 */
  take(): ScopedBatch[] {
    const out: ScopedBatch[] = []
    const cap = Math.max(1, this.limit)
    // 每轮把取到的项计入 active，故用 active.size 判上限（不要同时累加 out.length，会重复计数）
    while (this.waiting.length > 0 && this.active.size < cap) {
      const item = this.waiting.shift() as { key: string; payload: ScopedBatch }
      this.active.add(item.key)
      out.push(item.payload)
    }
    return out
  }

  /** 释放槽位（批次整条流水线结束：完成 / 失败 / 取消） */
  releaseActive(): void {
    this.active.clear()
  }

  /** 该 scope 是否已在跑或已排队 */
  has(key: string): boolean {
    return this.active.has(key) || this.waiting.some((w) => w.key === key)
  }

  /** 在跑 scope 数（0 = 可再次取槽） */
  get activeCount(): number {
    return this.active.size
  }

  /** 排队等待 scope 数（**>0 表示有活儿在等，不得丢弃**） */
  get waitingCount(): number {
    return this.waiting.length
  }

  /** 完全空闲（无在跑、无排队） */
  get idle(): boolean {
    return this.active.size === 0 && this.waiting.length === 0
  }

  /** 清空（调度器 stop 时调用） */
  clear(): void {
    this.active.clear()
    this.waiting.length = 0
  }
}
