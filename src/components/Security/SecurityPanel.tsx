/**
 * 权限面板（**设置页与房间授权页共用的同一个组件**）。
 *
 * 为什么存在：用户 2026-10-19 指出「前端 UI 没有权限授予的入口，也就是说当前无法授予任何权限
 * （还得有一份权限授予，所造成的损失，用户需自行承担的协议，做到告知义务）」。此前 `security:*`
 * 的**主进程**通道自 ADR-11 就在，但渲染面整条缺席——于是「T1 默认关」事实上等于「永远关」。
 *
 * 为什么只有一个组件：授予界面必须**只有一份**。设置页一份、房间抽屉再写一份，两处必然漂移，
 * 而权限界面的漂移是产品责任问题（一处显示了条款、另一处没显示）。所以这里做成自包含组件，
 * 两个宿主各自挂载它，不各自实现。
 *
 * 结构（自上而下，顺序即用户该走的顺序）：
 * 1. **诚实边界**——未授予 T1 时 AI 能做什么；
 * 2. **告知义务**——条款正文（小节键由 `shared/security/notice.ts` 声明，文字在 i18n），
 *    确认前**授予按钮不可用**（门同时也在主进程：未确认时 `security:grant` 会被拒）；
 * 3. **T1 可授予项**（逐项授予 / 撤回；scoped 能力必须圈范围，范围字段由能力目录自述）；
 * 4. **T0 / T2 只读清单**——让用户看清「哪些永远开不了」「哪些本来就开着」；
 * 5. **审计尾部**——每次放行/拒绝、授予/撤回都落一行。
 *
 * 状态覆盖：加载中 / 读取失败（显示原因，不吞）/ 未确认 / 已确认 / 已确认但条款升版（要求重确认）/
 * 授予中 / 授予失败（显示主进程给的原因）。**状态不只靠颜色**：每项都同时有文字（已授予/未授予）。
 *
 * 不删理由：删掉即权限授予回到「改配置文件」，与「显式授予、可撤回、用户可见」直接冲突。
 */
import { useCallback, useEffect, useState } from 'react'
import type { AuditEntry, CapabilityDef, SecurityGrant } from '@shared/types'
import { T0_CAPABILITIES, T1_CAPABILITIES, T2_CAPABILITIES } from '@shared/security/tiers'
import { SECURITY_NOTICE_KEYS, SECURITY_NOTICE_VERSION } from '@shared/security/notice'
import { useT } from '../../i18n/useT'
import { ScopeEditor } from './ScopeEditor'
import { splitScopeLines } from './scope-input'

/** 审计尾部展示条数（够看清最近发生了什么，又不把 DOM 撑大） */
const AUDIT_TAIL = 50

/** 兼容既有 import：范围解析的唯一实现在 `./scope-input`（两个组件共用，避免循环依赖） */
export { splitScopeLines } from './scope-input'

/** 时间戳 → `YYYY-MM-DD HH:MM`（只依赖入参，不读当前时刻） */
export function formatStamp(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function GrantRow({
  cap,
  grant,
  disabled,
  busy,
  highlighted = false,
  scopeDraft,
  onScopeDraft,
  onGrant,
  onRevoke
}: {
  cap: CapabilityDef
  grant?: SecurityGrant
  disabled: boolean
  busy: boolean
  /** 从其它页面跳转过来时高亮这一项（例如采集器的「去权限页授予」→ t1.collector） */
  highlighted?: boolean
  scopeDraft: string
  onScopeDraft: (v: string) => void
  onGrant: () => void
  onRevoke: () => void
}) {
  const t = useT()
  const granted = grant !== undefined
  const needsScope = cap.scoped === true
  const canGrant = !disabled && !busy && (!needsScope || splitScopeLines(scopeDraft).length > 0)
  return (
    <li
      id={`security-cap-${cap.key}`}
      className={`rounded-card border-2 p-2.5 ${
        highlighted ? 'border-accent/60 bg-accent/5' : 'border-border-subtle bg-bg-surface'
      }`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[12px] text-fg-primary">{cap.title}</span>
            <span className="font-mono text-micro text-fg-muted">{cap.key}</span>
            {/* 状态不只靠颜色：文字同时写出来 */}
            <span className={`text-micro ${granted ? 'text-success' : 'text-fg-muted'}`}>
              {granted ? t('security.granted') : t('security.notGranted')}
            </span>
          </div>
          {cap.description && <div className="text-micro leading-5 text-fg-muted">{cap.description}</div>}
          {/* 授予后到底会发生什么——用一句人话讲清（0.53.1：用户「不知道填啥」的同类问题） */}
          {cap.usage && <div className="mt-0.5 text-micro leading-5 text-fg-secondary">{cap.usage}</div>}
          {granted && grant.grantedAt > 0 && (
            <div className="text-micro text-fg-muted">{formatStamp(grant.grantedAt)}</div>
          )}
        </div>
        {granted ? (
          <div className="flex shrink-0 flex-col items-stretch gap-1">
            {/* scoped 已授予：范围可改（重新授予即替换范围），不需要先撤回 */}
            {needsScope && (
              <button
                type="button"
                onClick={onGrant}
                disabled={!canGrant}
                className="rounded-btn bg-accent px-2 py-1 text-micro text-accent-fg disabled:opacity-40"
                aria-label={`${t('security.scope.update')}：${cap.title}`}
              >
                {t('security.scope.update')}
              </button>
            )}
            <button
              type="button"
              onClick={onRevoke}
              disabled={busy}
              className="rounded-btn border border-border-subtle px-2 py-1 text-micro text-fg-secondary disabled:opacity-40"
              aria-label={`${t('security.revoke')}：${cap.title}`}
            >
              {t('security.revoke')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={onGrant}
            disabled={!canGrant}
            className="shrink-0 rounded-btn bg-accent px-2 py-1 text-micro text-accent-fg disabled:opacity-40"
            aria-label={`${t('security.grant')}：${cap.title}`}
          >
            {t('security.grant')}
          </button>
        )}
      </div>

      {/* scoped 能力：范围编辑器（节点可勾选 / 地址可手填 + 示例）。授予与改范围共用同一份草稿。 */}
      {needsScope && <ScopeEditor cap={cap} value={scopeDraft} onChange={onScopeDraft} />}
    </li>
  )
}

function ReadOnlyList({ caps, tone }: { caps: readonly CapabilityDef[]; tone: string }) {
  const t = useT()
  return (
    <ul className="space-y-1.5">
      {caps.map((c) => (
        <li key={c.key} className="text-[11px] leading-5">
          <span className={`font-mono text-micro ${tone}`}>{c.key}</span>
          <span className="ml-1.5 text-fg-secondary">{c.title}</span>
          {c.description && <div className="text-micro text-fg-muted">{c.description}</div>}
          <div className="text-micro text-fg-muted">
            {c.tier === 'T0' ? t('security.group.t0') : t('security.group.t2')}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function SecurityPanel({ focusKey }: { focusKey?: string }) {
  const t = useT()
  const [grants, setGrants] = useState<Record<string, SecurityGrant>>({})
  const [ackVersion, setAckVersion] = useState<number | null>(null)
  const [ackAt, setAckAt] = useState<number | null>(null)
  const [noticeVersion, setNoticeVersion] = useState(SECURITY_NOTICE_VERSION)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  /**
   * 是否已从主进程读到**授予状态**。
   * 注意：能力目录是编译期常量（`@shared/security/tiers`），**不等取数就渲染**——
   * 一进来就能看见「有哪些能力、哪些永远开不了」，而不是先看一段空白。
   * 取数只决定两件事：确认态、每项是否已授予；**取数完成前授予按钮一律不可用**
   * （否则用户点了会被主进程以「未确认」拒绝，是更差的体验）。
   */
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const refreshAudit = useCallback(async () => {
    const a = await window.lunareclipse?.securityListAudit?.(AUDIT_TAIL)
    if (a?.ok) setAudit((a.entries ?? []) as AuditEntry[])
  }, [])

  const load = useCallback(async () => {
    try {
      const r = await window.lunareclipse?.securityListCapabilities?.()
      if (!r?.ok) {
        setLoadFailed(true)
        return
      }
      setGrants((r.grants ?? {}) as Record<string, SecurityGrant>)
      // 已授予的 scoped 能力：把当前范围回填进草稿，用户点「更新范围」时看到的是**现状**而不是空框
      const loaded = (r.grants ?? {}) as Record<string, SecurityGrant>
      setDrafts((prev) => {
        const next = { ...prev }
        for (const cap of T1_CAPABILITIES) {
          const field = cap.scopeField
          if (!field) continue
          const vals = loaded[cap.key]?.scope?.[field]
          if (vals && vals.length > 0) next[cap.key] = vals.join('\n')
        }
        return next
      })
      setNoticeVersion(r.noticeVersion ?? SECURITY_NOTICE_VERSION)
      setAckVersion(r.acknowledged ? (r.noticeVersion ?? SECURITY_NOTICE_VERSION) : null)
      setAckAt(r.acknowledgedAt ?? null)
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    void refreshAudit()
  }, [load, refreshAudit])

  // 从采集器 / 其它入口跳过来：把目标能力滚到视野中间并高亮（不做定时器）
  useEffect(() => {
    if (!focusKey) return
    document.getElementById(`security-cap-${focusKey}`)?.scrollIntoView({ block: 'center' })
  }, [focusKey])

  const acknowledged = loaded && ackVersion === noticeVersion

  const acknowledge = async (): Promise<void> => {
    setBusy('__ack__')
    setActionError(null)
    try {
      const r = await window.lunareclipse?.securityAcknowledge?.()
      if (!r?.ok) setActionError(r?.error ?? t('security.notice.confirmFailed'))
      else {
        setNoticeVersion(r.noticeVersion ?? SECURITY_NOTICE_VERSION)
        setAckVersion(r.noticeVersion ?? SECURITY_NOTICE_VERSION)
        setAckAt(Date.now())
      }
    } catch (err) {
      // 权限操作**不许静默失败**：IPC reject 也要让用户看见原因
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const grant = async (cap: CapabilityDef): Promise<void> => {
    setBusy(cap.key)
    setActionError(null)
    try {
      const lines = cap.scopeField ? splitScopeLines(drafts[cap.key] ?? '') : []
      const r = await window.lunareclipse?.securityGrant?.({
        key: cap.key,
        ...(cap.scopeField && lines.length > 0 ? { scope: { [cap.scopeField]: lines } } : {})
      })
      if (!r?.ok) setActionError(r?.error ?? t('security.grantFailed'))
      else {
        setGrants((r.grants ?? {}) as Record<string, SecurityGrant>)
        void refreshAudit()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (key: string): Promise<void> => {
    setBusy(key)
    setActionError(null)
    try {
      const r = await window.lunareclipse?.securityRevoke?.(key)
      if (!r?.ok) setActionError(r?.error ?? t('security.revokeFailed'))
      else {
        setGrants((r.grants ?? {}) as Record<string, SecurityGrant>)
        void refreshAudit()
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      {/* 诚实边界：未授予 T1 时 AI 能做什么（与房间里的那份同源同口径） */}
      <p className="rounded-card border-2 border-border-subtle bg-bg-surface p-2.5 text-[11px] leading-5 text-fg-secondary">
        {t('security.honest')}
      </p>

      {loadFailed && (
        <p className="text-[11px] text-danger" role="alert">
          {t('security.loadFailed')}
        </p>
      )}
      {actionError && (
        <p className="text-[11px] text-danger" role="alert">
          {actionError}
        </p>
      )}

      {/* ===== 告知义务 ===== */}
      <section className="rounded-card border-2 border-warning/40 bg-bg-surface p-2.5">
        <h3 className="text-[12px] text-fg-primary">{t('security.notice.title')}</h3>
        <p className="mt-0.5 text-micro text-fg-muted">{t('security.notice.lead')}</p>
        <div className="mt-2 space-y-1.5">
          {SECURITY_NOTICE_KEYS.map((k) => (
            <p key={k} className="text-[11px] leading-5 text-fg-secondary">
              {t(k)}
            </p>
          ))}
        </div>

        {!loaded ? (
          <p className="mt-2 text-micro text-fg-muted">{t('security.loading')}</p>
        ) : acknowledged ? (
          <p className="mt-2 text-micro text-success">
            {t('security.notice.confirmed')
              .replace('{time}', ackAt != null ? formatStamp(ackAt) : '—')
              .replace('{version}', String(noticeVersion))}
          </p>
        ) : (
          <div className="mt-2.5 space-y-2">
            <label className="flex items-start gap-2 text-[11px] leading-5 text-fg-secondary">
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
              />
              <span>{t('security.notice.ack')}</span>
            </label>
            <button
              type="button"
              onClick={() => void acknowledge()}
              disabled={!checked || busy === '__ack__'}
              className="rounded-btn bg-accent px-3 py-1.5 text-micro text-accent-fg disabled:opacity-40"
            >
              {t('security.notice.confirm')}
            </button>
          </div>
        )}
        {loaded && !acknowledged && <p className="mt-1.5 text-micro text-warning">{t('security.notice.required')}</p>}
      </section>

      {/* ===== T1：可授予（逐项） ===== */}
      <section>
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="font-mono text-micro tracking-wider text-warning">{t('security.group.t1')}</span>
          <span className="text-micro text-fg-muted">{T1_CAPABILITIES.length}</span>
        </div>
        <ul className="space-y-2">
          {T1_CAPABILITIES.map((cap) => (
            <GrantRow
              key={cap.key}
              cap={cap}
              {...(grants[cap.key] ? { grant: grants[cap.key] } : {})}
              disabled={!acknowledged}
              busy={busy === cap.key}
              highlighted={focusKey === cap.key}
              scopeDraft={drafts[cap.key] ?? ''}
              onScopeDraft={(v) => setDrafts((d) => ({ ...d, [cap.key]: v }))}
              onGrant={() => void grant(cap)}
              onRevoke={() => void revoke(cap.key)}
            />
          ))}
        </ul>
      </section>

      {/* ===== T0 / T2：只读（看清哪些永远开不了、哪些本来就开着） ===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-2.5">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="font-mono text-micro tracking-wider text-danger">{t('security.group.t0')}</span>
          <span className="text-micro text-fg-muted">{T0_CAPABILITIES.length}</span>
        </div>
        <ReadOnlyList caps={T0_CAPABILITIES} tone="text-danger" />
      </section>
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-2.5">
        <div className="mb-1.5 flex items-baseline gap-2">
          <span className="font-mono text-micro tracking-wider text-success">{t('security.group.t2')}</span>
          <span className="text-micro text-fg-muted">{T2_CAPABILITIES.length}</span>
        </div>
        <ReadOnlyList caps={T2_CAPABILITIES} tone="text-success" />
      </section>

      {/* ===== 审计 ===== */}
      <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-2.5">
        <div className="mb-1.5 font-mono text-micro tracking-wider text-fg-muted">{t('security.audit.title')}</div>
        {audit.length === 0 ? (
          <p className="text-[11px] text-fg-muted">{t('security.audit.empty')}</p>
        ) : (
          <ul className="space-y-1">
            {[...audit].reverse().map((e, i) => (
              <li key={`${e.id}-${i}`} className="text-micro leading-5">
                <span className="text-fg-muted">{formatStamp(e.ts)}</span>
                <span className={`ml-1.5 ${e.decision === 'allow' ? 'text-success' : 'text-danger'}`}>
                  {e.decision === 'allow' ? t('security.audit.allow') : t('security.audit.deny')}
                </span>
                <span className="ml-1.5 font-mono text-fg-secondary">{e.action}</span>
                <span className="ml-1.5 text-fg-muted">{e.reason}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-micro text-fg-muted">{t('security.audit.hint')}</p>
      </section>
    </div>
  )
}
