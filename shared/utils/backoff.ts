/**
 * 重试退避 / sleep 统一骨架（批次 B4）。

 * 此前指数退避计算在 server.ts / dmn-runner.ts / client-manager.ts /
 * diary-workflow-scheduler.ts / appStore.ts 里各自 Math.pow 一份，
 * 任何退避策略调整都要逐一改 5 处。本模块收敛计算骨架：

 * - computeBackoffDelay：纯函数，指数退避延迟 = min(base * mult^attempt, max)，无 max 时不封顶
 * - sleep：纯等待
 * - sleepWithBackoff：计算退避延迟并等待，返回实际延迟（供日志/记录）

 * 刻意不同源的调用点（不做强行合并，测试里逐处记录参数）：
 * - sync-engine.ts：连续状态倍增（base 是每次累乘后的当前值，非固定 base），cap 300s
 * - ai-collaboration-scheduler.ts：随机 jitter 抖动（防多实例同刻唤醒，非失败重试退避）
 * - web-search.ts humanJitter：模拟人类操作随机抖动
 */
export interface BackoffOptions {
  /** 已失败/已重试次数（从 0 开始） */
  attempt: number
  /** 基础延迟（毫秒） */
  baseDelayMs: number
  /** 延迟上限（毫秒）；缺省不封顶 */
  maxDelayMs?: number
  /** 倍增系数，默认 2 */
  multiplier?: number
}

export function computeBackoffDelay(opts: BackoffOptions): number {
  const { attempt, baseDelayMs, multiplier = 2 } = opts
  const delay = baseDelayMs * Math.pow(multiplier, attempt)
  return opts.maxDelayMs !== undefined ? Math.min(delay, opts.maxDelayMs) : delay
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms))
}

export function sleepWithBackoff(opts: BackoffOptions): Promise<number> {
  const delay = computeBackoffDelay(opts)
  return sleep(delay).then(() => delay)
}