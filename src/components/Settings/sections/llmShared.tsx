/**
 * 为什么存在：前端 AI 与后端 AI 两个 Tab 共用同一套 provider 清单与"分槽切换"
 * 逻辑（各接入方式独立存档防串配置），抽成共享模块避免两份实现漂移。
 * 作用：导出 PROVIDERS（接入方式清单）与 switchLlmProfile（provider 分槽切换）等共享常量/函数。
 */
import type { AppConfig, LLMProvider, ReasoningEffort, LLMConfig } from '@shared/types'
import { PROVIDER_PRESETS } from '@shared/types'
import { resolveReasoningProfile, displayEffort } from '@shared/reasoning-profiles'
import { useT } from '../../../i18n/useT'

/** 接入方式列表（前端 AI / 后端 AI 共用） */
export const PROVIDERS: { value: LLMProvider; labelKey: string }[] = [
  { value: 'openai', labelKey: 'provider.openai' },
  { value: 'ollama', labelKey: 'provider.ollama' },
  { value: 'local', labelKey: 'provider.local' },
  { value: 'custom', labelKey: 'provider.custom' },
  { value: 'opencode-go', labelKey: 'provider.custom' }
]

/** LLM 接入方式分槽切换：归档当前编辑态到旧 provider 槽 → 目标槽已有存档则恢复，
 * 无存档用预设初始化（不继承旧 apiKey/model，避免不同接入方式串配置）。
 * 效果：本地服务/自定义/OpenAI 等各存各的，切走再切回不用重输 URL 和 Key。 */
export function switchLlmProfile(
  prev: AppConfig,
  key: 'llm' | 'dmnLlm',
  profilesKey: 'llmProfiles' | 'dmnLlmProfiles',
  activeKey: 'llmActiveProfile' | 'dmnLlmActiveProfile',
  target: LLMProvider
): AppConfig {
  const cur = prev[key]
  const profiles: Record<string, LLMConfig> = { ...(prev[profilesKey] ?? {}) }
  // 归档当前编辑态（含未保存改动）到当前 provider 槽
  profiles[cur?.provider ?? 'custom'] = { ...cur }
  const preset = PROVIDER_PRESETS[target]
  const targetCfg: LLMConfig = profiles[target] ?? {
    ...cur,
    provider: target,
    baseURL: preset?.baseURL ?? '',
    apiKey: '',
    model: '',
    temperature: cur?.temperature ?? 0.7,
    maxTokens: cur?.maxTokens ?? null,
    streamingSpeed: cur?.streamingSpeed ?? 1,
    reasoningEffort: cur?.reasoningEffort ?? 'medium'
  }
  profiles[target] = targetCfg
  return { ...prev, [key]: targetCfg, [profilesKey]: profiles, [activeKey]: target }
}

/** 思考强度产品 7 档（关闭/最低/低/中/高/极高/最大）
 * 这是产品级语义档位，wire 层按各接入方能力表归一（见 @shared/reasoning-profiles）：
 * DeepSeek 认 低/高/最大（minimal→low、medium→high）；OpenAI 枚举 minimal..high 透传
 * （very_high/max→high）；Gemini 3.7 起无 minimal（→low）；千问仅开/关（enable_thinking）。
 * ReasoningEffortSelect 会按当前 baseURL 命中的能力表动态只展示该接口可区分的档位，
 * 与主进程 buildReasoningParams 查同一张表，保证 UI 显示与实际发送一致。 */
export const REASONING_OPTIONS: { value: ReasoningEffort; labelKey: string; descKey: string }[] = [
  { value: 'off', labelKey: 'settings.reasoning.off', descKey: 'settings.reasoning.off.desc' },
  { value: 'minimal', labelKey: 'settings.reasoning.minimal', descKey: 'settings.reasoning.minimal.desc' },
  { value: 'low', labelKey: 'settings.reasoning.low', descKey: 'settings.reasoning.low.desc' },
  { value: 'medium', labelKey: 'settings.reasoning.medium', descKey: 'settings.reasoning.medium.desc' },
  { value: 'high', labelKey: 'settings.reasoning.high', descKey: 'settings.reasoning.high.desc' },
  { value: 'very_high', labelKey: 'settings.reasoning.very_high', descKey: 'settings.reasoning.very_high.desc' },
  { value: 'max', labelKey: 'settings.reasoning.max', descKey: 'settings.reasoning.max.desc' }
]

/** 思考强度下拉（带当前档位说明 + 按接入方能力表动态显隐档位/展示归一提示） */
export function ReasoningEffortSelect({
  value,
  onChange,
  baseURL
}: {
  value: ReasoningEffort | undefined
  onChange: (v: ReasoningEffort) => void
  /** 当前接入的 baseURL（可选）：解析命中 @shared/reasoning-profiles 的能力契约，
   * 只展示该接口可区分的档位，并把命中 profile 的归一提示（noteKey）显示在下方，
   * 避免用户以为选了中间档实际发送的是别的值（如 DeepSeek 上选「中」实际按 high 发送） */
  baseURL?: string
}) {
  const t = useT()
  // 与主进程 llmClient.buildReasoningParams 同源（@shared/reasoning-profiles）：
  // UI 显示档位集合与 wire 归一规则永不漂移。
  const profile = resolveReasoningProfile(baseURL)
  const available = REASONING_OPTIONS.filter((o) => profile.uiEfforts.includes(o.value))
  // 旧配置里可能存了该接口不可区分的档位（如 DeepSeek 上存了 medium），
  // 展示时就近归一到可见档，避免 select 出现空值；落库值不变，等待用户重选。
  // 未配置时按主进程默认（medium）求归一档展示，保证 UI 与默认行为一致。
  const effectiveValue = value ?? 'medium'
  const displayValue =
    available.find((o) => o.value === displayEffort(profile, effectiveValue)) ?? available[0]!
  const noteKey = profile.noteKey && value !== 'off' ? profile.noteKey : undefined
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <label className="block text-caption text-fg-secondary">{t('settings.reasoning')}</label>
        <span className="text-[10px] text-fg-muted">{t(displayValue.descKey)}</span>
      </div>
      <select
        value={displayValue.value}
        onChange={(e) => onChange(e.target.value as ReasoningEffort)}
        className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
      >
        {available.map((o) => (
          <option key={o.value} value={o.value}>
            {t(o.labelKey)}
          </option>
        ))}
      </select>
      {noteKey && (
        <p className="mt-1 text-[10px] leading-relaxed text-fg-muted">{t(noteKey)}</p>
      )}
    </div>
  )
}