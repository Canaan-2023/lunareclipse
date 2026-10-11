/**
 * 为什么存在：后端 AI（DMN 记忆处理模型）与前端对话模型分开配置，
 * 避免 DMN 输出的模型切换影响聊天体验，独立 Tab + llmShared 共享切换逻辑。
 * 作用：渲染后端 AI 设置 Tab——provider/模型/采样参数配置、连接测试与模型发现，
 * 可跟随主模型。
 */
import { Activity, Server, KeyRound, Cpu, Layers, RefreshCw, Plus, Trash2 } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { PROVIDER_PRESETS } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'
import { PROVIDERS, ReasoningEffortSelect } from './llmShared'
import type { LlmConfigState } from './useLlmConfigState'

/** 后端 AI（DMN 记忆处理模型）配置 Tab */
export function BackendLlmSection({
  local,
  setLocal,
  llm
}: {
  local: AppConfig
  setLocal: (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => void
  llm: LlmConfigState
}) {
  const t = useT()
  const dmnPreset = PROVIDER_PRESETS[local.dmnLlm.provider]

  return (
    <div className="space-y-5">
      {/* DMN 后端 AI 说明 */}
      <div className="border-b border-border-subtle pb-4">
        <div className="mb-1 flex items-center gap-2">
          <Activity size={14} className="text-accent" />
          <span className="text-body font-medium text-fg-primary">{t('settings.backendAi')}</span>
        </div>
        <div className="text-caption text-fg-muted">{t('settings.dmnDesc')}</div>
        {/* 跟随前端 AI 配置 */}
        <div className="mt-3 flex items-center justify-between rounded-btn border border-border-subtle bg-bg-base px-3 py-2">
          <div className="min-w-0">
            <div className="text-body text-fg-primary">{t('settings.followMain')}</div>
            <div className="break-words text-caption text-fg-muted">
              {t('settings.followMainDesc')}
            </div>
          </div>
          <button
            onClick={() =>
              setLocal({
                ...local,
                dmnLlm: { ...local.dmnLlm, followMain: !local.dmnLlm?.followMain }
              })
            }
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              local.dmnLlm?.followMain ? 'bg-accent' : 'bg-bg-muted'
            }`}
            title={local.dmnLlm?.followMain ? t('common.close') : t('settings.followMain')}
          >
            <span
              className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                local.dmnLlm?.followMain ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        {local.dmnLlm?.followMain && (
          <div className="mt-2 rounded-btn border border-accent/30 bg-accent/5 px-3 py-2 text-caption text-accent">
            {t('settings.followingMain', {
              model: local.llm.model || t('settings.notSet'),
              provider: PROVIDER_PRESETS[local.llm.provider]?.label ?? local.llm.provider
            })}
          </div>
        )}
      </div>

      <div hidden={local.dmnLlm?.followMain}>
        {/* DMN Provider 选择 */}
        <section>
          <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">
            {t('settings.provider')}
          </div>
          <div className="grid grid-cols-5 gap-2">
            {PROVIDERS.map((p) => {
              const preset = PROVIDER_PRESETS[p.value]
              const active = local.dmnLlm.provider === p.value
              return (
                <button
                  key={p.value}
                  onClick={() => llm.switchDmnProvider(p.value)}
                  className={`flex flex-col items-center gap-1 rounded-card border px-2 py-2.5 transition-all duration-150 active:scale-95 ${
                    active
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-border text-fg-muted hover:bg-bg-muted'
                  }`}
                  title={preset.hint}
                >
                  <Server size={14} />
                  <span className="text-[11px]">{t(p.labelKey)}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-2 text-caption text-fg-muted">{dmnPreset.hint}</div>
        </section>

        {/* DMN 连接配置 */}
        <section>
          <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <KeyRound size={12} />
            <span>{t('settings.connection')}</span>
          </div>
          <div className="space-y-3">
            <Field label="API Base URL">
              <input
                type="text"
                value={local.dmnLlm.baseURL}
                onChange={(e) => llm.editDmnBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <Field label="API Key">
              <input
                type="password"
                value={local.dmnLlm.apiKey}
                onChange={(e) =>
                  setLocal({ ...local, dmnLlm: { ...local.dmnLlm, apiKey: e.target.value } })
                }
                placeholder={dmnPreset.needsKey ? 'sk-...' : t('settings.apiKeyHint')}
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
            </Field>

            <div className="flex items-center gap-2">
              <button
                onClick={llm.fetchDmnModels}
                disabled={llm.dmnFetchingModels}
                className="flex items-center gap-1.5 rounded-btn border border-border bg-bg-elevated px-3 py-1.5 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-50"
                title={t('settings.fetchModelsTitle')}
              >
                <RefreshCw size={11} className={llm.dmnFetchingModels ? 'animate-spin' : ''} />
                {llm.dmnFetchingModels ? t('settings.fetching') : t('settings.discoverModels')}
              </button>
              <button
                onClick={llm.handleDmnTest}
                disabled={llm.dmnTesting}
                className="rounded-btn border border-border bg-bg-elevated px-3 py-1.5 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-50"
              >
                {llm.dmnTesting ? t('settings.testing') : t('settings.testConn')}
              </button>
              {llm.dmnTestResult && (
                <span
                  className={`text-caption ${
                    /^(失败|错误|未发现|Failed|Error|No models)/.test(llm.dmnTestResult ?? '')
                      ? 'text-red-400'
                      : 'text-accent'
                  }`}
                >
                  {llm.dmnTestResult}
                </span>
              )}
            </div>

            {llm.dmnDiscoveredModels.length > 0 && (
              <div className="rounded-btn border border-border-subtle bg-bg-base/50 p-2">
                <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
                  {t('settings.discovered')}
                </div>
                <div className="flex flex-wrap gap-1">
                  {llm.dmnDiscoveredModels.map((m) => (
                    <button
                      key={m}
                      onClick={() => setLocal({ ...local, dmnLlm: { ...local.dmnLlm, model: m } })}
                      className={`rounded-btn px-2 py-1 text-[11px] transition-all duration-150 active:scale-95 ${
                        local.dmnLlm.model === m
                          ? 'bg-accent text-accent-fg'
                          : 'bg-bg-muted text-fg-secondary hover:bg-bg-elevated'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* DMN 模型参数 */}
        <section>
          <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <Cpu size={12} />
            <span>{t('settings.modelParams')}</span>
          </div>
          <div className="space-y-3">
            <Field label={t('settings.currentModel')}>
              <input
                type="text"
                value={local.dmnLlm.model}
                onChange={(e) =>
                  setLocal({ ...local, dmnLlm: { ...local.dmnLlm, model: e.target.value } })
                }
                placeholder="qwen2.5:3b"
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Temperature">
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={local.dmnLlm.temperature}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      dmnLlm: { ...local.dmnLlm, temperature: Number(e.target.value) }
                    })
                  }
                  className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
                />
              </Field>
              <Field label={t('settings.maxTokens')}>
                <input
                  type="number"
                  min="1"
                  value={local.dmnLlm.maxTokens ?? ''}
                  onChange={(e) =>
                    setLocal({
                      ...local,
                      dmnLlm: {
                        ...local.dmnLlm,
                        maxTokens: e.target.value ? Number(e.target.value) : null
                      }
                    })
                  }
                  placeholder={t('settings.unlimited')}
                  className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
                />
              </Field>
            </div>
            <ReasoningEffortSelect
              value={local.dmnLlm.reasoningEffort}
              onChange={(v) =>
                setLocal({ ...local, dmnLlm: { ...local.dmnLlm, reasoningEffort: v } })
              }
              baseURL={local.dmnLlm.baseURL}
            />
          </div>
        </section>

        {/* DMN 可用模型列表 */}
        <section>
          <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
            <Layers size={12} />
            <span>{t('settings.modelList')}</span>
          </div>
          <div className="space-y-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={llm.newDmnModel}
                onChange={(e) => llm.setNewDmnModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    llm.addDmnModel()
                  }
                }}
                placeholder={t('settings.manualAdd')}
                className="flex-1 rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={llm.addDmnModel}
                disabled={!llm.newDmnModel.trim()}
                className="flex shrink-0 items-center gap-1 rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-30"
              >
                <Plus size={12} />
                {t('settings.addModel')}
              </button>
            </div>
            {local.dmnAvailableModels.length === 0 ? (
              <div className="px-1 text-caption text-fg-muted">
                {t('settings.noExtraModels')}.{' '}
                {t('settings.defaultModelLabel', {
                  model: local.dmnLlm.model || t('settings.notSet')
                })}
              </div>
            ) : (
              <div className="space-y-1">
                {local.dmnAvailableModels.map((m) => (
                  <div
                    key={m}
                    className="flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-1.5"
                  >
                    <span className="flex-1 truncate text-body text-fg-primary">{m}</span>
                    {m === local.dmnLlm.model && (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                        {t('settings.current')}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => llm.removeDmnModel(m)}
                      className="text-fg-muted hover:text-red-400"
                      title={t('settings.remove')}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}