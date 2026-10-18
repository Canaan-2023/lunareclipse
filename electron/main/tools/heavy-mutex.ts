/**
 * 全局互斥队列：确保 CPU 密集任务串行执行，防止多核被打满饿死主进程事件循环。

 * 从 run-command.ts 抽取为独立模块，使 code-sandbox.ts 等其他模块无需依赖
 * run-command 即可共享同一互斥锁——重型命令和 Python 子进程共用一个队列。
 */

/** 重型任务调度状态（供监控/日志查询） */
export interface HeavySchedulerStatus {
  running: boolean
  queued: number
  totalExecuted: number
}

let heavyTail: Promise<void> = Promise.resolve()
let heavyRunning = false
let heavyQueued = 0
let heavyTotalExecuted = 0

/**
 * 看门狗上限：fn 超过该时长仍未 settle 时强制释放互斥锁。

 * 必要性：互斥链完全依赖 fn 的 Promise settle 来 release。若 fn 永不 settle
 * （子进程僵死、close 事件因句柄被孙进程持有而永不触发），release 永不执行，
 * 整条重型队列会被永久占住，后续所有重型命令全部静默排队不执行。
 * 释放后旧任务若仍在跑，最多退化为并发，比死锁可接受。
 */
const HEAVY_WATCHDOG_MS = 20 * 60_000

/** 以全局互斥方式执行重型命令：等待前面所有重活完成后才执行 */
export async function runHeavyExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = heavyTail
  let release!: () => void
  heavyTail = new Promise<void>((r) => { release = r })
  heavyQueued++
  await prev
  heavyRunning = true
  heavyQueued--
  let released = false
  const doRelease = (): void => {
    if (released) return
    released = true
    heavyRunning = false
    release()
  }
  const watchdog = setTimeout(doRelease, HEAVY_WATCHDOG_MS)
  watchdog.unref?.()
  try {
    const result = await fn()
    heavyTotalExecuted++
    return result
  } finally {
    clearTimeout(watchdog)
    doRelease()
  }
}

/** 查询重型任务调度状态 */
export function getHeavySchedulerStatus(): HeavySchedulerStatus {
  return { running: heavyRunning, queued: heavyQueued, totalExecuted: heavyTotalExecuted }
}
