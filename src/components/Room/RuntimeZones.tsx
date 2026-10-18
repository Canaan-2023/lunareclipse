/**
 * 为什么存在：B3 的 ROOM 骨架里「规划区 / 记忆区」是占位；B8 接线后它们有了真实数据源
 * （`room:runtime-state`）。本文件把两个区一次接上，避免各写一遍读取逻辑。
 * 作用：规划区（本轮计划 + 事件流 + 立即行动/启停）+ 记忆区（分诊结果 + 采集状态）。
 * 不删理由：删掉即两区退回占位，用户看不到 AI 在房间里「想了什么、做了什么」。
 */
import { useState, useEffect, useCallback } from 'react'
import { Compass, Brain, Play, Square, Zap } from 'lucide-react'
import { useT } from '../../i18n/useT'

interface RuntimeState {
  running: boolean
  lastTick?: {
    phase: string
    acted: boolean
    mode?: string
    triageReason?: string
    error?: string
    executions: Array<{ ok: boolean }>
  }
  lastPlan?: { decisions: Array<{ toolName?: string; description: string }>; note?: string }
  events: Array<{ phase: string; ts: number; detail?: string; mode?: string }>
  /** AI 声明的采集视图（诉求 10：采集什么由 AI 决定） */
  collectorView?: { name: string; scopes: string[]; fields: string[] }
}

function useRuntimeState(aiId: number): { state: RuntimeState | null; reload: () => void } {
  const [state, setState] = useState<RuntimeState | null>(null)
  const reload = useCallback(() => {
    void window.lunareclipse?.roomRuntimeState?.(aiId).then((r) => {
      if (r?.ok) setState(r.state as RuntimeState)
    })
  }, [aiId])
  useEffect(() => {
    reload()
    const timer = setInterval(reload, 3000)
    return () => clearInterval(timer)
  }, [reload])
  return { state, reload }
}

/** 规划区：AI 本轮想做什么 + 房间事件流 + 手动控制（`aiId` = 当前选中的房间所属 AI）。 */
export function PlanZone({ aiId }: { aiId: number }) {
  const t = useT()
  const { state, reload } = useRuntimeState(aiId)
  const [busy, setBusy] = useState(false)

  const act = async (fn: 'tick' | 'start' | 'stop') => {
    setBusy(true)
    const api = window.lunareclipse
    if (fn === 'tick') await api?.roomTick?.(aiId)
    else if (fn === 'start') await api?.roomStartLoop?.(aiId)
    else await api?.roomStopLoop?.(aiId)
    reload()
    setBusy(false)
  }

  const plan = state?.lastPlan
  const tick = state?.lastTick

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="flex items-center justify-between rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="flex items-center gap-2 font-mono text-caption tracking-wider text-fg-muted">
          <Compass size={12} />
          {t('room.zone.plan')}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void act('tick')}
            disabled={busy}
            className="rounded-btn border-2 border-border-subtle px-2 py-1 text-fg-muted active:scale-95 disabled:opacity-40"
            title={t('room.plan.actNow')}
          >
            <Zap size={12} />
          </button>
          <button
            onClick={() => void act(state?.running ? 'stop' : 'start')}
            disabled={busy}
            className={`rounded-btn border-2 px-2 py-1 active:scale-95 disabled:opacity-40 ${
              state?.running ? 'border-red-400/40 text-red-400' : 'border-accent/40 text-accent'
            }`}
            title={state?.running ? t('room.plan.stopLoop') : t('room.plan.startLoop')}
          >
            {state?.running ? <Square size={12} /> : <Play size={12} />}
          </button>
        </div>
      </div>

      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.plan.lastPlan')}</div>
        {!plan || plan.decisions.length === 0 ? (
          <div className="text-[11px] text-fg-muted">{plan?.note || t('room.plan.noPlan')}</div>
        ) : (
          <ol className="space-y-1 text-[11px] text-fg-secondary">
            {plan.decisions.map((d, i) => (
              <li key={i}>
                {i + 1}. <span className="font-mono text-accent">{d.toolName}</span> — {d.description}
              </li>
            ))}
          </ol>
        )}
        {plan?.note && plan.decisions.length > 0 && <div className="mt-2 text-[11px] text-fg-muted">{plan.note}</div>}
      </div>

      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.plan.events')}</div>
        {!state || state.events.length === 0 ? (
          <div className="text-[11px] text-fg-muted">{t('room.plan.noEvents')}</div>
        ) : (
          <div className="space-y-0.5 text-[11px] text-fg-muted">
            {[...state.events].reverse().slice(0, 12).map((e, i) => (
              <div key={i}>
                <span className="font-mono text-fg-secondary">{e.phase}</span>
                {e.mode ? ` [${e.mode}]` : ''}
                {e.detail ? ` — ${e.detail}` : ''}
              </div>
            ))}
          </div>
        )}
      </div>

      {tick && (
        <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3 text-[11px] text-fg-muted">
          {t('room.plan.lastTick')}：{tick.phase}
          {tick.mode ? ` · ${tick.mode}` : ''}
          {tick.executions.length > 0 ? ` · ${tick.executions.length} ${t('room.plan.actions')}` : ''}
          {tick.error ? ` · ${tick.error}` : ''}
        </div>
      )}
    </div>
  )
}

/** 记忆区：分诊结果（即时/长线）+ 采集状态。 */
export function MemoryZone({ aiId }: { aiId: number }) {
  const t = useT()
  const { state } = useRuntimeState(aiId)
  const tick = state?.lastTick

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-2 flex items-center gap-2 font-mono text-caption tracking-wider text-fg-muted">
          <Brain size={12} />
          {t('room.zone.memory')}
        </div>
        <div className="text-[11px] text-fg-secondary">
          {tick?.mode ? (
            <>
              <span className="font-mono text-accent">
                {tick.mode === 'long-term' ? t('room.memory.longTerm') : t('room.memory.immediate')}
              </span>
              {tick.triageReason ? ` — ${tick.triageReason}` : ''}
            </>
          ) : (
            t('room.memory.noTriage')
          )}
        </div>
      </div>
      {/* 采集视图（诉求 10：采集什么由 AI 决定）——AI 声明、主进程校验后生效 */}
      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-1 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.collector.view')}</div>
        {state?.collectorView ? (
          <div className="text-[11px] text-fg-secondary">
            <span className="font-mono text-accent">{state.collectorView.name}</span>
            {` · ${state.collectorView.scopes.join('/')} · ${state.collectorView.fields.join('、')}`}
          </div>
        ) : (
          <div className="text-[11px] text-fg-muted">{t('room.collector.viewDefault')}</div>
        )}
      </div>
      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3 text-[11px] text-fg-muted">
        <div className="mb-1 font-mono tracking-wider">{t('room.memory.chain')}</div>
        {t('room.memory.chainHint')}
      </div>
    </div>
  )
}
