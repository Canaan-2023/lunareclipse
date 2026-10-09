/**
 * 为什么存在：前端 AI（对话/流式）与后端 AI（DMN 记忆处理）模型分开配置，
 * 各自独立 Tab、共用同一套 provider 切换逻辑，故独立组件 + llmShared 共享。
 * 作用：渲染前端 AI 设置 Tab——provider 切换、baseURL/API Key/模型/采样参数、
 * 连接测试与模型发现。
 */
import { Server, KeyRound, Cpu, Layers, RefreshCw, Plus, Trash2, Lock, AlertTriangle } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { PROVIDER_PRESETS } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'
import { PROVIDERS, ReasoningEffortSelect } from './llmShared'
import type { LlmConfigState } from './useLlmConfigState'

/** 前端 AI（浏览器侧主模型）配置 Tab */
export function FrontendLlmSection({
  local,
  setLocal,
  llm
}: {
  local: AppConfig
  setLocal: (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => void
  llm: LlmConfigState
}) {
  const t = useT()
  const preset = PROVIDER_PRESETS[local.llm.provider]

  return (
    <div className="space-y-5">
      {/* Provider 选择 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">
          {t('settings.provider')}
        </div>
        <div className="grid grid-cols-5 gap-2">
          {PROVIDERS.map((p) => {
            const preset = PROVIDER_PRESETS[p.value]
            const active = local.llm.provider === p.value
            return (
              <button
                key={p.value}
                onClick={() => llm.switchProvider(p.value)}
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
        <div className="mt-2 text-caption text-fg-muted">{preset.hint}</div>
      </section>

      {/* 连接配置 */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <KeyRound size={12} />
          <span>{t('settings.connection')}</span>
        </div>
        <div className="space-y-3">
          <Field label={t('settings.apiBaseUrl')}>
            <input
              type="text"
              value={local.llm.baseURL}
              onChange={(e) => llm.editBaseURL(e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label={t('settings.apiKey')}>
            <input
              type="password"
              value={local.llm.apiKey}
              onChange={(e) =>
                setLocal({ ...local, llm: { ...local.llm, apiKey: e.target.value } })
              }
              placeholder={preset.needsKey ? 'sk-...' : t('settings.apiKeyHint')}
              className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
          </Field>

          <div className="flex items-center gap-2">
            <button
              onClick={llm.fetchModels}
              disabled={llm.fetchingModels}
              className="flex items-center gap-1.5 rounded-btn border border-border bg-bg-elevated px-3 py-1.5 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-50"
              title={t('settings.discoverModels')}
            >
              <RefreshCw size={11} className={llm.fetchingModels ? 'animate-spin' : ''} />
              {llm.fetchingModels ? t('settings.fetching') : t('settings.discoverModels')}
            </button>
            <button
              onClick={llm.handleTest}
              disabled={llm.testing}
              className="rounded-btn border border-border bg-bg-elevated px-3 py-1.5 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-50"
            >
              {llm.testing ? t('settings.testing') : t('settings.testConn')}
            </button>
            {llm.testResult && (
              <span
                className={`text-caption ${
                  /^(失败|错误|未发现|Failed|Error|No models)/.test(llm.testResult ?? '')
                    ? 'text-red-400'
                    : 'text-accent'
                }`}
              >
                {llm.testResult}
              </span>
            )}
          </div>

          {llm.discoveredModels.length > 0 && (
            <div className="rounded-btn border border-border-subtle bg-bg-base/50 p-2">
              <div className="mb-1.5 text-[10px] uppercase tracking-wider text-fg-muted">
                {t('settings.discovered')}
              </div>
              <div className="flex flex-wrap gap-1">
                {llm.discoveredModels.map((m) => (
                  <button
                    key={m}
                    onClick={() => setLocal({ ...local, llm: { ...local.llm, model: m } })}
                    className={`rounded-btn px-2 py-1 text-[11px] transition-all duration-150 active:scale-95 ${
                      local.llm.model === m
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

      {/* 模型参数 */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Cpu size={12} />
          <span>{t('settings.modelParams')}</span>
        </div>
        <div className="space-y-3">
          <Field label={t('settings.currentModel')}>
            <input
              type="text"
              value={local.llm.model}
              onChange={(e) =>
                setLocal({ ...local, llm: { ...local.llm, model: e.target.value } })
              }
              placeholder="gpt-4o-mini"
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
                value={local.llm.temperature}
                onChange={(e) =>
                  setLocal({
                    ...local,
                    llm: { ...local.llm, temperature: Number(e.target.value) }
                  })
                }
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
              />
            </Field>
            <Field label={t('settings.maxTokens')}>
              <input
                type="number"
                min="1"
                value={local.llm.maxTokens ?? ''}
                onChange={(e) =>
                  setLocal({
                    ...local,
                    llm: {
                      ...local.llm,
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
            value={local.llm.reasoningEffort}
            onChange={(v) => setLocal({ ...local, llm: { ...local.llm, reasoningEffort: v } })}
            baseURL={local.llm.baseURL}
          />
        </div>
      </section>

      {/* 可用模型列表 */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Layers size={12} />
          <span>{t('settings.modelList')}</span>
        </div>
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={llm.newModel}
              onChange={(e) => llm.setNewModel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  llm.addModel()
                }
              }}
              placeholder={t('settings.manualAdd')}
              className="flex-1 rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={llm.addModel}
              disabled={!llm.newModel.trim()}
              className="flex shrink-0 items-center gap-1 rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-30"
            >
              <Plus size={12} />
              {t('settings.addModel')}
            </button>
          </div>
          {local.availableModels.length === 0 ? (
            <div className="px-1 text-caption text-fg-muted">
              {t('settings.noExtraModels')}.{' '}
              {t('settings.defaultModelLabel', {
                model: local.llm.model || t('settings.notSet')
              })}
            </div>
          ) : (
            <div className="space-y-1">
              {local.availableModels.map((m) => (
                <div
                  key={m}
                  className="flex items-center gap-2 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-1.5"
                >
                  <span className="flex-1 truncate text-body text-fg-primary">{m}</span>
                  {m === local.llm.model && (
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
                      {t('settings.current')}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => llm.removeModel(m)}
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

      {/* 权限与重启 */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Lock size={12} />
          <span>{t('settings.permission')}</span>
        </div>
        <div className="space-y-3">
          <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
            <div className="text-body text-fg-primary">{t('settings.greenlight')}</div>
            <div className="text-caption text-fg-muted">
              {t('settings.greenlightDesc')}
              {local.permissionGreenlight ? (
                <span className="text-accent"> {t('settings.greenlightOn')}</span>
              ) : (
                <span className="text-fg-muted"> {t('settings.greenlightOff')}</span>
              )}
            </div>
          </div>
          {local.permissionGreenlight && (
            <div className="flex items-start gap-2 rounded-btn border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-caption text-amber-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{t('settings.greenlightWarn')}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}