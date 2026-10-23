/**
 * 健康检查告警闸（从 health-check.ts 拆出）。
 *
 * 设计口径（0.53.10 简化，用户裁决「报错当时就修」）：
 * - 只保留**冷却期**：同一检查项、同一归一化指纹在冷却期内不重复唤醒 AI；
 * - **不做连续失败静默**，也不做「N 次后永久闭嘴」：错误是否消失由下一轮检查证明，
 *   不靠计数猜。面板/模块表始终显示真实结果；
 * - 指纹变化 = 可能是新问题 → 立即提醒；恢复 → 清除状态并只发一次 recovered。
 *
 * 这样不会出现「连续失败后长期不可见」或「指纹抖动绕过静默」两类问题，
 * 代价是持续未修复的错误每过一个冷却期会再提醒一次——这正是「当时就修」的语义。
 *
 * 指纹：
 * - 全文（超长取头尾 64K+64K）归一化后 SHA-256；
 * - 归一化只抹掉每次运行必然变化的量（时间戳/独立时钟/耗时/临时目录/PID/UUID/长十六进制/本地回环端口），
 *   保留路径主体、文件名、行号、错误码等诊断差异；
 * - **不把原文长度并入 hash**（否则 `9.4s` vs `10.1s` 这类等值归一化会被长度破坏）。
 */

import { createHash } from 'crypto'

/** 告警决策结果 */
export type AlertDecision = 'alert' | 'cooldown' | 'ok' | 'recovered'

interface GateState {
  fingerprint: string
  lastAlertAt: number
}

/** 可对外观测的单 key 状态（诊断用） */
export interface AlertGateState {
  key: string
  fingerprint: string
  lastAlertAt: number
}

/** 指纹采样上限：超出后取头尾各 64K（尾部常放 vitest/tsc 汇总与真实错误） */
const FINGERPRINT_HEAD_CHARS = 64_000
const FINGERPRINT_TAIL_CHARS = 64_000

/**
 * 告警去重状态机（纯逻辑，可独立单测）。
 * 对每个检查项 key 维护「当前指纹 + 最近一次提醒时间」。
 */
export class AlertGate {
  private states = new Map<string, GateState>()

  constructor(private opts: { cooldownMs: number }) {}

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
      this.states.set(key, { fingerprint, lastAlertAt: now })
      return 'alert'
    }
    if (prev.fingerprint === fingerprint && now - prev.lastAlertAt < this.opts.cooldownMs) {
      return 'cooldown'
    }
    // 指纹变化 = 可能是新问题；冷却期已过 = 持续未修复，再提醒一次。
    this.states.set(key, { fingerprint, lastAlertAt: now })
    return 'alert'
  }

  /** 当前有失败状态的 key（调试/报告用） */
  failingKeys(): string[] {
    return Array.from(this.states.keys())
  }

  /** 单 key 的可观测状态（无状态返回 null） */
  getState(key: string): AlertGateState | null {
    const s = this.states.get(key)
    return s ? { key, fingerprint: s.fingerprint, lastAlertAt: s.lastAlertAt } : null
  }

  /** 人工重置：清除全部或指定 key 的冷却状态（不影响最近报告） */
  reset(key?: string): void {
    if (key === undefined) this.states.clear()
    else this.states.delete(key)
  }
}

/**
 * 错误指纹：全文（超长取头尾）归一化后做 SHA-256。
 * 归一化原则：只抹掉「每次运行必然不同」的内容，保留有诊断价值的差异。
 */
export function hashFingerprint(text: string): string {
  const normalized = normalizeFingerprintText(sampleFingerprintText(text))
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32)
}

/** 指纹采样：短文本全文；超长取头尾（中段省略标记固定，不把长度带进指纹） */
export function sampleFingerprintText(text: string): string {
  if (text.length <= FINGERPRINT_HEAD_CHARS + FINGERPRINT_TAIL_CHARS) return text
  return (
    text.slice(0, FINGERPRINT_HEAD_CHARS) +
    '\n……（指纹采样省略中段）……\n' +
    text.slice(-FINGERPRINT_TAIL_CHARS)
  )
}

/** 归一化易变内容（导出供测试直接锁定口径） */
export function normalizeFingerprintText(text: string): string {
  return (
    text
      // ANSI 转义码（颜色/光标控制）
      // eslint-disable-next-line no-control-regex -- 刻意清除 ANSI 控制符
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      // ISO / 本地日期时间
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}[:.]\d{2}[:.]\d{2}(?:[.,]\d+)?Z?/g, '<timestamp>')
      .replace(/\d{4}\/\d{1,2}\/\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}/g, '<timestamp>')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}_\d{2}_\d{2}_\d{3}Z?-debug-\d+\.log/g, '<npm-debug-log>')
      // 独立时钟（vitest 的 "Start at 10:14:07"、日志行首时间等，每轮必变）
      .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
      // 耗时（ms/s/m）——每次运行必然不同
      .replace(/\b\d+(?:\.\d+)?\s*ms\b/g, '<duration>')
      .replace(/\b\d+(?:\.\d+)?\s*s\b/g, '<duration>')
      .replace(/\b\d+(?:\.\d+)?\s*m\b/g, '<duration>')
      // 进程号
      .replace(/\bpid[:= ]?\d+/gi, 'pid=<pid>')
      // UUID / 长十六进制（随机 ID、哈希）
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
      // 本机回环地址 + 随机端口
      .replace(/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/gi, '<localhost>')
      // 临时目录（vitest/npm/系统临时文件路径每次不同；保留其后的文件名）
      .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s\\/]+[\\/])*(?:Temp|tmp)[\\/][^\s:)"']+/g, '<temp-path>')
  )
}

/** 截断长文本（注入事件时控制长度） */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '\n……（已截断）'
}
