/**
 * 为什么存在：中继异步传输（L1.5 大云盘）是独立于好友聊天/私聊的功能域——发送方把文件上传到
 * 主系统中继暂存、接收方确认后下载，状态机与进度经 'relay:event' 推送，不走好友消息流。
 * 与好友面板的关联仅是「接收方从好友列表中选择」，故作为好友面板内的独立子视图挂载。
 * 作用：渲染中继传输面板——我发出的/我收到的两分区、上传入口（选接收好友→文件/文件夹）、
 * 确认下载/撤回操作、进度条与加载/空/错误态。
 */
import { useEffect, useState, useCallback } from 'react'
import { HardDrive, Upload, FileUp, FolderUp, Download, RotateCcw, File, Folder, Inbox, Send } from 'lucide-react'
import type { RelayListItem, RelayEvent, RelayStatus } from '../../../electron/main/multi-instance/relay/relay-types'
import type { TFunc } from '../../i18n/useT'
import type { FriendItem } from './types'
import { FOCUS } from './types'
import { formatRelativeTime } from './utils'

interface RelayPanelProps {
  /** 好友列表（接收方候选；与 FriendListView 同源） */
  friends: FriendItem[]
  t: TFunc
}

interface RelayInfoView {
  isHub: boolean
  downloadDir: string
  retentionDays: number
}

/** 传输进度缓存：itemId → 事件推送的最新进度 */
interface ProgressView {
  phase: 'upload' | 'download'
  sentBytes: number
  totalBytes: number
}

const STATUS_BADGE: Record<RelayStatus, { key: string; cls: string }> = {
  uploading: { key: 'relay.status.uploading', cls: 'bg-accent/15 text-accent' },
  uploaded: { key: 'relay.status.uploaded', cls: 'bg-bg-muted text-fg-secondary' },
  notified: { key: 'relay.status.notified', cls: 'bg-amber-500/15 text-amber-500' },
  downloaded: { key: 'relay.status.downloaded', cls: 'bg-emerald-500/15 text-emerald-500' },
  expired: { key: 'relay.status.expired', cls: 'text-fg-muted/70' }
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/**
 * 中继传输面板：数据自管理（relay:list 拉清单 + relay:event 订阅进度/状态变化）。
 * 为什么不自上而下受控：清单与进度是 RelayService 的实时视图，事件驱动高频刷新，
 * 放在面板内部订阅/清理最小化跨模块耦合；好友列表仍由 FriendsPanel 传入（接收方候选）。
 */
export function RelayPanel({ friends, t }: RelayPanelProps) {
  /** null=加载中；空数组=已加载但无记录 */
  const [items, setItems] = useState<RelayListItem[] | null>(null)
  const [info, setInfo] = useState<RelayInfoView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, ProgressView>>({})
  /** 正在执行确认/撤回的 itemId（防重复点击） */
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  /** 上传流程：已选接收好友（null=未选） */
  const [receiverUid, setReceiverUid] = useState<number | null>(null)
  /** 上传请求进行中（弹系统选择器期间禁用按钮防重复） */
  const [uploading, setUploading] = useState(false)

  const reportError = useCallback(
    (msg: string) => {
      setError(msg)
      window.setTimeout(() => setError((cur) => (cur === msg ? null : cur)), 4000)
    },
    []
  )

  const load = useCallback(async () => {
    const r = await window.lunareclipse.relayList()
    if (r.ok && r.list) {
      setItems(r.list)
      if (r.info) setInfo(r.info)
      return
    }
    // LAN 未启动或不支持中继：清空非空列表并以错误态提示（不能静默吞掉，用户会误以为无记录）
    setItems([])
    setError(r.error ?? t('relay.error'))
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  // 实时事件：进度更新；条目/状态变化（notify/entry/done/revoked/error）触发清单刷新
  useEffect(() => {
    const unsubscribe = window.lunareclipse.onRelayEvent((ev: RelayEvent) => {
      if (ev.type === 'progress') {
        setProgress((cur) => ({
          ...cur,
          [ev.itemId]: { phase: ev.phase, sentBytes: ev.sentBytes, totalBytes: ev.totalBytes }
        }))
        return
      }
      // done 后清理该条目的进度缓存（条目本身保留展示完成态）
      if ((ev.type === 'done' || ev.type === 'revoked' || ev.type === 'error') && ev.itemId) {
        setProgress((cur) => {
          const next = { ...cur }
          delete next[ev.itemId]
          return next
        })
      }
      void load()
    })
    return () => unsubscribe?.()
  }, [load])

  const upload = async (mode: 'file' | 'dir') => {
    if (receiverUid === null || uploading) return
    setUploading(true)
    try {
      const r = await window.lunareclipse.relayPickAndUpload(receiverUid, mode)
      // 取消选择不算失败，静默返回；成功后清单经 entry/done 事件或显式 load 刷新
      if (!r.ok && !r.canceled) reportError(r.error ?? t('relay.operateFailed'))
      if (r.ok) void load()
    } finally {
      setUploading(false)
    }
  }

  const confirm = async (itemId: string) => {
    if (busy[itemId]) return
    setBusy((cur) => ({ ...cur, [itemId]: true }))
    try {
      const r = await window.lunareclipse.relayConfirm(itemId)
      if (!r.ok) reportError(r.error ?? t('relay.operateFailed'))
      void load()
    } finally {
      setBusy((cur) => ({ ...cur, [itemId]: false }))
    }
  }

  const revoke = async (itemId: string) => {
    if (busy[itemId]) return
    setBusy((cur) => ({ ...cur, [itemId]: true }))
    try {
      const r = await window.lunareclipse.relayRevoke(itemId)
      if (!r.ok) reportError(r.error ?? t('relay.operateFailed'))
      void load()
    } finally {
      setBusy((cur) => ({ ...cur, [itemId]: false }))
    }
  }

  const sent = (items ?? []).filter((i) => i.direction === 'send')
  const received = (items ?? []).filter((i) => i.direction === 'receive')
  /** 可下载条件：对方发给我的且未被取走（uploading 阶段展示进度，不提供确认按钮） */
  const canConfirm = (i: RelayListItem) => i.direction === 'receive' && (i.status === 'uploaded' || i.status === 'notified')
  /** 可撤回条件：我发出的且接收方尚未下载 */
  const canRevoke = (i: RelayListItem) => i.direction === 'send' && i.status !== 'downloaded' && i.status !== 'expired'

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      {/* LAN 未启动提示 */}
      {error && (
        <div className="border-b border-danger/30 bg-danger-soft/60 px-3 py-1.5 text-[11px] text-danger" role="alert">
          {error}
        </div>
      )}

      {/* 上传入口：接收好友选择 + 文件/文件夹按钮 */}
      <div className="border-b border-border-subtle px-2.5 py-2">
        <div className="mb-1.5 flex items-center gap-1 text-micro uppercase tracking-wider text-fg-muted">
          <Upload size={10} />
          <span>{t('relay.upload')}</span>
        </div>
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-fg-muted">{t('relay.pickReceiver')}</span>
          <select
            value={receiverUid ?? ''}
            onChange={(e) => setReceiverUid(e.target.value ? Number(e.target.value) : null)}
            aria-label={t('relay.pickReceiver')}
            className={`max-w-[130px] flex-1 rounded-btn border border-border-subtle bg-bg-base px-1.5 py-1 text-caption text-fg-primary outline-none focus:border-accent ${FOCUS}`}
          >
            <option value="">—</option>
            {friends.map((f) => (
              <option key={f.uid} value={f.uid}>
                {f.备注 || f.昵称}
              </option>
            ))}
          </select>
          <span className="mx-0.5 text-fg-muted/50">·</span>
          <button
            onClick={() => void upload('file')}
            disabled={receiverUid === null || uploading}
            className={`flex shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
            title={t('relay.uploadFile')}
          >
            <FileUp size={11} />
            {t('relay.uploadFile')}
          </button>
          <button
            onClick={() => void upload('dir')}
            disabled={receiverUid === null || uploading}
            className={`flex shrink-0 items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
            title={t('relay.uploadDir')}
          >
            <FolderUp size={11} />
            {t('relay.uploadDir')}
          </button>
        </div>
        {info && (
          <div className="flex items-center gap-1 text-[10px] text-fg-muted">
            <HardDrive size={9} className="shrink-0" />
            <span className="truncate">{info.downloadDir}</span>
            <span className="shrink-0">· {t('relay.expires', { time: `${info.retentionDays}d` })}</span>
          </div>
        )}
      </div>

      {/* 清单 */}
      <div className="flex-1 overflow-y-auto p-2">
        {items === null ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-fg-muted">
            <HardDrive size={16} className="animate-pulse" />
            <span className="text-caption">{t('relay.loading')}</span>
          </div>
        ) : (
          <>
            {/* 我发出的 */}
            <div className="mb-1 flex items-center gap-1 px-2.5 text-micro uppercase tracking-wider text-fg-muted">
              <Send size={10} />
              {t('relay.sent')}
            </div>
            {sent.length === 0 ? (
              <div className="px-3 py-2 text-caption text-fg-muted/70">{t('relay.emptySent')}</div>
            ) : (
              sent.map((i) => (
                <RelayRow
                  key={i.itemId}
                  item={i}
                  progress={progress[i.itemId]}
                  busy={!!busy[i.itemId]}
                  t={t}
                  onConfirm={() => void confirm(i.itemId)}
                  onRevoke={() => void revoke(i.itemId)}
                  canConfirm={canConfirm(i)}
                  canRevoke={canRevoke(i)}
                />
              ))
            )}

            {/* 我收到的 */}
            <div className="mb-1 mt-3 flex items-center gap-1 px-2.5 text-micro uppercase tracking-wider text-fg-muted">
              <Inbox size={10} />
              {t('relay.received')}
            </div>
            {received.length === 0 ? (
              <div className="px-3 py-2 text-caption text-fg-muted/70">{t('relay.emptyReceived')}</div>
            ) : (
              received.map((i) => (
                <RelayRow
                  key={i.itemId}
                  item={i}
                  progress={progress[i.itemId]}
                  busy={!!busy[i.itemId]}
                  t={t}
                  onConfirm={() => void confirm(i.itemId)}
                  onRevoke={() => void revoke(i.itemId)}
                  canConfirm={canConfirm(i)}
                  canRevoke={canRevoke(i)}
                />
              ))
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 单条中继记录行：方向信息/名称/类型/计数/状态徽章/相对时间/进度条/操作按钮 */
function RelayRow({
  item,
  progress,
  busy,
  t,
  onConfirm,
  onRevoke,
  canConfirm,
  canRevoke
}: {
  item: RelayListItem
  progress?: ProgressView
  busy: boolean
  t: TFunc
  onConfirm: () => void
  onRevoke: () => void
  canConfirm: boolean
  canRevoke: boolean
}) {
  const badge = STATUS_BADGE[item.status]
  const KindIcon = item.kind === 'dir' ? Folder : File
  const pct = progress && progress.totalBytes > 0 ? Math.min(100, Math.round((progress.sentBytes / progress.totalBytes) * 100)) : 0
  const peerLabel =
    item.direction === 'send' ? t('relay.sendTo', { name: item.peerName }) : t('relay.receivedFrom', { name: item.peerName })

  return (
    <div className="group mb-1 rounded-btn border border-border-subtle bg-bg-elevated/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded ${item.kind === 'dir' ? 'bg-amber-500/10 text-amber-500' : 'bg-accent/10 text-accent'}`}>
          <KindIcon size={13} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-caption font-medium text-fg-primary">{item.name}</span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${badge.cls}`}>{t(badge.key)}</span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-fg-muted">
            <span className="truncate">{peerLabel}</span>
            <span className="shrink-0 text-fg-muted/60">{peerLabel ? '·' : ''}</span>
            <span className="shrink-0">{formatBytes(item.totalBytes)}</span>
            {item.kind === 'dir' && <span className="shrink-0">· {t('relay.counts', { files: item.files, dirs: item.dirs })}</span>}
            <span className="shrink-0">· {formatRelativeTime(item.createdAt, t)}</span>
          </div>
          {item.status !== 'downloaded' && item.status !== 'expired' && (
            <div className="text-[10px] text-fg-muted/70">{t('relay.expires', { time: formatRelativeTime(item.expiresAt, t) })}</div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canConfirm && (
            <button
              onClick={onConfirm}
              disabled={busy}
              className={`flex items-center gap-1 rounded-btn bg-accent/15 px-2 py-1 text-[10px] text-accent transition-colors hover:bg-accent/25 disabled:opacity-40 ${FOCUS}`}
              aria-label={t('relay.confirm')}
            >
              <Download size={10} />
              {busy ? t('relay.confirming') : t('relay.confirm')}
            </button>
          )}
          {canRevoke && (
            <button
              onClick={onRevoke}
              disabled={busy}
              className={`flex items-center gap-1 rounded-btn bg-bg-muted px-2 py-1 text-[10px] text-fg-secondary transition-colors hover:text-danger disabled:opacity-40 ${FOCUS}`}
              aria-label={t('relay.revoke')}
            >
              <RotateCcw size={10} />
              {busy ? t('relay.revoking') : t('relay.revoke')}
            </button>
          )}
        </div>
      </div>
      {/* 进行中进度条 */}
      {progress && (
        <div className="mt-1.5">
          <div className="h-1 w-full overflow-hidden rounded-full bg-bg-muted">
            <div
              className={`h-full rounded-full transition-all duration-300 ${progress.phase === 'download' ? 'bg-emerald-400' : 'bg-accent'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-0.5 text-right text-[9px] text-fg-muted">
            {formatBytes(progress.sentBytes)} / {formatBytes(progress.totalBytes)} · {t('relay.progress', { pct })}
          </div>
        </div>
      )}
    </div>
  )
}