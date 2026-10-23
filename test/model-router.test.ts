/**
 * AUTO 模型热切换（B7）回归测试：档位判定 / 池内挑选 / 最小驻留 / 回传口径分组 / 降级。
 *
 * 为什么存在：交接单 §8.2 的硬约束（轮间粒度、最小驻留、禁止跨口径切换、降级）都是**静默坏掉**的类型——
 * 跨口径切换会 400 或字段污染，最小驻留缺失会打爆前缀缓存且无任何报错。必须有回归网。
 *
 * 覆盖：
 * 1. decideTier：护栏/上轮失败/上下文吃紧/收尾近似/长指令 → strong，否则 fast
 * 2. pickFromPool：精确档位 + 降级链 + 空池
 * 3. selectModel：空池 / 驻留未满 / 目标即当前 → 不切；满足则切
 * 4. reasoningGroupOf + filterSameGroup：**跨口径候选被剔除**、禁用项被剔除
 * 5. resolveRoundModel：AUTO 关 / 钉死 / 可用列表降级 / 无同口径候选 → 保持当前
 */
import { describe, it, expect } from 'vitest'
import type { ModelPoolEntry, RouterFeatures } from '../shared/types/model-router'
import { decideTier, pickFromPool, selectModel, DEFAULT_MIN_DWELL_ROUNDS } from '../electron/main/api/llm/model-router'
import { filterSameGroup, reasoningGroupOf, resolveRoundModel } from '../electron/main/api/llm/model-switch'
import { attachContextRatio } from '../electron/main/api/llm/context-ratio'

const BASE_FEATURES: RouterFeatures = {
  round: 1,
  prevToolCalls: 3,
  prevToolFailures: 0,
  guardrailActive: false,
  userMessageLength: 20,
  contextRatio: null
}

const POOL: ModelPoolEntry[] = [
  { id: 'fast-model', tier: 'fast', enabled: true },
  { id: 'strong-model', tier: 'strong', enabled: true },
  { id: 'deep-model', tier: 'reasoning', enabled: true },
  { id: 'disabled-model', tier: 'fast', enabled: false }
]

describe('decideTier：档位判定（§8.4 a 规则）', () => {
  it('常规工具轮 → fast', () => {
    expect(decideTier(BASE_FEATURES)).toBe('fast')
  })

  it('护栏已触发 / 上轮有失败 → strong', () => {
    expect(decideTier({ ...BASE_FEATURES, guardrailActive: true })).toBe('strong')
    expect(decideTier({ ...BASE_FEATURES, prevToolFailures: 1 })).toBe('strong')
  })

  it('上下文吃紧（≥0.8）→ strong；contextRatio 为 null 时不生效', () => {
    expect(decideTier({ ...BASE_FEATURES, contextRatio: 0.85 })).toBe('strong')
    expect(decideTier({ ...BASE_FEATURES, contextRatio: null })).toBe('fast')
    expect(decideTier({ ...BASE_FEATURES, contextRatio: 0.5 })).toBe('fast')
  })

  it('收尾近似（已过首轮且上轮无工具调用）→ strong', () => {
    expect(decideTier({ ...BASE_FEATURES, round: 2, prevToolCalls: 0 })).toBe('strong')
    expect(decideTier({ ...BASE_FEATURES, round: 1, prevToolCalls: 0 })).toBe('fast')
  })

  it('超长用户指令 → strong', () => {
    expect(decideTier({ ...BASE_FEATURES, userMessageLength: 900 })).toBe('strong')
  })
})

describe('pickFromPool：池内挑选与降级链', () => {
  it('精确档位优先', () => {
    expect(pickFromPool(POOL, 'strong')?.id).toBe('strong-model')
    expect(pickFromPool(POOL, 'fast')?.id).toBe('fast-model')
  })

  it('禁用项不参与', () => {
    const pool: ModelPoolEntry[] = [{ id: 'x', tier: 'fast', enabled: false }]
    expect(pickFromPool(pool, 'fast')).toBeNull()
  })

  it('档位缺失时按降级链取（fast 缺失 → strong）', () => {
    const pool: ModelPoolEntry[] = [{ id: 's', tier: 'strong', enabled: true }]
    expect(pickFromPool(pool, 'fast')?.id).toBe('s')
  })
})

describe('selectModel：切换与最小驻留', () => {
  it('空池 → 保持当前', () => {
    const d = selectModel(BASE_FEATURES, { pool: [], currentModel: 'cur', dwellRounds: 99 })
    expect(d.switched).toBe(false)
    expect(d.model).toBe('cur')
  })

  it('驻留未满 → 保持当前（即使档位不同）', () => {
    const d = selectModel(
      { ...BASE_FEATURES, guardrailActive: true },
      { pool: POOL, currentModel: 'fast-model', dwellRounds: DEFAULT_MIN_DWELL_ROUNDS - 1 }
    )
    expect(d.switched).toBe(false)
    expect(d.reason).toContain('最小驻留')
  })

  it('驻留满足 + 档位不同 → 切换（含理由）', () => {
    const d = selectModel(
      { ...BASE_FEATURES, guardrailActive: true },
      { pool: POOL, currentModel: 'fast-model', dwellRounds: DEFAULT_MIN_DWELL_ROUNDS }
    )
    expect(d.switched).toBe(true)
    expect(d.model).toBe('strong-model')
    expect(d.targetTier).toBe('strong')
    expect(d.reason).toContain('strong')
  })

  it('目标即当前 → 不切', () => {
    const d = selectModel(BASE_FEATURES, { pool: POOL, currentModel: 'fast-model', dwellRounds: 99 })
    expect(d.switched).toBe(false)
  })
})

describe('回传口径分组（§8.2③ 硬约束）', () => {
  it('reasoningGroupOf：DeepSeek 与其他网关不同组', () => {
    expect(reasoningGroupOf('https://api.deepseek.com/v1')).toBe('deepseek')
    expect(reasoningGroupOf('https://api.openai.com/v1')).not.toBe('deepseek')
  })

  it('filterSameGroup：剔除异口径候选与禁用项', () => {
    const candidates = [
      { id: 'a', tier: 'fast' as const, enabled: true },
      { id: 'b', tier: 'fast' as const, enabled: true, baseURL: 'https://api.deepseek.com/v1' },
      { id: 'c', tier: 'fast' as const, enabled: false }
    ]
    const kept = filterSameGroup(candidates, 'https://api.openai.com/v1')
    expect(kept.map((e) => e.id)).toEqual(['a'])
  })
})

describe('attachContextRatio：上下文占比 provider（§8.3 特征穿透）', () => {
  function sink(): { setContextRatioProvider?: (fn: (() => number | null) | null) => void; get: () => number | null } {
    let fn: (() => number | null) | null = null
    return {
      setContextRatioProvider: (f) => {
        fn = f
      },
      get: () => fn?.() ?? null
    }
  }

  it('原样返回客户端（便于单行工厂接线）', () => {
    const c = sink()
    expect(attachContextRatio(c, () => 1, () => 10)).toBe(c)
  })

  it('占比 = min(1, 估算 / 预算)；超预算封顶 1', () => {
    const c = sink()
    attachContextRatio(c, () => 50, () => 100)
    expect(c.get()).toBe(0.5)
    const c2 = sink()
    attachContextRatio(c2, () => 300, () => 100)
    expect(c2.get()).toBe(1)
  })

  it('估算不可得 / 预算非法 → null（该规则不生效）', () => {
    const a = sink()
    attachContextRatio(a, () => null, () => 100)
    expect(a.get()).toBeNull()
    const b = sink()
    attachContextRatio(b, () => 10, () => 0)
    expect(b.get()).toBeNull()
    const d = sink()
    attachContextRatio(d, () => 10, () => -1)
    expect(d.get()).toBeNull()
  })

  it('无 provider 能力的客户端 → 不抛错', () => {
    expect(() => attachContextRatio({}, () => 1, () => 10)).not.toThrow()
  })
})

describe('resolveRoundModel：配置与降级', () => {
  const input = {
    baseURL: 'https://api.deepseek.com/v1',
    currentModel: 'fast-model',
    features: { ...BASE_FEATURES, guardrailActive: true },
    dwellRounds: 99
  }

  it('AUTO 未开启 → 保持当前', () => {
    expect(resolveRoundModel({ ...input, router: undefined }).switched).toBe(false)
    expect(resolveRoundModel({ ...input, router: { enabled: false, pool: POOL } }).switched).toBe(false)
  })

  it('钉死模型 → 保持当前', () => {
    const d = resolveRoundModel({ ...input, router: { enabled: true, pool: POOL, pinModel: 'fast-model' } })
    expect(d.switched).toBe(false)
    expect(d.reason).toContain('钉死')
  })

  it('开启且池可用 → 切到强档', () => {
    const d = resolveRoundModel({ ...input, router: { enabled: true, pool: POOL } })
    expect(d.switched).toBe(true)
    expect(d.model).toBe('strong-model')
  })

  it('可用列表降级：目标不在提供商列表 → 剔除后退回当前', () => {
    const d = resolveRoundModel({
      ...input,
      router: { enabled: true, pool: POOL },
      availableModels: ['fast-model'] // strong/reasoning 都不可用
    })
    expect(d.switched).toBe(false)
  })

  it('池内无可选（全禁用）→ 保持当前', () => {
    const d = resolveRoundModel({
      ...input,
      router: { enabled: true, pool: [{ id: 'x', tier: 'strong', enabled: false }] }
    })
    expect(d.switched).toBe(false)
    expect(d.reason).toContain('无同口径可用模型')
  })
})
