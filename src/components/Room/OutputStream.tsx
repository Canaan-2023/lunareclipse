/**
 * ROOM 的**唯一输出**：一条终端流。
 *
 * 用户裁决：「其实没必要什么都摆在明面上，**留出一个输出**，其余的总之」。此前同一件事
 * （AI 在干什么）被拆在四处说（相位灯 / 状态栏 / 计划区 / 事件流），用户没有「先看什么」。
 * 现在只有一条：**它做过的，按时间一行行**。
 *
 * 为什么是终端语气（用户选定「终端流」）：日志式混排（它说的与它做的同列）最安静，
 * 也最像「AI 的输出」——不需要图标、不需要分组、不需要折叠，扫一眼就知道它刚做了什么。
 *
 * 与顶栏的分工（**不重复**）：
 * - 顶栏说**现在**（一行：状态 + 阶段）；
 * - 这里说**过去**（历史）。所以本组件不渲染「当前状态」那一行。
 *
 * 可访问性：`role="log"` + `aria-live="polite"`（新行播报）；时间与阶段是辅助信息、低对比，
 * 正文才是主体；出错行用语义 `text-danger`（不只靠颜色——行首有 `!` 标记）。
 */
import { useEffect, useRef } from 'react'
import { useT } from '../../i18n/useT'
import type { RoomEvent } from './room-status'

/** 出错行着色 + 行首标记：detail 里出现这些词即判为异常（失败/拒绝/错误/异常） */
const ERROR_RE = /失败|拒绝|错误|异常|error|fail|reject/i

/** 阶段 → 语义 token（六主题自适应；只用既有 token） */
function phaseTone(phase: string): string {
  switch (phase) {
    case 'plan':
      return 'text-accent'
    case 'execute':
      return 'text-success'
    default:
      return 'text-fg-muted'
  }
}

/** 事件流的阶段列：内部是 `collect/triage/...` 枚举，给人看要转成中文（用户不该读到半截代码） */
const LOOP_PHASES = new Set(['collect', 'triage', 'recall', 'plan', 'execute', 'idle'])

function phaseText(phase: string, t: (key: string) => string): string {
  return LOOP_PHASES.has(phase) ? t(`room.stage.${phase}`) : phase
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 终端流最多渲染多少行（够回看，且不给长跑的房间堆 DOM） */
export const STREAM_MAX_LINES = 200

export function OutputStream({ events, live = false }: { events: RoomEvent[]; live?: boolean }) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)
  /**
   * 「贴底」而不是「永远跳到底」：用户往上翻历史时，新行不能把他拽回来。
   * 只有原本就在底部附近（<32px）才跟随；手动滚回底部后自然恢复跟随。
   */
  const stickRef = useRef(true)
  const lines = events.length > STREAM_MAX_LINES ? events.slice(events.length - STREAM_MAX_LINES) : events
  const count = lines.length

  // 新行到达时滚到底（终端语义：最新的在下面）——但只在用户没有往上翻的时候
  useEffect(() => {
    const el = boxRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [count])

  const onScroll = (): void => {
    const el = boxRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }

  return (
    <div className="room-stream flex min-h-0 flex-1 flex-col overflow-hidden" role="log" aria-live="polite" aria-label={t('room.stream')}>
      <div
        ref={boxRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 text-micro leading-5"
      >
        {count === 0 ? (
          <div className="text-fg-muted">{t('room.stream.empty')}</div>
        ) : (
          lines.map((e, i) => {
            const bad = e.detail != null && ERROR_RE.test(e.detail)
            const latest = i === lines.length - 1
            return (
              <div key={`${e.ts}-${i}`} className={`room-stream-line flex gap-2 ${latest ? 'room-stream-line-latest' : ''}`}>
                <span className="shrink-0 text-fg-muted/70">{formatTime(e.ts)}</span>
                <span className={`shrink-0 ${phaseTone(e.phase)}`}>{phaseText(e.phase, t)}</span>
                {e.mode && (
                  <span className="shrink-0 text-fg-muted/70">
                    {e.mode === 'long-term' ? t('room.stream.mode.long') : t('room.stream.mode.immediate')}
                  </span>
                )}
                {e.detail && (
                  <span className={`min-w-0 flex-1 truncate ${bad ? 'text-danger' : 'text-fg-secondary'}`}>
                    {bad && <span aria-hidden="true">! </span>}
                    {e.detail}
                  </span>
                )}
              </div>
            )
          })
        )}
        {/* 光标：它在跑 = 它还醒着（reduced-motion 下不闪） */}
        {live && <div className="room-cursor text-accent" aria-hidden="true">▍</div>}
      </div>
    </div>
  )
}
