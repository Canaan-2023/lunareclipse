import { describe, it, expect } from 'vitest'
import {
  deriveDynamicLimit,
  resolveDynamicConcurrency,
  SCENARIO_POLICIES,
  DynamicPool
} from '../electron/main/performance/dynamic-pool'

/**
 * 动态并发推导测试（性能子系统 T2）
 *
 * 背景：蒸馏/工作流/子 agent 并发上限此前写死或只在启动时检测一次；T2 改为
 * 随「当前设备参数 + 当前负载」实时变化。本测试只覆盖纯函数——deriveDynamicLimit
 * 的维度规则（CPU 比例 / 内存槽位 / 负载因子 / 夹取范围）与 resolveDynamicConcurrency
 * 的 auto 语义，容器 / CI 上不依赖真实机器，全部手工注入 profile。
 */

function profile(partial: Partial<Parameters<typeof deriveDynamicLimit>[0]> = {}) {
  return {
    hardware: { logicalCores: 16, totalMemBytes: 32 * 1024 ** 3 },
    freeMemBytes: 24 * 1024 ** 3,
    cpuUsagePct: 20,
    ...partial
  }
}

describe('deriveDynamicLimit - CPU 维度', () => {
  it('空闲高配：逻辑核 × cpuRatio，内存宽裕时由 CPU × maxWorkers 决定', () => {
    const p = profile({ hardware: { logicalCores: 16, totalMemBytes: 64 * 1024 ** 3 }, freeMemBytes: 56 * 1024 ** 3 })
    // workflow: cpuRatio 0.4 → cpuBased = 16*0.4 = 6；memBased 宽裕；负载低全量 → 6；maxWorkers=4 封顶 → 4
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.workflow)).toBe(4)
  })

  it('低配机器（4 核）受 CPU 维度收敛', () => {
    const p = profile({ hardware: { logicalCores: 4, totalMemBytes: 8 * 1024 ** 3 }, freeMemBytes: 6 * 1024 ** 3 })
    // subAgent: cpuRatio 0.5 → 4*0.5 = 2；memBased = (6-2)GB*1024/2048MB = 2；负载低全量 → 2
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.subAgent)).toBe(2)
  })
})

describe('deriveDynamicLimit - 内存维度', () => {
  it('内存吃紧时按可用内存收缩（低于 CPU 维度）', () => {
    const p = profile({
      hardware: { logicalCores: 16, totalMemBytes: 8 * 1024 ** 3 },
      freeMemBytes: 3.5 * 1024 ** 3
    })
    // cpuBased = 8；memBased = (3.5-2)GB*1024/512 ≈ 3；取小 3
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.workflow)).toBe(3)
  })

  it('可用内存不足以支撑一个任务时收到 minWorkers', () => {
    const p = profile({
      hardware: { logicalCores: 16, totalMemBytes: 8 * 1024 ** 3 },
      freeMemBytes: 2.2 * 1024 ** 3
    })
    // memBased = (2.2-2)*1024/512 = 0.4 → floor 0 → Math.max(1, 0) = 1；minWorkers=1 兜底
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.workflow)).toBe(1)
  })
})

describe('deriveDynamicLimit - 负载因子', () => {
  it('高负载（> highLoad）收敛到 minWorkers', () => {
    const p = profile({ cpuUsagePct: 92 })
    // 负载 > 85 → loadFactor 0 → raw 0 → clamp 到 minWorkers 1
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.workflow)).toBe(1)
  })

  it('中负载线性过渡（60-85 之间按比例降并发）', () => {
    const p = profile({ cpuUsagePct: 72.5 })
    // workflow: cpuBased = 16*0.4 = 6；72.5% → factor = 1 - (72.5-60)/(85-60) = 0.5
    // raw = 6*0.5 = 3；clamp [1,4] 内 → 3
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.workflow)).toBe(3)
  })

  it('满载也至少保留 minWorkers（不饿死后台）', () => {
    const p = profile({ cpuUsagePct: 99, freeMemBytes: 1 * 1024 ** 3 })
    const limit = deriveDynamicLimit(p, SCENARIO_POLICIES.distill)
    expect(limit).toBeGreaterThanOrEqual(SCENARIO_POLICIES.distill.minWorkers ?? 1)
  })
})

describe('deriveDynamicLimit - 夹取边界', () => {
  it('超大核数受 maxWorkers 封顶', () => {
    const p = profile({ hardware: { logicalCores: 96, totalMemBytes: 256 * 1024 ** 3 }, freeMemBytes: 200 * 1024 ** 3 })
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.workflow)).toBeLessThanOrEqual(SCENARIO_POLICIES.workflow.maxWorkers ?? 4)
  })

  it('蒸馏场景默认下限 2（主链路排队不丢弃的既有行为保持）', () => {
    const p = profile({ cpuUsagePct: 95 })
    expect(deriveDynamicLimit(p, SCENARIO_POLICIES.distill)).toBe(2)
  })
})

describe('resolveDynamicConcurrency', () => {
  it('显式数字直接采用（用户配置优先）', () => {
    expect(resolveDynamicConcurrency(1)).toBe(1)
    expect(resolveDynamicConcurrency(4)).toBe(4)
    expect(resolveDynamicConcurrency(0)).not.toBe(0)
    expect(resolveDynamicConcurrency(2.7)).toBe(2)
  })

  it("'auto' 落到默认蒸馏池的实时上限", () => {
    const limit = resolveDynamicConcurrency('auto')
    expect(limit).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(limit)).toBe(true)
  })

  it('传入自定义池时按池的策略推导', () => {
    const pool = new DynamicPool({ maxWorkers: 3, minWorkers: 1 })
    const limit = resolveDynamicConcurrency('auto', pool)
    expect(limit).toBeGreaterThanOrEqual(1)
    expect(limit).toBeLessThanOrEqual(3)
  })
})