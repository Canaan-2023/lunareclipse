/**
 * 为什么存在：账号管理面（管理员侧）与个人中心/设置里的账号管理职责不同，
 * 面向主账号对局域网/云端账号的统一治理，独立面板承载。
 * 作用：渲染账号管理面板——账号列表（主/分系统标记、禁用/启用、详情查看）、
 * 异常同步修复、凭据搜索与内部会话浏览。
 */
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, RefreshCw, X, Users, Ban, Check, FolderOpen, AlertTriangle, UserCog, Satellite, Monitor, Trash2, Search, FileText, ChevronDown, ChevronRight, Eraser } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'

interface AccountItem {
  uid: number
  用户名: string
  创建时间: string
  禁用: boolean
  来源: 'master' | 'satellite'
  instanceId?: string
  satelliteStatus?: 'active' | 'disabled'
  lastSyncAt?: string | null
}

interface AnomalyItem {
  instanceId: string
  uid: number
  type: string
  message: string
  ts: string
}

/** 账号检索结果项（multi:adminSearchUsers 返回） */
interface SearchUserItem {
  UID: number
  用户名: string
  昵称?: string
  姓名?: string
  禁用: boolean
}

/** 账号资料查看结果（multi:adminGetUserProfile 返回） */
interface ProfileResult {
  ok: boolean
  error?: string
  UID?: number
  用户名?: string
  昵称?: string
  userMd?: string | null
  chars?: number
  truncated?: boolean
  message?: string
}

/**
 * 账号管理局（主系统侧抽屉）：
 * 主系统账号 + 全部分系统账号的统一管理面板，账号管理系统风格。
 * - 大字统计（总账号/分系统/禁用）
 * - 账号列表：来源徽标（主系统/分系统）、禁用状态、最后同步
 * - 单个账号可禁用/恢复（主系统账号主要拦截本机登录；分系统账号连带作废令牌）
 * - 点击"记忆"跳转该账号记忆文件夹（用户数据按域分：统一 memory/U{uid}[/AI{aiId}]）
 */
export function AccountBoardPanel() {
  const t = useT()
  const open = useAppStore((s) => s.activeDrawer === 'admin' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const [accounts, setAccounts] = useState<AccountItem[] | null>(null)
  const [anomalies, setAnomalies] = useState<AnomalyItem[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revokeConfirm, setRevokeConfirm] = useState<number | null>(null)
  const [disableConfirm, setDisableConfirm] = useState<number | null>(null)
  const [purgeConfirm, setPurgeConfirm] = useState<number | null>(null)

  // ===== 账号检索状态（按姓名/昵称/用户名检索 UID + 查看 USER.md 资料） =====
  const [searchKeyword, setSearchKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchDone, setSearchDone] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchUserItem[] | null>(null)
  const [profileBusyUid, setProfileBusyUid] = useState<number | null>(null)
  const [profileByUid, setProfileByUid] = useState<Record<number, ProfileResult>>({})

  const load = useCallback(async () => {
    setError(null)
    const [a, an] = await Promise.all([
      window.lunareclipse.multiAdminAccounts(),
      window.lunareclipse.multiAdminAnomalies()
    ])
    if (!a.ok) setError(a.error ?? '读取失败')
    else setAccounts(a.accounts ?? [])
    if (an.ok) setAnomalies(an.anomalies ?? [])
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  const toggleDisabled = async (acc: AccountItem) => {
    // 恢复（单向安全）直接执行；禁用需二次点击确认
    if (!acc.禁用 && disableConfirm !== acc.uid) {
      setDisableConfirm(acc.uid)
      setRevokeConfirm(null)
      return
    }
    setDisableConfirm(null)
    setBusy(`acc-${acc.uid}`)
    const r = await window.lunareclipse.multiAdminSetAccountDisabled(acc.uid, !acc.禁用)
    setBusy(null)
    if (!r.ok) setError(r.error ?? '操作失败')
    await load()
  }

  /** 撤销分系统接入（仅分系统账号）：从 registry 移除，链接立即失效 */
  const revoke = async (acc: AccountItem) => {
    if (!acc.instanceId) return
    if (revokeConfirm !== acc.uid) {
      setRevokeConfirm(acc.uid)
      setDisableConfirm(null)
      return
    }
    setRevokeConfirm(null)
    setBusy(`rev-${acc.uid}`)
    const r = await window.lunareclipse.multiAdminRevoke(acc.instanceId)
    setBusy(null)
    if (!r.ok) setError(r.error ?? '撤销失败')
    await load()
  }

  /** 打开账号记忆文件夹（主/分账号统一 memory/U{uid}[/AI{aiId}]，uid 全局唯一不冲突） */
  const openMemory = async (acc: AccountItem) => {
    setBusy(`mem-${acc.uid}`)
    const r = await window.lunareclipse.multiAdminOpenMemory(acc.uid)
    setBusy(null)
    if (!r.ok) setError(r.error ?? '打开失败')
  }

  /**
   * 清理账号本机工作域（仅主系统账号管理局）：永久清空该账号在本机的全部工作域数据
   * （记忆/技能/对话/配置/备份等），仅清数据、保留账号记录。高影响不可恢复——必须
   * 二次确认：首次点击进入确认态（按钮变为「确认清理？」），再次点击才执行。
   */
  const purgeAccount = async (acc: AccountItem) => {
    if (purgeConfirm !== acc.uid) {
      setPurgeConfirm(acc.uid)
      setRevokeConfirm(null)
      setDisableConfirm(null)
      return
    }
    setPurgeConfirm(null)
    setBusy(`purge-${acc.uid}`)
    const r = await window.lunareclipse.multiAdminPurgeUser(acc.uid)
    setBusy(null)
    if (!r.ok) {
      setError(r.error ?? t('admin.purgeFail'))
    } else {
      setError(null)
      if (r.removedDirs || r.removedFiles) {
        window.alert(t('admin.purged', { dirs: r.removedDirs ?? 0, files: r.removedFiles ?? 0 }))
      }
    }
    await load()
  }

  /** 账号检索：按姓名/昵称/用户名 模糊检索 UID 列表（空关键词 = 全部账号） */
  const runSearch = useCallback(
    async (keyword: string) => {
      const kw = keyword.trim()
      setSearching(true)
      setSearchError(null)
      setSearchDone(false)
      const r = await window.lunareclipse.multiAdminSearchUsers(kw)
      setSearching(false)
      setSearchDone(true)
      if (!r.ok) {
        setSearchResults(null)
        setSearchError(r.error ?? '检索失败')
        return
      }
      setSearchResults(r.users ?? [])
    },
    []
  )

  /** 查看某 UID 的 USER.md 资料（已成功加载的直接用缓存，失败的允许重试） */
  const viewProfile = useCallback(
    async (uid: number) => {
      if (profileByUid[uid]?.ok) return
      setProfileBusyUid(uid)
      const r = await window.lunareclipse.multiAdminGetUserProfile(uid)
      setProfileBusyUid(null)
      setProfileByUid((prev) => ({ ...prev, [uid]: r }))
    },
    [profileByUid]
  )

  if (!open) return null

  const total = accounts?.length ?? 0
  const satCount = accounts?.filter((a) => a.来源 === 'satellite').length ?? 0
  const disabledCount = accounts?.filter((a) => a.禁用).length ?? 0

  const fmtSync = (ts?: string | null): string => {
    if (!ts) return t('admin.never')
    const diff = Date.now() - new Date(ts).getTime()
    if (diff < 60_000) return t('admin.justNow')
    if (diff < 3600_000) return t('admin.minutesAgo', { n: Math.floor(diff / 60_000) })
    if (diff < 86400_000) return t('admin.hoursAgo', { n: Math.floor(diff / 3600_000) })
    return new Date(ts).toLocaleDateString()
  }

  const statCards = [
    { label: t('admin.statTotal'), value: total, icon: Users, cls: 'text-accent' },
    { label: t('admin.statSatellite'), value: satCount, icon: Satellite, cls: 'text-sky-400' },
    { label: t('admin.statDisabled'), value: disabledCount, icon: Ban, cls: 'text-danger' },
  ]

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <ShieldCheck size={13} className="text-accent" />
          {t('admin.title')}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('admin.refresh')}
            aria-label={t('admin.refresh')}
          >
            <RefreshCw size={11} />
          </button>
          <button
            onClick={() => closeDrawer()}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-2">
        {error && (
          <div className="rounded-btn border border-danger-soft bg-danger-soft/20 px-2.5 py-1.5 text-[11px] text-danger">
            {error}
          </div>
        )}

        {/* 账号资料检索：按姓名/昵称/用户名查 UID → 看 USER.md */}
        <section aria-label={t('admin.searchTitle')}>
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
            <Search size={11} />
            {t('admin.searchTitle')}
          </div>
          <div className="rounded-btn border border-border-subtle bg-bg-base/50 p-2 space-y-2">
            <div className="flex items-center gap-1.5">
              <input
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch(searchKeyword)
                  if (e.key === 'Escape') {
                    setSearchKeyword('')
                    setSearchResults(null)
                    setSearchDone(false)
                    setSearchError(null)
                  }
                }}
                placeholder={t('admin.searchPlaceholder')}
                aria-label={t('admin.searchPlaceholder')}
                maxLength={100}
                className="h-7 min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-muted/60 px-2 text-caption text-fg-primary placeholder:text-fg-muted/70 focus:border-accent/50 focus:outline-none"
              />
              <button
                onClick={() => void runSearch(searchKeyword)}
                disabled={searching}
                className="flex h-7 shrink-0 items-center gap-1 rounded-btn border border-border-subtle px-2 text-[10px] text-fg-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
              >
                {searching ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-border-subtle border-t-accent" />
                    {t('common.loading')}
                  </>
                ) : (
                  <>
                    <Search size={10} />
                    {t('admin.searchBtn')}
                  </>
                )}
              </button>
            </div>

            {searchError && (
              <div className="rounded-btn border border-danger-soft bg-danger-soft/20 px-2.5 py-1.5 text-[10px] text-danger">
                {searchError}
              </div>
            )}

            {searchDone && !searchError && (searchResults?.length ?? 0) === 0 && (
              <div className="px-2 py-3 text-center text-[10px] text-fg-muted">{t('admin.searchEmpty')}</div>
            )}

            {searchResults && searchResults.length > 0 && (
              <ul className="space-y-1">
                {searchResults.map((u) => (
                  <li key={u.UID}>
                    <button
                      onClick={() => void viewProfile(u.UID)}
                      disabled={profileBusyUid === u.UID}
                      className="flex w-full items-center justify-between gap-2 rounded-btn border border-border-subtle bg-bg-base/40 px-2 py-1.5 text-left transition-colors hover:border-accent/40 hover:bg-bg-muted/40 disabled:opacity-60"
                      aria-expanded={!!profileByUid[u.UID]}
                    >
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          {profileByUid[u.UID] ? (
                            <ChevronDown size={10} className="shrink-0 text-fg-muted" />
                          ) : (
                            <ChevronRight size={10} className="shrink-0 text-fg-muted" />
                          )}
                          <span className="truncate text-[11px] font-medium text-fg-primary">
                            {u.姓名 || u.昵称 || u.用户名}
                          </span>
                          {u.禁用 && (
                            <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-[1px] text-[9px] text-danger">
                              {t('admin.disabled')}
                            </span>
                          )}
                        </span>
                        <span className="mt-0.5 block pl-4 font-mono text-[9px] text-fg-muted">
                          UID {u.UID}
                          {u.用户名 && <span className="ml-1 not-italic">· {u.用户名}</span>}
                          {u.姓名 && u.姓名 !== u.用户名 && <span className="ml-1 not-italic">· 姓名 {u.姓名}</span>}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {profileBusyUid === u.UID ? (
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-border-subtle border-t-accent" />
                        ) : (
                          <FileText size={10} className="text-fg-muted" />
                        )}
                      </span>
                    </button>

                    {profileByUid[u.UID] && (
                      <div className="mt-1 rounded-btn border border-border-subtle bg-bg-base/70 px-2 py-2">
                        {profileByUid[u.UID].ok === false ? (
                          <div className="text-[10px] text-danger">{profileByUid[u.UID].error ?? t('admin.profileLoadError')}</div>
                        ) : !profileByUid[u.UID].userMd ? (
                          <div className="text-[10px] text-fg-muted">{t('admin.profileEmpty')}</div>
                        ) : (
                          <>
                            <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-fg-secondary">
                              {profileByUid[u.UID].userMd}
                            </pre>
                            {profileByUid[u.UID].truncated && (
                              <div className="mt-1 text-[9px] text-fg-muted">
                                {t('admin.profileTruncated', { chars: profileByUid[u.UID].chars ?? 0 })}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 大字统计 */}
        <div className="grid grid-cols-3 gap-1.5">
          {statCards.map((c) => (
            <div key={c.label} className="rounded-btn border border-border-subtle bg-bg-base/50 px-2.5 py-2">
              <div className="flex items-center gap-1 text-[9px] uppercase tracking-wider text-fg-muted">
                <c.icon size={9} className={c.cls} />
                {c.label}
              </div>
              <div className={`mt-0.5 text-xl font-semibold leading-none ${c.cls}`}>{c.value}</div>
            </div>
          ))}
        </div>

        {/* 账号列表：主系统 + 分系统统一台账 */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
            <UserCog size={11} />
            {t('admin.accounts')}
            <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">{total}</span>
          </div>
          {accounts === null ? (
            <div className="px-3 py-4 text-center text-caption text-fg-muted">{t('common.loading')}</div>
          ) : accounts.length === 0 ? (
            <div className="px-3 py-6 text-center text-caption text-fg-muted">{t('admin.emptyAccounts')}</div>
          ) : (
            <div className="space-y-1.5">
              {accounts.map((acc) => (
                <div key={acc.uid} className="rounded-btn border border-border-subtle bg-bg-base/50 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        {acc.来源 === 'master' ? (
                          <Monitor size={10} className="shrink-0 text-accent" aria-label={t('admin.sourceMaster')} />
                        ) : (
                          <Satellite size={10} className="shrink-0 text-sky-400" aria-label={t('admin.sourceSatellite')} />
                        )}
                        <span className="truncate text-body text-fg-primary">{acc.用户名}</span>
                        {acc.禁用 && (
                          <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-[1px] text-[9px] text-danger">
                            {t('admin.disabled')}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-fg-muted">
                        UID {acc.uid}
                        {acc.来源 === 'satellite' && (
                          <span className="ml-1">
                            · {acc.instanceId}
                            {acc.lastSyncAt ? ` · ${t('admin.lastSync')} ${fmtSync(acc.lastSyncAt)}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => void openMemory(acc)}
                        disabled={busy === `mem-${acc.uid}`}
                        className="flex h-6 items-center gap-1 rounded-btn border border-border-subtle px-1.5 text-[10px] text-fg-muted transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
                        title={t('admin.openMemory')}
                      >
                        <FolderOpen size={10} />
                        {t('admin.memory')}
                      </button>
                      <button
                        onClick={() => void purgeAccount(acc)}
                        disabled={busy === `purge-${acc.uid}`}
                        className={`flex h-6 items-center gap-1 rounded-btn border px-1.5 text-[10px] transition-colors disabled:opacity-50 ${
                          purgeConfirm === acc.uid
                            ? 'border-danger-soft bg-danger-soft/20 text-danger'
                            : 'border-border-subtle text-fg-muted hover:border-danger-soft/60 hover:text-danger'
                        }`}
                        title={t('admin.purgeHint')}
                      >
                        <Eraser size={10} />
                        {purgeConfirm === acc.uid ? t('admin.confirmPurgeWorkspace') : t('admin.purgeWorkspace')}
                      </button>
                      <button
                        onClick={() => void toggleDisabled(acc)}
                        disabled={busy === `acc-${acc.uid}`}
                        className={`flex h-6 items-center gap-1 rounded-btn border px-1.5 text-[10px] transition-colors disabled:opacity-50 ${
                          acc.禁用
                            ? 'border-border-subtle text-fg-muted hover:border-emerald-500/40 hover:text-emerald-400'
                            : disableConfirm === acc.uid
                              ? 'border-danger-soft bg-danger-soft/20 text-danger'
                              : 'border-border-subtle text-fg-muted hover:border-danger-soft/60 hover:text-danger'
                        }`}
                        title={acc.禁用 ? t('admin.enable') : disableConfirm === acc.uid ? t('admin.confirmDisable') : t('admin.disable')}
                      >
                        {acc.禁用 ? <Check size={10} /> : <Ban size={10} />}
                        {acc.禁用 ? t('admin.enable') : disableConfirm === acc.uid ? t('admin.confirmDisable') : t('admin.disable')}
                      </button>
                      {acc.来源 === 'satellite' && acc.instanceId && (
                        <button
                          onClick={() => void revoke(acc)}
                          disabled={busy === `rev-${acc.uid}`}
                          className={`flex h-6 items-center gap-1 rounded-btn border px-1.5 text-[10px] transition-colors disabled:opacity-50 ${
                            revokeConfirm === acc.uid
                              ? 'border-danger-soft bg-danger-soft/20 text-danger'
                              : 'border-border-subtle text-fg-muted hover:border-danger-soft/60 hover:text-danger'
                          }`}
                          title={t('admin.revoke')}
                        >
                          <Trash2 size={10} />
                          {revokeConfirm === acc.uid ? t('admin.confirmRevoke') : t('admin.revoke')}
                        </button>
                      )}
                    </div>
                  </div>
                  {acc.禁用 && (
                    <div className="mt-1 text-[10px] text-danger/80">
                      {acc.来源 === 'satellite'
                        ? t('admin.disabledHintSatellite')
                        : t('admin.disabledHintMaster')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 异常记录（分系统汇报） */}
        <section>
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
            <AlertTriangle size={11} />
            {t('admin.anomalies')}
            <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">{anomalies.length}</span>
          </div>
          {anomalies.length === 0 ? (
            <div className="px-3 py-4 text-center text-caption text-fg-muted">{t('admin.emptyAnomalies')}</div>
          ) : (
            <div className="space-y-1">
              {anomalies.map((a, i) => (
                <div key={i} className="rounded-btn border border-border-subtle bg-bg-base/50 px-2.5 py-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[10px] font-medium text-fg-secondary">{a.type}</span>
                    <span className="shrink-0 text-[9px] text-fg-muted">{new Date(a.ts).toLocaleString()}</span>
                  </div>
                  <div className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">
                    {a.message}
                    <span className="ml-1 font-mono text-[9px] opacity-70">{a.instanceId}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}