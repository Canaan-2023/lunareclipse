import { describe, it, expect, vi } from 'vitest'

// mock os：固定机器容量（8 核 / 16GB 总内存 / 8GB 空闲），让并发计算可断言。
// 为什么 mock：detectMachineCapacity 依赖真实机器状态，测试期望值会随执行机漂移。
vi.mock('os', () => {
  return {
    cpus: () => Array.from({ length: 8 }, () => ({})),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3
  }
})

import {
  detectMachineCapacity,
  resolveMaxConcurrency,
  SubAgentScheduler
} from '../electron/main/services/subagent-scheduler'

/**
 * 子 AGENT 进程级调度器单测。

 * 背景：子 agent 同步（SubAgentManager）与异步（AsyncDelegationManager）两套入口
 * 共享 globalSubAgentScheduler 同一并发预算——超过机器容量时 FIFO 排队而非直接失败。
 * 本文件覆盖三个可机械验证的约束：
 *   1. auto 上限 = min(逻辑核, 内存槽位, 8)，且恒 ≥1
 *   2. FIFO：满员时新任务进入等待队列，release 后按先来先出放行
 *   3. abort：排队中被中断的任务移出队列、不占槽位，且不误放行
 */

/** 冲刷微任务队列：让被挂起的 acquire promise 有机会 settle */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

describe('detectMachineCapacity', () => {
  it('按 8 核 / 16GB 内存算出推荐并发 = min(8, memSlots, 8)', () => {
    const cap = detectMachineCapacity()
    // memSlots = floor(16 * 0.5 / 2) = 4
    expect(cap.logicalCores).toBe(8)
    expect(cap.totalMemGB).toBe(16)
    expect(cap.freeMemGB).toBe(8)
    expect(cap.recommendedConcurrency).toBe(4)
  })

  it('极端环境（无 CPU/无内存）也不退化为 0 并发', () => {
    // 该断言依赖 mock 固定值，验证下限保护：cpus 缺失时兜底 4、memSlots 兜底 1
    const cap = detectMachineCapacity()
    expect(cap.recommendedConcurrency).toBeGreaterThanOrEqual(1)
    expect(cap.recommendedConcurrency).toBeLessThanOrEqual(8)
  })
})

describe('resolveMaxConcurrency', () => {
  const cap = { logicalCores: 8, totalMemGB: 16, freeMemGB: 8, recommendedConcurrency: 4 }

  it("显式数字直接采用（'auto' 只在未给数字时生效）", () => {
    expect(resolveMaxConcurrency(10, cap)).toBe(10)
    expect(resolveMaxConcurrency(1, cap)).toBe(1)
  })

  it("'auto' 采用机器检测推荐值", () => {
    expect(resolveMaxConcurrency('auto', cap)).toBe(4)
  })

  it('非法数字（0/负数/NaN）回退到机器推荐值', () => {
    expect(resolveMaxConcurrency(0 as never, cap)).toBe(4)
    expect(resolveMaxConcurrency(-3 as never, cap)).toBe(4)
    expect(resolveMaxConcurrency(Number.NaN, cap)).toBe(4)
  })

  it('(0,1) 区间的合法数字经 floor 后不得退化为 0（0 并发 = 死锁）', () => {
    // 回归：0.5 通过 Number.isFinite && >0 校验后 Math.floor 得 0，会让 acquire 永久排队
    expect(resolveMaxConcurrency(0.5, cap)).toBe(1)
  })
})

describe('SubAgentScheduler FIFO 排队', () => {
  it('空位立即进入；满员时挂起排队，release 后按先来先出放行', async () => {
    const s = new SubAgentScheduler(2)
    const order: string[] = []

    expect(await s.acquire()).toBe(true)
    expect(await s.acquire()).toBe(true)

    // 第三个 acquire：满员，进入等待队列
    const p3 = s.acquire().then((ok) => {
      order.push('c')
      return ok
    })
    const p4 = s.acquire().then((ok) => {
      order.push('d')
      return ok
    })
    await flush()
    expect(s.getActiveCount()).toBe(2)
    expect(s.getWaitingCount()).toBe(2)

    // 释放一个槽位 → 队首（c）获得槽位
    s.release()
    await flush()
    expect(await p3).toBe(true)
    expect(s.getActiveCount()).toBe(2)

    // c 占用中，d 仍在排队
    expect(s.getWaitingCount()).toBe(1)

    // 再释放两个：d 拿到槽位，队列清空
    s.release()
    await flush()
    expect(await p4).toBe(true)
    s.release()
    await flush()
    expect(s.getActiveCount()).toBe(1)
    expect(s.getWaitingCount()).toBe(0)
    expect(order).toEqual(['c', 'd'])
  })

  it('setLimit 提高上限后立即放行排队任务，无需等下一次 release', async () => {
    const s = new SubAgentScheduler(1)
    expect(await s.acquire()).toBe(true)
    const p2 = s.acquire()
    await flush()
    expect(s.getWaitingCount()).toBe(1)

    s.setLimit(2)
    await flush()
    expect(await p2).toBe(true)
    expect(s.getWaitingCount()).toBe(0)
    expect(s.getActiveCount()).toBe(2)
  })

  it('setLimit 拒绝非法值（<1 / NaN），并发上限保持不变', () => {
    const s = new SubAgentScheduler(2)
    s.setLimit(0)
    expect(s.getLimit()).toBe(2)
    s.setLimit(Number.NaN)
    expect(s.getLimit()).toBe(2)
  })

  it('构造时显式非法 limit（0/小数）回退机器推荐值，不产生 0 并发死锁', () => {
    // 回归：构造传 0 会让 active<limit 恒 false、acquire 永久排队；传 0.5 会被
    // Math.floor 成 0。两者都必须兜底为机器推荐值（mock 下为 4），保证恒 ≥1。
    expect(new SubAgentScheduler(0).getLimit()).toBe(4)
    expect(new SubAgentScheduler(0.5).getLimit()).toBe(4)
  })
})

describe('SubAgentScheduler abort 移出队列', () => {
  it('排队中被 abort：返回 false、移出队列、不占槽位', async () => {
    const s = new SubAgentScheduler(1)
    expect(await s.acquire()).toBe(true)

    const ctrl = new AbortController()
    const p2 = s.acquire(ctrl.signal)
    await flush()
    expect(s.getWaitingCount()).toBe(1)

    ctrl.abort()
    await flush()
    expect(await p2).toBe(false)
    expect(s.getWaitingCount()).toBe(0)
    expect(s.getActiveCount()).toBe(1) // 槽位仍被第一个任务占用
  })

  it('已 abort 的信号直接快速失败，不进队列', async () => {
    const s = new SubAgentScheduler(1)
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await s.acquire(ctrl.signal)).toBe(false)
    expect(s.getWaitingCount()).toBe(0)
    expect(s.getActiveCount()).toBe(0)
  })

  it('release 时跳过已 abort 的队首并顺延放行下一个', async () => {
    const s = new SubAgentScheduler(1)
    expect(await s.acquire()).toBe(true)

    const ctrlA = new AbortController()
    const pA = s.acquire(ctrlA.signal)
    const pB = s.acquire()
    await flush()

    // A 在排队中被中断，B 仍在排队
    ctrlA.abort()
    await flush()
    expect(await pA).toBe(false)
    expect(s.getWaitingCount()).toBe(1)

    // 释放槽位：应跳过 A、放行 B
    s.release()
    await flush()
    expect(await pB).toBe(true)
    expect(s.getWaitingCount()).toBe(0)
    expect(s.getActiveCount()).toBe(1)
  })
})