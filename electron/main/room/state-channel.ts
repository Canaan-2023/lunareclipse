/**
 * @category ROOM
 * @summary 状态通道：事件环（带裁剪）+ 状态推送，两处失败都只留痕不阻断循环
 *
 * 为什么存在：`runtime.ts` 里「事件入环 → 落盘 → 推状态」是一条固定管线，0.54.0 体量红线
 * （800 行棘轮）要求把这段机制移出主流程；移出后主流程读起来只剩业务动作本身。
 *
 * 不删理由：删掉即事件环与状态推送各自散落，裁剪上限与失败留痕会出现两份不一致实现。
 */
import type { RoomEvent, RoomRuntimeState } from './runtime-types'

export interface RoomStateChannel {
  /** 事件入环（超上限裁掉最旧的）→ 落盘 → 推状态 */
  push: (ev: RoomEvent) => void
  /** 只推状态（相位 / 待机 / 感知开关变了） */
  notify: () => void
  /** 事件环的一份副本（`getState` 下发用，调用方改不到内部数组） */
  list: () => RoomEvent[]
}

export function createStateChannel(opts: {
  /** 事件环上限 */
  max: number
  onEvent?: (ev: RoomEvent) => void
  onStateChange?: (state: RoomRuntimeState) => void
  snapshot: () => RoomRuntimeState
}): RoomStateChannel {
  const events: RoomEvent[] = []

  const notify = (): void => {
    try {
      opts.onStateChange?.(opts.snapshot())
    } catch (err) {
      console.error('[room] 状态推送失败:', (err as Error).message)
    }
  }

  return {
    push: (ev) => {
      events.push(ev)
      if (events.length > opts.max) events.splice(0, events.length - opts.max)
      try {
        opts.onEvent?.(ev)
      } catch (err) {
        // 不静默：落盘失败要看得见（不阻断循环，但绝不装作没发生）
        console.error('[room] 事件落盘失败:', (err as Error).message)
      }
      notify()
    },
    notify,
    list: () => [...events]
  }
}
