/**
 * 为什么存在：备份是账号维度的自助数据安全能力，须与账号管理分离避免混淆权限；
 * 文件多、体积大，独立面板承载备份流转全流程。
 * 作用：按 master/satellite 角色渲染备份中心——备份列表（含卫星延迟/进度）、查看并提取
 * zip、就地覆盖恢复，并支持切换账号会话。
 */
import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, RefreshCw, X, Archive, Download, FileText, Folder, HardDrive, Power, AlertTriangle, RotateCcw, ChevronRight } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'

interface ArchiveItem {
  uid: number
  date: string
  entryCount: number
  用户名?: string
}

interface InspectDetail {
  count: number
  bytes: number
  domains: Array<{ domain: string; files: number; bytes: number }>
  files: Array<{ path: string; size: number; preview?: string }>
}

/**
 * 备份中心（账号维度自助，与账号管理局分离）：
 * - master：主系统本机账号的日备份（backup/U{uid}/{date}/memory|NNG 完整镜像，日期恒为昨天一份），
 * 查看内容后在主系统本机完全覆盖恢复；分系统数据仅存镜像由分系统自行管理，本面板不出现。
 * - satellite：从主系统提取自己账号的备份（token 鉴权，仅能访问本实例本账号），
 * 查看内容 / 提取 zip / 在分系统本机完全覆盖恢复（恢复期间暂停同步）。
 */
export function BackupCenterPanel() {
  const t = useT()
  const open = useAppStore((s) => s.activeDrawer === 'backup' && !s.vizPanelOpen && !s.settingsOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const [role, setRole] = useState<'master' | 'satellite' | null>(null)
  const [archives, setArchives] = useState<ArchiveItem[]>([])
  const [selected, setSelected] = useState<ArchiveItem | null>(null)
  const [detail, setDetail] = useState<InspectDetail | null>(null)
  const [restoreArmed, setRestoreArmed] = useState(false)
  const [restoreConfirm, setRestoreConfirm] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    setLoading(true) // 为什么：初次加载不置 loading 会闪现「暂无备份」空态，误判数据丢失（评审 MINOR-5）
    try {
      const status = await window.lunareclipse.multiGetStatus()
      setRole(status.role === 'master' || status.role === 'satellite' ? status.role : null)
      if (status.role === 'satellite') {
        const r = await window.lunareclipse.multiSatBackupArchives()
        if (r.ok) setArchives(r.archives ?? [])
        else setError(r.error ?? '读取失败')
        return
      }
      if (status.role === 'master') {
        const r = await window.lunareclipse.multiLocalBackupStatus()
        if (r.ok) setArchives(r.archives ?? [])
        else setError(r.error ?? '读取失败')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  // 选中备份变化时重新 inspect（按角色走对应通道）
  useEffect(() => {
    setDetail(null)
    setRestoreArmed(false)
    setRestoreConfirm(false)
    setOkMsg(null)
    if (!open || !selected || !role) return
    ;(async () => {
      setBusy('inspect')
      const r =
        role === 'master'
          ? await window.lunareclipse.multiLocalBackupInspect(selected.uid, selected.date)
          : await window.lunareclipse.multiSatBackupInspect(selected.uid, selected.date)
      setBusy(null)
      if (r.ok) {
        setDetail(r.detail ?? null)
      } else {
        setDetail(null)
        setError(r.error ?? '读取备份内容失败')
      }
    })()
  }, [open, selected, role])

  const downloadZip = async (a: ArchiveItem) => {
    if (role !== 'satellite') return
    setBusy(`dl-${a.date}`)
    const r = await window.lunareclipse.multiSatBackupSave(a.uid, a.date)
    setBusy(null)
    if (!r.ok && !r.canceled) setError(r.error ?? '提取失败')
    else if (r.ok && r.path) setOkMsg(`已保存：${r.path}`)
  }

  const doRestore = async (a: ArchiveItem) => {
    if (!role) return
    setBusy('restore')
    const r =
      role === 'master'
        ? await window.lunareclipse.multiLocalBackupRestoreOverwrite(a.uid, a.date)
        : await window.lunareclipse.multiSatBackupRestoreOverwrite(a.uid, a.date)
    setBusy(null)
    setRestoreArmed(false)
    setRestoreConfirm(false)
    if (r.ok) setOkMsg(t('backup.restored', { n: r.restored ?? 0 }))
    else setError(r.error ?? '恢复失败')
    await load()
  }

  if (!open) return null

  const accountName = (a: ArchiveItem): string => a.用户名 ?? `UID ${a.uid}`
  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  return (
    <div className="flex h-full w-full flex-col bg-bg-surface">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <div className="flex items-center gap-1.5 text-caption font-medium text-fg-secondary">
          <DatabaseBackup size={13} className="text-accent" />
          {t('backup.title')}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
            title={t('backup.refresh')}
            aria-label={t('backup.refresh')}
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

      {/* 角色语义提示 */}
      <div className="border-b border-border-subtle px-3 py-1.5 text-[10px] leading-relaxed text-fg-muted">
        {role === 'master'
          ? t('backup.masterHint')
          : role === 'satellite'
            ? t('backup.satelliteHint')
            : t('backup.standaloneHint')}
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* 错误 / 成功提示 */}
        {(error || okMsg) && (
          <div className="space-y-1 p-2 pb-0">
            {error && (
              <div className="rounded-btn border border-danger-soft bg-danger-soft/20 px-2.5 py-1.5 text-[11px] text-danger">{error}</div>
            )}
            {okMsg && (
              <div className="rounded-btn border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] text-emerald-400">{okMsg}</div>
            )}
          </div>
        )}

        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
          {/* 备份列表 */}
          <div className="grid grid-cols-1 gap-1.5">
            {loading ? (
              <div className="px-3 py-6 text-center text-caption text-fg-muted">{t('common.loading')}</div>
            ) : archives.length === 0 ? (
              <div className="px-3 py-6 text-center text-caption text-fg-muted">{t('backup.empty')}</div>
            ) : (
              archives.map((a) => {
                const isSel = selected?.uid === a.uid && selected?.date === a.date
                return (
                  <button
                    key={`${a.uid}-${a.date}`}
                    onClick={() => setSelected(a)}
                    className={`flex w-full items-center justify-between gap-2 rounded-btn border px-2.5 py-2 text-left transition-colors ${
                      isSel ? 'border-accent/50 bg-accent/10' : 'border-border-subtle bg-bg-base/50 hover:border-accent/30 hover:bg-bg-muted'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Archive size={10} className="shrink-0 text-accent" />
                        <span className="text-body text-fg-primary">{accountName(a)}</span>
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-fg-muted">
                        {a.date} · {t('backup.entries', { n: a.entryCount })}
                      </div>
                    </div>
                    <ChevronRight size={12} className="shrink-0 text-fg-muted" />
                  </button>
                )
              })
            )}
          </div>

          {/* 内容明细 + 操作 */}
          {selected && (
            <div className="rounded-btn border border-border-subtle bg-bg-base/50">
              <div className="flex items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-fg-muted">
                <FileText size={11} />
                {t('backup.inspectTitle')}
                <span className="ml-auto font-mono normal-case tracking-normal">{selected.date}</span>
              </div>

              {busy === 'inspect' ? (
                <div className="px-3 py-4 text-center text-caption text-fg-muted">{t('common.loading')}</div>
              ) : detail ? (
                <div className="space-y-2 p-2.5">
                  {/* 概要 */}
                  <div className="flex items-center gap-2 text-[10px] text-fg-muted">
                    <HardDrive size={10} className="text-accent" />
                    {detail.count} {t('backup.files')} · {fmtBytes(detail.bytes)}
                  </div>
                  {/* 域聚合 chips */}
                  {detail.domains.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {detail.domains.map((d) => (
                        <span key={d.domain} className="rounded-full border border-border-subtle bg-bg-surface px-1.5 py-[2px] text-[9px] text-fg-secondary">
                          {d.domain} · {d.files} · {fmtBytes(d.bytes)}
                        </span>
                      ))}
                    </div>
                  )}
                  {/* 文件清单 */}
                  <div className="max-h-[120px] overflow-y-auto rounded-btn border border-border-subtle bg-bg-surface/60">
                    {detail.files.slice(0, 30).map((f) => (
                      <div key={f.path} className="flex items-center gap-1.5 border-b border-border-subtle/50 px-2 py-1 last:border-b-0">
                        <Folder size={9} className="shrink-0 text-fg-muted" />
                        <span className="truncate font-mono text-[9px] text-fg-secondary">{f.path}</span>
                        <span className="ml-auto shrink-0 text-[9px] text-fg-muted">{fmtBytes(f.size)}</span>
                      </div>
                    ))}
                    {detail.files.length > 30 && (
                      <div className="px-2 py-1 text-center text-[9px] text-fg-muted">+{detail.files.length - 30} …</div>
                    )}
                  </div>
                  {/* 文本预览 */}
                  {detail.files.find((f) => f.preview) && (
                    <div className="rounded-btn border border-border-subtle bg-bg-surface/60 p-2">
                      <div className="mb-1 text-[9px] uppercase tracking-wider text-fg-muted">{t('backup.inspectTitle')} · preview</div>
                      <pre className="max-h-[90px] overflow-y-auto whitespace-pre-wrap break-all font-mono text-[9px] leading-relaxed text-fg-secondary">
                        {detail.files.find((f) => f.preview)?.preview ?? t('backup.noPreview')}
                      </pre>
                    </div>
                  )}

                  {/* 操作区 */}
                  <div className="space-y-1.5 border-t border-border-subtle pt-2">
                    {role === 'satellite' && (
                      <button
                        onClick={() => void downloadZip(selected)}
                        disabled={busy === `dl-${selected.date}`}
                        className="flex h-7 w-full items-center justify-center gap-1.5 rounded-btn border border-border-subtle text-[10px] text-fg-secondary transition-colors hover:border-accent/40 hover:text-accent disabled:opacity-50"
                        title={t('backup.downloadArc')}
                      >
                        <Download size={10} />
                        {t('backup.download')}
                      </button>
                    )}

                    {/* 恢复开关：显式开启 + 二次确认后才亮起执行按钮 */}
                    <div className="rounded-btn border border-border-subtle bg-bg-surface/40 p-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 text-[10px] font-medium text-fg-secondary">
                          <RotateCcw size={10} className="text-danger" />
                          {t('backup.restoreMode')}
                        </div>
                        <button
                          onClick={() => {
                            setRestoreArmed(!restoreArmed)
                            setRestoreConfirm(false)
                          }}
                          className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${restoreArmed ? 'bg-danger' : 'bg-bg-muted'}`}
                          role="switch"
                          aria-checked={restoreArmed}
                          aria-label={t('backup.restoreMode')}
                          title={t('backup.restoreMode')}
                        >
                          <span
                            className={`absolute top-[2px] h-3 w-3 rounded-full bg-white transition-all ${
                              restoreArmed ? 'left-[18px]' : 'left-[2px]'
                            }`}
                          />
                        </button>
                      </div>
                      {restoreArmed && (
                        <div className="mt-1.5 flex items-start gap-1.5 text-[9px] leading-relaxed text-fg-muted">
                          <AlertTriangle size={9} className="mt-[2px] shrink-0 text-danger" />
                          {role === 'satellite' ? t('backup.restoreHintSat') : t('backup.restoreHint')}
                        </div>
                      )}
                      {restoreArmed && (
                        <button
                          onClick={() => {
                            if (!restoreConfirm) {
                              setRestoreConfirm(true)
                              return
                            }
                            void doRestore(selected)
                          }}
                          disabled={busy === 'restore'}
                          className={`mt-1.5 flex h-7 w-full items-center justify-center gap-1.5 rounded-btn border text-[10px] transition-colors disabled:opacity-50 ${
                            restoreConfirm
                              ? 'border-danger-soft bg-danger-soft/20 text-danger'
                              : 'border-danger-soft/60 text-danger hover:bg-danger-soft/20'
                          }`}
                          title={t('backup.confirmRestore')}
                        >
                          <Power size={10} />
                          {/* 二次确认态用恢复专用文案（backup.confirmRestoreAction），
                              不复用 admin.confirmRevoke（revoke 语义与恢复无关，评审 MINOR-4） */}
                          {busy === 'restore'
                            ? t('backup.restoring')
                            : restoreConfirm
                              ? t('backup.confirmRestoreAction')
                              : t('backup.restore')}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="px-3 py-5 text-center text-caption text-fg-muted">{t('backup.selectHint')}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}