/**
 * 静默续接定时器的所有权回归（2026-10-31 生命周期收口）。
 *
 * 背景：`error-dispatch.ts` 的退避 `setTimeout` 原先没有句柄，用户点停止（ws abort 消息）
 * 或发新消息时无法取消——到点仍 `resume()`，表现为「停止按钮在重试窗口内无效」，
 * 且新消息与旧续接并发。修复：句柄落进连接级 `retryTimerRef`，由 ws-protocol
 * 在 abort / 新消息时调用 `cancelPendingStreamRetry`。
 *
 * 本文件同时锁定 2026-10-31 的错误分类扩展：确定性 4xx（401/403/400/404/422）与
 * 上下文超限不再落入无限重试，而是走 permanent-error（推可行动文案 + 清活跃标志）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import {
  dispatchStreamError,
  cancelPendingStreamRetry,
  type ErrorDispatchDeps
} from '../electron/main/api/stream/error-dispatch'

interface Harness {
  deps: ErrorDispatchDeps
  pushed: string[]
  resume: ReturnType<typeof vi.fn>
  setStreamActive: ReturnType<typeof vi.fn>
  requestInterruptRecovery: ReturnType<typeof vi.fn>
  retryTimerRef: { current: ReturnType<typeof setTimeout> | null }
}

function makeHarness(err: Error, overrides: Partial<ErrorDispatchDeps> = {}): Harness {
  const pushed: string[] = []
  const resume = vi.fn()
  const setStreamActive = vi.fn()
  const requestInterruptRecovery = vi.fn()
  const retryTimerRef: { current: ReturnType<typeof setTimeout> | null } = { current: null }
  const deps = {
    err,
    ws: { readyState: WebSocket.OPEN } as unknown as WebSocket,
    messageId: 'm_retry_timer',
    sessionId: 's1',
    activation: false,
    retryCount: 0,
    maxStreamRetries: Number.POSITIVE_INFINITY,
    maxRetryDelayMs: 30_000,
    continuationTimerRef: { current: null },
    retryTimerRef,
    streamSession: {
      isOpen: () => true,
      push: (_ws: unknown, data: string) => {
        pushed.push(data)
        return true
      }
    },
    activationManager: {
      setStreamActive,
      requestInterruptRecovery,
      resetInterruptRecovery: vi.fn()
    },
    messages: [],
    fullOutput: '',
    fullReasoning: '',
    writeRawMemoryForStream: vi.fn(),
    resume,
    ...overrides
  } as unknown as ErrorDispatchDeps
  return { deps, pushed, resume, setStreamActive, requestInterruptRecovery, retryTimerRef }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('静默续接定时器：句柄落盘 + 可取消', () => {
  it('瞬时错误 → 定时器句柄存入 retryTimerRef；到点触发 resume 后置空', async () => {
    const h = makeHarness(new Error('fetch failed'))
    dispatchStreamError(h.deps)
    expect(h.retryTimerRef.current).not.toBeNull()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.resume).toHaveBeenCalledTimes(1)
    expect(h.retryTimerRef.current).toBeNull()
  })

  it('cancelPendingStreamRetry 取消后，到点不再 resume（停止按钮在退避窗口内必须有效）', async () => {
    const h = makeHarness(new Error('fetch failed'))
    dispatchStreamError(h.deps)
    expect(cancelPendingStreamRetry(h.retryTimerRef)).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.retryTimerRef.current).toBeNull()
  })

  it('重复错误只保留一个续接定时器（旧调度被取消，不双 resume）', async () => {
    const h = makeHarness(new Error('fetch failed'))
    dispatchStreamError(h.deps)
    const first = h.retryTimerRef.current
    dispatchStreamError(h.deps)
    expect(h.retryTimerRef.current).not.toBe(first)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.resume).toHaveBeenCalledTimes(1)
  })
})

describe('确定性错误不再进入无限续接', () => {
  it('401 → permanent-error：推可行动文案、清活跃标志、不调度续接、不触发中断恢复', () => {
    const h = makeHarness(new Error('401 invalid api key'))
    ;(h.deps.err as Error & { status?: number }).status = 401
    dispatchStreamError(h.deps)

    expect(h.retryTimerRef.current).toBeNull()
    expect(h.resume).not.toHaveBeenCalled()
    expect(h.setStreamActive).toHaveBeenCalledWith(false)
    expect(h.requestInterruptRecovery).not.toHaveBeenCalled()
    expect(h.pushed.join('\n')).toContain('鉴权失败')
    expect(h.pushed.join('\n')).toContain('暂停自动恢复')
  })

  it('429 仍走 retry（瞬时错误保留无限重试的产品决策）', async () => {
    const h = makeHarness(new Error('rate limited'))
    ;(h.deps.err as Error & { status?: number }).status = 429
    dispatchStreamError(h.deps)
    expect(h.retryTimerRef.current).not.toBeNull()

    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.resume).toHaveBeenCalledTimes(1)
  })

  it('上下文超限 → permanent-error 且文案提示开新会话', () => {
    const h = makeHarness(new Error('context_length_exceeded'))
    dispatchStreamError(h.deps)
    expect(h.retryTimerRef.current).toBeNull()
    expect(h.pushed.join('\n')).toContain('上下文超限')
    expect(h.pushed.join('\n')).toContain('新会话')
  })
})
