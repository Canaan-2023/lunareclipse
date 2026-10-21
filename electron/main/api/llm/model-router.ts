/**
 * @category LLM
 * @summary AUTO 模型热切换策略引擎（纯函数）：判定特征 → 池内模型 id
 *
 * 为什么存在：交接单 §8.5 明确「策略引擎 → 新建 `api/llm/model-router.ts`（**纯函数**：特征 → 模型 id，可单测）」。
 * 把「什么时候切、切到哪档」抽成纯函数后，切换策略可单测、可审计、可替换（§8.4 的 a 规则先行，
 * b 小模型分类器后续接入时只换实现、不动决策点）。
 *
 * 不删理由：删掉即切换逻辑内联进 tool-loop，既无法单测也无法在 ROOM 的模型配置区展示「为什么切」。
 *
 * 硬约束（§8.2）：① 只在**轮间**决策（调用方保证在每轮建流前调用）；② 最小驻留轮数；
 * ③ 候选必须已按**回传口径**分组（调用方过滤，见 `model-switch.ts`）；④ 目标不可用 → 不切（回落当前）。
 */
import type { ModelPoolEntry, ModelTier, RouterDecision, RouterFeatures } from '@shared/types/model-router'

/** 默认最小驻留轮数：换模型会打断前缀缓存，至少连续 N 轮不切（§8.2②）。 */
export const DEFAULT_MIN_DWELL_ROUNDS = 2

/** 上下文占比阈值：超过即视为「该用强模型收束」（contextRatio 为 null 时该规则不生效）。 */
export const CONTEXT_PRESSURE_RATIO = 0.8

export interface SelectModelOptions {
  /** 最小驻留轮数（默认 2） */
  minDwellRounds?: number
  /** 当前模型已连续驻留的轮数（调用方维护） */
  dwellRounds: number
  /** 当前模型 id */
  currentModel: string
  /**
   * 候选池（**调用方已按回传口径过滤**，且已剔除不可用模型）。
   * 池为空 → 恒用 currentModel。
   */
  pool: readonly ModelPoolEntry[]
}

/**
 * 判定目标档位（§8.4 a 规则，零额外成本、可预测）：
 * - 规划 / 检验 / 收尾 / 有失败 / 上下文吃紧 → strong（或池内 reasoning）；
 * - 其余（执行·工具轮）→ fast。
 *
 * 「收尾轮」在**建流前**不可知（要看本轮是否返回 tool_calls），故此处以
 * 「上一轮无工具调用 + 已有轮次」近似：`round > 1 && prevToolCalls === 0` 视为收尾。
 */
export function decideTier(f: RouterFeatures): ModelTier {
  if (f.guardrailActive || f.prevToolFailures > 0) return 'strong'
  if (f.contextRatio != null && f.contextRatio >= CONTEXT_PRESSURE_RATIO) return 'strong'
  // 收尾近似：已过首轮且上一轮没有工具调用（说明上一轮在收束）
  if (f.round > 1 && f.prevToolCalls === 0) return 'strong'
  // 用户给了长指令（多半是复杂需求）→ strong
  if (f.userMessageLength > 800) return 'strong'
  return 'fast'
}

/** 从池内挑该档位的模型；优先精确档位，其次 reasoning→strong→fast 的降级链。 */
export function pickFromPool(pool: readonly ModelPoolEntry[], tier: ModelTier): ModelPoolEntry | null {
  const enabled = pool.filter((e) => e.enabled)
  if (enabled.length === 0) return null
  const exact = enabled.find((e) => e.tier === tier)
  if (exact) return exact
  // 降级链：strong 找不到就用 reasoning，fast 找不到就用 strong，再不行用池内任意
  const fallbackOrder: ModelTier[] =
    tier === 'fast' ? ['strong', 'reasoning'] : tier === 'strong' ? ['reasoning', 'fast'] : ['strong', 'fast']
  for (const t of fallbackOrder) {
    const hit = enabled.find((e) => e.tier === t)
    if (hit) return hit
  }
  return enabled[0]
}

/**
 * 唯一裁决入口。见文件头「硬约束」。
 * 不切的情形：池空 / 仍在最小驻留期 / 目标即当前 / 目标不在池内。
 */
export function selectModel(features: RouterFeatures, opts: SelectModelOptions): RouterDecision {
  const minDwell = opts.minDwellRounds ?? DEFAULT_MIN_DWELL_ROUNDS
  const keep = (reason: string): RouterDecision => ({
    model: opts.currentModel,
    switched: false,
    reason,
    targetTier: 'unknown'
  })

  const enabled = opts.pool.filter((e) => e.enabled)
  if (enabled.length === 0) return keep('模型池为空（AUTO 不生效）')
  if (opts.dwellRounds < minDwell) {
    return keep(`最小驻留轮数未满（${opts.dwellRounds}/${minDwell}）`)
  }

  const tier = decideTier(features)
  const target = pickFromPool(enabled, tier)
  if (!target) return keep('池内无可选模型')
  if (target.id === opts.currentModel) return keep(`已在目标档位（${tier}）`)

  return {
    model: target.id,
    switched: true,
    reason: `按特征切至 ${tier}（轮 ${features.round}；上轮工具调用 ${features.prevToolCalls}、失败 ${features.prevToolFailures}${features.guardrailActive ? '、护栏已触发' : ''}）`,
    targetTier: tier
  }
}
