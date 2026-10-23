/**
 * 抽屉 · 日记：读这个 AI 的日记（`diary:get`，**零新 IPC**）。
 *
 * 为什么放在 ROOM：用户要「抽屉里有日记」——自主模式是 AI 自己过日子，日记是它过日子的记录，
 * 放在房间里看最自然（而不是让用户去设置页或别处翻）。
 *
 * 状态覆盖（空 / 加载 / 成功 / 异常）：
 * - 加载中 → 一行「读取中」；
 * - 无该日日记（`content === null`）→ 明确说「这天没写」，**不是错误**；
 * - 读取失败（权限/过大/未登录）→ 显示主进程给的原因（**不吞**）；
 * - 成功 → 以等宽小字原样展示 markdown 源（不渲染 HTML：日记是 AI 自己写的文本，不做富文本解析）。
 *
 * 时间口径：日期在**挂载时采样一次**（`todayIso()`），此后翻页是纯算术（`shiftIso`）。
 */
import { useEffect, useState } from 'react'
import { useT } from '../../../i18n/useT'
import { shiftIso, todayIso } from './dates'

interface DiaryState {
  loading: boolean
  /** `null` = 这天没有日记（合法状态，不是错误） */
  content: string | null
  error: string | null
}

export function DiaryPanel() {
  const t = useT()
  // 挂载时采样一次（此后翻页是纯算术，不在渲染里调时间）
  const [date, setDate] = useState<string>(() => todayIso())
  const [state, setState] = useState<DiaryState>({ loading: true, content: null, error: null })

  useEffect(() => {
    let alive = true
    setState({ loading: true, content: null, error: null })
    void window.lunareclipse?.diaryGet?.(date).then((r) => {
      if (!alive) return
      if (!r?.ok) {
        setState({ loading: false, content: null, error: r?.error ?? t('room.drawer.diaryFailed') })
        return
      }
      setState({ loading: false, content: r.content ?? null, error: null })
    })
    return () => {
      alive = false
    }
  }, [date, t])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 日期条：上一天 / 今天 / 下一天 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={() => setDate((d) => shiftIso(d, -1))}
          className="room-press px-2 py-1 text-caption text-fg-muted"
          title={t('room.drawer.diary.prev')}
        >
          ◀
        </button>
        <span className="min-w-0 flex-1 truncate text-center font-mono text-caption text-fg-secondary">{date}</span>
        <button
          type="button"
          onClick={() => setDate(todayIso())}
          className="room-press px-2 py-1 text-micro text-fg-muted"
          title={t('room.drawer.diary.today')}
        >
          {t('room.drawer.diary.today')}
        </button>
        <button
          type="button"
          onClick={() => setDate((d) => shiftIso(d, 1))}
          className="room-press px-2 py-1 text-caption text-fg-muted"
          title={t('room.drawer.diary.next')}
        >
          ▶
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        {state.loading ? (
          <div className="text-[11px] text-fg-muted">{t('room.drawer.diaryLoading')}</div>
        ) : state.error ? (
          <div className="text-[11px] text-danger">{state.error}</div>
        ) : state.content === null ? (
          <div className="text-[11px] text-fg-muted">{t('room.drawer.diaryEmpty')}</div>
        ) : (
          // 原样展示（不做富文本解析）：日记是 AI 写给自己/用户看的文本
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-5 text-fg-secondary">
            {state.content}
          </pre>
        )}
      </div>
    </div>
  )
}
