/**
 * @category LLM
 * @summary AUTO 模型热切换的每轮解析：配置/池/口径分组 → 纯策略引擎 → 本轮模型
 *
 * 为什么存在：`model-router.ts` 是纯策略（特征 → 档位 → 池内模型），但一次真实决策还需要三件
 * 与运行环境相关的事：① 读 AUTO 配置（开关 / 钉死模型 / 池）；② 按**回传口径**过滤候选；
 * ③ 按提供商可用列表做降级。这三件在本模块收口，使决策点（`tool-loop`）只调一个函数。
 *
 * 不删理由：删掉即口径分组与降级逻辑散进 tool-loop，跨口径切换（400 或字段污染）失去单点防线。
 *
 * 回传口径（§8.2③，硬约束）：DeepSeek 系要求历史 assistant 消息回传 `reasoning_content`，
 * 其他网关不认该字段。口径键 = `resolveReasoningProfile(baseURL).id`（既有单源，不新造）。
 */
import type { ModelPoolEntry, ModelRouterConfig, RouterDecision, RouterFeatures } from '@shared/types/model-router'
import { resolveReasoningProfile } from '@shared/reasoning-profiles'
import { selectModel } from './model-router'

/** 池候选（可选带各自 baseURL——多提供商池时用于口径过滤；单提供商池留空即继承当前）。 */
export interface PoolCandidate extends ModelPoolEntry {
  baseURL?: string
}

/** 回传口径分组键（既有单源：reasoning-profiles）。 */
export function reasoningGroupOf(baseURL: string | undefined): string {
  return resolveReasoningProfile(baseURL).id
}

/**
 * 按回传口径过滤候选：只保留与当前 baseURL 同口径、且已启用的条目。
 * 单提供商池下全部通过；多提供商池下会剔除异口径项——这是「禁止跨口径切换」的执行点。
 */
export function filterSameGroup(
  candidates: readonly PoolCandidate[],
  currentBaseURL: string | undefined
): ModelPoolEntry[] {
  const group = reasoningGroupOf(currentBaseURL)
  const out: ModelPoolEntry[] = []
  for (const c of candidates) {
    if (!c.enabled) continue
    if (reasoningGroupOf(c.baseURL ?? currentBaseURL) !== group) continue
    out.push({ id: c.id, tier: c.tier, enabled: c.enabled })
  }
  return out
}

export interface RoundModelInput {
  /** 当前 LLM 配置的 baseURL（口径分组依据） */
  baseURL: string | undefined
  /** 会话当前生效模型（可能是上一轮切换后的结果） */
  currentModel: string
  /** AUTO 配置；undefined / enabled=false → 恒用 currentModel */
  router: ModelRouterConfig | undefined
  features: RouterFeatures
  /** 当前模型已连续驻留轮数（由调用方维护） */
  dwellRounds: number
  /** 提供商实际可用模型（可选；给了就做降级校验——目标不在列表即剔除） */
  availableModels?: readonly string[]
}

/**
 * 本轮应使用的模型。恒不抛错：任何异常/缺配都退回 `currentModel`（§8.2④ 降级）。
 */
export function resolveRoundModel(input: RoundModelInput): RouterDecision {
  const keep = (reason: string): RouterDecision => ({
    model: input.currentModel,
    switched: false,
    reason,
    targetTier: 'unknown'
  })

  const router = input.router
  if (!router || router.enabled !== true) return keep('AUTO 未开启')
  if (router.pinModel && router.pinModel.trim()) return keep(`已钉死模型 ${router.pinModel}`)

  let pool = filterSameGroup(router.pool ?? [], input.baseURL)
  if (input.availableModels && input.availableModels.length > 0) {
    const avail = new Set(input.availableModels)
    pool = pool.filter((e) => avail.has(e.id))
  }
  if (pool.length === 0) return keep('池内无同口径可用模型')

  try {
    return selectModel(input.features, {
      pool,
      currentModel: input.currentModel,
      dwellRounds: input.dwellRounds,
      minDwellRounds: router.minDwellRounds
    })
  } catch {
    // 策略引擎异常不得影响生成：退回当前模型（§8.2④）
    return keep('策略引擎异常，回落当前模型')
  }
}
