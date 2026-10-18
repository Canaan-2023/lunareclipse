/**
 * ROOM 底部事件流（终端式）。驾驶舱的「AI 在想什么 / 做了什么」实时窗口。
 *
 * 为什么常驻底部：房间事件此前埋在「规划区」卡片里（`RuntimeZones.tsx`），用户看不到 AI 在动；
 * 事件流是自主模式**可观测性**的主要承载面（配合 B-D 的 `room-events.jsonl` 落盘审计）。
 *
 * 只读渲染：数据来自 `room:runtime-state`（`RoomView` 轮询后传入），本组件不自行取数。
 */
import { useT } from '../../i18n/useT'

export interface RoomEvent {
  phase: string
  ts: number
  detail?: string
  mode?: string
}

/** 错误行着色：detail 里出现这些词即判为异常（失败/拒绝/错误/异常）。 */
const ERROR_RE = /失败|拒绝|错误|异常|error|fail|reject/i

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function RoomTicker({ events }: { events: RoomEvent[] }) {
  const t = useT()
  // 最新在上；最多 6 行（终端式滚动，不撑高布局）
  const lines = [...events].reverse().slice(0, 6)
  return (
    <div className="room-panel flex h-24 shrink-0 flex-col overflow-hidden" role="log" aria-label={t('room.ticker')}>
      <div className="flex shrink-0 items-center gap-2 border-b-2 border-border-subtle px-2 py-1">
        <span className="text-micro tracking-widest text-fg-muted">{t('room.ticker')}</span>
        <span className="text-micro text-fg-muted">({events.length})</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1 text-micro leading-5">
        {lines.length === 0 ? (
          <div className="text-fg-muted">{t('room.plan.noEvents')}</div>
        ) : (
          lines.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="flex gap-2">
              <span className="shrink-0 text-fg-muted">{formatTime(e.ts)}</span>
              <span className="shrink-0 text-fg-secondary">{e.phase}</span>
              {e.mode && <span className="shrink-0 text-fg-muted">[{e.mode}]</span>}
              {e.detail && (
                <span className={`min-w-0 truncate ${ERROR_RE.test(e.detail) ? 'text-red-400' : 'text-fg-muted'}`}>
                  {e.detail}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
