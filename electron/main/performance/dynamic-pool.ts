/**
 * 动态并发池（性能子系统 核心）——「检查当前设备参数 → 自动分配核心/线程」
 *
 * 为什么存在：工具结果蒸馏（maxConcurrent 写死 2）、工作流、子 agent 此前要么是
 * 固定数字、要么只在启动时检测一次。用户要求动态优化：并发上限必须随「当前设备
 * 参数 + 当前负载」实时变化——机器空闲时放开（用满核心），机器被其他程序占满时
 * 收拢（不抢前台），内存吃紧时按内存槽位收敛。
 *
 * 组成：
 *   - deriveDynamicLimit()：纯函数。由 RuntimeProfile（逻辑核/物理核/内存/负载）
 * 推导当前推荐并发上限。维度：CPU 核数（留余量）→ 内存槽位 → 负载因子
 * （负载高自动降并发）→ 夹在 [min, max]。
 * - DynamicPool：动态信号量。与 SubAgentScheduler / ToolResultDistiller 的信号量
 * 同构（FIFO 等待队列 + 槽位转交），但 limit 不是构造时定死的——每次
 *     getLimit() 都按最新 RuntimeProfile 重算，acquire/release 后自动刷新。
 * - 全局实例：dynamicDistillPool（工具结果蒸馏专用预算）、dynamicWorkflowPool
 * （工作流实例/节点预算）、dynamicSubAgentPool（子 agent 预算），互不抢占。
 *
 * 为什么是独立模块：性能调优是公共底座，蒸馏/工作流/子 agent/未来其他并发场景
 * 共用同一套推导与调度，集中一处避免各自维护计数/队列产生竞态。
 */
import { getRuntimeProfile } from './runtime-profile'

const GB = 1024 ** 3

/** 动态并发推导策略（全部可选，缺省用默认值） */
export interface DynamicPoolPolicy {
  /** 逻辑核使用比例：0.5=留一半给系统/前台/其他程序 */
  cpuRatio?: number
  /** 内存预留（GB，留给系统与其他程序） */
  reserveMemGB?: number
  /** 每个并发任务预估内存占用（MB） */
  memPerTaskMB?: number
  /** 并发上限（防极端大核/大内存场景失控） */
  maxWorkers?: number
  /** 并发下限（任何机器至少能跑起来） */
  minWorkers?: number
  /**
   * CPU 负载因子曲线：cpuUsagePct >= highLoad 时收敛到 minWorkers，
   * <= lowLoad 时全量；中间线性过渡。默认 (60, 85)——占用超 85% 基本
   * 收到底、低于 60% 才敢用满。
   */
  loadCurve?: { lowLoad: number; highLoad: number }
}

/** 默认策略（相对保守：桌面应用需保证前台与主对话响应） */
export const DEFAULT_DYNAMIC_POOL_POLICY: Required<DynamicPoolPolicy> = {
  cpuRatio: 0.5,
  reserveMemGB: 2,
  memPerTaskMB: 300,
  maxWorkers: 8,
  minWorkers: 1,
  loadCurve: { lowLoad: 60, highLoad: 85 }
}

/** 各种场景的推荐策略（调用方按需覆盖字段） */
export const SCENARIO_POLICIES = {
  /** 工具结果蒸馏：后台辅助任务，低占用——每任务模型调用内存小，但也不能抢占主链路 */
  distill: { cpuRatio: 0.5, memPerTaskMB: 200, maxWorkers: 6, minWorkers: 2, loadCurve: { lowLoad: 65, highLoad: 90 } },
  /** 工作流：节点执行（LLM 调用 + 工具执行），内存占用较大，上限偏低 */
  workflow: { cpuRatio: 0.4, memPerTaskMB: 512, maxWorkers: 4, minWorkers: 1, loadCurve: { lowLoad: 60, highLoad: 85 } },
  /** 子 agent：整条会话链（LLM 流式 + 工具进程），占用最大，沿用 subagent-scheduler 的 8 封顶思路 */
  subAgent: { cpuRatio: 0.5, memPerTaskMB: 2048, maxWorkers: 8, minWorkers: 1, loadCurve: { lowLoad: 55, highLoad: 80 } }
} as const satisfies Record<string, DynamicPoolPolicy>

/** 合并策略：默认 + 场景覆盖 + 调用方覆盖 */
function mergePolicy(policy: DynamicPoolPolicy): Required<DynamicPoolPolicy> {
  return { ...DEFAULT_DYNAMIC_POOL_POLICY, ...policy }
}

/**
 * 由运行时设备参数 + 当前负载推导推荐并发上限（纯函数，可单测）。
 * 规则：
 * 1. CPU 维度：逻辑核 × cpuRatio（留余量，别占满所有核）
 * 2. 内存维度：可用内存 - 预留，按每任务预估占用折算上限
 * 3. 负载因子：cpuUsagePct 高 → 自动降并发（空闲放开、忙碌收拢）
 * 4. 取小 + 夹 [minWorkers, maxWorkers]
 */
export function deriveDynamicLimit(
  profile: { hardware: { logicalCores: number; totalMemBytes: number }; freeMemBytes: number; cpuUsagePct: number },
  policy: DynamicPoolPolicy = {}
): number {
  const p = mergePolicy(policy)
  const logical = Math.max(1, profile.hardware.logicalCores)
  // 维度 1：CPU——逻辑核按比例留余量（后台任务别占满所有核）
  const cpuBased = Math.max(1, Math.floor(logical * p.cpuRatio))
  // 维度 2：内存——可用内存（而非总内存）减去预留后按每任务占用折算，
  // 内存吃紧时并发随可用量收缩（与 hardware-profiler 总量口径不同：这里是动态口径）
  const availGB = Math.max(0, Math.min(profile.hardware.totalMemBytes, profile.freeMemBytes) / GB - p.reserveMemGB)
  const memBased = Math.max(1, Math.floor((availGB * 1024) / p.memPerTaskMB))
  // 维度 3：负载因子——CPU 占用超过 lowLoad 开始线性降并发，超过 highLoad 收到下限
  const { lowLoad, highLoad } = p.loadCurve
  let loadFactor = 1
  if (profile.cpuUsagePct >= highLoad) {
    loadFactor = 0
  } else if (profile.cpuUsagePct > lowLoad) {
    loadFactor = 1 - (profile.cpuUsagePct - lowLoad) / (highLoad - lowLoad)
  }
  const raw = Math.min(cpuBased, memBased) * loadFactor
  const clamped = Math.max(p.minWorkers, Math.min(p.maxWorkers, Math.floor(raw)))
  // 负载满时允许低于 minWorkers 收缩到 1？不——minWorkers 是「至少能跑起来」的
  // 保证，负载维度在 clamp 之前生效；满载时夹到 minWorkers 即收到底。
  return clamped
}

/**
 * 动态信号量：并发上限随运行时负载实时变化。
 * 与 SubAgentScheduler 同构（FIFO 等待 + 槽位转交 + abort 支持），差异在 limit
 * 非固定：每次 getLimit() 按最新 RuntimeProfile 重算，acquire/release 后刷新。
 */
export class DynamicPool {
  private active = 0
  private waiters: Array<{ resolve: (admitted: boolean) => void; signal?: AbortSignal; onAbort?: () => void }> = []
  private policy: Required<DynamicPoolPolicy>
  private lastLimit = 1

  constructor(policy: DynamicPoolPolicy = {}) {
    this.policy = mergePolicy(policy)
    this.lastLimit = this.computeLimit()
  }

  /** 当前生效并发上限（每次按最新运行时快照重算——动态的关键） */
  getLimit(): number {
    this.lastLimit = this.computeLimit()
    return this.lastLimit
  }

  /** 运行时调整策略（配置变更热更新；提高上限后立即放行可放行的排队者） */
  setPolicy(policy: DynamicPoolPolicy): void {
    this.policy = mergePolicy(policy)
    this.lastLimit = this.computeLimit()
    this.drain()
  }

  /** 当前活跃（已放行）数量 */
  getActiveCount(): number {
    return this.active
  }

  /** 排队中（未放行）数量 */
  getWaitingCount(): number {
    return this.waiters.length
  }

  /** 上次推导的上限（无新采样时的稳定引用，诊断用） */
  getLastLimit(): number {
    return this.lastLimit
  }

  /**
   * 申请调度槽位：空位直接进入；满则排队等待。
   * @param signal 可选中断信号——排队期间被 abort 返回 false（调用方按中断处理，不进执行）
   */
  async acquire(signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return false
    // 每次入场前重算上限：负载升高时收紧（新申请者按新上限排队）
    this.lastLimit = this.computeLimit()
    if (this.active < this.lastLimit) {
      this.active += 1
      return true
    }
    return new Promise<boolean>((resolve) => {
      const waiter: { resolve: (admitted: boolean) => void; signal?: AbortSignal; onAbort?: () => void } = { resolve, signal }
      if (signal) {
        waiter.onAbort = () => this.removeWaiter(waiter)
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  /** 释放一个槽位并按 FIFO 唤醒队首；被中断的队首跳过并顺延 */
  release(): void {
    if (this.active > 0) this.active -= 1
    this.drain()
  }

  /** 重算并发上限（供测试断言与诊断） */
  private computeLimit(): number {
    const profile = getRuntimeProfile()
    return deriveDynamicLimit(
      {
        hardware: { logicalCores: profile.hardware.logicalCores, totalMemBytes: profile.hardware.totalMemBytes },
        freeMemBytes: profile.freeMemBytes,
        cpuUsagePct: profile.cpuUsagePct
      },
      this.policy
    )
  }

  /** 把可放行的排队任务逐个放行（active < limit 且有等待者时） */
  private drain(): void {
    const limit = this.getLimit()
    while (this.active < limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.signal?.removeEventListener('abort', waiter.onAbort!)
      if (waiter.signal?.aborted) {
        waiter.resolve(false)
        continue
      }
      this.active += 1
      waiter.resolve(true)
    }
  }

  /** 排队中 abort：移出队列并通知 await 方（不占槽位） */
  private removeWaiter(waiter: { resolve: (admitted: boolean) => void; signal?: AbortSignal; onAbort?: () => void }): void {
    const idx = this.waiters.indexOf(waiter)
    if (idx === -1) return
    this.waiters.splice(idx, 1)
    waiter.resolve(false)
  }
}

/** 全局实例：三种并发场景各自独立预算，互不抢占 */
export const dynamicDistillPool = new DynamicPool(SCENARIO_POLICIES.distill)
export const dynamicWorkflowPool = new DynamicPool(SCENARIO_POLICIES.workflow)
export const dynamicSubAgentPool = new DynamicPool(SCENARIO_POLICIES.subAgent)

/** 解析并发配置：显式数字直接采用；'auto' 用对应场景动态池的实时上限 */
export function resolveDynamicConcurrency(
  input: number | 'auto',
  pool: DynamicPool = dynamicDistillPool
): number {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    return Math.max(1, Math.floor(input))
  }
  return pool.getLimit()
}