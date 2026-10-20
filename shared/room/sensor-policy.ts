/**
 * @category ROOM
 * @summary 感知器策略：**由 AI 自己配置**要看什么、多久看一次、多大的变化才算「有事」
 *
 * 为什么存在（用户 2026-10-20 裁决）：「AI 应该有控制感知器的能力，屏蔽某个行为的能力，
 * 而不是三次这种魔法」。此前感知器固定观察 CPU / 可用内存 / 本应用传输，阈值与间隔全在代码里；
 * AI 若被某个信号反复吵醒，只能靠系统的计数刹车——那不是它自己的控制权。
 *
 * 本模块把「感知什么」变成 AI 可声明的**策略**（计划 JSON 的 `sensor` 字段）：
 * - `enabled`：是否感知（false = 完全闭眼，只保留待机到期这一条兜底）；
 * - `mute`：屏蔽某个信号（CPU / 内存 / 局域网流 / 中继待取件）——**屏蔽后该信号不再产生唤醒**；
 * - `intervalMs`：采样间隔；
 * - `thresholds`：CPU 百分点 / 可用内存 GB 的变化阈值。
 *
 * 边界（勿回退）：
 * - **策略只收窄「感知」，不放大权限**：采样仍受用户层开关 + `t1.collector` 两层闸门约束；
 * - 校验在**入口**（本文件）完成：越界 / 非法值整条拒绝并回传原因，绝不把未校验策略交给感知器；
 * - 未经声明的字段**保持当前值**（局部更新），AI 不必每轮重写整份策略。
 *
 * 不删理由：删掉即感知器回到「系统替 AI 决定看什么」——正是用户本轮否定的形态。
 */

/** 可被 AI 单独屏蔽的感知信号 */
export const SENSOR_SIGNALS = ['cpu', 'memory', 'lan', 'relay'] as const
export type SensorSignal = (typeof SENSOR_SIGNALS)[number]

/**
 * 采样间隔的**技术上限** = JS `setTimeout` 的 32 位毫秒上限（2³¹−1 ≈ 24.8 天）。
 * 为什么必须夹：Node/Electron 对超过该值的 delay **不排队等待，而是静默改成 1ms**
 * （`TimeoutOverflowWarning`）——AI 一句 `"intervalMs": 2592000000`（30 天）就会让感知器
 * 变成 1ms 忙循环。这是引擎限制，不是产品上限；更长的等待请用 `standbyMs`。
 */
export const MAX_SENSOR_INTERVAL_MS = 2 ** 31 - 1

/** 信号 → 人话（事件流 / 设置页共用同一份措辞） */
export const SENSOR_SIGNAL_LABEL: Record<SensorSignal, string> = {
  cpu: 'CPU',
  memory: '可用内存',
  lan: '局域网流',
  relay: '中继待取件'
}

export interface SensorThresholds {
  /** CPU 变化阈值（百分点） */
  cpuDeltaPct?: number
  /** 可用内存变化阈值（GB） */
  freeMemDeltaGB?: number
}

/** 一份**完整**的感知策略（运行时持有的形状） */
export interface RoomSensorPolicy {
  enabled: boolean
  /** 被屏蔽的信号（命中即不参与差分，也就不会唤醒 AI） */
  mute: SensorSignal[]
  /** 采样间隔（毫秒）；省略 = 用感知器默认值 */
  intervalMs?: number
  /** 变化阈值；省略的字段用感知器默认值 */
  thresholds?: SensorThresholds
}

/** AI 声明的**局部更新**：只包含它真的写了的字段 */
export interface SensorPolicyPatch {
  enabled?: boolean
  mute?: SensorSignal[]
  intervalMs?: number
  thresholds?: SensorThresholds
}

/** 默认策略：全部感知、不屏蔽、阈值与间隔交给感知器的默认值。 */
export const DEFAULT_SENSOR_POLICY: RoomSensorPolicy = { enabled: true, mute: [] }

export type SensorPolicyParseResult =
  | { ok: true; patch: SensorPolicyPatch }
  | { ok: false; error: string }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** 解析 AI 的 `sensor` 字段；非法值整条拒绝（不做「坏字段丢弃、好字段保留」的半吊子合并）。 */
export function parseSensorPolicyPatch(raw: unknown): SensorPolicyParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'sensor 必须是对象' }
  }
  const o = raw as {
    enabled?: unknown
    mute?: unknown
    intervalMs?: unknown
    thresholds?: unknown
  }
  const patch: SensorPolicyPatch = {}

  if (o.enabled !== undefined) {
    if (typeof o.enabled !== 'boolean') return { ok: false, error: 'sensor.enabled 必须是布尔值' }
    patch.enabled = o.enabled
  }

  if (o.mute !== undefined) {
    if (!Array.isArray(o.mute)) return { ok: false, error: 'sensor.mute 必须是数组' }
    const mute: SensorSignal[] = []
    for (const item of o.mute) {
      if (typeof item !== 'string' || !(SENSOR_SIGNALS as readonly string[]).includes(item)) {
        return {
          ok: false,
          error: `sensor.mute 含未知信号「${String(item)}」（只有 ${SENSOR_SIGNALS.join(' / ')}）`
        }
      }
      if (!mute.includes(item as SensorSignal)) mute.push(item as SensorSignal)
    }
    patch.mute = mute
  }

  if (o.intervalMs !== undefined) {
    if (!isFiniteNumber(o.intervalMs) || o.intervalMs <= 0) {
      return { ok: false, error: 'sensor.intervalMs 必须是正有限数（毫秒）' }
    }
    if (o.intervalMs > MAX_SENSOR_INTERVAL_MS) {
      return {
        ok: false,
        error: `sensor.intervalMs 超过 JS 定时器上限（${MAX_SENSOR_INTERVAL_MS}ms ≈ 24.8 天）；更长的等待请用 standbyMs`
      }
    }
    patch.intervalMs = Math.floor(o.intervalMs)
  }

  if (o.thresholds !== undefined) {
    if (!o.thresholds || typeof o.thresholds !== 'object' || Array.isArray(o.thresholds)) {
      return { ok: false, error: 'sensor.thresholds 必须是对象' }
    }
    const t = o.thresholds as { cpuDeltaPct?: unknown; freeMemDeltaGB?: unknown }
    const thresholds: SensorThresholds = {}
    if (t.cpuDeltaPct !== undefined) {
      if (!isFiniteNumber(t.cpuDeltaPct) || t.cpuDeltaPct < 1 || t.cpuDeltaPct > 100) {
        return { ok: false, error: 'sensor.thresholds.cpuDeltaPct 必须在 [1, 100] 内（百分点；低于 1pp 是噪声）' }
      }
      thresholds.cpuDeltaPct = t.cpuDeltaPct
    }
    if (t.freeMemDeltaGB !== undefined) {
      if (!isFiniteNumber(t.freeMemDeltaGB) || t.freeMemDeltaGB < 0.1) {
        return { ok: false, error: 'sensor.thresholds.freeMemDeltaGB 必须 ≥ 0.1（GB；低于它是文件缓存抖动）' }
      }
      thresholds.freeMemDeltaGB = t.freeMemDeltaGB
    }
    if (Object.keys(thresholds).length > 0) patch.thresholds = thresholds
  }

  return { ok: true, patch }
}

/**
 * 把局部更新合并到当前策略。
 * - `mute` **替换**而不是累加：AI 说「现在只屏蔽 CPU」就该是只屏蔽 CPU，否则它没法解除屏蔽；
 * - `thresholds` 按字段合并（只改 CPU 阈值不必重写内存阈值）；
 * - 其余字段有值即替换。
 */
export function applySensorPolicy(current: RoomSensorPolicy, patch: SensorPolicyPatch): RoomSensorPolicy {
  return {
    enabled: patch.enabled ?? current.enabled,
    mute: patch.mute ? [...patch.mute] : [...current.mute],
    ...(patch.intervalMs != null
      ? { intervalMs: patch.intervalMs }
      : current.intervalMs != null
        ? { intervalMs: current.intervalMs }
        : {}),
    ...(patch.thresholds || current.thresholds
      ? {
          thresholds: {
            ...(current.thresholds ?? {}),
            ...(patch.thresholds ?? {})
          }
        }
      : {})
  }
}

/** 策略里被屏蔽的信号（方便 UI / 事件流派生；顺序与 `SENSOR_SIGNALS` 一致）。 */
export function mutedSignals(policy: RoomSensorPolicy): SensorSignal[] {
  return SENSOR_SIGNALS.filter((s) => policy.mute.includes(s))
}

/** 给人看的策略摘要（事件流用；不含默认值，只写 AI 真正声明过的部分）。 */
export function describeSensorPolicy(policy: RoomSensorPolicy): string {
  const parts: string[] = [policy.enabled ? '感知开' : '感知关']
  if (!policy.enabled) return parts[0]
  const muted = mutedSignals(policy)
  if (muted.length > 0) parts.push(`屏蔽 ${muted.map((s) => SENSOR_SIGNAL_LABEL[s]).join('、')}`)
  if (policy.intervalMs != null) parts.push(`间隔 ${Math.round(policy.intervalMs / 1000)}s`)
  if (policy.thresholds?.cpuDeltaPct != null) parts.push(`CPU 阈值 ${policy.thresholds.cpuDeltaPct}pp`)
  if (policy.thresholds?.freeMemDeltaGB != null) parts.push(`内存阈值 ${policy.thresholds.freeMemDeltaGB}GB`)
  return parts.join(' · ')
}
