/**
 * ROOM 驾驶舱外壳：顶栏仪表 + 左侧主区导航（像素风）。
 *
 * 为什么拆出来：`RoomView` 负责状态与 IPC（视图不持循环生命周期，见其文件头），本文件只管
 * 「长什么样」——相位灯 / 自主开关 / 急停 / 三主区导航。分开后两者各自可单测、且 RoomView 不膨胀。
 *
 * 相位语义（主进程 `room/runtime.ts` 的相位机，勿在此重复定义业务）：
 * `stopped`=停 / `standby`=AI 自设待机 / `idle`=空闲（**采集器睁眼的唯一相位**）/ `running`=处理中。
 * 相位灯是 ROOM 最重要的仪表——用户一眼看到「AI 现在是醒着、在动、还是睡了」。
 */
import { useT } from '../../i18n/useT'
import { GLYPH, PixelGlyph, type GlyphRows } from './pixel-icons'

export type RoomZone = 'executor' | 'collector' | 'device'
export type RoomPhase = 'stopped' | 'standby' | 'idle' | 'running'

export const PHASE_KEY: Record<RoomPhase, string> = {
  stopped: 'room.stopped',
  standby: 'room.standby',
  idle: 'room.idle',
  running: 'room.running'
}

/** 相位灯色（亮时取 currentColor）：停=灰 / 待机=蓝 / 空闲=琥珀 / 运行=绿 */
const PHASE_TONE: Record<RoomPhase, string> = {
  stopped: 'text-fg-muted',
  standby: 'text-sky-400',
  idle: 'text-amber-400',
  running: 'text-emerald-400'
}

const PHASE_ORDER: RoomPhase[] = ['stopped', 'standby', 'idle', 'running']

const ZONES: Array<{ id: RoomZone; key: string; glyph: GlyphRows }> = [
  { id: 'executor', key: 'room.zone.executor', glyph: GLYPH.gear },
  { id: 'collector', key: 'room.zone.collector', glyph: GLYPH.eye },
  { id: 'device', key: 'room.zone.device', glyph: GLYPH.chip }
]

/** 相位灯组：四灯，当前相位亮；运行/空闲时闪烁（reduced-motion 下自动不闪）。 */
export function PhaseLamps({ phase }: { phase: RoomPhase }) {
  const t = useT()
  return (
    <div className="flex items-center gap-1.5" role="status" aria-live="polite" aria-label={t('room.phase')}>
      {PHASE_ORDER.map((p) => (
        <span
          key={p}
          className={`room-led ${PHASE_TONE[p]}`}
          data-on={p === phase}
          data-blink={p === phase && (p === 'running' || p === 'idle')}
          title={t(PHASE_KEY[p])}
        />
      ))}
      <span className={`ml-1 text-caption ${PHASE_TONE[phase]}`}>{t(PHASE_KEY[phase])}</span>
    </div>
  )
}

/** 顶栏仪表：房间所属 AI（只读标签）+ 相位灯 + 自主开关 + 急停。 */
export function InstrumentBar({
  aiName,
  phase,
  running,
  busy,
  error,
  onToggle,
  onEstop
}: {
  aiName: string
  phase: RoomPhase
  running: boolean
  busy: boolean
  error: string | null
  onToggle: () => void
  onEstop: () => void
}) {
  const t = useT()
  return (
    <div className="room-panel flex shrink-0 items-center justify-between gap-3 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-mono text-caption tracking-widest text-accent">ROOM</span>
        <span className="truncate text-caption text-fg-muted">{t('room.zoneOwner')}</span>
        <span className="truncate text-caption text-fg-secondary">{aiName}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {error && (
          <span className="max-w-[240px] truncate text-micro text-red-400" title={error}>
            {error}
          </span>
        )}
        <PhaseLamps phase={phase} />
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-pressed={running}
          className={`room-press flex items-center gap-1.5 px-2.5 py-1 text-caption disabled:opacity-40 ${
            running ? 'text-emerald-400' : 'text-fg-secondary'
          }`}
          title={running ? t('room.stop') : t('room.start')}
        >
          <PixelGlyph rows={GLYPH.power} size={12} />
          {running ? t('room.stop') : t('room.start')}
        </button>
        <button
          type="button"
          onClick={onEstop}
          disabled={busy || !running}
          className="room-press flex items-center gap-1 px-2 py-1 text-red-400 disabled:opacity-30"
          title={t('room.estopHint')}
          aria-label={t('room.estop')}
        >
          <PixelGlyph rows={GLYPH.stop} size={12} />
        </button>
      </div>
    </div>
  )
}

/** 左侧主区导航（三主区，互斥选中）。 */
export function ZoneRail({ zone, onSelect }: { zone: RoomZone; onSelect: (z: RoomZone) => void }) {
  const t = useT()
  return (
    <nav
      role="tablist"
      aria-orientation="vertical"
      className="flex w-32 shrink-0 flex-col gap-1 border-r-2 border-border-subtle bg-bg-surface p-2"
    >
      {ZONES.map(({ id, key, glyph }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={zone === id}
          onClick={() => onSelect(id)}
          className={`room-press flex w-full items-center gap-2 px-2 py-2 text-caption ${
            zone === id ? 'text-accent' : 'text-fg-muted hover:text-fg-secondary'
          }`}
        >
          <PixelGlyph rows={glyph} size={12} />
          {t(key)}
        </button>
      ))}
    </nav>
  )
}
