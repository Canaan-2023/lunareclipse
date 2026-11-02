/**
 * 为什么存在：AI 联网浏览需要复用本地浏览器登录态，CDP 接管是外部依赖且需检测/连接流程，
 * 独立成设置区便于单独管理与排障。
 * 作用：配置/检测本地调试端口浏览器（--remote-debugging-port），
 * 一键接管默认浏览器并展示连接结果与标签页数量。
 */
import { useCallback, useEffect, useState } from 'react'
import { Plug, Save, RefreshCw, Globe, Database, MapPin } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { useT } from '../../i18n/useT'

interface Props {
  config: AppConfig
  onChange: (next: AppConfig) => void
}

export function AiChatSection({ config, onChange }: Props) {
  const t = useT()
  const [cdpPort, setCdpPort] = useState(9222)
  const [cdpStatus, setCdpStatus] = useState<'unknown' | 'available' | 'unavailable'>('unknown')
  const [cdpLaunching, setCdpLaunching] = useState(false)
  const [cdpConnected, setCdpConnected] = useState(false)
  // 浏览器工具当前真实工作模式（跨会话持久态）：true=CDP 接管，false=无头快照（默认，可分发）
  const [cdpActive, setCdpActive] = useState<boolean | null>(null)
  const [statusMsg, setStatusMsg] = useState('')

  const checkCdp = useCallback(async () => {
    const res = await window.lunareclipse.browserCdpStatus(cdpPort)
    setCdpStatus(res.available ? 'available' : 'unavailable')
    if (res.available) setStatusMsg(t('settings.cdpDetected', { n: res.pageCount ?? 0 }))
    else setStatusMsg(t('settings.cdpNotFound'))
  }, [cdpPort, t])

  useEffect(() => {
    void checkCdp()
    // 模式 B/持久态：打开即查询浏览器工具当前工作模式，覆盖“上次已接管、本次重置后仍处于 CDP 模式”的场景
    void window.lunareclipse.browserCdpMode().then((r) => setCdpActive(r.cdpMode))
  }, [checkCdp])

  const connectCdp = async () => {
    const res = await window.lunareclipse.browserCdpConnect(cdpPort)
    if (res.ok) {
      setCdpConnected(true)
      setCdpActive(true)
      setStatusMsg(t('settings.cdpConnectedMsg', { n: res.pageCount ?? 0 }))
    } else {
      setStatusMsg(`❌ ${res.error}`)
    }
  }

  // 一键接管默认浏览器：检测默认浏览器 → 调试端口启动（独立 profile）→ 自动 CDP 接管
  const launchCdp = async () => {
    setCdpLaunching(true)
    try {
      const res = await window.lunareclipse.browserCdpLaunch(cdpPort)
      if (res.ok) {
        setCdpConnected(true)
        setCdpActive(true)
        setStatusMsg(
          res.launched
            ? t('settings.cdpLaunched', { name: res.browserName ?? 'Edge/Chrome' })
            : t('settings.cdpTakeoverDone')
        )
        setCdpStatus('available')
      } else {
        setStatusMsg(`❌ ${res.error}`)
      }
    } finally {
      setCdpLaunching(false)
    }
  }

  const saveLogin = async () => {
    const res = await window.lunareclipse.browserSaveLoginState()
    if (res.ok) setStatusMsg(t('settings.loginSaved'))
    else setStatusMsg(`❌ ${res.error}`)
  }

  const clearLogin = async () => {
    // 破坏性操作护栏：清除会销毁已持久化的登录态 profile，浏览器工具后续需重新登录，
    // 且无恢复入口，先 confirm 再执行（项目清理类操作统一惯例）
    if (!confirm(t('settings.clearLoginConfirm'))) return
    try {
      const res = await window.lunareclipse.browserClearLoginState()
      // 原实现不检查 ok：IPC 失败也提示"已清除"，误导用户；失败必须如实反馈
      setStatusMsg(res.ok ? t('settings.clearLoginDone') : t('settings.clearLoginFail'))
    } catch (err) {
      setStatusMsg(`❌ ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return (
    <div className="space-y-4">
      {/* 浏览器配置 */}
      <section className="rounded-btn border border-border-subtle p-3">
        <div className="flex items-center gap-2">
          <Globe size={14} className="text-accent" />
          <h3 className="text-body font-medium text-fg-primary">{t('settings.tab.aiChat')}</h3>
        </div>
        <p className="mt-1 break-words text-caption text-fg-muted">
          {t('settings.browserIntro')}
        </p>

        {/* 浏览器打开方式：内置视图 vs 系统默认浏览器 */}
        <div className="mt-3 flex items-center justify-between rounded-btn border border-border-subtle bg-bg-base px-3 py-2">
          <div className="min-w-0">
            <div className="text-body text-fg-primary">{t('settings.browserSystemTitle')}</div>
            <div className="break-words text-caption text-fg-muted">
              {t('settings.browserSystemDesc')}
            </div>
          </div>
          <button
            onClick={() => onChange({ ...config, browser: { ...(config.browser ?? {}), useSystemBrowser: !(config.browser?.useSystemBrowser ?? false) } })}
            role="switch"
            aria-checked={config.browser?.useSystemBrowser ?? false}
            aria-label={t('settings.browserSystemAria')}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              config.browser?.useSystemBrowser ? 'bg-accent' : 'bg-bg-muted'
            }`}
            title={config.browser?.useSystemBrowser ? t('settings.browserSystemOnTip') : t('settings.browserSystemOffTip')}
          >
            <span
              className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                config.browser?.useSystemBrowser ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* 内置浏览器定位策略：默认拒绝外部网页获取系统定位，用户显式开启后才放行（隐私红线） */}
        <div className="mt-3 flex items-center justify-between rounded-btn border border-border-subtle bg-bg-base px-3 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-body text-fg-primary">
              <MapPin size={12} className="text-accent" />
              {t('settings.geoAllowTitle')}
            </div>
            <div className="break-words text-caption text-fg-muted">
              {t('settings.geoAllowDesc')}
            </div>
          </div>
          <button
            onClick={() =>
              onChange({
                ...config,
                browser: {
                  useSystemBrowser: config.browser?.useSystemBrowser ?? false,
                  ...(config.browser ?? {}),
                  geolocationPolicy: config.browser?.geolocationPolicy === 'allow' ? 'deny' : 'allow'
                }
              })
            }
            role="switch"
            aria-checked={config.browser?.geolocationPolicy === 'allow'}
            aria-label={t('settings.geoAllowTitle')}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              config.browser?.geolocationPolicy === 'allow' ? 'bg-accent' : 'bg-bg-muted'
            }`}
            title={
              config.browser?.geolocationPolicy === 'allow' ? t('settings.geoAllowDenyTip') : t('settings.geoAllowTip')
            }
          >
            <span
              className={`absolute left-[2px] top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                config.browser?.geolocationPolicy === 'allow' ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* CDP 连接 */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="text-caption text-fg-secondary">{t('settings.debugPort')}</label>
          <input
            type="number"
            value={cdpPort}
            onChange={(e) => setCdpPort(parseInt(e.target.value) || 9222)}
            className="w-20 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption text-fg-primary outline-none focus:border-accent"
          />
          <button
            onClick={() => void checkCdp()}
            className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[11px] text-fg-secondary hover:bg-bg-muted/70"
            title={t('settings.checkPortTip')}
          >
            <RefreshCw size={11} />
            {t('settings.checkBtn')}
          </button>
          <button
            onClick={() => void connectCdp()}
            className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
            title={t('settings.connectBrowserTip')}
          >
            <Plug size={11} />
            {t('settings.connectBrowser')}
          </button>
          <button
            onClick={() => void launchCdp()}
            disabled={cdpLaunching}
            className="flex items-center gap-1 rounded-btn bg-success/15 px-2 py-1 text-[11px] text-success hover:bg-success/25 disabled:opacity-50"
            title={t('settings.takeoverBrowserTip')}
          >
            <Plug size={11} />
            {cdpLaunching ? t('settings.launching') : t('settings.takeoverBrowser')}
          </button>
          <span className={`text-[11px] ${cdpStatus === 'available' ? 'text-success' : 'text-fg-muted'}`}>
            {cdpStatus === 'available' ? t('settings.portAvailable') : cdpStatus === 'unavailable' ? t('settings.portNoBrowser') : '…'}
          </span>
          {cdpConnected && <span className="text-[11px] text-success">{t('settings.connected')}</span>}
          {cdpActive !== null && (
            <span className={`text-[11px] ${cdpActive ? 'text-accent' : 'text-fg-muted'}`} title={t('settings.browserModeTip')}>
              {cdpActive ? t('settings.cdpActive') : t('settings.headlessMode')}
            </span>
          )}
        </div>
        <div className="mt-1 break-all rounded bg-bg-muted/50 px-2 py-1 font-mono text-[10px] text-fg-muted">
          {t('settings.launchCmd')}
        </div>

        {/* 登录态保存 */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void saveLogin()}
            className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
            title={t('settings.saveLoginTip')}
          >
            <Save size={11} />
            {t('settings.saveLogin')}
          </button>
          <button
            onClick={() => void clearLogin()}
            className="flex items-center gap-1 rounded-btn bg-danger/10 px-2 py-1 text-[11px] text-danger hover:bg-danger/20"
            title={t('settings.clearLoginTip')}
          >
            <Database size={11} />
            {t('settings.clearBtn')}
          </button>
          <span className="text-[11px] text-fg-muted">{t('settings.saveLoginHint')}</span>
        </div>

        {statusMsg && <div className="mt-2 text-[11px] text-fg-muted">{statusMsg}</div>}
      </section>
    </div>
  )
}
