/**
 * 子 AGENT 进程级调度器：机器配置检测 + 动态并发上限 + 全局 FIFO 排队。

 * 为什么存在：子 AGENT（同步 SubAgentManager + 异步 AsyncDelegationManager 两套入口）
 * 并发上限是硬编码 10，且 AsyncDelegationManager.dispatch 无任何并发限制——用户明确
 * 要求"检查电脑配置，实行自动分配，排队来解决当下的性能问题"。同一台机器上两套入口
 * 同时跑子 agent 可能把 CPU/内存打爆（每个子 agent 都是独立 LLM 流式会话 + 工具进程）。

 * 什么作用：
 * - detectMachineCapacity：读 os.cpus()/totalmem/freemem，按 "min(逻辑核, 内存槽位, 8)" 估算
 * 本机安全的并发上限（内存槽位 = 总内存 50% / 每会话 2GB，见函数注释），8 封顶保证
 * 主对话与 UI 仍有余量
 * - SubAgentScheduler：全局单例信号量——超过上限的任务进 FIFO 等待队列，空位时按先来
 * 先出唤醒；支持 AbortSignal，排队中被中断的任务直接移出队列、不占槽位
 * - resolveMaxConcurrency：ConcurrencyConfig.maxConcurrent 支持显式数字或 'auto'
 * - SubAgentManager / AsyncDelegationManager 各自接入全局调度器（构造时注入同一实例），
 * 跨入口共享同一并发预算

 * 留存理由：并发调度是子 agent 性能的公共底座，集中一处实现避免两套入口各自维护
 * 计数/队列而产生竞态；auto 上限随机器配置自适应，同时保留显式配置覆盖能力。
 */
import { cpus, totalmem, freemem } from 'os'

/** 机器容量快照（诊断/报告用） */
export interface MachineCapacity {
  /** 逻辑核心数 */
  logicalCores: number
  /** 总内存（GB，1 位小数） */
  totalMemGB: number
  /** 空闲内存（GB，1 位小数） */
  freeMemGB: number
  /** 推荐并发上限（min(核心数, 内存槽位, 8)） */
  recommendedConcurrency: number
}

/**
 * 检测本机配置并给出推荐并发上限。
 * 为什么取 min(核心数, 内存槽位, 8)：并发子 agent 受两端约束——
 * - 逻辑核：每个子 agent 至少占一个核做 LLM 流式推理与工具执行
 * - 内存：估每个并发会话 + 工具进程约 2GB 余量（LLM 上下文 + 磁盘缓存），
 * 内存槽位 = 总内存 * 50% / 2GB（留 50% 给系统、主对话与 UI）
 * - 8 封顶：桌面应用需保证主对话与 UI 响应，8 路模型并发已远超单用户实际需求，
 * 再高只会互相抢资源拖慢总吞吐
 * 返回值恒 ≥1，空机/异常环境不退化为 0（无并发）。
 */
export function detectMachineCapacity(): MachineCapacity {
  const logicalCores = Math.max(1, cpus()?.length ?? 4)
  const totalMemGB = totalmem() / 1024 ** 3
  const freeMemGB = freemem() / 1024 ** 3
  const memSlots = Math.max(1, Math.floor((totalMemGB * 0.5) / 2))
  const recommendedConcurrency = Math.min(logicalCores, memSlots, 8)
  return {
    logicalCores,
    totalMemGB: Math.round(totalMemGB * 10) / 10,
    freeMemGB: Math.round(freeMemGB * 10) / 10,
    recommendedConcurrency
  }
}

/** 解析并发配置：显式数字直接采用；'auto' 用机器检测推荐值 */
export function resolveMaxConcurrency(input: number | 'auto', capacity: MachineCapacity = detectMachineCapacity()): number {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) {
    // Math.max(1, ...)：(0,1) 区间的数字（如 0.5）经 Math.floor 会得到 0，
    // 并发上限 0 会让所有 acquire 永久排队（active<limit 恒 false），等价于死锁。
    // 与 detectMachineCapacity 的「恒 ≥1」约定保持一致，下限兜底为 1。
    return Math.max(1, Math.floor(input))
  }
  return capacity.recommendedConcurrency
}

/** 排队条目：resolve 唤醒回调 + 可选中断信号（排队中被 abort 则移出队列） */
interface Waiter {
  resolve: (admitted: boolean) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * 全局信号量（FIFO 排队）。
 * 为什么存在：子 agent 启动点分散（launchOne / dispatch），需要统一闸门按机器容量限流；
 * 直接跑会打爆资源，全失败又不可接受——排队是"压得上、放得下"的中间态。
 * 什么作用：acquire 在有空位时立即进入（active+1），否则挂起进入 FIFO 队尾；
 * release 释放一个槽位并按先来先出唤醒队首；带 signal 的 acquire 在排队期间
 * 被 abort 时移出队列返回 false（不占槽、不误执行）。
 * 留存理由：与 tool-result-distiller 的信号量同构但专用于子 agent 全局调度，
 * 独立文件便于 SubAgentManager 与 AsyncDelegationManager 共享同一实例。
 */
export class SubAgentScheduler {
  private active = 0
  private waiters: Waiter[] = []
  private limit: number

  constructor(limit?: number) {
    // 未显式给限流时用机器配置自动计算；调用方也可 setLimit 在运行时调。
    // 显式 limit 也必须 ≥1 且有限：0/负/NaN/小数会被 Math.floor 截成 0 或非法值，
    // 使 active<limit 恒 false 导致 acquire 永久排队（死锁），所以统一回退机器推荐值
    // （与 resolveMaxConcurrency 的约定一致：并发上限恒 ≥1）。
    this.limit =
      typeof limit === 'number' && Number.isFinite(limit) && limit >= 1
        ? Math.floor(limit)
        : detectMachineCapacity().recommendedConcurrency
  }

  /** 当前并发上限 */
  getLimit(): number {
    return this.limit
  }

  /** 运行时调整并发上限（配置变更热更新用） */
  setLimit(n: number): void {
    if (!Number.isFinite(n) || n < 1) return
    this.limit = Math.floor(n)
    // 提高上限后立即把可放行的排队任务放行（否则要等下一次 release 才唤醒）
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

  /**
   * 申请调度槽位：空位直接进入；满则排队等待。
   * @param signal 可选中断信号——排队期间被 abort 返回 false（调用方按中断处理，不进执行）
   * @returns true=已获得槽位（完成后必须 release）；false=排队期间被中断
   */
  async acquire(signal?: AbortSignal): Promise<boolean> {
    // 已中断的任务不再申请槽位（快速失败路径）
    if (signal?.aborted) return false
    if (this.active < this.limit) {
      this.active += 1
      return true
    }
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = { resolve, signal }
      if (signal) {
        waiter.onAbort = () => this.removeWaiter(waiter)
        // 复用同一个 AbortSignal（多个 listener 无碍）；once 保证只移队列一次
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

  /** 把可放行的排队任务逐个放行（active < limit 且有等待者时） */
  private drain(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      // 到达放行时刻但已在排队期被 abort：释放其 abort listener 并顺延下一位
      // 注意：不使用 DOM 的 EventListener 类型（node tsconfig 无 DOM lib），
      // onAbort 是 () => void，可安全赋给 removeEventListener 的回调形参。
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
  private removeWaiter(waiter: Waiter): void {
    const idx = this.waiters.indexOf(waiter)
    if (idx === -1) return
    this.waiters.splice(idx, 1)
    waiter.resolve(false)
  }
}

/** 全局唯一调度器：SubAgentManager / AsyncDelegationManager 共享同一并发预算 */
export const globalSubAgentScheduler = new SubAgentScheduler()