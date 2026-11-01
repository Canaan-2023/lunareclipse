/**
 * resolveSummaryBudgetChars（会话继承预算「生效值」推导）契约测试。
 * 为什么存在：该函数是「存储继承阈值」的唯一推导真源（internal-session.ts 与
 * IPC 生效值回显共用），口径分叉会导致设置页与运行时行为不一致（评审 W1）；
 * 用测试锁定三态契约：手动值优先 / 自动=模型窗口×1/4 / 保底 30000。
 * 另锁读取侧的窗口限幅：patch 覆盖层可以写任意预算，但生效值不得超过模型真实窗口。
 */
import { describe, it, expect } from 'vitest'
import {
  resolveSummaryBudgetChars,
  SESSION_BUDGET_RATIO,
  estimateModelWindow
} from '../electron/main/api/server-utils'
import {
  clampContextCharsForModel,
  clampTokenBudgetForModel
} from '../electron/main/api/model-capability'

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

describe('读取侧预算限幅（patch 覆盖层不得越窗）', () => {
  it('未登记的 deepseek 变体按 128k 保守推断（不高估窗口）', () => {
    // 只有 registry 登记的 deepseek-v4 系列是 1M；deepseek-flash 这类未登记变体走家族推断，
    // 必须保守 128k——高估窗口会让压缩/截断永不触发，越过真实窗口就是整轮失败。
    expect(estimateModelWindow('deepseek-flash')).toBe(128000)
  })

  it('已登记的 1M 型号仍按 registry 精确值', () => {
    expect(estimateModelWindow('deepseek-v4-flash')).toBe(1000000)
  })

  it('tokenBudget 超过模型窗口时被夹到窗口（800k patch 对 128k 模型 → 128000）', () => {
    expect(clampTokenBudgetForModel(800000, 'deepseek-flash')).toBe(128000)
  })

  it('tokenBudget 在窗口内时原样保留（1M 模型上的 800k 合法）', () => {
    expect(clampTokenBudgetForModel(800000, 'deepseek-v4-flash')).toBe(800000)
  })

  it('未配置（null / 0）保留「走软预算」语义', () => {
    expect(clampTokenBudgetForModel(null, 'deepseek-flash')).toBeNull()
    expect(clampTokenBudgetForModel(0, 'deepseek-flash')).toBeNull()
  })

  it('contextWindow.chars 同样按模型窗口夹（token 模式的注入上限）', () => {
    expect(clampContextCharsForModel(800000, 'deepseek-flash')).toBe(128000)
    expect(clampContextCharsForModel(5000, 'deepseek-flash')).toBe(5000)
    expect(clampContextCharsForModel(0, 'deepseek-flash')).toBeNull()
  })
})