/**
 * @category ROOM
 * @summary 待机计时器：把 AI 声明的待机时长按引擎上限分片续排，返回取消函数
 *
 * 为什么存在：JS `setTimeout` 只有 32 位毫秒上限（2^31-1 ≈ 24.8 天），而 AI 声明的待机总时长
 * 没有产品上限——必须拆成若干段逐段续排，累计到总时长才算到期。0.54.0 从 `runtime.ts`
 * 拆出（体量红线 800 行棘轮）：这段是纯计时逻辑，与运行时状态（相位/驱动句柄）无关。
 *
 * 不删理由：删掉即长待机被引擎截断成 24.8 天，`standbyMs` 的语义随之失真。
 */
import type { RoomTimers } from './runtime-types'

/** `setTimeout` 的 32 位毫秒上限（引擎技术限制，不是产品规则） */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/**
 * 排一段（或多段）待机计时。
 *
 * @param timers 运行时注入的计时器（单测用假时钟时提供）；缺省用全局 `setTimeout`
 * @param waitMs 需要等待的总毫秒数（调用方已保证 > 0）
 * @param onExpire 真正到期时调用一次（分片全部走完才触发）
 * @returns 取消函数：清掉当前那一段，后续段不再排
 */
export function armStandbyTimer(opts: {
  timers?: RoomTimers
  waitMs: number
  onExpire: () => void
}): () => void {
  let current: (() => void) | null = null
  /**
   * 分片续排：不用「到期时刻 - now()」算剩余，是因为假时钟（单测）不推进 `now`；
   * 用本地 `remaining` 累计更可测，也更直接表达「总时长 = 各段之和」。
   */
  let remaining = opts.waitMs
  const arm = (): void => {
    const chunk = Math.min(remaining, MAX_TIMER_DELAY_MS)
    const onChunk = (): void => {
      remaining -= chunk
      if (remaining > 0) {
        arm()
        return
      }
      current = null
      opts.onExpire()
    }
    if (opts.timers) {
      const handle = opts.timers.setTimeout(onChunk, chunk, 'room-standby')
      current = () => opts.timers?.clearTimeout(handle)
    } else {
      const handle = setTimeout(onChunk, chunk)
      if (typeof handle.unref === 'function') handle.unref()
      current = () => clearTimeout(handle)
    }
  }
  arm()
  return () => {
    current?.()
    current = null
  }
}
