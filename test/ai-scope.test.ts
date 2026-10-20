/**
 * 会话 → AI 作用域解析（ADR-25 §4.5 的 L2 处置）契约测试。
 *
 * 为什么存在：L2（`resolveSessionAiId` 会话缺 `aiId` 时回落 AI1）经复核**不是 bug**——
 * 主会话本就属月蚀 AI1，删掉回落会断主链路。但它同时是「多 AI 串味」的**信号**，
 * 故按 §4.5「不删回落，加审计」：回落发生时留一条可观测记录（会话 id 存在却拿不到合法 aiId）。
 *
 * 噪音口径：`sessionId` 缺省（主会话）是最常见调用，**不记**（否则每轮刷屏、信号被稀释）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolveSessionAiIdWithAudit } from '../electron/main/api/ai-scope'
import type { SessionStore } from '../electron/main/api/session-store'
import { DEFAULT_AI_ID } from '../electron/main/models/path-context'

/** 最小会话存储假体：只实现本函数用到的 `get` */
function fakeStore(sessions: Record<string, { aiId?: number } | null>, throwOn?: string): SessionStore {
  return {
    get: (id: string) => {
      if (throwOn && id === throwOn) throw new Error('boom')
      return sessions[id] ?? null
    }
  } as unknown as SessionStore
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('resolveSessionAiIdWithAudit（ADR-25 L2）', () => {
  it('会话 aiId 合法 → 用之（不记审计）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveSessionAiIdWithAudit('s_a', fakeStore({ s_a: { aiId: 2 } }))).toBe(2)
    expect(warn).not.toHaveBeenCalled()
  })

  it('sessionId 缺省（主会话）→ 回落月蚀且**不记审计**（常见正常调用，避免刷屏）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveSessionAiIdWithAudit(undefined, fakeStore({}))).toBe(DEFAULT_AI_ID)
    expect(warn).not.toHaveBeenCalled()
  })

  it('会话存在但 aiId 缺失/非法 → 回落月蚀并记审计（该链路未把 aiId 带下来）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveSessionAiIdWithAudit('s_b', fakeStore({ s_b: {} }))).toBe(DEFAULT_AI_ID)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('s_b')
    expect(String(warn.mock.calls[0][0])).toContain('L2 审计')

    warn.mockClear()
    // 非法 aiId（0 / 负数 / 非整数）同样回落 + 审计
    for (const bad of [0, -1, 1.5]) {
      expect(resolveSessionAiIdWithAudit('s_c', fakeStore({ s_c: { aiId: bad } }))).toBe(DEFAULT_AI_ID)
    }
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('读取抛错 → 回落月蚀并记审计（不向上抛）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveSessionAiIdWithAudit('s_d', fakeStore({}, 's_d'))).toBe(DEFAULT_AI_ID)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
