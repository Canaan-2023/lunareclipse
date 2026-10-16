/**
 * 为什么存在：莉莉丝是独立于主 AI 的游戏联动智能体，其联机配置
 * （游戏路径/自启/模式/工具策略）与主配置并存但语义不同，独立成设置区。
 * 作用：渲染莉莉丝设置区——游戏路径配置与自启、接入模式/persona 选择、
 * Lilith 工具策略（DMN 工具配置复用）与状态保存。
 */
import { useState, useEffect } from 'react'
import { Check, Search, Rocket, CircleDot } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { getLilithTools, mergeLilithToolPolicy } from '@shared/tools/registry'
import { StatusRow } from '../StatusRow'
import { DmnToolConfig } from '../DmnToolConfig'
import { useT } from '../../../i18n/useT'

interface LilithStatusView {
  gamePath: string
  gameExists: boolean
  modExists: boolean
  gameRunning: boolean
  companionRunning: boolean
  companionPort?: number
  modValid: boolean
}

export function LilithConnectSection({ config, onChange }: { config: AppConfig; onChange: (c: AppConfig) => void }) {
  const t = useT()
  const [path, setPath] = useState(config.lilith?.gamePath ?? '')
  const [autoStart, setAutoStart] = useState(config.lilith?.autoStart ?? false)
  const [detecting, setDetecting] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [status, setStatus] = useState<LilithStatusView | null>(null)

  // 莉莉丝总开关（缺省视为 true）
  const enabled = config.lilith?.enabled !== false

  // 同步回 local：路径/开关每次变更都写进 local.lilith，保证全局「保存设置」不会用旧值覆盖。
  // 之前只走 lilith:save IPC 直写磁盘，local 一直是初始空值 → 用户点「保存连接」后再点全局保存，
  // 磁盘刚写入的 gamePath 被空值覆盖（持久化丢失）。现在双通道一致。
  const syncLocal = (next: { gamePath?: string; autoStart?: boolean; enabled?: boolean }) => {
    onChange({
      ...config,
      lilith: {
        // 展开式合并：不能只写 gamePath/autoStart——
        // lilith 还有 mode/persona/toolPolicy/useAdapter，砍字段会让全局保存清空高级配置
        ...(config.lilith ?? { gamePath: '', autoStart: false }),
        gamePath: next.gamePath ?? path,
        autoStart: next.autoStart ?? autoStart,
        enabled: next.enabled ?? (config.lilith?.enabled !== false)
      },
    })
  }

  const refreshStatus = async () => {
    const s = await window.lunareclipse?.lilithStatus?.()
    if (s) setStatus(s)
  }

  useEffect(() => {
    refreshStatus()
    const t = setInterval(refreshStatus, 5000)
    return () => clearInterval(t)
  }, [])

  const handleDetect = async () => {
    setDetecting(true)
    setMsg(null)
    const r = await window.lunareclipse?.lilithDetect?.()
    setDetecting(false)
    if (r?.found) {
      setPath(r.dir)
      syncLocal({ gamePath: r.dir })
      setMsg(r.hasMod ? t('settings.lilithDetectFoundMod', { dir: r.dir }) : t('settings.lilithDetectFoundNoMod', { dir: r.dir }))
      refreshStatus()
    } else {
      setMsg(t('settings.lilithDetectNotFound'))
    }
  }

  const handleSave = async () => {
    // 保存连接：连同总开关/人设一起落盘（lilith:save 已扩展支持 enabled/persona 等字段）
    const r = await window.lunareclipse?.lilithSave?.({
      gamePath: path,
      autoStart,
      enabled: config.lilith?.enabled !== false,
      persona: config.lilith?.persona ?? ''
    })
    if (r?.ok) {
      syncLocal({ gamePath: path, autoStart })
      setMsg(t('settings.lilithSaveOk') + (autoStart ? t('settings.lilithSaveOkAutoStart') : t('settings.lilithSaveOkNoAutoStart')))
      refreshStatus()
    } else {
      setMsg(t('settings.lilithSaveFail', { error: r?.error ?? t('settings.lilithUnknownError') }))
    }
  }

  // 总开关：点击立即持久化（enabled 走 lilith:save），不只改 local——
  // 原实现 syncLocal 只写面板 local state，不点全局「保存设置」就不落盘，开关看起来没响应
  const toggleEnabled = () => {
    const next = !enabled
    syncLocal({ enabled: next })
    void window.lunareclipse?.lilithSave?.({ enabled: next })
  }

  // 人设提示词：输入即可用（lilith 接入时注入），离开 textarea 时立即持久化
  const handlePersonaBlur = () => {
    void window.lunareclipse?.lilithSave?.({ persona: config.lilith?.persona ?? '' })
  }

  const handleLaunch = async () => {
    setLaunching(true)
    setMsg(null)
    const r = await window.lunareclipse?.lilithLaunch?.()
    setLaunching(false)
    if (r?.ok) {
      setMsg(r.alreadyRunning ? t('settings.lilithAlreadyRunning') : t('settings.lilithLaunchOk'))
      refreshStatus()
    } else {
      setMsg(t('settings.lilithLaunchFail', { error: r?.error ?? t('settings.lilithUnknownError') }))
    }
  }

  const ok = status?.gameExists && status?.modExists

  return (
    <div className="space-y-5">
      {/* 总开关 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithEnable')}</div>
        <div className="flex items-center justify-between rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
          <div>
            <div className="text-body text-fg-primary">{t('settings.lilithEnableLabel')}</div>
            <div className="text-caption text-fg-muted">
              {t('settings.lilithEnableDesc')}
            </div>
          </div>
          <button
            onClick={toggleEnabled}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              enabled ? 'bg-accent' : 'bg-bg-muted'
            }`}
            title={enabled ? t('settings.lilithClickDisable') : t('settings.lilithClickEnable')}
          >
            <span
              className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                enabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </section>

      {/* 路径配置 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithGamePath')}</div>
        <div className="space-y-2.5">
          <input
            type="text"
            value={path}
            onChange={(e) => {
              setPath(e.target.value)
              syncLocal({ gamePath: e.target.value })
            }}
            placeholder={t('settings.lilithPathPh')}
            className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleDetect}
              disabled={detecting}
              className="flex h-8 items-center gap-1.5 rounded-btn bg-bg-muted px-3 text-caption text-fg-secondary transition-all duration-150 hover:bg-accent/15 hover:text-accent active:scale-95 disabled:opacity-40"
            >
              <Search size={12} />
              {detecting ? t('settings.lilithDetecting') : t('settings.lilithAutoDetect')}
            </button>
            <button
              onClick={handleSave}
              className="flex h-8 items-center gap-1.5 rounded-btn bg-accent px-3 text-caption text-accent-fg transition-all duration-150 hover:bg-accent/80 active:scale-95"
            >
              <Check size={12} />
              {t('settings.lilithSaveConn')}
            </button>
            <button
              onClick={handleLaunch}
              disabled={launching || !ok}
              className="flex h-8 items-center gap-1.5 rounded-btn bg-bg-muted px-3 text-caption text-fg-secondary transition-all duration-150 hover:bg-accent/15 hover:text-accent active:scale-95 disabled:opacity-40"
            title={ok ? t('settings.lilithLaunchTitle') : t('settings.lilithLaunchDisabled')}
          >
            <Rocket size={12} />
            {launching ? t('settings.lilithLaunching') : t('settings.lilithLaunch')}
            </button>
          </div>
          {msg && <div className="text-[11px] text-fg-secondary leading-relaxed">{msg}</div>}
        </div>
      </section>

      {/* 自动启动开关 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithAutoStart')}</div>
        <label className="flex cursor-pointer items-start gap-2.5 rounded-btn border border-border-subtle bg-bg-base/40 px-3 py-2.5">
          <input
            type="checkbox"
            checked={autoStart}
            onChange={(e) => {
              setAutoStart(e.target.checked)
              syncLocal({ autoStart: e.target.checked })
            }}
            className="mt-0.5 accent-[var(--accent)]"
          />
          <span className="text-caption leading-relaxed text-fg-secondary">
            {t('settings.lilithAutoStartDesc')}（<span className="text-fg-muted">{t('settings.lilithAutoStartCond')}</span>）
          </span>
        </label>
      </section>

      {/* 连接状态 */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithConnStatus')}</div>
        <div className="space-y-1.5 rounded-btn border border-border-subtle bg-bg-base/40 px-3 py-2.5 text-caption">
          <StatusRow label={t('settings.lilithGameBody')} ok={status?.gameExists ?? false} okText={t('settings.lilithFound')} badText={t('settings.lilithNotFoundCfg')} />
          <StatusRow label={t('settings.lilithMod')} ok={status?.modExists ?? false} okText={t('settings.lilithComplete')} badText={t('settings.lilithMissing')} />
          <StatusRow label={t('settings.lilithGameProcess')} ok={status?.gameRunning ?? false} okText={t('settings.lilithRunning')} badText={t('settings.lilithNotRunning')} />
          <StatusRow label={t('settings.lilithCompanion')} ok={status?.companionRunning ?? false} okText={status?.companionPort ? t('settings.lilithOnlinePort', { port: status.companionPort }) : t('settings.lilithOnline')} badText={t('settings.lilithOffline')} />
          <div className="flex items-center gap-1.5 pt-1 text-[11px] text-fg-muted">
            <CircleDot size={10} />
            {t('settings.lilithConfigPath')}：
            <span className="truncate">{status?.gamePath || t('settings.lilithNotConfigured')}</span>
          </div>
        </div>
        <div className="mt-2 rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
          <div className="mb-1 font-medium text-fg-secondary">{t('settings.lilithAboutTitle')}</div>
          {t('settings.lilithAboutDesc')}
          {t('settings.lilithAboutDesc2')}
        </div>
      </section>

      {/* 莉莉丝模式（双模式：角色/全能，输出风格不变） */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithMode')}</div>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() =>
              onChange({ ...config, lilith: { ...(config.lilith ?? { gamePath: '', autoStart: false }), mode: 'character' } })
            }
            className={`rounded-btn border px-3 py-2.5 text-left transition-all ${
              (config.lilith?.mode ?? 'character') === 'character'
                ? 'border-accent bg-accent/10'
                : 'border-border-subtle bg-bg-base/40 hover:border-accent/40'
            }`}
          >
            <div className="text-caption font-medium text-fg-primary">{t('settings.lilithRoleMode')}</div>
            <div className="mt-1 text-[10px] text-fg-muted leading-relaxed">{t('settings.lilithRoleModeDesc')}</div>
          </button>
          <button
            onClick={() =>
              onChange({ ...config, lilith: { ...(config.lilith ?? { gamePath: '', autoStart: false }), mode: 'agent' } })
            }
            className={`rounded-btn border px-3 py-2.5 text-left transition-all ${
              config.lilith?.mode === 'agent'
                ? 'border-accent bg-accent/10'
                : 'border-border-subtle bg-bg-base/40 hover:border-accent/40'
            }`}
          >
            <div className="text-caption font-medium text-fg-primary">{t('settings.lilithOmniMode')}</div>
            <div className="mt-1 text-[10px] text-fg-muted leading-relaxed">{t('settings.lilithOmniModeDesc')}</div>
          </button>
        </div>
        <div className="mt-2 rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
          {t('settings.lilithOmniDesc')}
          {t('settings.lilithOmniDesc2')}
        </div>
      </section>

      {/* 莉莉丝人设（角色自我塑造——月蚀侧配置，最高优先级覆盖 MOD 原版） */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithPersona')}</div>
        <div className="space-y-2">
          <textarea
            value={config.lilith?.persona ?? ''}
            onChange={(e) =>
              onChange({ ...config, lilith: { ...(config.lilith ?? { gamePath: '', autoStart: false }), persona: e.target.value } })
            }
            onBlur={handlePersonaBlur}
            rows={8}
            placeholder={t('settings.lilithPersonaPh')}
            className="w-full resize-y rounded-btn border border-border bg-bg-elevated px-3 py-2 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent/50 focus:outline-none"
          />
          <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
            {t('settings.lilithPersonaHint')}
          </div>
        </div>
      </section>

      {/* 莉莉丝工具配置（工具可自己配置，与常规线路连通） */}
      <section>
        <div className="mb-3 text-caption uppercase tracking-wider text-fg-muted">{t('settings.lilithTools')}</div>
        <div className="space-y-2">
          <div className="rounded-btn bg-bg-muted/50 px-3 py-2 text-[11px] text-fg-muted leading-relaxed">
            {t('settings.lilithToolsDesc')}
          </div>
          <DmnToolConfig
            tools={getLilithTools()}
            policy={mergeLilithToolPolicy(config.lilith?.toolPolicy)}
            onChange={(toolPolicy) =>
              onChange({ ...config, lilith: { ...(config.lilith ?? { gamePath: '', autoStart: false }), toolPolicy } })
            }
          />
        </div>
      </section>
    </div>
  )
}



/** 消息接入状态（messaging:get 返回） */
