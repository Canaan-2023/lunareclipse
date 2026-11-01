/**
 * 流计时器 vs 工具阶段的边界回归测试（2026-10-31 评审后落实）
 *
 * 背景（评审 P1）：TTFT/idle 计时器由 `runTurnStream` 创建、由 `tool-loop` 在**轮次 finally**
 * 才释放，于是"工具执行阶段计时器仍武装"。但 TTFT 只在收到正文/思考首 token 时解除，
 * `tool_calls` 帧不算——当模型先返回工具调用（无思考的非思考模式、纯工具轮）时，
 * 30s TTFT 计时器会在工具执行中途 `ctrl.abort()`：
 * - 场景 A：工具轮本身很快结束，但 30s 后 abort 已无意义；
 * - 场景 B：`run_command`/`code_run` 恰在 30s 从硬墙转入托管、返回 `taskId` + `tool_watch` 指引，
 *   而同一时刻 TTFT 的 abort 把整条流掐掉 → AI 永远收不到"已转后台"的提示，
 *   用户看到超时/重试，工具却还在后台跑（副作用 + 重复执行风险）。
 *
 * 约定（本文件锁定）：
 * 1. `tool_calls` 帧到达 = 首包已到，TTFT 计时器必须解除；
 * 2. 流消费结束时 TTFT/idle 两个计时器都必须清理——流阶段结束之后的时间归工具外墙/托管协议管，
 *    流计时器不得跨阶段误杀；
 * 3. 两个计时器在流结束后都不再触发 abort（单测用假时钟推进 60s 直接证明）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { runTurnStream, type TurnStreamContext } from '../electron/main/api/llm/tool-loop-stream'
import type { StreamCallbacks } from '../electron/main/api/llm-types'

function cbs(): StreamCallbacks {
  return { onToken: () => {}, onDone: () => {}, onError: () => {} }
}

/** 只收敛测试关心的字段；其余按生产契约给最小值 */
function makeCtx(
  stream: unknown,
  overrides: Partial<TurnStreamContext> = {}
): TurnStreamContext & { ctrl: AbortController; entry: { abortReason: string | null } } {
  const ctrl = new AbortController()
  const entry = { abortReason: null as string | null }
  return {
    client: {
      chat: { completions: { create: async () => stream } }
    } as unknown as TurnStreamContext['client'],
    conversation: [{ role: 'user', content: '执行一个长任务' }],
    useModel: 'test-model',
    config: {},
    tools: undefined,
    buildReasoningParams: () => ({}),
    buildSamplingParams: () => ({}),
    isLocalProvider: false,
    ctrl,
    entry,
    callbacks: cbs(),
    round: 1,
    ...overrides
  }
}

/** 只有工具调用、没有正文/思考的流（非思考模式 / 纯工具轮的典型形态） */
function toolCallOnlyStream(name = 'run_command') {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ttft_1',
                  function: { name, arguments: JSON.stringify({ command: 'sleep 45' }) }
                }
              ]
            }
          }
        ]
      }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    }
  }
}

/** 正文 + 工具调用的流（首包是正文，idle 计时器被武装） */
function textThenToolCallStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '我先跑一下命令。' } }] }
      yield {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_ttft_2',
                  function: { name: 'run_command', arguments: JSON.stringify({ command: 'sleep 45' }) }
                }
              ]
            }
          }
        ]
      }
      yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('流计时器只覆盖流阶段，不跨工具阶段误杀', () => {
  it('tool_calls 首帧即视为首包：60s 后不再触发 TTFT abort', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx(toolCallOnlyStream())
    const turn = await runTurnStream(ctx)
    expect(turn.toolCallMap.size).toBe(1)
    expect(turn.toolCallMap.get(0)?.name).toBe('run_command')

    // 推进 60s（云模型 TTFT=30s）：修复前 TTFT 计时器仍在武装 → ctrl.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.ctrl.signal.aborted).toBe(false)
    expect(ctx.entry.abortReason).toBeNull()
    turn.timers.dispose()
  })

  it('正文 + 工具调用：流结束后 idle 计时器被清理，工具阶段不被 abort', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx(textThenToolCallStream())
    const turn = await runTurnStream(ctx)
    expect(turn.contentBuf).toContain('我先跑一下命令')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.ctrl.signal.aborted).toBe(false)
    expect(ctx.entry.abortReason).toBeNull()
    turn.timers.dispose()
  })

  it('纯正文流结束后同样不再触发 idle abort（流阶段已结束，计时器无继续武装的理由）', async () => {
    vi.useFakeTimers()
    const ctx = makeCtx({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: '完成。' } }] }
      }
    })
    const turn = await runTurnStream(ctx)
    expect(turn.contentBuf).toBe('完成。')

    await vi.advanceTimersByTimeAsync(60_000)
    expect(ctx.ctrl.signal.aborted).toBe(false)
    expect(ctx.entry.abortReason).toBeNull()
    turn.timers.dispose()
  })

  it('tool_calls 解除 TTFT 后仍保留 idle 看门狗：参数分片停滞时会 abort（不能留无计时器空窗）', async () => {
    vi.useFakeTimers()
    let releaseStalled: () => void = () => {}
    const stalled = new Promise<void>((resolve) => {
      releaseStalled = resolve
    })
    const ctx = makeCtx({
      async *[Symbol.asyncIterator]() {
        // 只给一个没有完整参数的 tool_calls 分片，然后停滞
        yield {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: 'call_stall', function: { name: 'run_command', arguments: '{' } }]
              }
            }
          ]
        }
        await stalled
        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
      }
    })
    const p = runTurnStream(ctx)
    // 30s：TTFT 已因 tool_calls 首帧解除，但 idle 看门狗应触发
    await vi.advanceTimersByTimeAsync(31_000)
    expect(ctx.ctrl.signal.aborted).toBe(true)
    expect(ctx.entry.abortReason).toBe('idle_timeout')

    releaseStalled()
    const turn = await p
    turn.timers.dispose()
  })
})
