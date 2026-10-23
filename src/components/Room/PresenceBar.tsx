/**
 * ROOM 顶栏：**一条**（不是一栏仪表）。
 *
 * 设计口径（用户：「没必要什么都摆在明面上，留出一个输出」）：
 * 常驻只剩三件——**它是谁 / 它现在怎么样 / 一个开关**；其余一切在一次点击之后（`DetailPanel`）。
 *
 * 「它现在怎么样」= **一个小月相**（16×16 像素），一物三编码（不只靠颜色）：
 * - **形状**：停=新月 / 待机=满月 / 空闲=渐亏 / 运行=日偏食 / 出错=红月（`moonRows` 已测）；
 * - **节奏**：随相位呼吸（与房间画面同一个 CSS 动画，节奏一致）；
 * - **色温**：语义 token（六主题自适应）。
 * 加上**状态词**（如「运行 · 规划」「待机 · 15:42 醒」），四重编码。
 *
 * 待机显示的是**醒来时刻**而不是倒计时——倒计时需要一个每秒跳的定时器，而
 * 「没事发生时不产生工作」是本项目的硬口径（绝对时刻同样有用，且零开销）。
 *
 * 不删理由：删掉即「它现在怎么样 / 怎么停」没有入口——极简不等于没有仪表。
 */
import { useT } from '../../i18n/useT'
import { GLYPH, PixelGlyph } from './pixel-icons'
import { breathAmplitude, breathPeriodMs, sceneStateOf } from './scene-layers'
import { moonRows, phaseLabelKey, phaseTone, phaseToMoon, stageLabelKey } from './room-status'
import type { CSSProperties } from 'react'

/** 时间戳 → `HH:MM`（纯格式化：只依赖入参，不读当前时刻） */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 待机到期时刻：同一天只写 `HH:MM`，跨天补 `M/D`。
 * 为什么（SRE P2-2）：AI 可以把待机设到几天后，只写 `09:00` 会让人误以为是今天。
 * `now` 由调用方传入（纯函数），不在格式化里读当前时刻。
 */
export function formatStandbyClock(ts: number, now: number): string {
  const d = new Date(ts)
  const n = new Date(now)
  const sameDay =
    d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? formatClock(ts) : `${d.getMonth() + 1}/${d.getDate()} ${formatClock(ts)}`
}

/** 状态词：相位 + 出错优先 + 待机给醒来时刻 + 运行给当前阶段 + 空闲但感知中要显式说出来 */
export function statusText(o: {
  phase: string
  llmFailed: boolean
  standbyUntil?: number
  stage: number
  sensing?: boolean
  /** 当前时刻（仅用于判断待机是否跨天；缺省按同日处理，保持纯函数可测） */
  now?: number
  t: (key: string) => string
}): string {
  if (o.llmFailed) return o.t('room.phase.error')
  if (o.phase === 'standby' && o.standbyUntil) {
    // 待机 ≠ 闭眼：感知器仍在看，事件可以提前叫醒；`standbyMs` 只是最迟醒来时刻
    const base = `${o.t('room.phase.standby')}${o.sensing ? ` · ${o.t('room.status.sensing')}` : ''}`
    const at = formatStandbyClock(o.standbyUntil, o.now ?? o.standbyUntil)
    return `${base} · ${at} ${o.t('room.status.wakeAt')}`
  }
  if (o.phase === 'running' && o.stage >= 0) {
    return `${o.t('room.phase.running')} · ${o.t(stageLabelKey(o.stage))}`
  }
  // 空闲 ≠ 静默：感知器在跑时必须让用户看见「它还在睁着眼」
  if (o.phase === 'idle' && o.sensing) {
    return `${o.t('room.phase.idle')} · ${o.t('room.status.sensing')}`
  }
  return o.t(phaseLabelKey(o.phase as 'stopped' | 'standby' | 'idle' | 'running'))
}

export function PresenceBar({
  aiName,
  phase,
  running,
  busy,
  llmFailed,
  standbyUntil,
  stage,
  sensing = false,
  onToggle,
  onOpenDetail,
  onOpenLog
}: {
  aiName: string
  phase: string
  running: boolean
  busy: boolean
  llmFailed: boolean
  standbyUntil?: number
  /** 本轮阶段下标（-1 = 不在阶段中） */
  stage: number
  /** 感知器是否在跑（0.53.1：空闲时它替 AI 睁着眼） */
  sensing?: boolean
  onToggle: () => void
  onOpenDetail: () => void
  /** 打开「记录」抽屉（GALGAME 式回看；不常驻占版面） */
  onOpenLog: () => void
}) {
  const t = useT()
  const state = sceneStateOf(phase, { llmFailed })
  const moon = phaseToMoon(phase as 'stopped' | 'standby' | 'idle' | 'running', { llmFailed })
  const tone = phaseTone(phase as 'stopped' | 'standby' | 'idle' | 'running', { llmFailed })
  const period = breathPeriodMs(state)
  const amp = breathAmplitude(state)
  const breathStyle = {
    ...(period != null ? { '--room-breath-period': `${period}ms` } : {}),
    ...(amp != null ? { '--room-breath-amp': String(amp) } : {})
  } as CSSProperties
  const label = statusText({
    phase,
    llmFailed,
    ...(standbyUntil != null ? { standbyUntil } : {}),
    stage,
    sensing,
    now: Date.now(),
    t
  })

  return (
    <div className="room-bar flex shrink-0 items-center gap-2.5 px-3 py-1.5">
      <span className="shrink-0 text-caption text-fg-muted">{aiName}</span>

      {/* 月相：形状 + 呼吸节奏 + 色温（三重编码，不只靠颜色） */}
      <span
        className={`shrink-0 ${period != null ? 'room-breath' : ''}`}
        style={breathStyle}
        title={t('room.phase')}
        aria-label={t('room.phase')}
        role="img"
      >
        <PixelGlyph rows={moonRows(moon)} size={14} className={tone} />
      </span>
      <span
        className={`min-w-0 truncate text-caption ${tone}`}
        role="status"
        aria-live="polite"
        {...(phase === 'standby' ? { title: t('room.status.standbyHint') } : {})}
      >
        {label}
      </span>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenLog}
          className="room-press flex items-center gap-1 px-1.5 py-1 text-fg-muted"
          title={t('room.log')}
          aria-label={t('room.log')}
        >
          <PixelGlyph rows={GLYPH.log} size={12} />
          <span className="text-caption">{t('room.log')}</span>
        </button>
        <button
          type="button"
          onClick={onOpenDetail}
          className="room-press px-1.5 py-1 text-fg-muted"
          title={t('room.drawer')}
          aria-label={t('room.drawer')}
        >
          <PixelGlyph rows={GLYPH.drawer} size={12} />
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={busy}
          aria-pressed={running}
          className={`room-press flex items-center gap-1.5 px-2.5 py-1 text-caption disabled:opacity-40 ${
            running ? 'text-success' : 'text-fg-secondary'
          }`}
          title={running ? t('room.stop') : t('room.start')}
        >
          <PixelGlyph rows={GLYPH.power} size={12} />
          {running ? t('room.stop') : t('room.start')}
        </button>
      </div>
    </div>
  )
}
