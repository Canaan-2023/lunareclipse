/**
 * 健康检查防死循环闸（从 health-check.ts 拆出，L2 拆分）

 * AlertGate 状态机 + 错误指纹/文本截断纯函数。
 * 纯逻辑，不依赖任何实例状态，可独立单测。
 */

/** AlertGate 决策结果 */
export type AlertDecision = 'alert' | 'cooldown' | 'silence' | 'ok' | 'recovered'

interface GateState {
  fingerprint: string
  consecutiveFailures: number
  lastAlertAt: number
}

/** consecutiveFailures 上限（防无界增长：超此值后不再递增） */
const CONSECUTIVE_FAILURES_CAP = 100

/**
 * 防死循环状态机（纯逻辑，可单测）

 * 对每个检查项 key 维护状态：
 * - 失败 → 首次 alert；同指纹且冷却期内 → cooldown；同指纹冷却期后 → alert（失败计数+1）
 * - 同指纹连续失败超过上限 → silence（彻底静默，直到指纹变化）
 * - 指纹变化（错误内容变了）→ 重置计数，alert
 * - 恢复（ok）→ 清除状态，recovered
 */
export class AlertGate {
  private states = new Map<string, GateState>()

  constructor(
    private opts: { cooldownMs: number; maxConsecutiveFailures: number }
  ) {}

  decide(key: string, ok: boolean, fingerprint: string, now: number): AlertDecision {
    if (ok) {
      if (this.states.has(key)) {
        this.states.delete(key)
        return 'recovered'
      }
      return 'ok'
    }

    const prev = this.states.get(key)
    if (!prev) {
      // 首次失败：直接提醒
      this.states.set(key, { fingerprint, consecutiveFailures: 1, lastAlertAt: now })
      return 'alert'
    }

    if (prev.fingerprint !== fingerprint) {
      // 错误内容变了：可能是新问题（或上次没修好但症状变了），重置计数重新提醒
      this.states.set(key, { fingerprint, consecutiveFailures: 1, lastAlertAt: now })
      return 'alert'
    }

    // 同指纹：错误没变化
    prev.consecutiveFailures += 1
    // 计数上限至少要「比静默阈值大 1」，否则静默永远不可达：
    // 反例——CAP=100 而 maxConsecutiveFailures=200 时，计数被截顶在 100，
    // 永远无法满足「>200」这个静默条件，每轮冷却期后还会继续 alert，防死循环失效。
    const effectiveCap = Math.max(CONSECUTIVE_FAILURES_CAP, this.opts.maxConsecutiveFailures + 1)
    if (prev.consecutiveFailures > effectiveCap) {
      prev.consecutiveFailures = effectiveCap
    }
    if (prev.consecutiveFailures > this.opts.maxConsecutiveFailures) {
      // 连续失败超上限：不再打扰（防死循环），直到错误变化或恢复
      return 'silence'
    }
    if (now - prev.lastAlertAt < this.opts.cooldownMs) {
      // 冷却期内：不重复提醒
      return 'cooldown'
    }
    prev.lastAlertAt = now
    return 'alert'
  }

  /** 当前有失败状态的 key（调试/报告用） */
  failingKeys(): string[] {
    return Array.from(this.states.keys())
  }
}

/** 错误指纹：取输出前 2000 字符的 djb2 hash，同指纹 ≈ 同一错误 */
export function hashFingerprint(text: string): string {
  let h = 5381
  // 归一化：剥离输出中每次运行都会变化的内容，使同错误 → 同指纹 → 冷却期生效。
  // 1. ANSI 转义码（vitest 等 TTY 工具输出的颜色控制符，每次可能不同）
  // 2. npm debug 日志路径中的时间戳（如 2026-08-06T05_09_22_042Z-debug-0.log）
  // 3. 测试执行时间（如 "17 tests) 31ms" → "17 tests) <ms>"），每次运行必然不同
  // 4. 端口号、内存值等动态数字（如 "http://127.0.0.1:8789" 中端口固定但其他位置可能变）
  const sample = text
    .slice(0, 2000)
    // eslint-disable-next-line no-control-regex -- 刻意清除 ANSI 颜色控制符做归一化
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // ANSI 转义码
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z?-debug-\d+\.log/g, '<npm-debug-log>')
    .replace(/\)\s*\d+\s*ms/g, ') <ms>') // vitest 行尾执行时间
    .replace(/\b\d+\s*ms\b/g, '<ms>') // 独立的 ms 时间值
  for (let i = 0; i < sample.length; i++) {
    h = ((h << 5) + h + sample.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

/** 截断长文本（注入事件时控制长度） */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '\n……（已截断）'
}