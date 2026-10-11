/**
 * 为什么存在：AI 联网浏览需要复用本地浏览器登录态，CDP 接管是外部依赖且需检测/连接流程，
 * 独立成设置区便于单独管理与排障。
 * 作用：配置/检测本地调试端口浏览器（--remote-debugging-port），
 * 一键接管默认浏览器并展示连接结果与标签页数量。
 */
import { useCallback, useEffect, useState } from 'react'
import { Plug, Save, RefreshCw, Globe, Database, MapPin } from 'lucide-react'
import type { AppConfig } from '@shared/types'

interface Props {
  config: AppConfig
  onChange: (next: AppConfig) => void
}

export function AiChatSection({ config, onChange }: Props) {
  const [cdpPort, setCdpPort] = useState(9222)
  const [cdpStatus, setCdpStatus] = useState<'unknown' | 'available' | 'unavailable'>('unknown')
  const [cdpLaunching, setCdpLaunching] = useState(false)
  const [cdpConnected, setCdpConnected] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')

  const checkCdp = useCallback(async () => {
    const res = await window.lunareclipse.browserCdpStatus(cdpPort)
    setCdpStatus(res.available ? 'available' : 'unavailable')
    if (res.available) setStatusMsg(`✅ 检测到本地浏览器（${res.pageCount ?? 0} 个标签页），可连接复用登录态`)
    else setStatusMsg('⚠️ 未检测到调试端口浏览器。用 `--remote-debugging-port=9222` 启动 Edge/Chrome 后可连接')
  }, [cdpPort])

  useEffect(() => {
    void checkCdp()
  }, [checkCdp])

  const connectCdp = async () => {
    const res = await window.lunareclipse.browserCdpConnect(cdpPort)
    if (res.ok) {
      setCdpConnected(true)
      setStatusMsg(`✅ 已连接本地浏览器（${res.pageCount ?? 0} 个标签页），浏览器工具将使用其登录会话`)
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
        setStatusMsg(
          res.launched
            ? `✅ 已启动并接管默认浏览器（${res.browserName ?? 'Edge/Chrome'}），登录会话已复用`
            : '✅ 已连接本地浏览器（端口已有浏览器，直接接管）'
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
    if (res.ok) setStatusMsg('✅ 登录态已保存（持久化 profile），浏览器工具可复用')
    else setStatusMsg(`❌ ${res.error}`)
  }

  const clearLogin = async () => {
    // 破坏性操作护栏：清除会销毁已持久化的登录态 profile，浏览器工具后续需重新登录，
    // 且无恢复入口，先 confirm 再执行（项目清理类操作统一惯例）
    if (!confirm('清除持久化登录态后，浏览器工具将需要重新登录。确定清除？')) return
    try {
      const res = await window.lunareclipse.browserClearLoginState()
      // 原实现不检查 ok：IPC 失败也提示"已清除"，误导用户；失败必须如实反馈
      setStatusMsg(res.ok ? '已清除持久化登录态' : '清除登录态失败，请查看日志')
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
          <h3 className="text-body font-medium text-fg-primary">浏览器配置</h3>
        </div>
        <p className="mt-1 break-words text-caption text-fg-muted">
          浏览器工具接入配置：无头（AI 快照看页面，默认，可分发）与真实系统浏览器（复用登录态）二选一。
        </p>

        {/* 浏览器打开方式：内置视图 vs 系统默认浏览器 */}
        <div className="mt-3 flex items-center justify-between rounded-btn border border-border-subtle bg-bg-base px-3 py-2">
          <div className="min-w-0">
            <div className="text-body text-fg-primary">用系统默认浏览器打开网页</div>
            <div className="break-words text-caption text-fg-muted">
              开启后弃用内置浏览器面板，AI 导航/外链一律转到系统默认浏览器（无法注入/点击/截图，仅外开）
            </div>
          </div>
          <button
            onClick={() => onChange({ ...config, browser: { ...(config.browser ?? {}), useSystemBrowser: !(config.browser?.useSystemBrowser ?? false) } })}
            role="switch"
            aria-checked={config.browser?.useSystemBrowser ?? false}
            aria-label="使用系统默认浏览器"
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              config.browser?.useSystemBrowser ? 'bg-accent' : 'bg-bg-muted'
            }`}
            title={config.browser?.useSystemBrowser ? '点击改回内置浏览器' : '点击切到系统默认浏览器'}
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
              允许外部网页获取系统定位
            </div>
            <div className="break-words text-caption text-fg-muted">
              关闭（默认）：内置浏览器里打开的普通网页一律拒绝 geolocation，拿不到你的系统定位；
              开启后放行（仍需网站自己的授权流程）。主页、受信本地窗口不依赖此开关，能力不受影响
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
            aria-label="允许外部网页获取系统定位"
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              config.browser?.geolocationPolicy === 'allow' ? 'bg-accent' : 'bg-bg-muted'
            }`}
            title={
              config.browser?.geolocationPolicy === 'allow' ? '点击改回默认拒绝' : '点击允许外部网页获取系统定位'
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
          <label className="text-caption text-fg-secondary">调试端口</label>
          <input
            type="number"
            value={cdpPort}
            onChange={(e) => setCdpPort(parseInt(e.target.value) || 9222)}
            className="w-20 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-caption text-fg-primary outline-none focus:border-accent"
          />
          <button
            onClick={() => void checkCdp()}
            className="flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[11px] text-fg-secondary hover:bg-bg-muted/70"
            title="检测调试端口"
          >
            <RefreshCw size={11} />
            检测
          </button>
          <button
            onClick={() => void connectCdp()}
            className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
            title="连接调试模式浏览器（复用已登录会话）"
          >
            <Plug size={11} />
            连接本地浏览器
          </button>
          <button
            onClick={() => void launchCdp()}
            disabled={cdpLaunching}
            className="flex items-center gap-1 rounded-btn bg-success/15 px-2 py-1 text-[11px] text-success hover:bg-success/25 disabled:opacity-50"
            title="一键接管默认浏览器：自动检测默认浏览器 → 调试端口启动（独立 profile）→ 连接复用登录态"
          >
            <Plug size={11} />
            {cdpLaunching ? '启动中…' : '一键接管默认浏览器'}
          </button>
          <span className={`text-[11px] ${cdpStatus === 'available' ? 'text-success' : 'text-fg-muted'}`}>
            {cdpStatus === 'available' ? '● 端口可用' : cdpStatus === 'unavailable' ? '○ 端口无浏览器' : '…'}
          </span>
          {cdpConnected && <span className="text-[11px] text-success">已连接</span>}
        </div>
        <div className="mt-1 break-all rounded bg-bg-muted/50 px-2 py-1 font-mono text-[10px] text-fg-muted">
          启动命令：&quot;Edge/Chrome 路径&quot; --remote-debugging-port=9222
        </div>

        {/* 登录态保存 */}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void saveLogin()}
            className="flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent hover:bg-accent/25"
            title="保存当前浏览器登录态（持久化 profile）"
          >
            <Save size={11} />
            保存登录态
          </button>
          <button
            onClick={() => void clearLogin()}
            className="flex items-center gap-1 rounded-btn bg-danger/10 px-2 py-1 text-[11px] text-danger hover:bg-danger/20"
            title="清除持久化登录态"
          >
            <Database size={11} />
            清除
          </button>
          <span className="text-[11px] text-fg-muted">保存后浏览器工具自动复用登录态</span>
        </div>

        {statusMsg && <div className="mt-2 text-[11px] text-fg-muted">{statusMsg}</div>}
      </section>
    </div>
  )
}
