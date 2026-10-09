/**
 * 为什么存在：多开实例并存时 AI 主动协作若同时唤醒会互相抢资源，且 LAN 未在线/AI 非空闲时触发没有意义，需要节流错峰。
 * 作用：注册定时器驱动一次协作：经 jitter 抖动、按可用性与空闲开关过滤，组装协作 prompt 交给上层执行。
 */

import type { TimerRegistry, TimerHandle } from '../monitor/timer-registry'
import type { ActivationManager } from '../api/activation-manager'

/**
 * AI 协作心跳：周期性把「协作」事件注入主会话，让 AI 自行判断要不要去
 * 聊天室/私聊/公示板发言（主动发起，而非只被动应答）。

 * 设计要点：
 * - 走主会话激活事件，不用 headless 会话，避免挤占 streamSession 的串行队列。
 * - single-flight：队列里已有未消费的协作事件则跳过本轮，避免堆积。
 * - 仅在局域网真正运行时启用（standalone 角色下 LAN 未启动，自动不启用）。
 * - 默认关闭，由 ai-agent-config.json 的 proactive 控制。
 */

/** 事件内容前缀，供 single-flight 去重识别 */
export const COLLABORATION_EVENT_PREFIX = '【月蚀协作】'

export interface AiCollaborationDeps {
  timerRegistry: TimerRegistry
  activationManager: ActivationManager
  /** 是否启用（读 ai-agent-config 的 proactive） */
  isEnabled: () => boolean
  /** 局域网是否在运行（standalone 角色下为 false） */
  isLanActive: () => boolean
  /** 构造注入内容（列出可用线路；无话可说就让 AI 什么都不做） */
  buildPrompt: () => string
  /** 间隔毫秒（<=0 视为关闭） */
  intervalMs: () => number
  /** 抖动比例（默认 0.2，避免多实例同刻唤醒） */
  jitterRatio?: number
  /** 随机源（测试注入） */
  random?: () => number
}

export class AiCollaborationScheduler {
  private handle: TimerHandle | null = null

  constructor(private readonly deps: AiCollaborationDeps) {}

  /** 启动周期唤醒（重复调用无副作用） */
  start(): void {
    if (this.handle) return
    const base = this.deps.intervalMs()
    if (base <= 0) return
    const jitter = this.deps.jitterRatio ?? 0.2
    const rnd = this.deps.random ?? Math.random
    // ±jitter 抖动：多实例不会同刻唤醒
    const delay = Math.max(1000, Math.round(base * (1 + (rnd() * 2 - 1) * jitter)))
    this.handle = this.deps.timerRegistry.setTimeout(() => {
      this.handle = null
      this.tick()
      this.start() // 下一轮（间隔可能已被配置改动，每轮重新读取）
    }, delay, 'ai-collaboration')
  }

  /** 停止周期唤醒 */
  stop(): void {
    if (!this.handle) return
    this.deps.timerRegistry.clearTimeout(this.handle)
    this.handle = null
  }

  /** 单次唤醒判定：不满足条件则不注入 */
  tick(): boolean {
    if (!this.deps.isEnabled()) return false
    if (!this.deps.isLanActive()) return false
    // single-flight：已有未消费的协作事件 → 跳过本轮，避免堆积
    if (this.deps.activationManager.hasPendingEvent(COLLABORATION_EVENT_PREFIX)) return false
    this.deps.activationManager.pushExternalEvent(`${COLLABORATION_EVENT_PREFIX}${this.deps.buildPrompt()}`)
    return true
  }
}
