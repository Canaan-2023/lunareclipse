/**
 * 为什么存在：系统健康检查（typecheck/test/lint 等）结果需要集中查看并对比历史，
 * 独立 Tab 承载（批次 E-5c 拆分产物）。
 * 作用：渲染健康检查 Tab——检查项列表/状态展示、重跑检查与历史对比视图。
 */
import { useState } from 'react'
import { RefreshCw, ShieldCheck, Activity, History } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import type { HealthCheckItemStatus, VisualizationData } from '@shared/types'
import { SectionTitle, EmptyHint } from './common'
import { formatDateTime } from '../../utils/time'
import { useT } from '../../i18n/useT'

/** 健康检查 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */

const CHECK_LABEL_KEYS: Record<string, string> = {
  typecheck: 'vizui.health.check.typecheck',
  test: 'vizui.health.check.test',
  lint: 'vizui.health.check.lint',
  build: 'vizui.health.check.build',
  files: 'vizui.health.check.files',
  'code-review': 'vizui.health.check.codeReview',
  uiux: 'vizui.health.check.uiux',
  safety: 'vizui.health.check.safety'
}

/** 工作区代码健康状态：来自主进程 HealthCheck 模块内存态快照（viz:getAll 附带） */
export function HealthTab({ data }: { data: VisualizationData | null }) {
  const t = useT()
  const loading = useAppStore((s) => s.visualizationLoading)
  const hc = data?.healthCheck ?? null

  if (!hc) {
    return (
      <div className="space-y-5">
        <SectionTitle icon={ShieldCheck} title={t('vizui.health.title')} />
        <EmptyHint text={t('vizui.health.notInit')} />
      </div>
    )
  }

  if (!hc.available) {
    return (
      <div className="space-y-5">
        <SectionTitle icon={ShieldCheck} title={t('vizui.health.title')} />
        <EmptyHint text={t('vizui.health.moduleUnavailable')} />
      </div>
    )
  }

  const runCheck = () => void useAppStore.getState().healthCheckRun()
  const resetAlerts = () => void useAppStore.getState().healthCheckReset()
  const busy = loading || hc.running
  const unavailable = hc.checks.filter((c) => c.outcome === 'unavailable').length
  const failed = hc.checks.filter((c) => c.outcome === 'fail' || c.outcome === 'error' || c.outcome === 'timeout').length

  // 总状态卡片
  const overall =
    !hc.enabled
      ? { label: t('vizui.health.status.disabled'), dot: 'bg-fg-muted/50', desc: t('vizui.health.desc.disabled') }
      : hc.overallOk === null
        ? { label: t('vizui.health.status.unchecked'), dot: 'bg-fg-muted', desc: t('vizui.health.desc.unchecked') }
        : failed > 0
          ? {
              label: t('vizui.health.status.failed'),
              dot: 'bg-danger',
              desc: t('vizui.health.desc.failed', { n: failed }) + (unavailable > 0 ? t('vizui.health.desc.failedExtra', { n: unavailable }) : '')
            }
          : unavailable > 0
            ? {
                label: t('vizui.health.status.partial'),
                dot: 'bg-warning',
                desc: t('vizui.health.desc.partial', { n: unavailable })
              }
            : { label: t('vizui.health.status.allPass'), dot: 'bg-success', desc: t('vizui.health.desc.allPass') }

  return (
    <div className="space-y-5">
      {/* 总状态 + 立即检查 */}
      <section>
        <SectionTitle icon={ShieldCheck} title={t('vizui.health.title')} />
        <div className="flex items-center gap-3 rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${overall.dot} ${hc.running ? 'animate-pulse' : ''}`} />
          <div className="flex-1">
            <div className="text-body font-medium text-fg-primary">{overall.label}</div>
            <div className="text-[10px] text-fg-muted">{overall.desc}</div>
          </div>
          {hc.enabled && (
            <>
              {(failed > 0 || hc.incomplete) && (
                <button
                  onClick={resetAlerts}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-btn border border-border-subtle px-2.5 py-1 text-caption text-fg-secondary hover:bg-bg-hover disabled:opacity-50"
                  title={t('vizui.health.resetTitle')}
                >
                  {t('vizui.health.reset')}
                </button>
              )}
              <button
                onClick={runCheck}
                disabled={busy}
                className="flex items-center gap-1 rounded-btn border border-accent/40 px-2.5 py-1 text-caption text-accent hover:bg-accent/10 disabled:opacity-50"
                title={t('vizui.health.runTitle')}
              >
                <RefreshCw size={11} className={busy ? 'animate-spin' : ''} />
                {busy ? t('vizui.health.checking') : t('vizui.health.run')}
              </button>
            </>
          )}
        </div>
        {/* 元信息 */}
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 px-1 text-[10px] text-fg-muted">
          <span>{t('vizui.health.interval', { n: hc.interval_minutes })}</span>
          {hc.lastRunAt ? (
            <span>{t('vizui.health.lastRun', { time: new Date(hc.lastRunAt).toLocaleString('zh-CN') })}</span>
          ) : (
            <span>{t('vizui.health.lastRunNever')}</span>
          )}
        </div>
        {/* 打包态说明：源码类检查依赖工作区源码与 devDependencies（分发包不含）。
            现在不再自动关闭这些检查项，而是逐项显示「无法执行 + 原因」——避免把缺材料伪装成通过 */}
        {hc.packaged && (
          <div className="mt-1.5 px-1 text-[10px] text-fg-muted">
            {t('vizui.health.packaged')}
          </div>
        )}
      </section>

      {/* 检查项列表 */}
      {hc.enabled && (
        <section>
          <SectionTitle icon={Activity} title={t('vizui.health.checksTitle', { n: hc.checks.length })} />
          <div className="space-y-1.5">
            {hc.checks.length === 0 ? (
              <EmptyHint text={t('vizui.health.noChecks')} />
            ) : (
              hc.checks.map((c) => <HealthCheckItem key={c.key} item={c} />)
            )}
          </div>
        </section>
      )}

      {/* 修复记录：AI 处理过程时间线（发现异常→修复→恢复全留痕） */}
      {hc.repairLog && hc.repairLog.length > 0 && (
        <section>
          <SectionTitle icon={History} title={t('vizui.health.repairTitle', { n: hc.repairLog.length })} />
          <div className="space-y-1.5">
            {hc.repairLog.slice(0, 20).map((e, i) => {
              const kindCfg = {
                alert: { label: t('vizui.health.kind.alert'), cls: 'text-danger border-danger/40' },
                recovered: { label: t('vizui.health.kind.recovered'), cls: 'text-success border-success/40' },
                unavailable: { label: t('vizui.health.kind.unavailable'), cls: 'text-warning border-warning/40' }
              }[e.kind] ?? { label: e.kind, cls: 'text-fg-muted border-border-subtle' }
              return (
                <div key={`${e.time}-${i}`} className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] ${kindCfg.cls}`}>{kindCfg.label}</span>
                    <span className="flex-1 text-caption text-fg-primary">{t(CHECK_LABEL_KEYS[e.key] ?? e.key)}</span>
                    <span className="shrink-0 text-[10px] text-fg-muted">{new Date(e.time).toLocaleString('zh-CN')}</span>
                  </div>
                  {e.detail && (
                    <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-all font-mono text-[10px] text-fg-secondary">{e.detail}</div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="mt-1 px-1 text-[10px] text-fg-muted">{t('vizui.health.repairNote')}</div>
        </section>
      )}
    </div>
  )
}

function HealthCheckItem({ item }: { item: HealthCheckItemStatus }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const label = item.label || t(CHECK_LABEL_KEYS[item.key] ?? item.key)
  const hasDetail = item.output.length > 0 || item.reason.length > 0
  // 四态：null=尚未检查 / pass / fail|error|timeout / unavailable（无法执行不是通过，也不是业务失败）
  const okState =
    item.outcome === 'pass'
      ? { dot: 'bg-success', text: t('vizui.health.outcome.pass'), cls: 'border-border-subtle bg-bg-elevated' }
      : item.outcome === 'unavailable'
        ? { dot: 'bg-warning', text: t('vizui.health.outcome.unavailable'), cls: 'border-warning/40 bg-warning/5' }
        : item.outcome === 'error'
          ? { dot: 'bg-danger', text: t('vizui.health.outcome.error'), cls: 'border-danger/40 bg-danger/5' }
          : item.outcome === 'timeout'
            ? { dot: 'bg-danger', text: t('vizui.health.outcome.timeout'), cls: 'border-danger/40 bg-danger/5' }
            : item.outcome === 'fail'
              ? { dot: 'bg-danger', text: t('vizui.health.outcome.fail'), cls: 'border-danger/40 bg-danger/5' }
              : { dot: 'bg-fg-muted/40', text: t('vizui.health.outcome.unchecked'), cls: 'border-border-subtle bg-bg-elevated' }
  return (
    <div className={`rounded-btn border px-3 py-2 ${okState.cls}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${okState.dot}`} />
        <span className="flex-1 text-caption text-fg-primary">{label}</span>
        <span className="text-[10px] text-fg-muted">{okState.text}</span>
        {item.checkedAt && (
          <span className="shrink-0 text-[10px] text-fg-muted">
            {formatDateTime(item.checkedAt)}
          </span>
        )}
      </div>
      {hasDetail && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-1 w-full text-left">
          <div
            className={`whitespace-pre-wrap break-all font-mono text-[10px] ${
              item.outcome === 'unavailable' ? 'text-warning' : 'text-danger'
            } ${expanded ? '' : 'line-clamp-2'}`}
          >
            {item.reason || item.output}
          </div>
          <div className="mt-0.5 text-[9px] text-fg-muted">{expanded ? t('vizui.health.collapse') : t('vizui.health.expand')}</div>
        </button>
      )}
    </div>
  )
}