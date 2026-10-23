/**
 * 「形象与背景」：**用户侧独立配置**（人物位置/大小 + 背景来源）。
 *
 * 为什么单独一层（用户 2026-10-20）：「人物的图像也好，什么也罢，我觉得都可以单独配置比较好」。
 * 这里不替用户做审美决定，只提供边界清晰的参数；舞台立即生效，配置落 `<data>/room/appearance.json`。
 *
 * 边界：
 * - 人物 x/y/scale 有明确上下限（与 `@shared/room/appearance` 同一份）；
 * - 背景只认 `<data>/room/background/background.png`（PNG 魔数 + 尺寸/体积校验在主进程）；
 * - 保存走用户 IPC，AI 不可写。
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  DEFAULT_ROOM_APPEARANCE,
  parseRoomAppearance,
  ROOM_CHARACTER_LIMITS,
  characterSourceOf,
  type RoomAppearance,
  type RoomCharacterSource
} from '@shared/room/appearance'
import { useT } from '../../../i18n/useT'
import { reloadAppearance, saveAppearance, useAppearance } from '../use-appearance'

function field(label: string, hint: string, children: ReactNode) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-fg-muted" title={hint}>
        {label}
      </span>
      {children}
    </label>
  )
}

export function AppearancePanel({ aiId }: { aiId: number }) {
  const t = useT()
  const state = useAppearance(aiId)
  const [x, setX] = useState(String(DEFAULT_ROOM_APPEARANCE.character.x))
  const [y, setY] = useState(String(DEFAULT_ROOM_APPEARANCE.character.y))
  const [lift, setLift] = useState(String(DEFAULT_ROOM_APPEARANCE.character.lift))
  const [scale, setScale] = useState(String(DEFAULT_ROOM_APPEARANCE.character.scale))
  const [source, setSource] = useState<RoomCharacterSource>(characterSourceOf(DEFAULT_ROOM_APPEARANCE))
  const [mode, setMode] = useState<RoomAppearance['background']['mode']>(DEFAULT_ROOM_APPEARANCE.background.mode)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  // 配置从主进程回来 / 保存成功后同步到输入框
  useEffect(() => {
    setX(String(state.appearance.character.x))
    setY(String(state.appearance.character.y))
    setLift(String(state.appearance.character.lift))
    setScale(String(state.appearance.character.scale))
    setSource(characterSourceOf(state.appearance))
    setMode(state.appearance.background.mode)
  }, [state.appearance])

  const save = async (next: RoomAppearance): Promise<void> => {
    const parsed = parseRoomAppearance(next)
    if (!parsed.ok) {
      setStatus({ ok: false, text: `${t('room.appearance.invalid')}：${parsed.error}` })
      return
    }
    setSaving(true)
    setStatus(null)
    try {
      const r = await saveAppearance(aiId, parsed.appearance)
      setStatus({ ok: r.ok, text: r.ok ? t('room.appearance.saved') : (r.error ?? t('room.appearance.invalid')) })
    } finally {
      setSaving(false)
    }
  }

  const saveCurrent = (): Promise<void> =>
    save({
      version: 1,
      characterSource: source,
      character: { x: Number(x), y: Number(y), lift: Number(lift), scale: Number(scale) },
      background: { mode }
    })

  const reset = (): Promise<void> => save({ ...DEFAULT_ROOM_APPEARANCE })

  return (
    <section className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] tracking-wider text-fg-muted">{t('room.appearance.title')}</span>
        <span className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void reloadAppearance(aiId)}
            className="room-press px-2 py-0.5 text-micro text-fg-muted"
          >
            {t('room.appearance.reload')}
          </button>
          <button
            type="button"
            onClick={() => void reset()}
            disabled={saving}
            className="room-press px-2 py-0.5 text-micro text-fg-muted disabled:opacity-40"
          >
            {t('room.appearance.reset')}
          </button>
          <button
            type="button"
            onClick={() => void saveCurrent()}
            disabled={saving}
            className="room-press px-2 py-0.5 text-micro text-accent disabled:opacity-40"
          >
            {t('common.save')}
          </button>
        </span>
      </div>

      <div className="mb-2 font-mono text-micro text-fg-muted">{t('room.appearance.source')}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setSource('portrait')}
          aria-pressed={source === 'portrait'}
          className={`room-press px-2 py-0.5 text-micro ${source === 'portrait' ? 'text-accent' : 'text-fg-muted'}`}
        >
          {t('room.appearance.sourcePortrait')}
        </button>
        <button
          type="button"
          onClick={() => setSource('live2d')}
          aria-pressed={source === 'live2d'}
          className={`room-press px-2 py-0.5 text-micro ${source === 'live2d' ? 'text-accent' : 'text-fg-muted'}`}
        >
          {t('room.appearance.sourceLive2d')}
        </button>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-fg-muted">{t('room.appearance.sourceHint')}</p>
      {source === 'live2d' && !state.live2d && (
        <div className="mt-1.5 text-micro text-warning">{t('room.appearance.live2dMissing')}</div>
      )}

      <div className="mb-2 mt-3 font-mono text-micro text-fg-muted">{t('room.appearance.character')}</div>
      <p className="mb-1.5 text-[11px] leading-5 text-fg-muted">{t('room.appearance.scopeHint')}</p>
      <div className="space-y-1.5">
        {field(
          t('room.appearance.x'),
          `${ROOM_CHARACTER_LIMITS.x.min} ~ ${ROOM_CHARACTER_LIMITS.x.max}`,
          <input
            type="number"
            step="0.05"
            min={ROOM_CHARACTER_LIMITS.x.min}
            max={ROOM_CHARACTER_LIMITS.x.max}
            value={x}
            onChange={(e) => setX(e.target.value)}
            className="w-24 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-right font-mono text-micro text-fg-primary"
          />
        )}
        {field(
          t('room.appearance.y'),
          `${ROOM_CHARACTER_LIMITS.y.min} ~ ${ROOM_CHARACTER_LIMITS.y.max}`,
          <input
            type="number"
            step="0.05"
            min={ROOM_CHARACTER_LIMITS.y.min}
            max={ROOM_CHARACTER_LIMITS.y.max}
            value={y}
            onChange={(e) => setY(e.target.value)}
            className="w-24 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-right font-mono text-micro text-fg-primary"
          />
        )}
        {field(
          t('room.appearance.lift'),
          `${ROOM_CHARACTER_LIMITS.lift.min} ~ ${ROOM_CHARACTER_LIMITS.lift.max}（正数向上）`,
          <input
            type="number"
            step="1"
            min={ROOM_CHARACTER_LIMITS.lift.min}
            max={ROOM_CHARACTER_LIMITS.lift.max}
            value={lift}
            onChange={(e) => setLift(e.target.value)}
            className="w-24 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-right font-mono text-micro text-fg-primary"
          />
        )}
        {field(
          t('room.appearance.scale'),
          `${ROOM_CHARACTER_LIMITS.scale.min} ~ ${ROOM_CHARACTER_LIMITS.scale.max}`,
          <input
            type="number"
            step="0.05"
            min={ROOM_CHARACTER_LIMITS.scale.min}
            max={ROOM_CHARACTER_LIMITS.scale.max}
            value={scale}
            onChange={(e) => setScale(e.target.value)}
            className="w-24 rounded-btn border border-border-subtle bg-bg-base px-2 py-1 text-right font-mono text-micro text-fg-primary"
          />
        )}
      </div>
      <p className="mt-1.5 text-[11px] leading-5 text-fg-muted">{t('room.appearance.directHint')}</p>

      <div className="mb-2 mt-3 font-mono text-micro text-fg-muted">{t('room.appearance.background')}</div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setMode('code')}
          aria-pressed={mode === 'code'}
          className={`room-press px-2 py-0.5 text-micro ${mode === 'code' ? 'text-accent' : 'text-fg-muted'}`}
        >
          {t('room.appearance.bgCode')}
        </button>
        <button
          type="button"
          onClick={() => setMode('image')}
          aria-pressed={mode === 'image'}
          className={`room-press px-2 py-0.5 text-micro ${mode === 'image' ? 'text-accent' : 'text-fg-muted'}`}
        >
          {t('room.appearance.bgImage')}
        </button>
        {state.background && (
          <img
            src={state.background}
            alt=""
            className="ml-auto h-10 w-16 rounded-btn border border-border-subtle object-cover"
          />
        )}
      </div>
      <div className="mt-1.5 break-all font-mono text-micro text-fg-secondary" title={state.dir ?? ''}>
        {state.dir ?? t('room.drawer.about.mascotNoDir')}
      </div>
      <p className="mt-1 text-[11px] leading-5 text-fg-muted">{t('room.appearance.bgHint')}</p>
      {mode === 'image' && !state.background && (
        <div className="mt-1.5 text-micro text-warning">{t('room.appearance.bgMissing')}</div>
      )}

      <div className="mb-2 mt-3 font-mono text-micro text-fg-muted">{t('room.appearance.scenes')}</div>
      <div className="break-all font-mono text-micro text-fg-secondary" title={state.scenesDir ?? ''}>
        {state.scenesDir ?? t('room.drawer.about.mascotNoDir')}
      </div>
      <p className="mt-1 text-[11px] leading-5 text-fg-muted">{t('room.appearance.scenesHint')}</p>
      <div className="mt-1 text-micro text-fg-muted">
        {Object.keys(state.scenes).length > 0
          ? Object.keys(state.scenes).join(' / ')
          : t('room.appearance.scenesNone')}
      </div>
      {state.live2d && (
        <div className="mt-3 rounded-card border border-border-subtle/60 p-2 text-micro">
          <div className="text-success">Live2D：{state.live2d.model}</div>
          <div className="mt-1 text-fg-secondary">
            模型与 Cubism Core 由你自备（放在房间数据目录的 live2d/ 下），不随安装包分发。
          </div>
          <div className="mt-1 leading-5 text-warning">
            Live2D 核心是专有软件（不是 AGPL）；请确认你有权使用该模型，并遵守 Live2D 的发布许可。
          </div>
        </div>
      )}
      {state.error && <div className="mt-1.5 text-micro text-danger">{state.error}</div>}
      {status && (
        <div className={`mt-1.5 text-micro ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</div>
      )}
    </section>
  )
}
