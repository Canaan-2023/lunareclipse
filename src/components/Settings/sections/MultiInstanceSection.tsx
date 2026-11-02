/**
 * 为什么存在：主/分系统是分布式部署的高级场景（多设备协同），
 * 接入信息与已接入状态不占全局设置保存，独立配置区承载。
 * 作用：渲染多实例设置区——主系统接入链接（baseUrl/inviteCode）展示/复制/轮换，
 * 分系统已接入信息展示与密钥/用户名查看。
 */
import { useState, useEffect } from 'react'
import { Copy, Check, RotateCcw, Share2, Network, MonitorSmartphone, Server } from 'lucide-react'
import { useT } from '../../../i18n/useT'
import { useTransientTimer } from '../../../hooks/useTransientTimer'
import { copyText } from '../../../utils/clipboard'

interface JoinInfo {
  baseUrl: string
  code: string
  link: string
}

interface InstanceStatus {
  role: 'standalone' | 'master' | 'satellite'
  master: { baseUrl: string; instanceId: string } | null
}

const ROLE_BADGE: Record<InstanceStatus['role'], { labelKey: string; cls: string }> = {
  master: { labelKey: 'settings.multi.roleMaster', cls: 'border-accent/40 bg-accent/10 text-accent' },
  satellite: { labelKey: 'settings.multi.roleSatellite', cls: 'border-success/30 bg-success/10 text-success' },
  standalone: { labelKey: 'settings.multi.roleStandalone', cls: 'border-border-subtle bg-bg-elevated text-fg-muted' }
}

/**
 * 主/分系统区块：
 * - master：展示接入链接（复制/轮换），分系统凭此链接注册
 * - satellite：展示已接入的主系统
 * - standalone：引导注册主系统账号
 */
export function MultiInstanceSection() {
  const t = useT()
  const [status, setStatus] = useState<InstanceStatus | null>(null)
  const [info, setInfo] = useState<JoinInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  // 「复制成功」提示「1.5 秒后自动消失」的计时器句柄（卸载清理 + 重复调度先取消）
  const { schedule: scheduleCopiedClear } = useTransientTimer()

  const refresh = async () => {
    const s = await window.lunareclipse.multiGetStatus()
    setStatus(s)
    const j = await window.lunareclipse.multiGetJoinInfo()
    if (j.ok && j.link && j.code && j.baseUrl) setInfo({ baseUrl: j.baseUrl, code: j.code, link: j.link })
    else setInfo(null)
  }

  useEffect(() => {
    refresh()
  }, [])

  const copy = async () => {
    if (!info) return
    const ok = await copyText(info.link)
    if (ok) {
      setCopied(true)
      scheduleCopiedClear(() => setCopied(false), 1500)
    } else {
      setMsg(t('settings.multi.copyFail'))
    }
  }

  const rotate = async () => {
    if (!confirmRotate) {
      setConfirmRotate(true)
      return
    }
    setConfirmRotate(false)
    const r = await window.lunareclipse.multiRotateJoinCode()
    if (r.ok && r.link) {
      setInfo({ baseUrl: info?.baseUrl ?? '', code: r.code ?? '', link: r.link })
      setMsg(t('settings.multi.rotated'))
    } else {
      setMsg(r.error ?? t('settings.multi.rotateFail'))
    }
  }

  const resetToStandalone = async () => {
    const r = await window.lunareclipse.multiResetRole()
    if (r.ok) {
      setMsg(t('settings.multi.backToStandalone'))
      await refresh()
    } else {
      setMsg(r.error ?? t('settings.multi.backFail'))
    }
  }

  const role = status?.role

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Network size={12} />
          <span>{t('settings.multi.title')}</span>
        </div>

        {/* 当前角色 */}
        <div className="mb-3 flex items-center gap-2">
          {role && (
            <span className={`rounded-full border px-2.5 py-1 text-[11px] ${ROLE_BADGE[role].cls}`}>
              {t(ROLE_BADGE[role].labelKey)}
            </span>
          )}
          {role === 'satellite' && status?.master && (
            <span className="text-[11px] text-fg-muted">{t('settings.multi.joinedTo', { url: status.master.baseUrl })}</span>
          )}
        </div>

        {/* 主系统：接入链接 */}
        {role === 'master' && (
          <div className="rounded-btn border border-border-subtle bg-bg-elevated p-3">
            {info ? (
              <div className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 text-body text-fg-primary">
                    <Share2 size={14} className="text-accent" />
                    <span>{t('settings.multi.joinLink')}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={copy}
                      className="flex items-center gap-1 rounded-btn border border-border-subtle px-2 py-1 text-[11px] text-fg-muted transition-all duration-150 hover:border-accent/40 hover:text-accent active:scale-95"
                    >
                      {copied ? <Check size={11} className="text-success" /> : <Copy size={11} />}
                      {copied ? t('settings.multi.copied') : t('settings.multi.copy')}
                    </button>
                    <button
                      onClick={rotate}
                      className={`flex items-center gap-1 rounded-btn border px-2 py-1 text-[11px] transition-all duration-150 active:scale-95 ${
                        confirmRotate
                          ? 'border-danger/40 bg-danger/10 text-danger'
                          : 'border-border-subtle text-fg-muted hover:border-warning/40 hover:text-warning'
                      }`}
                    >
                      <RotateCcw size={11} />
                      {confirmRotate ? t('settings.multi.confirmRotate') : t('settings.multi.rotate')}
                    </button>
                  </div>
                </div>

                <div className="rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">{t('settings.multi.link')}</div>
                  <div className="select-all break-all font-mono text-[11px] leading-relaxed text-fg-primary">{info.link}</div>
                </div>

                <div className="rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">{t('settings.multi.code')}</div>
                  <div className="font-mono text-sm tracking-[0.2em] text-accent">{info.code}</div>
                </div>

                <p className="text-[11px] leading-relaxed text-fg-muted">
                  {t('settings.multi.joinLinkHint')}
                </p>
              </div>
            ) : (
              <div className="text-[11px] text-fg-muted">{t('settings.multi.noCode')}</div>
            )}
          </div>
        )}

        {/* 分系统：接入信息 */}
        {role === 'satellite' && (
          <div className="rounded-btn border border-border-subtle bg-bg-elevated p-3">
            <div className="mb-2 flex items-center gap-2 text-body text-fg-primary">
              <MonitorSmartphone size={14} className="text-success" />
              {t('settings.multi.satelliteHint')}
            </div>
            {status?.master && (
              <div className="space-y-2">
                <div className="rounded-btn border border-border-subtle bg-bg-base/60 px-3 py-2 font-mono text-[11px] text-fg-primary">
                  {status.master.baseUrl}
                </div>
                <p className="text-[11px] leading-relaxed text-fg-muted">
                  {t('settings.multi.masterManaged')}
                </p>
              </div>
            )}
            {!status?.master?.instanceId && (
              <button
                onClick={resetToStandalone}
                className="mt-3 flex items-center gap-1 text-[11px] text-fg-muted/70 transition-all duration-150 hover:text-danger active:scale-95"
              >
                <RotateCcw size={11} />
                {t('settings.multi.leaveStandalone')}
              </button>
            )}
          </div>
        )}

        {/* 单机：引导 */}
        {role === 'standalone' && (
          <div className="rounded-btn border border-border-subtle bg-bg-elevated p-3">
            <div className="mb-2 flex items-center gap-2 text-body text-fg-primary">
              <Server size={14} />
              {t('settings.multi.standaloneHint')}
            </div>
            <p className="text-[11px] leading-relaxed text-fg-muted">
              {t('settings.multi.standaloneGuide')}
            </p>
          </div>
        )}

        {msg && (
          <div className="mt-3 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 text-[11px] text-fg-muted">
            {msg}
          </div>
        )}
      </section>
    </div>
  )
}