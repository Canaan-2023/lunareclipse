/**
 * @category ROOM
 * @summary 唤醒仲裁（**主进程单 owner**）：采集器 / 监控 / 渲染进程只**上报事件**，不得各自唤醒 AI
 *
 * 为什么存在：用户裁决「AI 停止时由采集器返回值激活 AI」「待机模式（静默期采集器不产出，事件唤醒）」。
 * 若让每个来源自己决定「现在该唤醒」，同一时刻会被重复激活（用户到达 + 监控命中同时发生），
 * 且去抖规则会散落各处。故本模块是**唯一仲裁点**：上报 → 去抖 → 触发回调（由 owner 执行真正的激活）。
 *
 * 去抖口径（SRE 定）：**同源 5s / 跨源 60s**——同一来源 5s 内不重复；任意来源触发后 60s 内压制其它来源。
 *
 * 不删理由：删掉即唤醒判定散落到采集器/监控/渲染三处，无法保证「单 owner」与去抖一致性。
 */
export type WakeSource = 'user-present' | 'monitor'

export const WAKE_DEBOUNCE = {
  /** 同源最小间隔 */
  sameSourceMs: 5_000,
  /** 跨源最小间隔（任意来源触发后，其它来源被压制） */
  crossSourceMs: 60_000
} as const

export interface WakeArbiter {
  /** 上报一次唤醒；返回是否真的触发（被去抖丢弃则 false）。 */
  request: (source: WakeSource, now?: number) => boolean
}

/** 建一个仲裁器（纯逻辑，注入 `onWake` 与可选 `now`，便于假时钟单测）。 */
export function createWakeArbiter(onWake: (source: WakeSource) => void): WakeArbiter {
  let lastAt = Number.NEGATIVE_INFINITY
  let lastSource: WakeSource | null = null
  return {
    request(source, now = Date.now()) {
      const gap = lastSource === source ? WAKE_DEBOUNCE.sameSourceMs : WAKE_DEBOUNCE.crossSourceMs
      if (now - lastAt < gap) return false
      lastAt = now
      lastSource = source
      onWake(source)
      return true
    }
  }
}

/** 每个 AI 一个仲裁器（唤醒是「某个 AI 的房间」的事）。 */
const arbiters = new Map<number, WakeArbiter>()

export function registerWakeArbiter(aiId: number, arbiter: WakeArbiter): void {
  arbiters.set(aiId, arbiter)
}

/**
 * **唯一上报入口**（采集器 / 监控 / 渲染进程都只调这里）。
 * - 传 `aiId` → 只报该 AI（渲染进程的「用户来了」知道是哪个房间）；
 * - 不传 → 广播给所有已注册房间（监控事件不知归属，如工作流事件）。
 */
export function reportRoomWake(source: WakeSource, aiId?: number, now?: number): boolean {
  if (aiId != null) return arbiters.get(aiId)?.request(source, now) ?? false
  let any = false
  for (const a of arbiters.values()) {
    const fired = a.request(source, now)
    any = fired || any
  }
  return any
}

/** 测试/关停用：清空注册表。 */
export function clearWakeArbiters(): void {
  arbiters.clear()
}
