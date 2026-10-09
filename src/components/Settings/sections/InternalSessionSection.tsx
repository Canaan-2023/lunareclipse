/**
 * 为什么存在：内部会话存储（双层会话 v11）走独立的 MonitorConfig 通道且含
 * 只读上限说明，独立设置区避免与 AppConfig 保存互相影响。
 * 作用：渲染内部会话存储设置区——summaryBudgetChars 与 routePreviewTurnPairs
 * 可编辑即时写入、userShardMaxBytes 只读说明与错误回显。
 */
import { useState, useEffect } from 'react'
import { Database } from 'lucide-react'
import type { MonitorConfig } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'

/**
 * 内部会话存储（双层会话）
 * - 独立的 MonitorConfig 通道（dmn:config:get/update），与 AppConfig 保存互不影响
 * - summaryBudgetChars 可编辑：改动即时写入（后端 updateConfig 深合并 sessionSummary）
 * - routePreviewTurnPairs 可编辑：路由前用户界面会话预览对数（0=关闭，见 buildUiHistoryPreview）
 * - userShardMaxBytes 只读说明：500K 分片上限为代码内常量，防止误改导致分片行为异常
 */
export function InternalSessionConfigSection() {
  const t = useT()
  const [sessionSummaryCfg, setSessionSummaryCfg] = useState<MonitorConfig['sessionSummary'] | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cfg = await window.lunareclipse.dmnGetConfig()
        if (!cancelled && cfg?.sessionSummary) setSessionSummaryCfg(cfg.sessionSummary)
      } catch {
        // 拉取失败保持 null，展示"未加载"提示
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const applySessionSummary = async (patch: Partial<NonNullable<MonitorConfig['sessionSummary']>>) => {
    if (!sessionSummaryCfg) return
    const next = { ...sessionSummaryCfg, ...patch }
    setSessionSummaryCfg(next)
    setSaveState('idle')
    setErrorMsg(null)
    try {
      await window.lunareclipse.dmnUpdateConfig({ sessionSummary: next })
      setSaveState('saved')
    } catch (err) {
      setSaveState('error')
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section>
      <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
        <Database size={12} />
        <span>{t('settings.internalSessionBudget')}</span>
      </div>
      <div className="rounded-btn border border-border-subtle bg-bg-elevated p-3 space-y-3">
        <div className="text-caption text-fg-muted">
          {t('settings.internalSessionBudgetDesc')}
        </div>
        {!sessionSummaryCfg ? (
          <div className="text-caption text-fg-muted">…</div>
        ) : (
          <>
            <Field label={t('settings.summaryBudgetChars')}>
              <input
                type="number"
                min="0"
                step="10000"
                value={sessionSummaryCfg.summaryBudgetChars ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  void applySessionSummary({ summaryBudgetChars: Number(v) })
                }}
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
              />
              <div className="mt-1 text-caption text-fg-muted">
                {t('settings.summaryBudgetCharsDesc')}
                {saveState === 'saved' && <span className="ml-2 text-accent">✓</span>}
                {saveState === 'error' && (
                  <span className="ml-2 text-red-400" title={errorMsg ?? ''}>✗</span>
                )}
              </div>
            </Field>
            <Field label={t('settings.routePreviewTurnPairs')}>
              <input
                type="number"
                min="0"
                step="1"
                value={sessionSummaryCfg.routePreviewTurnPairs ?? 4}
                onChange={(e) => {
                  const v = e.target.value
                  if (!v) return
                  void applySessionSummary({ routePreviewTurnPairs: Math.max(0, Math.floor(Number(v))) })
                }}
                className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
              />
              <div className="mt-1 text-caption text-fg-muted">
                {t('settings.routePreviewTurnPairsDesc')}
                {saveState === 'saved' && <span className="ml-2 text-accent">✓</span>}
                {saveState === 'error' && (
                  <span className="ml-2 text-red-400" title={errorMsg ?? ''}>✗</span>
                )}
              </div>
            </Field>
            <div className="flex items-center justify-between rounded-btn border border-border-subtle bg-bg-base px-3 py-2.5">
              <div>
                <div className="text-body text-fg-primary">{t('settings.userShardMaxBytes')}</div>
                <div className="text-caption text-fg-muted">
                  {t('settings.userShardMaxBytesDesc', { n: sessionSummaryCfg.userShardMaxBytes })}
                </div>
              </div>
              <span className="text-caption text-fg-muted">
                {(sessionSummaryCfg.userShardMaxBytes / 1024).toLocaleString()} KB
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}