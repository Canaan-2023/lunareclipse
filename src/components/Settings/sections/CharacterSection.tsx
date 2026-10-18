/**
 * 为什么存在：AI 角色属性（名称、上下文宽度、工具结果蒸馏）直接决定对话体验，
 * 独立成设置区便于集中调节而不与其他配置混淆。
 * 作用：渲染「AI 角色」设置区——AI 名称、上下文窗口/工具结果蒸馏等字段，
 * 蒸馏缺省值直接复用 shared DEFAULT_CONFIG（避免本地重复常量与 shared 漂移矛盾）。
 */
import { Cat, Lock, Unlock } from 'lucide-react'
import { DEFAULT_TOOL_RESULT_DISTILL, type AppConfig, type ToolResultDistillConfig } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'

/** 角色 Tab：AI 名称、上下文窗口、工具结果蒸馏、会话正文宽度 */
export function CharacterSection({
  local,
  setLocal,
  config
}: {
  local: AppConfig
  setLocal: (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => void
  config: AppConfig
}) {
  const t = useT()
  // 工具结果蒸馏配置：旧配置未保存过该字段时用 shared 单源默认值（DEFAULT_TOOL_RESULT_DISTILL）
  // 兜底；显式标注完整类型——DEFAULT_TOOL_RESULT_DISTILL 是全字段必填的常量，合并后
  // distill 各字段仍保号必填，避免 AppConfig.toolResultDistill 可选类型展开成 Partial 漂移
  // （typecheck 曾报 TS2322：enabled 等变 boolean | undefined）。
  const distill: ToolResultDistillConfig = {
    ...DEFAULT_TOOL_RESULT_DISTILL,
    ...(local.toolResultDistill ?? {})
  }

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Cat size={12} />
          <span>{t('settings.charName')}</span>
        </div>
        <Field label={t('settings.charNameField')}>
          <input
            type="text"
            value={local.aiName}
            onChange={(e) => setLocal({ ...local, aiName: e.target.value })}
            placeholder={t('settings.charNamePlaceholder')}
            maxLength={16}
            className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
        </Field>
        <div className="mt-1.5 text-caption text-fg-muted">{t('settings.charNameHint')}</div>
        {/* 防覆盖控制：用户手动编辑后，AI 的 update_ai_name 工具会被拒绝 */}
        <div className="mt-2 flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
          {local.aiNameManualEdited ? (
            <>
              <Lock size={12} className="text-fg-muted" />
              <span className="text-caption text-fg-muted flex-1">
                {t('settings.charProtected')}
              </span>
              <button
                onClick={() => setLocal({ ...local, aiNameManualEdited: false })}
                className="text-caption text-accent hover:underline"
              >
                {t('settings.charAllowEdit')}
              </button>
            </>
          ) : (
            <>
              <Unlock size={12} className="text-fg-muted" />
              <span className="text-caption text-fg-muted">
                {t('settings.charAllowEditDesc')}
              </span>
            </>
          )}
        </div>
      </section>

      <section>
        {/* 上下文窗口管理：控制发送给 AI 的历史消息量 */}
        <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-3 space-y-3">
          <div>
            <div className="text-body text-fg-primary">{t('settings.contextWindow')}</div>
            <div className="text-caption text-fg-muted">{t('settings.contextWindowDesc')}</div>
          </div>
          {/* 模式切换 */}
          <div className="flex items-center gap-1 rounded-btn bg-bg-muted p-0.5">
            {(
              [
                { v: 'off', label: t('settings.contextMode.off') },
                { v: 'pairs', label: t('settings.contextMode.pairs') },
                { v: 'chars', label: t('settings.contextMode.chars') }
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                onClick={() =>
                  setLocal({
                    ...local,
                    contextWindow: { ...local.contextWindow, mode: opt.v }
                  })
                }
                className={`flex-1 rounded-[6px] px-2 py-1.5 text-caption transition-all duration-150 active:scale-95 ${
                  local.contextWindow.mode === opt.v
                    ? 'bg-accent text-accent-fg'
                    : 'text-fg-muted hover:text-fg-secondary'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {/* 参数输入 */}
          {local.contextWindow.mode === 'pairs' && (
            <>
              <Field label={t('settings.contextPairsLabel')}>
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={local.contextWindow.pairs}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      contextWindow: {
                        ...local.contextWindow,
                        pairs: Math.max(1, Math.min(100, Number(e.target.value) || 10))
                      }
                    })
                  }
                  className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
              </Field>
              <Field label={t('settings.contextTokenLimit')}>
                <input
                  type="number"
                  min="0"
                  step="500"
                  value={local.contextWindow.chars}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      contextWindow: {
                        ...local.contextWindow,
                        chars: Math.max(0, Number(e.target.value) || 0)
                      }
                    })
                  }
                  className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
              </Field>
            </>
          )}
          {local.contextWindow.mode === 'chars' && (
            <Field label={t('settings.contextKeepTokens')}>
              <input
                type="number"
                min="500"
                step="500"
                value={local.contextWindow.chars}
                onChange={(e) =>
                  setLocal({
                    ...local,
                    contextWindow: {
                      ...local.contextWindow,
                      chars: Math.max(500, Number(e.target.value) || 8000)
                    }
                  })
                }
                className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
              />
            </Field>
          )}
          {local.contextWindow.mode === 'off' && (
            <div className="text-caption text-fg-muted rounded-btn bg-bg-muted/50 px-3 py-2">
              {t('settings.contextUnlimitedHint')}
            </div>
          )}
        </div>

        {/* 工具结果蒸馏：大体积工具结果先用 LLM 提炼有用信息后进上下文，
            蒸馏失败重试一次仍失败则保留原文 */}
        <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-3 space-y-3">
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={distill.enabled}
              onChange={(e) =>
                setLocal({ ...local, toolResultDistill: { ...distill, enabled: e.target.checked } })
              }
            />
            <span className="flex flex-col">
              <span className="text-body text-fg-primary">
                {t('settings.toolResultDistill')}
                <span className={`ml-2 text-[11px] ${distill.enabled ? 'text-accent' : 'text-fg-muted'}`}>
                  {distill.enabled ? t('settings.toolResultDistillOn') : t('settings.toolResultDistillOff')}
                </span>
              </span>
              <span className="text-caption text-fg-muted">{t('settings.toolResultDistillDesc')}</span>
            </span>
          </label>
          {distill.enabled && (
            <>
              <Field label={t('settings.toolResultDistill.minChars')}>
                <input
                  type="number"
                  min="0"
                  step="500"
                  value={distill.minChars}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      toolResultDistill: {
                        ...distill,
                        // 0 = 全量过滤（0.17 起默认），>0 = 仅蒸馏超过该体积的结果；
                        // 空输入回退到 shared 单源默认值（DEFAULT_TOOL_RESULT_DISTILL）而非本地常量
                        minChars: Math.max(0, Number(e.target.value) || DEFAULT_TOOL_RESULT_DISTILL.minChars)
                      }
                    })
                  }
                  className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
              </Field>
              <Field label={t('settings.toolResultDistill.intentTurnPairs')}>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={distill.intentTurnPairs}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      toolResultDistill: {
                        ...distill,
                        // 意图上下文 = 最近几对 user/assistant 对话（0 = 蒸馏时不携带历史上下文）；
                        // 空输入回退到 shared 单源默认值，避免魔法数字散落各处
                        intentTurnPairs: Math.max(0, Number(e.target.value) || DEFAULT_TOOL_RESULT_DISTILL.intentTurnPairs)
                      }
                    })
                  }
                  className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
                <p className="text-caption text-fg-muted">{t('settings.toolResultDistill.intentTurnPairsHint')}</p>
              </Field>
              <Field label={t('settings.toolResultDistill.model')}>
                <input
                  type="text"
                  value={distill.model}
                  placeholder={config.llm.model}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      toolResultDistill: { ...distill, model: e.target.value.trim() }
                    })
                  }
                  className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
              </Field>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={distill.onlyListSearchTools}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      toolResultDistill: { ...distill, onlyListSearchTools: e.target.checked }
                    })
                  }
                />
                <span className="text-caption text-fg-muted">
                  {t('settings.toolResultDistill.onlyListSearch')}
                </span>
              </label>
              <Field label={t('settings.toolResultDistill.skipTools')}>
                <input
                  type="text"
                  value={distill.skipTools?.join(', ') ?? DEFAULT_TOOL_RESULT_DISTILL.skipTools?.join(', ') ?? ''}
                  onChange={(e) => {
                    const names = e.target.value.split(',').map((s) => s.trim()).filter(Boolean)
                    setLocal({
                      ...local,
                      toolResultDistill: {
                        ...distill,
                        // 逗号分隔工具名 → 数组；空输入恢复默认名单（use_skill），指令型保护
                        // 不可被误清空（与 minChars 空输入回退单源默认的惯例一致）；显式清空
                        // 豁免仅可经配置文件配置 skipTools: []（高级用途，UI 不做此入口）。
                        skipTools: names.length > 0 ? names : DEFAULT_TOOL_RESULT_DISTILL.skipTools
                      }
                    })
                  }}
                  className="w-full rounded-btn border border-border bg-bg-base px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
                <p className="text-caption text-fg-muted">{t('settings.toolResultDistill.skipToolsHint')}</p>
              </Field>
            </>
          )}
        </div>

        {/* 会话正文宽度：小/中/大三档，控制消息列最大宽度。
            注：AI 曾改成"跟随容器自适应"说明文字但实际锁死窄宽，已恢复三档可调 */}
        <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-3 space-y-3">
          <div>
            <div className="text-body text-fg-primary">{t('settings.textWidth')}</div>
            <div className="text-caption text-fg-muted">{t('settings.textWidthDesc')}</div>
          </div>
          <div className="flex items-center gap-1 rounded-btn bg-bg-muted p-0.5">
            {(
              [
                { v: 'narrow', labelKey: 'settings.textWidth.narrow' },
                { v: 'medium', labelKey: 'settings.textWidth.medium' },
                { v: 'wide', labelKey: 'settings.textWidth.wide' }
              ] as const
            ).map((opt) => (
              <button
                key={opt.v}
                onClick={() =>
                  setLocal({
                    ...local,
                    messageWidth: opt.v
                  })
                }
                className={`flex-1 rounded-[6px] px-2 py-1.5 text-caption transition-all duration-150 active:scale-95 ${
                  (local.messageWidth ?? 'medium') === opt.v
                    ? 'bg-accent text-accent-fg'
                    : 'text-fg-muted hover:text-fg-secondary'
                }`}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}