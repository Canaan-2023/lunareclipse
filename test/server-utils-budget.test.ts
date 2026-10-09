/**
 * resolveSummaryBudgetChars（会话继承预算「生效值」推导）契约测试。
 * 为什么存在：该函数是「存储继承阈值」的唯一推导真源（internal-session.ts 与
 * IPC 生效值回显共用），口径分叉会导致设置页与运行时行为不一致（评审 W1）；
 * 用测试锁定三态契约：手动值优先 / 自动=模型窗口×1/4 / 保底 30000。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveSummaryBudgetChars,
  SESSION_BUDGET_RATIO,
  estimateModelWindow
} from '../electron/main/api/server-utils'

describe('resolveSummaryBudgetChars', () => {
  it('configured>0 时手动值优先，忽略自动推导', () => {
    expect(resolveSummaryBudgetChars('qwen2.5-72b-instruct', 500000)).toBe(500000)
  })

  it('configured<=0 时按模型窗口 × 1/4 自动推导', () => {
    const window = estimateModelWindow('qwen2.5-72b-instruct')
    const expected = Math.max(30000, Math.floor(window * SESSION_BUDGET_RATIO))
    expect(resolveSummaryBudgetChars('qwen2.5-72b-instruct', 0)).toBe(expected)
    expect(resolveSummaryBudgetChars('qwen2.5-72b-instruct', -1)).toBe(expected)
  })

  it('configured 缺省（undefined）时按自动推导', () => {
    const window = estimateModelWindow('qwen2.5-72b-instruct')
    expect(resolveSummaryBudgetChars('qwen2.5-72b-instruct')).toBe(Math.max(30000, Math.floor(window * SESSION_BUDGET_RATIO)))
  })

  it('小窗口模型推导不低于 30000 保底（避免低端模型短会话频繁继承）', () => {
    // 32k 窗口 × 1/4 = 8000 < 30000，保底生效
    const budget = resolveSummaryBudgetChars('qwen2.5-1.5b-instruct', 0)
    expect(budget).toBeGreaterThanOrEqual(30000)
  })
})