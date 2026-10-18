/**
 * @category LLM
 * @summary 模型切换审计环：记录 AUTO 的每次切换（供 ROOM 模型配置区展示「为什么切」）
 *
 * 为什么存在：交接单 §8.5 要求 ROOM 的模型配置管理区含「**切换审计视图**」。`tool-loop` 只把切换
 * 写进 `logInfo`（崩溃日志，不可查询）；本模块提供**可查询的定长环**，让 UI 能展示切换历史与理由。
 *
 * 不删理由：删掉即切换审计无处可查，用户无法回答「刚才为什么换了模型」。
 *
 * 定长环：超出上限丢最早的（切换是低频事件，100 条足够覆盖一次会话）。
 */
import type { ModelTier } from '@shared/types/model-router'

export interface ModelSwitchEntry {
  /** 切换时刻（epoch ms） */
  ts: number
  /** 轮序号（从 1 起） */
  round: number
  from: string
  to: string
  /** 目标档位 */
  tier: ModelTier | 'unknown'
  /** 判定理由 */
  reason: string
}

const MAX_ENTRIES = 100
let ring: ModelSwitchEntry[] = []
let sink: ((entry: ModelSwitchEntry) => void) | null = null

/**
 * 注入持久化落点（组合根接 `createFileAuditSink(<data>/model-switch.jsonl)`）。
 * 未注入时只在内存环里（与改造前一致）。落盘失败不影响生成（审计是旁路）。
 */
export function setModelSwitchSink(fn: ((entry: ModelSwitchEntry) => void) | null): void {
  sink = fn
}

/** 记录一次切换（由 `tool-loop` 的决策点调用）。落内存环 + 可选落盘。 */
export function recordModelSwitch(entry: ModelSwitchEntry): void {
  ring.push(entry)
  if (ring.length > MAX_ENTRIES) ring = ring.slice(ring.length - MAX_ENTRIES)
  try {
    sink?.(entry)
  } catch {
    /* 落盘失败不影响生成 */
  }
}

/** 读取切换历史（按时间升序）。 */
export function listModelSwitches(): readonly ModelSwitchEntry[] {
  return ring
}

/** 清空（测试用）。 */
export function resetModelSwitchLog(): void {
  ring = []
}
