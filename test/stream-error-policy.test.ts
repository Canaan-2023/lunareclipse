import { describe, it, expect } from 'vitest'
import {
  classifyStreamError,
  decideStreamErrorAction,
  buildPermanentErrorPayload
} from '../electron/main/api/stream-error-policy'

/**
 * 流式错误策略（分类 → 分支决策 → 用户文案）的契约测试。
 *
 * 为什么存在：这段判定原先内联在 stream-runner.ts 的 onError 回调里，与 flush/清定时器/推帧
 * 等副作用交织，**零测试覆盖**。它决定五条出路：永久性错误（未配置 / 余额不足）/ 用户中止 /
 * 静默续接重试 / 断线中断恢复 / 重试耗尽恢复。判错的表现都是「用户可感知的失败」而不是异常：
 * 余额不足被当成网络抖动 → 重试 5 次 + 恢复 10 次注定失败循环（2026-09-08 真实故障）；
 * 用户中止被判成可恢复 → 点停止后反倒触发恢复，停止按钮失效。
 * 作用：把五条分支的判定依据与优先级逐条钉死（含「永久性优先于重试」「中止优先于恢复」
 *   「断线优先于重试耗尽」三条顺序契约）。
 * 不删理由：这是该回调唯一的验证手段——onError 只在真实流失败时触发，E2E 无法稳定构造
 *   「402」「用户中止」「重试耗尽」这些样本。
 */

/** 与 llm.ts 的置值一致：abort('main') → abortReason='user'；兜底口径为 'aborted' */
const USER_ABORT_MESSAGES = ['user', 'aborted']
/** llm.ts 的流超时原因 */
const TIMEOUT_MESSAGES = ['ttft_timeout', 'idle_timeout']
/** 各服务商的余额/配额文案（应全部归入永久性错误） */
const BALANCE_MESSAGES = [
  'Insufficient Balance',
  'insufficient balance',
  'API 余额不足，请充值',
  'quota exceeded',
  'insufficient_quota'
]

describe('classifyStreamError · 分类口径', () => {
  it.each(USER_ABORT_MESSAGES)('%s → isUserAbort（且不算永久性错误）', (message) => {
    const facts = classifyStreamError({ message })
    expect(facts.isUserAbort).toBe(true)
    expect(facts.isPermanentError).toBe(false)
  })

  it.each(TIMEOUT_MESSAGES)('%s → isTimeout（仅影响退避基准，不改变分支）', (message) => {
    const facts = classifyStreamError({ message })
    expect(facts.isTimeout).toBe(true)
    expect(facts.isPermanentError).toBe(false)
    expect(facts.isUserAbort).toBe(false)
  })

  it('LLM 未配置 → isConfigError 且 isPermanentError', () => {
    const facts = classifyStreamError({ message: 'LLM 未配置：请在设置中填写 API Key' })
    expect(facts.isConfigError).toBe(true)
    expect(facts.isBalanceError).toBe(false)
    expect(facts.isPermanentError).toBe(true)
  })

  it('status=402 → isBalanceError 且 isPermanentError（不看文案）', () => {
    const facts = classifyStreamError({ message: 'something went wrong', status: 402 })
    expect(facts.isBalanceError).toBe(true)
    expect(facts.isPermanentError).toBe(true)
  })

  it.each(BALANCE_MESSAGES)('文案「%s」→ isBalanceError 且 isPermanentError', (message) => {
    const facts = classifyStreamError({ message })
    expect(facts.isBalanceError).toBe(true)
    expect(facts.isPermanentError).toBe(true)
  })

  it.each(['fetch failed', 'ECONNRESET', 'repetition_loop', 'system_replay_loop', '外部中断（子 agent 超时）'])(
    '瞬时/其它错误「%s」→ 既非永久性也非中止（走重试或恢复）',
    (message) => {
      const facts = classifyStreamError({ message })
      expect(facts).toEqual({
        isUserAbort: false,
        isTimeout: false,
        isConfigError: false,
        isBalanceError: false,
        isPermanentError: false
      })
    }
  )

  it('status=500 不被当作余额不足（只认 402）', () => {
    const facts = classifyStreamError({ message: 'internal error', status: 500 })
    expect(facts.isBalanceError).toBe(false)
  })

  it('模块级正则无 g 标志：同一余额文案连续判定两次结果一致（lastIndex 不泄漏）', () => {
    const first = classifyStreamError({ message: 'Insufficient Balance' }).isBalanceError
    const second = classifyStreamError({ message: 'Insufficient Balance' }).isBalanceError
    const third = classifyStreamError({ message: 'Insufficient Balance' }).isBalanceError
    expect([first, second, third]).toEqual([true, true, true])
  })

  it('模块级正则无 g 标志：命中与非命中交替判定不串扰', () => {
    const hit = classifyStreamError({ message: '余额不足' }).isBalanceError
    const miss = classifyStreamError({ message: 'fetch failed' }).isBalanceError
    const hitAgain = classifyStreamError({ message: '余额不足' }).isBalanceError
    expect([hit, miss, hitAgain]).toEqual([true, false, true])
  })
})

describe('decideStreamErrorAction · 永久性错误优先', () => {
  const ctx = { wsOpen: true, retryCount: 0, maxRetries: 5 }

  it('402 + WS 开着 + 还有重试额度 → permanent-error（不是 retry）', () => {
    const d = decideStreamErrorAction({ message: 'Insufficient Balance', status: 402, ...ctx })
    expect(d.action).toBe('permanent-error')
    expect(d.facts.isBalanceError).toBe(true)
  })

  it('402 + WS 已断 → 仍 permanent-error（永久性判定不受连接状态影响）', () => {
    const d = decideStreamErrorAction({
      message: 'Insufficient Balance',
      status: 402,
      wsOpen: false,
      retryCount: 0,
      maxRetries: 5
    })
    expect(d.action).toBe('permanent-error')
  })

  it('未配置 + 重试额度已耗尽 + WS 开着 → permanent-error（优先于 retry-exhausted-recovery）', () => {
    const d = decideStreamErrorAction({
      message: 'LLM 未配置：请在设置中填写 API Key',
      wsOpen: true,
      retryCount: 5,
      maxRetries: 5
    })
    expect(d.action).toBe('permanent-error')
  })
})

describe('decideStreamErrorAction · 用户中止优先于恢复', () => {
  it.each(USER_ABORT_MESSAGES)('%s + WS 开着 + 有重试额度 → user-abort（不复用重试通道）', (message) => {
    const d = decideStreamErrorAction({ message, wsOpen: true, retryCount: 0, maxRetries: 5 })
    expect(d.action).toBe('user-abort')
  })

  it.each(USER_ABORT_MESSAGES)('%s + WS 已断 → 仍 user-abort（不得触发中断恢复）', (message) => {
    const d = decideStreamErrorAction({ message, wsOpen: false, retryCount: 0, maxRetries: 5 })
    expect(d.action).toBe('user-abort')
  })

  it.each(USER_ABORT_MESSAGES)('%s + 重试耗尽 → 仍 user-abort（不得推 interrupted）', (message) => {
    const d = decideStreamErrorAction({ message, wsOpen: true, retryCount: 5, maxRetries: 5 })
    expect(d.action).toBe('user-abort')
  })
})

describe('decideStreamErrorAction · 重试与恢复的分界', () => {
  it.each(TIMEOUT_MESSAGES)('%s → retry 且退避基准 500ms（超时尽快续接）', (message) => {
    const d = decideStreamErrorAction({ message, wsOpen: true, retryCount: 0, maxRetries: 5 })
    expect(d.action).toBe('retry')
    expect(d.baseDelayMs).toBe(500)
  })

  it('普通网络错误 → retry 且退避基准 1500ms', () => {
    const d = decideStreamErrorAction({ message: 'fetch failed', wsOpen: true, retryCount: 0, maxRetries: 5 })
    expect(d.action).toBe('retry')
    expect(d.baseDelayMs).toBe(1500)
  })

  it('retryCount = maxRetries - 1 是最后一次重试（闭区间：用 < 判定）', () => {
    const d = decideStreamErrorAction({ message: 'fetch failed', wsOpen: true, retryCount: 4, maxRetries: 5 })
    expect(d.action).toBe('retry')
  })

  it('retryCount = maxRetries → retry-exhausted-recovery（推 interrupted + 中断恢复）', () => {
    const d = decideStreamErrorAction({ message: 'fetch failed', wsOpen: true, retryCount: 5, maxRetries: 5 })
    expect(d.action).toBe('retry-exhausted-recovery')
  })

  it('maxRetries = 0 且 WS 开着 → retry-exhausted-recovery（零额度即耗尽）', () => {
    const d = decideStreamErrorAction({ message: 'fetch failed', wsOpen: true, retryCount: 0, maxRetries: 0 })
    expect(d.action).toBe('retry-exhausted-recovery')
  })

  it('WS 已断 + 还有重试额度 → ws-closed-recovery（不推任何帧）', () => {
    const d = decideStreamErrorAction({ message: 'fetch failed', wsOpen: false, retryCount: 0, maxRetries: 5 })
    expect(d.action).toBe('ws-closed-recovery')
  })

  it('WS 已断 + 重试耗尽 → ws-closed-recovery（断线判定优先于耗尽：两者推帧行为不同）', () => {
    const d = decideStreamErrorAction({ message: 'fetch failed', wsOpen: false, retryCount: 5, maxRetries: 5 })
    expect(d.action).toBe('ws-closed-recovery')
  })

  it('决策透传分类事实，供调用点取用（余额不足要选专用文案）', () => {
    const d = decideStreamErrorAction({
      message: 'quota exceeded',
      wsOpen: true,
      retryCount: 0,
      maxRetries: 5
    })
    expect(d.facts.isBalanceError).toBe(true)
    expect(d.facts.isPermanentError).toBe(true)
  })

  it('同一余额错误连续决策两次结果一致（模块级正则无 g，跨调用不泄漏）', () => {
    const call = () =>
      decideStreamErrorAction({ message: 'Insufficient Balance', wsOpen: true, retryCount: 0, maxRetries: 5 })
    expect([call().action, call().action, call().action]).toEqual([
      'permanent-error',
      'permanent-error',
      'permanent-error'
    ])
  })
})

describe('buildPermanentErrorPayload · 用户可见文案', () => {
  it('余额不足 → 含原始错误、充值/换 Key 建议与「已暂停自动恢复」说明', () => {
    const payload = buildPermanentErrorPayload('Insufficient Balance', true)
    expect(payload).toContain('Insufficient Balance')
    expect(payload).toContain('充值')
    expect(payload).toContain('暂停自动恢复')
  })

  it('非余额类永久性错误（如未配置）→ 原样返回错误消息', () => {
    const message = 'LLM 未配置：请在设置中填写 API Key'
    expect(buildPermanentErrorPayload(message, false)).toBe(message)
  })
})
