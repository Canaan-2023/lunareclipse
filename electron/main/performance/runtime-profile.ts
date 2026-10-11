/**
 * 运行时设备参数检测（性能子系统 ：动态资源分配的第一步）
 *
 * 为什么存在：蒸馏/工作流/子 agent 的并发配置此前要么写死（maxConcurrent: 2），
 * 要么只在启动时检测一次机器配置（subagent-scheduler / hardware-profiler 是
 * 一次性快照，不感知「现在忙不忙」）。用户要求「检查当前运行设备的参数，
 * 自动分配不同的核心、不同的线程」，且必须是动态的——本轮运行时的负载
 * （CPU 是否已被其他任务占满）决定了此刻到底该放开还是收拢并发。
 *
 * 本模块职责：
 * - sampleCpuUsage()：同步采样系统级 CPU 使用率（Windows 下 os.loadavg() 恒为
 * 0，改用 os.cpus() 的 times 增量差估算，跨调用自然存在时间间隔，无需 sleep）
 * - getRuntimeProfile()：带 TTL 缓存的完整运行时快照（逻辑核/物理核/内存/负载），
 * 物理核数由 hardware-profiler 的跨平台查询异步补全，缓存后同步可读
 * - 供 dynamic-pool.ts 计算动态并发上限，也供 设备基底把「本机」注册为一台设备
 */
import { cpus, totalmem, freemem, availableParallelism } from 'os'
import { detectHardwareDetailed, type HardwareInfo } from '../utils/hardware-profiler'

/** 采样间隔下限：两次 os.cpus() 读数间隔太短时差值噪声大，延用上次值 */
const MIN_SAMPLE_GAP_MS = 150
/** 运行时快照缓存 TTL（毫秒）：5 秒内复用，避免每次 limit 查询都重算 */
const PROFILE_TTL_MS = 5_000

/** CPU 采样基线（上一次 os.cpus() 读数 + 时间戳） */
interface CpuSampleBase {
  /** 各核累计总 tick（user+nice+sys+idle+irq） */
  totalTicks: number[]
  /** 各核累计空闲 tick */
  idleTicks: number[]
  /** 采样时间戳（毫秒） */
  at: number
}

let cpuBase: CpuSampleBase | null = null
/** 上一次计算出的使用率（间隔不足时延用，避免首采抖动） */
let lastCpuUsage = 0
/** 物理核缓存（异步补全一次后长期复用；undefined=未查询） */
let cachedPhysicalCores: number | null | undefined = undefined

/** 取 os.cpus() 各核的累计总 tick / 空闲 tick */
function readCpuTicks(): { totalTicks: number[]; idleTicks: number[] } {
  const cups = cpus()
  const totalTicks: number[] = []
  const idleTicks: number[] = []
  for (const c of cups) {
    totalTicks.push(c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq)
    idleTicks.push(c.times.idle)
  }
  return { totalTicks, idleTicks }
}

/**
 * 采样系统级 CPU 使用率（0-100）。
 * 原理：os.cpus() 的 times 是进程启动以来的累计 tick，两次读数之差 / 流逝时间
 * 即区间内平均占用率。Windows 下这是 loadavg 恒 0 的唯一可行同步方案。
 * 首次调用（无基线）只建基线返回 0；间隔过短延用上次值。
 */
export function sampleCpuUsage(): number {
  const now = readCpuTicks()
  const at = Date.now()
  if (!cpuBase) {
    cpuBase = { ...now, at }
    return 0
  }
  if (at - cpuBase.at < MIN_SAMPLE_GAP_MS) {
    return lastCpuUsage
  }
  let totalDelta = 0
  let idleDelta = 0
  for (let i = 0; i < now.totalTicks.length; i++) {
    const prevTotal = cpuBase.totalTicks[i] ?? now.totalTicks[i]
    const prevIdle = cpuBase.idleTicks[i] ?? now.idleTicks[i]
    totalDelta += Math.max(0, now.totalTicks[i] - prevTotal)
    idleDelta += Math.max(0, now.idleTicks[i] - prevIdle)
  }
  cpuBase = { ...now, at }
  if (totalDelta <= 0) return lastCpuUsage
  const usage = ((totalDelta - idleDelta) / totalDelta) * 100
  lastCpuUsage = Math.max(0, Math.min(100, usage))
  return lastCpuUsage
}

/** 运行时快照（dynamic-pool 推导并发上限与 本机设备注册共用） */
export interface RuntimeProfile {
  /** 硬件静态信息（逻辑核/型号/总内存等） */
  hardware: HardwareInfo
  /** 当前 CPU 使用率（0-100，最近一次采样） */
  cpuUsagePct: number
  /** 当前可用内存（字节） */
  freeMemBytes: number
  /** 采样时刻 */
  sampledAt: number
}

/** 运行时快照缓存（TTL） */
let profileCache: RuntimeProfile | null = null
/** 物理核异步补全进行中的 promise（防并发重复查询） */
let physicalRefreshPromise: Promise<void> | null = null

/** 异步补全物理核数（只跑一次；失败静默，不影响主流程） */
function ensurePhysicalCores(): Promise<void> {
  if (cachedPhysicalCores !== undefined) return Promise.resolve()
  if (!physicalRefreshPromise) {
    physicalRefreshPromise = detectHardwareDetailed()
      .then((hw) => {
        cachedPhysicalCores = hw.physicalCores
      })
      .catch(() => {
        cachedPhysicalCores = null
      })
      .finally(() => {
        physicalRefreshPromise = null
      })
  }
  return physicalRefreshPromise
}

/**
 * 获取运行时设备快照（TTL 缓存 5 秒）。
 * 每次跨 TTL 调用重新采样 CPU 使用率与可用内存——这就是「动态」的关键：
 * 负载不是启动时定死的，而是随本轮实际运行状态变化。
 */
export function getRuntimeProfile(): RuntimeProfile {
  const now = Date.now()
  if (profileCache && now - profileCache.sampledAt < PROFILE_TTL_MS) {
    return profileCache
  }
  const hardware: HardwareInfo = {
    platform: process.platform,
    logicalCores: Math.max(1, availableParallelism?.() ?? cpus().length),
    physicalCores: cachedPhysicalCores ?? null,
    cpuModel: cpus()[0]?.model ?? 'unknown',
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    loadAvg: []
  }
  profileCache = {
    hardware,
    cpuUsagePct: sampleCpuUsage(),
    freeMemBytes: freemem(),
    sampledAt: now
  }
  void ensurePhysicalCores()
  return profileCache
}

/** 清空快照缓存（测试用：模拟全新进程 / 强制重采样） */
export function resetRuntimeProfile(): void {
  profileCache = null
  cpuBase = null
  lastCpuUsage = 0
  cachedPhysicalCores = undefined
}