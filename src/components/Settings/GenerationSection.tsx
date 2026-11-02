/**
 * 为什么存在：多模态生成（图/视频/音频）按接入口配置 provider，
 * 独立成区避免与 LLM 对话配置混淆，且启用联动工具可见性。
 * 作用：按模态配置 imageGen / generation.video / generation.audio 的参数，
 * 对应模态启用后其生成工具自动可见并进入 AI 内容生成能力提示。
 */
import { useState } from 'react'
import { Wand2, Image as ImageIcon, Video, Music, FileText, FolderOpen, RefreshCw } from 'lucide-react'
import type { AppConfig, GenMediaProviderConfig, ImageGenConfig } from '@shared/types'
import { useT } from '../../i18n/useT'

interface Props {
  config: AppConfig
  onChange: (next: AppConfig) => void
}

/**
 * 多模态内容生成设置区：
 * 按模态配置 provider（图片 imageGen / 视频 generation.video / 音频 generation.audio）。
 * 对应模态启用后，其 LLM 工具（image_gen / video_gen / audio_gen）自动可见，
 * 并出现在 AI「内容生成能力」提示里；生成的产物按分类+日期落盘。
 */
export function GenerationSection({ config, onChange }: Props) {
  const t = useT()
  const image = config.imageGen ?? { enabled: false, baseURL: '', apiKey: '', model: '' }
  const video = config.generation?.video ?? { enabled: false, baseURL: '', apiKey: '', model: '', endpointPath: 'videos' }
  const audio = config.generation?.audio ?? { enabled: false, baseURL: '', apiKey: '', model: '', endpointPath: 'audio' }

  // 顶层 imageGen 写回（兼容既有字段；image 不改动 generation.*）
  const patchImage = (patch: Partial<ImageGenConfig>) => {
    onChange({ ...config, imageGen: { ...image, ...patch } })
  }
  const patchGen = (key: 'video' | 'audio', patch: Partial<GenMediaProviderConfig>) => {
    const cur = key === 'video' ? video : audio
    onChange({
      ...config,
      generation: { ...(config.generation ?? {}), [key]: { ...cur, ...patch } }
    })
  }

  const enabledCount = [image.enabled, video.enabled, audio.enabled].filter(Boolean).length

  return (
    <div className="space-y-4">
      {/* 说明 + 状态 */}
      <section className="rounded-btn border border-border-subtle bg-bg-base p-3">
        <div className="flex items-center gap-2">
          <Wand2 size={14} className="text-accent" />
          <h3 className="text-body font-medium text-fg-primary">{t('settings.genTitle')}</h3>
          {enabledCount > 0 && (
            <span className="ml-auto rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">
              {t('settings.genEnabledCount', { n: enabledCount })}
            </span>
          )}
        </div>
        <p className="mt-1 break-words text-caption text-fg-muted">
          {t('settings.genDesc')}
        </p>
        <div className="mt-2 flex items-center gap-1.5 break-all rounded bg-bg-muted/50 px-2 py-1 font-mono text-[10px] text-fg-muted">
          <FolderOpen size={11} className="shrink-0" />
          <span>
            {t('settings.genOutputDir')}
          </span>
        </div>
      </section>

      {/* 图片 */}
      <ProviderCard
        icon={<ImageIcon size={14} className="text-accent" />}
        title={t('settings.genImageTitle')}
        tool="image_gen"
        hint={t('settings.genImageHint')}
        config={{ enabled: image.enabled, baseURL: image.baseURL, apiKey: image.apiKey, model: image.model }}
        onToggle={(v) => patchImage({ enabled: v })}
        onPatch={(patch) => patchImage(patch)}
        // 图片沿用顶层 imageGen 配置，无独立 endpointPath
        showEndpoint={false}
      />

      {/* 视频 */}
      <ProviderCard
        icon={<Video size={14} className="text-accent" />}
        title={t('settings.genVideoTitle')}
        tool="video_gen"
        hint={t('settings.genVideoHint')}
        config={video}
        onToggle={(v) => patchGen('video', { enabled: v })}
        onPatch={(patch) => patchGen('video', patch)}
        showEndpoint
      />

      {/* 音频 */}
      <ProviderCard
        icon={<Music size={14} className="text-accent" />}
        title={t('settings.genAudioTitle')}
        tool="audio_gen"
        hint={t('settings.genAudioHint')}
        config={audio}
        onToggle={(v) => patchGen('audio', { enabled: v })}
        onPatch={(patch) => patchGen('audio', patch)}
        showEndpoint
      />

      {/* 文稿归档（无需配置，即时可用） */}
      <section className="rounded-btn border border-border-subtle p-3">
        <div className="flex items-center gap-2">
          <FileText size={14} className="text-accent" />
          <h3 className="text-body font-medium text-fg-primary">{t('settings.genDocTitle')}</h3>
          <span className="ml-auto rounded-full bg-success/15 px-2 py-0.5 text-[10px] text-success">{t('settings.genDocBadge')}</span>
        </div>
        <p className="mt-1 break-words text-caption text-fg-muted">
          <code className="rounded bg-bg-muted/50 px-1 text-[10px]">create_document</code>{t('settings.genDocDesc')}
        </p>
      </section>
    </div>
  )
}

interface CardProps {
  icon: React.ReactNode
  title: string
  tool: string
  hint: string
  config: { enabled: boolean; baseURL: string; apiKey: string; model: string; endpointPath?: string }
  onToggle: (v: boolean) => void
  onPatch: (patch: Partial<GenMediaProviderConfig>) => void
  showEndpoint?: boolean
}

function ProviderCard({ icon, title, tool, hint, config, onToggle, onPatch, showEndpoint }: CardProps) {
  const t = useT()
  const [fetching, setFetching] = useState(false)
  const [fetchMsg, setFetchMsg] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const listId = `gen-models-${tool}`

  // 拉取端点模型清单（OpenAI 兼容 GET /models；生成端点通常同源提供）
  const discoverModels = async () => {
    if (!config.baseURL || !config.apiKey) {
      setFetchMsg(t('settings.genNeedUrlKey'))
      return
    }
    setFetching(true)
    setFetchMsg(null)
    try {
      const base = config.baseURL.trim().replace(/\/+$/, '')
      const res = await fetch(`${base}/models`, {
        headers: { Authorization: `Bearer ${config.apiKey}` }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ id?: string }> }
      const ids = (data.data ?? data.models ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length === 0) throw new Error(t('settings.genEmptyList'))
      setModels(ids)
      setFetchMsg(t('settings.genFoundModels', { n: ids.length }))
    } catch (err) {
      setModels([])
      setFetchMsg(t('settings.genFetchFail', { error: (err as Error).message }))
    } finally {
      setFetching(false)
    }
  }

  const inputCls =
    'w-full rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-body text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none'
  return (
    <section className="rounded-btn border border-border-subtle p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <div className="text-body font-medium text-fg-primary">{title}</div>
            <div className="text-[11px] text-fg-muted">
              {t('settings.genToolLabel')}<code className="rounded bg-bg-muted/50 px-1 text-[10px]">{tool}</code>
            </div>
          </div>
        </div>
        <button
          onClick={() => onToggle(!config.enabled)}
          role="switch"
          aria-checked={config.enabled}
          aria-label={tool}
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${config.enabled ? 'bg-accent' : 'bg-bg-muted'}`}
          title={config.enabled ? t('settings.genEnabledTitle', { tool }) : t('settings.genDisabledTitle', { tool })}
        >
          <span
            className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
              config.enabled ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <p className="mt-1 break-words text-caption text-fg-muted">{hint}</p>

      {config.enabled && (
        <div className="mt-3 space-y-2">
          <label className="block text-caption text-fg-secondary">
            {t('settings.genBaseUrlLabel')}
            <input
              type="text"
              value={config.baseURL}
              onChange={(e) => onPatch({ baseURL: e.target.value })}
              placeholder="https://api.xxx.com/v1"
              className={inputCls}
            />
          </label>
          <label className="block text-caption text-fg-secondary">
            API Key
            <input
              type="password"
              value={config.apiKey}
              onChange={(e) => onPatch({ apiKey: e.target.value })}
              placeholder="sk-..."
              className={inputCls}
            />
          </label>
          <label className="block text-caption text-fg-secondary">
            {t('settings.genModelLabel')}
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                list={listId}
                value={config.model}
                onChange={(e) => onPatch({ model: e.target.value })}
                placeholder={t('settings.genModelPlaceholder')}
                className={inputCls}
              />
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button
                onClick={() => void discoverModels()}
                disabled={fetching}
                className="flex shrink-0 items-center gap-1 rounded-btn border border-border-subtle bg-bg-elevated px-2.5 py-2 text-caption text-fg-secondary transition-all duration-150 hover:bg-bg-muted active:scale-95 disabled:opacity-50"
                title={t('settings.genFetchTitle')}
              >
                <RefreshCw size={11} className={fetching ? 'animate-spin' : ''} />
                {t('settings.genFetchBtn')}
              </button>
            </div>
          </label>
          {fetchMsg && <div className="text-[11px] text-fg-muted">{fetchMsg}</div>}
          {showEndpoint && (
            <label className="block text-caption text-fg-secondary">
              {t('settings.genEndpointLabel')}
              <input
                type="text"
                value={config.endpointPath ?? ''}
                onChange={(e) => onPatch({ endpointPath: e.target.value })}
                placeholder="videos / audio"
                className={inputCls}
              />
            </label>
          )}
        </div>
      )}
    </section>
  )
}