/**
 * 思考强度 provider 能力契约表（通用动态映射的单一事实源）
 *
 * 为什么存在：各家 API 对"思考强度"的表达各不相同（DeepSeek 官方只认 low/high/max
 * 三档枚举 + thinking 开关；OpenAI 系是 minimal/low/medium/high 枚举透传；Gemini 3.7
 * 起移除 minimal；千问只有 enable_thinking 布尔开关；Claude 经典模型无档位、经兼容
 * 网关近似映射）。若在主进程写 if (deepseek) 特化分支，每接一家就要改请求构造和 UI,
 * 且容易漏改导致"档位选了但没生效"。
 *
 * 通用解法：把每家接口的契约声明为一条 profile（命中规则 + 可展示档位 + 7 档 → wire
 * 参数组装函数）。主进程 buildReasoningParams 与前端挡位下拉都只做一件事——按 baseURL
 * 查表（resolveReasoningProfile），命中则按其契约组装/展示；未命中走 default
 * （OpenAI 兼容枚举语义）。新增 provider 只在表里加一行，不改任何业务代码。
 *
 * 档位语义（产品级 7 档，与 ReasoningEffort 一致）：
 *   off → minimal → low → medium → high → very_high → max
 * 各 profile 的 uiEfforts 声明"该接口下用户可真实区分的档位"，其余档位隐藏并在 UI 归一
 * 提示（displayEffort 就近归一到可见档），避免用户以为选了中间档实际发送的是别的值。
 */
import type { ReasoningEffort } from './types/llm'

/** 产品级档位强度序（与 ReasoningEffort 声明一致，就近归一用） */
const EFFORT_ORDER: readonly ReasoningEffort[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'very_high',
  'max'
]

export interface ReasoningProfile {
  /** 唯一标识：deepseek / openai / gemini / qwen / anthropic / default */
  id: string
  /** baseURL 命中正则（大小写不敏感）。default 不用正则，作为兜底。 */
  match?: RegExp
  /** 该接口下可真实区分的档位（从弱到强）。未列出的 7 档会从下拉隐藏并在命中时就近归一。 */
  uiEfforts: readonly ReasoningEffort[]
  /** 产品 7 档 → wire 参数（含 off 语义）。返回对象会被展开进请求体。 */
  buildParams: (effort: ReasoningEffort) => Record<string, unknown>
  /** UI 归一提示 i18n key（可选）；命中时有说明文案才显示 */
  noteKey?: string
}

/**
 * 就近归一：把任意产品档位映射到该 profile 可见档位集合中的展示档。
 * 规则：off 只归到 off 自身；非 off 档在可见的非 off 档中取"强度距离最近"者，
 * 同距离时向更强档靠拢（如 DeepSeek 的 medium→high、very_high→max），
 * 与 wire 归一语义一致（medium 比 low 更接近 high 一侧的档位表达）。
 */
export function displayEffort(
  profile: ReasoningProfile,
  effort: ReasoningEffort
): ReasoningEffort {
  if (profile.uiEfforts.includes(effort)) return effort
  if (effort === 'off') return 'off'
  const candidates = profile.uiEfforts.filter((l) => l !== 'off')
  if (candidates.length === 0) return 'off'
  let best = candidates[0]!
  let bestDist = Number.POSITIVE_INFINITY
  const vi = EFFORT_ORDER.indexOf(effort)
  for (const l of candidates) {
    const d = Math.abs(EFFORT_ORDER.indexOf(l) - vi)
    // 更近优先；等距取更强档（index 更大）
    if (d < bestDist || (d === bestDist && EFFORT_ORDER.indexOf(l) > EFFORT_ORDER.indexOf(best))) {
      best = l
      bestDist = d
    }
  }
  return best
}

/** DeepSeek 官方（2026-10 契约见 app/electron/main/api/llm.ts buildReasoningParams 注释）：
 *  official reasoning_effort 接受 low/high/max 三档强度（兼容映射 minimal→low、
 *  medium→high、xhigh→high；none 用于关思考但我们用 thinking disabled 更稳——部分网关
 *  对 none 校验失败返回 400）。思考模式需 thinking: { type: 'enabled' } 显式开启。 */
const deepseekProfile: ReasoningProfile = {
  id: 'deepseek',
  match: /deepseek/i,
  uiEfforts: ['off', 'low', 'high', 'max'],
  buildParams: (effort) => {
    if (effort === 'off') return { thinking: { type: 'disabled' } }
    const wire = ((): string => {
      if (effort === 'max' || effort === 'very_high') return 'max'
      if (effort === 'low' || effort === 'minimal') return 'low'
      return 'high'
    })()
    return { thinking: { type: 'enabled' }, reasoning_effort: wire }
  },
  noteKey: 'settings.reasoning.note.deepseek'
}

/** OpenAI 官方：reasoning_effort 枚举 minimal/low/medium/high 原样透传；档位到 high 为止，
 *  very_high/max 归一 high（官方无更大档位枚举；上层模型若有 max 语义走 default 网关兼容）。 */
const openaiProfile: ReasoningProfile = {
  id: 'openai',
  match: /(^|\.)openai\.com/i,
  uiEfforts: ['off', 'minimal', 'low', 'medium', 'high'],
  buildParams: (effort) => {
    if (effort === 'off') return {}
    const wire = ((): string => {
      if (effort === 'very_high' || effort === 'max') return 'high'
      return effort
    })()
    return { reasoning_effort: wire }
  },
  noteKey: 'settings.reasoning.note.openai'
}

/** Gemini（OpenAI 兼容接入）：3.7 起官方不再提供 minimal 档（返回 error），故 minimal→low；
 *  档位到 high 为止，very_high/max 归一 high。关思考经兼容层用 thinking disabled。 */
const geminiProfile: ReasoningProfile = {
  id: 'gemini',
  match: /generativelanguage|gemini/i,
  uiEfforts: ['off', 'low', 'medium', 'high'],
  buildParams: (effort) => {
    if (effort === 'off') return { thinking: { type: 'disabled' } }
    const wire = ((): string => {
      if (effort === 'minimal') return 'low'
      if (effort === 'very_high' || effort === 'max') return 'high'
      return effort
    })()
    return { reasoning_effort: wire }
  },
  noteKey: 'settings.reasoning.note.gemini'
}

/** 千问（DashScope/百炼 OpenAI 兼容）：官方只支持 enable_thinking 布尔开关，无档位细分。
 *  非 off 一律开启思考；wire 用非标准字段 enable_thinking（OpenAI SDK 会原样序列化）。 */
const qwenProfile: ReasoningProfile = {
  id: 'qwen',
  match: /dashscope|aliyun|qwen/i,
  uiEfforts: ['off', 'medium'],
  buildParams: (effort) => {
    return effort === 'off' ? { enable_thinking: false } : { enable_thinking: true }
  },
  noteKey: 'settings.reasoning.note.qwen'
}

/** Anthropic（Claude）：经典模型不支持档位细分（extended thinking 用 budget_tokens），
 *  Haiku 5.5+ 新增 effort 档位但通常经兼容网关映射；此处按近似语义透传并提示归一。 */
const anthropicProfile: ReasoningProfile = {
  id: 'anthropic',
  match: /anthropic|claude/i,
  uiEfforts: ['off', 'minimal', 'low', 'medium', 'high'],
  buildParams: (effort) => {
    if (effort === 'off') return {}
    const wire = ((): string => {
      if (effort === 'very_high' || effort === 'max') return 'high'
      return effort
    })()
    return { reasoning_effort: wire }
  },
  noteKey: 'settings.reasoning.note.anthropic'
}

/** 兜底（未命中任何已知 profile：自定义网关/第三方聚合/本地推理等）：
 *  按 OpenAI 兼容枚举语义透传 minimal/low/medium/high，very_high/max 归一 high，off 不传。 */
const defaultProfile: ReasoningProfile = {
  id: 'default',
  uiEfforts: ['off', 'minimal', 'low', 'medium', 'high', 'very_high', 'max'],
  buildParams: (effort) => {
    if (effort === 'off') return {}
    const wire = ((): string => {
      if (effort === 'very_high' || effort === 'max') return 'high'
      return effort
    })()
    return { reasoning_effort: wire }
  }
}

/** 按出现顺序匹配；先命中先用。新 provider 在此追加一行即可，勿在别处特化。 */
const PROFILES: readonly ReasoningProfile[] = [
  deepseekProfile,
  openaiProfile,
  geminiProfile,
  qwenProfile,
  anthropicProfile
]

/** 按 baseURL 解析当前接入的思考强度契约 profile（未命中 → default） */
export function resolveReasoningProfile(baseURL: string | undefined): ReasoningProfile {
  const url = baseURL ?? ''
  for (const p of PROFILES) {
    if (p.match && p.match.test(url)) return p
  }
  return defaultProfile
}

/** 按契约组装思考强度 wire 参数（主进程请求构造用；与前端下拉同一事实源） */
export function buildReasoningWireParams(
  baseURL: string | undefined,
  effort: ReasoningEffort
): Record<string, unknown> {
  return resolveReasoningProfile(baseURL).buildParams(effort)
}