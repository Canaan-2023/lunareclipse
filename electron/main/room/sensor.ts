/**
 * @category ROOM
 * @summary 房间感知器：AI **静默之后**由采集器低频采样，只在环境发生有意义变化时唤醒 AI
 *
 * 为什么存在（用户 2026-10-20 裁决，勿回退）：「自主模式不是时间轮询驱动，也不是让 AI 就那么静默，
 * 而是让 AI 真正的循环起来」；「采集器，待机状态事件激活，其余状态是 **AI 静默后激活**」。
 * 此前 `WakeSource` 只有 `user-present` / `monitor`——房间 park 之后只能等用户或工作流事件，
 * 「采集器返回数据 → 激活 AI」这一环是断的（README 曾如实标注为当前边界）。
 *
 * 边界（与「采集器是感官不是定时器」不冲突）：
 * - 本模块**不调用模型**。定时器只驱动**廉价采样**（CPU / 可用内存 / 本应用传输计数，
 *   都是进程内或 os 模块读数），不跑 PowerShell、不扫进程；
 * - **看什么由 AI 的策略决定**（0.53.3）：`enabled / mute / intervalMs / thresholds`；
 *   被屏蔽的信号不采、不产生唤醒——AI 用屏蔽对付噪声，不再靠系统计数；
 * - **条件触发，不设上限**（用户 2026-10-20 裁决「反正是条件触发，不用加上限」）：
 *   只有相邻两次采样**越过阈值**且唤醒被接受才触发；持续高位不会反复唤醒
 *   （差分是「相邻两次采样」，不是与唤醒时的基线比）。
 * - 防抖只剩三层：阈值、相邻差分、唤醒仲裁的同源 5s（双击去重）；
 *   AI 若想安静，自己声明 `standbyMs` 或屏蔽信号。
 * - **待机也采样**（用户 2026-10-20 纠正）：待机是 AI 说「先别主动做事」，不是闭眼；
 *   事件仍可提前把它叫醒，`standbyMs` 只是最迟醒来时刻。
 *   只有 `running`（正在采集）/ `stopped`（用户关停）/ `sensor.enabled=false` 不采样。
 *
 * 不删理由：删掉即 idle 重新变成「AI 就那么静默」——闭环最后一环缺失。
 */
import type { RoomTimers } from './runtime-types'
import { PROFILE_TTL_MS } from '../performance/runtime-profile'
import { MAX_SENSOR_INTERVAL_MS, type RoomSensorPolicy, type SensorSignal } from '@shared/room/sensor-policy'

/** 一次廉价环境采样。字段可选：视图里没有的字段不采（`undefined` 表示本次不判）。 */
export interface RoomSensorSnapshot {
  at: number
  /** CPU 使用率（0-100） */
  cpuPct?: number
  /** 可用内存（GB） */
  freeMemGB?: number
  /** 本应用活跃 LAN 流数量 */
  lanStreams?: number
  /** 中继待取件条数 */
  relayPending?: number
}

export interface RoomSensorThresholds {
  /** CPU 变化百分比阈值（百分点） */
  cpuDeltaPct: number
  /** 可用内存变化阈值（GB） */
  freeMemDeltaGB: number
}

export const SENSOR_DEFAULTS = {
  /**
   * 采样间隔 = **3 × `PROFILE_TTL_MS`（5s）**。
   * 为什么不是拍脑袋的「15 秒」：运行时快照本身有 5s TTL，采样快于 5s 只会读到同一份 CPU 差分；
   * 取 3 个周期，既保证每次拿到**新的**差值，又能把单次调度尖峰平滑掉。
   *
   * 注意：这是**默认值**。AI 可以在计划里用 `sensor.intervalMs` 改写它；下限见
   * `SENSOR_INTERVAL_FLOOR_MS`，上限不设（AI 自己决定多久看一次）。
   */
  intervalMs: 3 * PROFILE_TTL_MS,
  /**
   * CPU 阈值 30 个百分点：15s 平均下，正常系统调度抖动通常在 10pp 以内；
   * 30pp ≈ 3 倍噪声底，且语义上代表「约三分之一的机器算力被占用/释放」。
   * AI 可用 `sensor.thresholds.cpuDeltaPct` 改写（同样只是默认值）。
   */
  cpuDeltaPct: 30,
  /**
   * 可用内存阈值 2GB：一个浏览器 / 构建进程 / 游戏释放的典型量级；
   * 低于它多半是文件缓存涨落，不代表「有事发生」。
   * AI 可用 `sensor.thresholds.freeMemDeltaGB` 改写。
   */
  freeMemDeltaGB: 2
} as const

/**
 * 采样间隔下限 = 运行时快照 TTL（5s）。
 * 为什么是技术下限而不是产品限制：`collectEnvironment()` 读的是带 TTL 的快照；比它更快
 * 只会反复读到**同一份** CPU 差分，既没有新信息，又白耗电。AI 可以把间隔调得很长，
 * 系统不会替它设上限。
 */
export const SENSOR_INTERVAL_FLOOR_MS = PROFILE_TTL_MS

export interface SensorDiff {
  changed: boolean
  /** 人可读的变化原因（进事件流 / UI 的「最近唤醒」） */
  reasons: string[]
}

/**
 * 差分（纯函数）：只比较**两边都有值**的字段。返回的 reasons 同时是事件流文案。
 * 语义是「相邻两次采样的变化」——持续高位不会反复触发（只有新的跃迁才算）。
 * 非有限值（NaN / Infinity）视为「本次没有这个字段」，避免毒化基线或每次采样都触发。
 */
export function diffSensor(
  prev: RoomSensorSnapshot,
  next: RoomSensorSnapshot,
  thresholds: RoomSensorThresholds = { cpuDeltaPct: SENSOR_DEFAULTS.cpuDeltaPct, freeMemDeltaGB: SENSOR_DEFAULTS.freeMemDeltaGB },
  /** AI 屏蔽的信号：命中的信号**不参与差分**，因此也不会产生唤醒 */
  muted: readonly SensorSignal[] = []
): SensorDiff {
  const reasons: string[] = []
  const off = (s: SensorSignal): boolean => muted.includes(s)
  const num = (v: number | undefined): number | undefined => (v != null && Number.isFinite(v) ? v : undefined)
  const prevCpu = num(prev.cpuPct)
  const nextCpu = num(next.cpuPct)
  if (!off('cpu') && prevCpu != null && nextCpu != null) {
    const delta = Math.abs(nextCpu - prevCpu)
    if (delta >= thresholds.cpuDeltaPct) {
      reasons.push(`CPU ${Math.round(prevCpu)}% → ${Math.round(nextCpu)}%`)
    }
  }
  const prevMem = num(prev.freeMemGB)
  const nextMem = num(next.freeMemGB)
  if (!off('memory') && prevMem != null && nextMem != null) {
    if (Math.abs(nextMem - prevMem) >= thresholds.freeMemDeltaGB) {
      reasons.push(`可用内存 ${prevMem.toFixed(1)}GB → ${nextMem.toFixed(1)}GB`)
    }
  }
  const prevLan = num(prev.lanStreams)
  const nextLan = num(next.lanStreams)
  if (!off('lan') && prevLan != null && nextLan != null && prevLan !== nextLan) {
    reasons.push(`局域网流 ${prevLan} → ${nextLan}`)
  }
  const prevRelay = num(prev.relayPending)
  const nextRelay = num(next.relayPending)
  if (!off('relay') && prevRelay != null && nextRelay != null && prevRelay !== nextRelay) {
    reasons.push(`中继待取件 ${prevRelay} → ${nextRelay}`)
  }
  return { changed: reasons.length > 0, reasons }
}

export interface RoomSensorDeps {
  /** 采一次廉价快照；`null` = 当前不可感知（未授权 / 视图无可用字段）——同时清基线 */
  sample: () => Promise<RoomSensorSnapshot | null>
  /**
   * 越过阈值且通过冷却 / 预算时回调（调用方上报 `collector` 唤醒源）。
   * **返回值 = 这次唤醒是否真的被接受**：`false`（被仲裁器去抖 / 相位拦下）时感知器
   * **保留旧基线并下一次重试**，不会把这次变化吞掉。
   */
  onChange: (reasons: readonly string[]) => boolean | void
  /** 定时器（生产注入全局注册表，便于退出清理；缺省用进程内 setTimeout） */
  timers?: RoomTimers
  intervalMs?: number
  thresholds?: Partial<RoomSensorThresholds>
  /** AI 初始策略里被屏蔽的信号（运行时随后还可 `configure` 改写） */
  muted?: readonly SensorSignal[]
  /** 是否允许感知（false = 即使 start 也不排期；运行时通常用 `configure` 表达） */
  enabled?: boolean
  /** 采样异常（不打断感知：记下来，下一次继续） */
  onError?: (err: Error) => void
}

export interface RoomSensor {
  /** 开始感知（幂等）。首次采样只建基线，不触发唤醒。策略 `enabled=false` 时不排期。 */
  start: () => void
  stop: () => void
  isRunning: () => boolean
  /** AI 改写策略：间隔变化会重排下一次采样；屏蔽信号即时生效（无需重启） */
  configure: (policy: RoomSensorPolicy) => void
}

/** 进程内定时器兜底（未注入 `RoomTimers` 时用；句柄表避免把 Timeout 对象当字符串传） */
function nativeTimers(): RoomTimers {
  const handles = new Map<string, ReturnType<typeof setTimeout>>()
  let seq = 0
  return {
    setTimeout(cb, ms) {
      const id = `sensor-${++seq}`
      const h = setTimeout(() => {
        handles.delete(id)
        cb()
      }, ms)
      if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref()
      handles.set(id, h)
      return id
    },
    clearTimeout(id) {
      const h = handles.get(id)
      if (h) {
        clearTimeout(h)
        handles.delete(id)
      }
    }
  }
}

export function createRoomSensor(deps: RoomSensorDeps): RoomSensor {
  const timers = deps.timers ?? nativeTimers()
  /** AI 策略（enabled / mute 在这里生效；阈值与间隔取有效值） */
  let policy: RoomSensorPolicy = {
    enabled: deps.enabled ?? true,
    mute: [...(deps.muted ?? [])],
    ...(deps.intervalMs != null ? { intervalMs: deps.intervalMs } : {}),
    ...(deps.thresholds ? { thresholds: { ...deps.thresholds } } : {})
  }
  const effectiveInterval = (p: RoomSensorPolicy): number =>
    Math.min(
      MAX_SENSOR_INTERVAL_MS,
      Math.max(SENSOR_INTERVAL_FLOOR_MS, p.intervalMs ?? SENSOR_DEFAULTS.intervalMs)
    )
  const effectiveThresholds = (p: RoomSensorPolicy): RoomSensorThresholds => ({
    cpuDeltaPct: p.thresholds?.cpuDeltaPct ?? SENSOR_DEFAULTS.cpuDeltaPct,
    freeMemDeltaGB: p.thresholds?.freeMemDeltaGB ?? SENSOR_DEFAULTS.freeMemDeltaGB
  })
  let intervalMs = effectiveInterval(policy)
  let thresholds = effectiveThresholds(policy)

  let running = false
  let handle: string | null = null
  /** 上一次成功样本（不可感知时清空，避免「授权恢复后第一眼」被误判为变化） */
  let prev: RoomSensorSnapshot | null = null
  let busy = false
  /**
   * 代际：stop/start/configure 时 +1。在飞的 `await sample()` 恢复后发现代际变了就丢弃，
   * 否则上一代的样本会被写成新会话的基线（跨代污染）。
   */
  let gen = 0

  const clear = (): void => {
    if (handle != null) {
      timers.clearTimeout(handle)
      handle = null
    }
  }

  const schedule = (): void => {
    if (!running || !policy.enabled || handle != null) return
    handle = timers.setTimeout(() => {
      handle = null
      void tick()
    }, intervalMs, 'room-sensor')
  }

  const tick = async (): Promise<void> => {
    if (!running || !policy.enabled) return
    if (busy) {
      schedule()
      return
    }
    busy = true
    const g = gen
    try {
      const sample = await deps.sample()
      if (!running || g !== gen) return
      if (!sample) {
        // 当前不可感知（未授权）：清基线，别把长间隔当成变化
        prev = null
        return
      }
      if (!prev) {
        prev = sample
        return
      }
      const diff = diffSensor(prev, sample, thresholds, policy.mute)
      if (!diff.changed) {
        prev = sample
        return
      }
      const accepted = deps.onChange(diff.reasons)
      if (accepted === false) {
        // 被仲裁器同源去抖拦下：不推进基线，下一次采样继续重试（变化不会丢）
        return
      }
      prev = sample
    } catch (err) {
      // 采样失败后清基线：恢复时不要把「跨故障间隔」的变化当成一次跃迁（SRE P2）
      prev = null
      deps.onError?.(err instanceof Error ? err : new Error(String(err)))
    } finally {
      busy = false
      schedule()
    }
  }

  return {
    start() {
      if (running || !policy.enabled) return
      running = true
      gen += 1
      // 只清基线：首次采样只建基线，不触发唤醒
      prev = null
      schedule()
    },
    stop() {
      running = false
      gen += 1
      clear()
      prev = null
    },
    isRunning: () => running,
    configure(next) {
      const nextInterval = effectiveInterval(next)
      const intervalChanged = nextInterval !== intervalMs
      const wasEnabled = policy.enabled
      // 策略变更即新一代：在飞的旧样本不能在旧策略/旧基线上落地
      gen += 1
      policy = {
        enabled: next.enabled,
        mute: [...next.mute],
        ...(next.intervalMs != null ? { intervalMs: next.intervalMs } : {}),
        ...(next.thresholds ? { thresholds: { ...next.thresholds } } : {})
      }
      intervalMs = nextInterval
      thresholds = effectiveThresholds(policy)
      // 关闭感知：立刻停排期并清基线；重新打开由运行时的 syncSensor 调 start
      if (!policy.enabled) {
        running = false
        clear()
        prev = null
        return
      }
      // 从关到开 / 间隔变化：旧排期已经不代表新策略，丢弃并按新间隔重排
      if ((!wasEnabled && running) || (intervalChanged && running)) {
        clear()
        if (running) schedule()
      }
    }
  }
}
