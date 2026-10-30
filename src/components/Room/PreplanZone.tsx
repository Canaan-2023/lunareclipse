/**
 * ROOM 前置规划区（2026-10-31 前置规划功能）：前置规划开关 + 定位说明 + 已记节奏条数。
 *
 * 为什么存在：前置规划是主AI的**专属影子**——每轮规划前先看环境与近期节奏，给主AI一句
 * 方向性指令；工具由主AI自己选、自己调、自己承担后果。前置规划不占 AI 位、不写 RAW、
 * 不进记忆工作流（裁决：防与主AI记忆重复）。这个开关是用户侧唯一入口：
 * 开 = 两段式规划（前置规划给方向 → 主AI产出完整计划）；关 = 主AI自规划（缺省行为）。
 *
 * 不删理由：删掉即前置规划功能没有任何用户侧开关，只能在数据目录里手改 preplan.json。
 *
 * 取数口径：挂载 / aiId 变化时读一次 `room:preplan-get`（开关 + 初始条数）；切换后立即回读
 * 真实落盘值（不猜开关状态——落盘失败时界面显示真实错误，不假装已开）。条数的后续刷新
 * 走房间快照（`preplanHistoryCount`，父级下传）——快照优先、IPC 值为初始回退。
 */
import { useEffect, useState } from 'react'
import { Feather } from 'lucide-react'
import { useT } from '../../i18n/useT'

export function PreplanZone({ aiId, liveHistoryCount }: { aiId: number; liveHistoryCount?: number }) {
  const t = useT()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [historyCount, setHistoryCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await window.lunareclipse?.roomPreplanGet?.(aiId)
      if (!alive) return
      if (r?.ok) {
        setEnabled(r.enabled === true)
        setHistoryCount(r.historyCount ?? 0)
      } else {
        setError(r?.error ?? t('room.preplan.loadFailed'))
      }
    })()
    return () => {
      alive = false
    }
  }, [aiId, t])

  const toggle = async (): Promise<void> => {
    if (enabled == null || busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await window.lunareclipse?.roomPreplanSet?.(aiId, !enabled)
      if (r?.ok) {
        setEnabled(r.enabled === true)
      } else {
        setError(r?.error ?? t('room.preplan.setFailed'))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-fg-muted">
          <Feather size={12} />
          {t('room.preplan.title')}
        </span>
        {enabled != null && (
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={busy}
            role="switch"
            aria-checked={enabled}
            className={`room-press px-2 py-0.5 text-micro disabled:opacity-40 ${enabled ? 'text-success' : 'text-fg-muted'}`}
          >
            {/* 开关状态不只靠颜色：文字也写出来（无障碍） */}
            {enabled ? t('room.preplan.on') : t('room.preplan.off')}
          </button>
        )}
      </div>
      {error ? (
        <div className="text-[11px] text-danger">{error}</div>
      ) : enabled == null ? (
        <div className="text-[11px] text-fg-muted">{t('room.drawer.loading')}</div>
      ) : (
        <>
          <p className="text-[11px] leading-5 text-fg-muted">{t('room.preplan.desc')}</p>
          {enabled && (
            <div className="mt-1.5 text-[11px] text-fg-secondary">
              <span className="text-fg-muted">{t('room.preplan.history')}：</span>
              {t('room.preplan.historyCount').replace('{n}', String(liveHistoryCount ?? historyCount))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
