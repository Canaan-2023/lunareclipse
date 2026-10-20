/**
 * ROOM 的「记录」：**GALGAME 式回看抽屉**。
 *
 * 为什么是抽屉而不是常驻分栏（用户 2026-10-20）：
 * 「占用了大量的窗口很糟糕」；GALGAME 的做法是——舞台占满，记录按需打开。
 * 这里的**内容仍是它自己的终端流**（不做成 GALGAME 台词），但**承载方式是 GALGAME 的 LOG**：
 * 一个可以随时打开、按时间回看、关闭后不占版面的面板。
 *
 * 不删理由：删掉即「它做过什么」重新变成常驻窗口占用，或者只能去翻 room-events.jsonl。
 */
import { useEffect, useRef } from 'react'
import { useT } from '../../i18n/useT'
import { OutputStream } from './OutputStream'
import type { RoomEvent } from './room-status'

export function RoomLogPanel({
  open,
  onClose,
  events,
  live
}: {
  open: boolean
  onClose: () => void
  events: RoomEvent[]
  live: boolean
}) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)

  // 打开时焦点移入、Esc 关闭、关闭后把焦点还给打开它的按钮（与 DetailPanel 同口径）
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    boxRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prev?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <>
      <div className="absolute inset-0 z-20 bg-black/55" onClick={onClose} aria-hidden="true" />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('room.log')}
        tabIndex={-1}
        className="absolute inset-y-2 left-1/2 z-30 flex w-[min(56rem,calc(100%-1rem))] -translate-x-1/2 flex-col overflow-hidden rounded-card border border-border-subtle bg-bg-base/96 shadow-2xl outline-none backdrop-blur-md"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle/60 px-4 py-2">
          <span className="font-mono text-caption tracking-wider text-fg-secondary">{t('room.log')}</span>
          <span className="min-w-0 truncate text-micro text-fg-muted">{t('room.log.hint')}</span>
          <button
            type="button"
            onClick={onClose}
            className="room-press ml-auto px-2 py-0.5 text-caption text-fg-muted"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <OutputStream events={events} live={live} />
        </div>
      </div>
    </>
  )
}
