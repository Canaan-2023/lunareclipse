import { describe, it, expect } from 'vitest'
import {
  deriveConcurrency,
  detectHardware,
  detectHardwareDetailed,
  workerFlag,
  DEFAULT_CONCURRENCY_POLICY,
  type HardwareInfo
} from '../electron/main/utils/hardware-profiler'

/** 构造硬件快照（内存单位 GB 转字节，方便用例表达） */
function hw(logicalCores: number, totalGB: number, freeGB: number): HardwareInfo {
  return {
    platform: 'win32',
    logicalCores,
    physicalCores: null,
    cpuModel: 'Test CPU',
    totalMemBytes: totalGB * 1024 ** 3,
    freeMemBytes: freeGB * 1024 ** 3,
    loadAvg: [0, 0, 0]
  }
}

describe('hardware-profiler 自动任务配置推导（deriveConcurrency）', () => {
  it('低配机器（2 核/8GB）→ 按 cpuRatio 下取整 = 1，且不低于 minWorkers', () => {
    expect(deriveConcurrency(hw(2, 8, 6))).toBe(1)
  })

  it('中配机器（8 核/32GB）→ 8*0.5=4（内存维度 30GB/0.3GB≈100 不约束）', () => {
    expect(deriveConcurrency(hw(8, 32, 30))).toBe(4)
  })

  it('32 核/64GB → 32*0.5=16，命中 maxWorkers 上限 16', () => {
    expect(deriveConcurrency(hw(32, 64, 60))).toBe(DEFAULT_CONCURRENCY_POLICY.maxWorkers)
  })

  it('小内存机器（16 核/仅 2GB）→ 预留 2GB 后内存维度归零，保底 1', () => {
    expect(deriveConcurrency(hw(16, 2, 1.5))).toBe(1)
  })

  it('内存环比 CPU 更紧时生效：16 核/3GB → 内存(3-2)GB/0.3GB=3 小于 cpu 8', () => {
    expect(deriveConcurrency(hw(16, 3, 2.5))).toBe(3)
  })

  it('内存约束生效：16 核/8GB 可用 → (8-2)GB/0.3GB=20，CPU 维度 8 更小', () => {
    expect(deriveConcurrency(hw(16, 8, 8))).toBe(8)
  })

  it('策略可覆盖：cpuRatio=1.0 时 8 核 → 8（不留余量给前台，调用方显式选择）', () => {
    expect(deriveConcurrency(hw(8, 32, 30), { cpuRatio: 1.0 })).toBe(8)
  })

  it('策略可覆盖：maxWorkers=32 时 32 核/128GB → 仍受 cpuRatio 0.5 约束 = 16', () => {
    expect(deriveConcurrency(hw(32, 128, 120), { maxWorkers: 32 })).toBe(16)
  })

  it('minWorkers 可覆盖：32 核但显式要求至少 2 → 不受影响仍 16', () => {
    expect(deriveConcurrency(hw(32, 64, 60), { minWorkers: 2 })).toBe(16)
  })

  it('极端大核（128 核）→ 命中 maxWorkers（16），不会无界膨胀', () => {
    expect(deriveConcurrency(hw(128, 512, 500))).toBe(16)
  })

  it('logicalCores 传入 0 或缺失防御：至少返回 1', () => {
    expect(deriveConcurrency(hw(0, 8, 6))).toBe(1)
  })
})

describe('hardware-profiler 硬件检测', () => {
  it('同步检测返回非空结构化结果', () => {
    const h = detectHardware()
    expect(h.logicalCores).toBeGreaterThanOrEqual(1)
    expect(h.totalMemBytes).toBeGreaterThan(0)
    expect(h.freeMemBytes).toBeGreaterThan(0)
    expect(h.freeMemBytes).toBeLessThanOrEqual(h.totalMemBytes)
    expect(h.cpuModel.length).toBeGreaterThan(0)
    // 检测结果能驱动推导（自洽性：同一快照下推导不抛错、数量>0）
    expect(deriveConcurrency(h)).toBeGreaterThanOrEqual(1)
  })

  it('异步详细检测尽力补物理核数（失败为 null，不抛错）', async () => {
    const h = await detectHardwareDetailed()
    expect(h.logicalCores).toBeGreaterThanOrEqual(1)
    // 本机若可查询则应有值；查询失败也不影响主流程
    if (h.physicalCores !== null) {
      expect(h.physicalCores).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('hardware-profiler 命令拼装工具', () => {
  it('workerFlag 生成 vitest 可识别的参数', () => {
    expect(workerFlag(16)).toBe('--maxWorkers=16')
    expect(workerFlag(4, '--poolOptions.forks.maxForks')).toBe('--poolOptions.forks.maxForks=4')
  })
})