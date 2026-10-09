/**
 * 通用硬件检测与任务负载自动配置（L4 拆分，供任意程序复用）

 * 背景：
 * 健康检查的 test 检查项此前硬编码 `--maxWorkers=4`——换台机器要么浪费（高配机
 * 只跑 4 worker），要么超载（低配机 4 worker 也可能拖垮）。任何类似「按机器能力
 * 决定并发/负载」的任务（vitest、lint、构建、批处理）都该由本模块统一推导，
 * 不写死固定数量。

 * 设计：
 * - detectHardware()：同步采集 CPU 逻辑核/型号、内存总量与可用量、负载（无第三方依赖）
 * - detectHardwareDetailed()：尽力而为补物理核数（Windows PowerShell / Linux cpuinfo /
 * macOS sysctl，失败返回 null，不影响主流程）
 * - deriveConcurrency()：纯函数，由硬件推导并发 worker 上限。规则=「逻辑核按比例留余量」
 * 与「内存不超可用量」取小，再夹在 [minWorkers, maxWorkers] 区间；比例/余量/上限均为
 * 可调策略参数（默认值经过实测校准），数量本身永远来自硬件，不写死。
 */

import { availableParallelism, cpus, freemem, totalmem, loadavg } from 'os'
import { execFile } from 'child_process'

/** 硬件快照（同步可得的全部信息） */
export interface HardwareInfo {
  platform: NodeJS.Platform
  /** 逻辑 CPU 核数（超线程后，任务并发的直接依据） */
  logicalCores: number
  /** 物理核数（尽力而为，查询失败为 null） */
  physicalCores: number | null
  /** CPU 型号（如 "Intel(R) Core(TM) i9-14900K"） */
  cpuModel: string
  /** 物理内存总量（字节） */
  totalMemBytes: number
  /** 当前可用内存（字节） */
  freeMemBytes: number
  /** 系统 1/5/15 分钟负载均值；Windows 无此概念恒为 0 */
  loadAvg: number[]
}

/** 并发推导策略（全部可选，缺省用默认值；可被调用方按场景覆盖） */
export interface ConcurrencyPolicy {
  /** 逻辑核使用比例：0.5=留一半核给系统/前台/其他程序；1=全部用 */
  cpuRatio?: number
  /** 内存预留（GB，留给系统与其他程序） */
  reserveMemGB?: number
  /** 每个 worker 预估内存占用（MB，用于内存维度约束） */
  memPerWorkerMB?: number
  /** 并发上限（防极端大核/大内存场景失控） */
  maxWorkers?: number
  /** 并发下限（任何机器至少能跑起来） */
  minWorkers?: number
}

const GB = 1024 ** 3

/** 默认策略（经实测校准：32 核机上 ≈ vitest 默认 16 worker，约 15-20s 全量且不挤占前台） */
export const DEFAULT_CONCURRENCY_POLICY: Required<ConcurrencyPolicy> = {
  cpuRatio: 0.5,
  reserveMemGB: 2,
  memPerWorkerMB: 300,
  maxWorkers: 16,
  minWorkers: 1
}

/** 同步采集硬件快照（electron 主进程与本机工具脚本通用） */
export function detectHardware(): HardwareInfo {
  const logicalCores = Math.max(1, availableParallelism?.() ?? cpus().length)
  const cpuModel = cpus()[0]?.model ?? 'unknown'
  return {
    platform: process.platform,
    logicalCores,
    physicalCores: null, // 同步路径不查询跨平台物理核，见 detectHardwareDetailed
    cpuModel,
    totalMemBytes: totalmem(),
    freeMemBytes: freemem(),
    loadAvg: loadavg()
  }
}

/** 异步补全物理核数（尽力而为；查询失败返回 null，不抛错） */
export async function detectHardwareDetailed(): Promise<HardwareInfo> {
  const hw = detectHardware()
  hw.physicalCores = await queryPhysicalCores(hw.platform)
  return hw
}

/** 由硬件推导并发 worker 数（纯函数，可单测；不写死固定数量） */
export function deriveConcurrency(hw: HardwareInfo, policy: ConcurrencyPolicy = {}): number {
  const p = { ...DEFAULT_CONCURRENCY_POLICY, ...policy }
  const logical = Math.max(1, hw.logicalCores)
  // 维度 1：CPU——逻辑核按比例留余量（后台任务别占满所有核）
  const cpuBased = Math.max(1, Math.floor(logical * p.cpuRatio))
  // 维度 2：内存——预留系统占用量后，每个 worker 按预估内存折算上限
  const availGB = Math.max(0, hw.totalMemBytes / GB - p.reserveMemGB)
  const memBased = Math.max(1, Math.floor((availGB * 1024) / p.memPerWorkerMB))
  // 取小 + 夹区间
  const workers = Math.min(cpuBased, memBased)
  return Math.max(p.minWorkers, Math.min(p.maxWorkers, workers))
}

/** 把并发数格式化为命令行片段（如 "--maxWorkers=16"；供命令拼接用，可复用） */
export function workerFlag(count: number, flagName = '--maxWorkers'): string {
  return `${flagName}=${count}`
}

/** 跨平台尽力查物理核数：Windows CIM / Linux cpuinfo / macOS sysctl；超时 3s */
function queryPhysicalCores(platform: NodeJS.Platform): Promise<number | null> {
  return new Promise((resolve) => {
    let cmd: string
    let args: string[]
    if (platform === 'win32') {
      cmd = 'powershell.exe'
      args = [
        '-NoProfile',
        '-Command',
        '(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum'
      ]
    } else if (platform === 'linux') {
      cmd = 'sh'
      args = ['-c', "grep -m1 'cpu cores' /proc/cpuinfo | awk '{print $4}'"]
    } else if (platform === 'darwin') {
      cmd = 'sysctl'
      args = ['-n', 'hw.physicalcpu']
    } else {
      resolve(null)
      return
    }
    execFile(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }
      const n = Number.parseInt(String(stdout).trim(), 10)
      resolve(Number.isFinite(n) && n > 0 ? n : null)
    })
  })
}