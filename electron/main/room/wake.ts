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
 * 唤醒源（0.53.1 收口）：
 * - `user-present`：房间视图可见 / 窗口聚焦（渲染进程上报）；
 * - `monitor`：工作流等监控事件；
 * - `collector`：**AI 静默后感知器发现环境变化**（`room/sensor.ts` 低频廉价采样，
 *   阈值 + 相邻差分；不调用模型、不设小时上限）。这是「AI 自己循环起来」的最后一环——
 *   此前 idle 只能等用户/监控，用户看到的正是「AI 就那么静默了」；
 * - `user-action`：**用户刚做了一件事**（授予 `t1.collector` / 打开采集器开关）。
 *   用户显式操作不应该被「刚刚有过监控事件」的跨源去抖压掉（那正是「授权了没反应」），
 *   故该源始终按 5s 同源口径去抖。
 *
 * 去抖补充：`collector` 与 `user-action` 都是**条件触发**，不被跨源 60s 压制；
 * 只有 `user-present` / `monitor` 之间仍按「同源 5s / 跨源 60s」。
 *
 * 不删理由：删掉即唤醒判定散落到采集器/监控/渲染三处，无法保证「单 owner」与去抖一致性。
 */
export type WakeSource = 'user-present' | 'monitor' | 'collector' | 'user-action'

/** 唤醒源 → 事件流里给人看的中文标签（可观测与 UI 共用同一份措辞） */
export const WAKE_SOURCE_LABEL: Record<WakeSource, string> = {
  'user-present': '用户来了',
  monitor: '监控事件',
  collector: '感知到变化',
  'user-action': '用户操作'
}

export const WAKE_DEBOUNCE = {
  /** 同源最小间隔：一次用户动作（focus + visibilitychange）常在同一秒内重复上报，5s 视为一次 */
  sameSourceMs: 5_000,
  /** 跨源最小间隔：一轮规划通常 10–30s，60s 给足余量，避免同一件事被两条链路各叫一次 */
  crossSourceMs: 60_000
} as const

export interface WakeArbiter {
  /** 上报一次唤醒；返回是否真的触发（被去抖丢弃则 false）。`detail` 只进事件流，不参与去抖。 */
  request: (source: WakeSource, now?: number, detail?: string) => boolean
}

/** 建一个仲裁器（纯逻辑，注入 `onWake` 与可选 `now`，便于假时钟单测）。 */
export function createWakeArbiter(onWake: (source: WakeSource, detail?: string) => void): WakeArbiter {
  let lastAt = Number.NEGATIVE_INFINITY
  let lastSource: WakeSource | null = null
  return {
    request(source, now = Date.now(), detail) {
      // 用户显式操作 / 感知到变化是**条件触发**，不被「刚有监控事件」的跨源 60s 压掉；
      // 仍受 5s 同源限制（防同一事件的重复上报 / 双击）。
      const urgent = source === 'user-action' || source === 'collector'
      const gap = lastSource === source || urgent ? WAKE_DEBOUNCE.sameSourceMs : WAKE_DEBOUNCE.crossSourceMs
      if (now - lastAt < gap) return false
      lastAt = now
      lastSource = source
      onWake(source, detail)
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
 * - `now` 仅供单测注入假时钟；`detail` 是给人看的原因（进事件流，可省略）。
 */
export function reportRoomWake(source: WakeSource, aiId?: number, now?: number, detail?: string): boolean {
  if (aiId != null) return arbiters.get(aiId)?.request(source, now, detail) ?? false
  let any = false
  for (const a of arbiters.values()) {
    const fired = a.request(source, now, detail)
    any = fired || any
  }
  return any
}

/** 测试/关停用：清空注册表。 */
export function clearWakeArbiters(): void {
  arbiters.clear()
}

/**
 * 注销某个 AI 的仲裁器（运行时被销毁时调用）。
 * 为什么必须有：否则 Map 会一直持有旧 runtime 的闭包——AI 下线/换号后仍被广播唤醒，
 * 而且这是不可回收的引用（SRE 评审 P1）。
 */
export function unregisterWakeArbiter(aiId: number): void {
  arbiters.delete(aiId)
}
