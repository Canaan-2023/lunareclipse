import { describe, it, expect } from 'vitest'
import { AiCollaborationScheduler, COLLABORATION_EVENT_PREFIX } from '../electron/main/multi-instance/ai-collaboration-scheduler'
import type { TimerRegistry, TimerHandle } from '../electron/main/monitor/timer-registry'
import type { ActivationManager } from '../electron/main/api/activation-manager'

/** 最小可用的假 TimerRegistry：记录回调/延迟与已清理句柄，不真正触发 */
class FakeTimerRegistry {
  timeouts: Array<{ id: TimerHandle; cb: () => void; delay: number }> = []
  cleared: TimerHandle[] = []
  setTimeout(cb: () => void, delay: number): TimerHandle {
    const id = `t${this.timeouts.length}`
    this.timeouts.push({ id, cb, delay })
    return id
  }
  clearTimeout(id: TimerHandle): void {
    this.cleared.push(id)
  }
}

/** 最小可用的假 ActivationManager：只保留 pushExternalEvent / hasPendingEvent */
class FakeActivation {
  queue: string[] = []
  pushExternalEvent(content: string): void {
    this.queue.push(content)
  }
  hasPendingEvent(prefix: string): boolean {
    return this.queue.some((c) => c.includes(prefix))
  }
}

interface Deps {
  enabled: boolean
  lanActive: boolean
  interval: number
  prompt: string
  pendingPrefilled?: string
}

function make(deps: Partial<Deps>): {
  sched: AiCollaborationScheduler
  timer: FakeTimerRegistry
  activation: FakeActivation
} {
  const timer = new FakeTimerRegistry()
  const activation = new FakeActivation()
  if (deps.pendingPrefilled) activation.queue.push(deps.pendingPrefilled)
  const sched = new AiCollaborationScheduler({
    timerRegistry: timer as unknown as TimerRegistry,
    activationManager: activation as unknown as ActivationManager,
    isEnabled: () => deps.enabled ?? true,
    isLanActive: () => deps.lanActive ?? true,
    buildPrompt: () => deps.prompt ?? '可用线路：好友/聊天室/公示板。',
    intervalMs: () => deps.interval ?? 60000,
    random: () => 0.5,
  })
  return { sched, timer, activation }
}

describe('AiCollaborationScheduler 主动协作心跳', () => {
  it('tick：未启用时跳过（standalone / proactive=false）', () => {
    const { sched, activation } = make({ enabled: false })
    expect(sched.tick()).toBe(false)
    expect(activation.queue).toHaveLength(0)
  })

  it('tick：LAN 未运行时跳过', () => {
    const { sched, activation } = make({ lanActive: false })
    expect(sched.tick()).toBe(false)
    expect(activation.queue).toHaveLength(0)
  })

  it('tick：队列已有同源协作事件时跳过（single-flight）', () => {
    const { sched, activation } = make({ pendingPrefilled: `${COLLABORATION_EVENT_PREFIX}上次未消费` })
    expect(sched.tick()).toBe(false)
    expect(activation.queue).toHaveLength(1)
  })

  it('tick：满足条件时注入带线路前缀的事件', () => {
    const { sched, activation } = make({ prompt: '可用线路：好友/聊天室。' })
    expect(sched.tick()).toBe(true)
    expect(activation.queue).toHaveLength(1)
    expect(activation.queue[0]).toContain(COLLABORATION_EVENT_PREFIX)
    expect(activation.queue[0]).toContain('好友')
  })

  it('start：间隔<=0 不调度；否则注册 setTimeout 并按抖动计算延迟', () => {
    const off = make({ interval: 0 })
    off.sched.start()
    expect(off.timer.timeouts).toHaveLength(0)

    const on = make({ interval: 60000 })
    on.sched.start()
    expect(on.timer.timeouts).toHaveLength(1)
    // random=0.5 → 抖动系数 = 1 + (1.0-0.5)*0.2 = 1.0 → delay = 60000
    expect(on.timer.timeouts[0].delay).toBe(60000)
    // 重复 start 无副作用
    on.sched.start()
    expect(on.timer.timeouts).toHaveLength(1)
  })

  it('stop：清理已注册定时器；未启动时无副作用', () => {
    const { sched, timer } = make({ interval: 60000 })
    sched.stop()
    expect(timer.cleared).toHaveLength(0)

    sched.start()
    const id = timer.timeouts[0].id
    sched.stop()
    expect(timer.cleared).toEqual([id])
  })
})
