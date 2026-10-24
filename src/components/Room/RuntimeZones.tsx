/**
 * 为什么存在：B3 的 ROOM 骨架里「规划区 / 记忆区」是占位；B8 接线后它们有了真实数据源
 * （房间运行态快照）。
 *
 * 作用（**UI 重做后收窄**）：这两块不再常驻主界面——它们住在「细节」面板里
 * （`DetailPanel` 的动作页 / 感知页），因为用户裁决「没必要什么都摆在明面上，留出一个输出」。
 * - 规划区：本轮计划 + **当前落点** + 立即行动（启停归顶栏的开关，**不在这里重复**）；
 * - 记忆区：分诊结果 + 采集视图。
 * **事件流不在这里**——它已经是主界面上那条**唯一输出**（`OutputStream`），不再重复一份。
 *
 * ⚠️ **本文件不取数**：运行态由唯一取数点 `useRoomRuntimeState`（见 `use-room-state.ts`）下传。
 *
 * 不删理由：删掉即「它打算做什么 / 它能看到什么」无处可看。
 */
import { useState } from 'react'
import { Compass, Brain, Zap } from 'lucide-react'
import { useT } from '../../i18n/useT'
import type { RoomRuntimeSnapshot } from './room-status'

/** 规划区：AI 本轮想做什么 + 当前落点 + 立即行动（`aiId` = 当前选中的房间所属 AI）。 */
export function PlanZone({ aiId, state }: { aiId: number; state: RoomRuntimeSnapshot }) {
  const t = useT()
  const [busy, setBusy] = useState(false)

  // 动作后的状态由主进程推送回来（`room:tick` 会触发状态推送），因此不需要手动取数。
  const act = async (fn: 'tick') => {
    setBusy(true)
    const api = window.lunareclipse
    try {
      if (fn === 'tick') await api?.roomTick?.(aiId)
    } finally {
      setBusy(false)
    }
  }

  const plan = state.lastPlan
  const tick = state.lastTick

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

      {tick && (
        <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3 text-[11px] text-fg-muted">
          {t('room.plan.lastTick')}：{tick.phase}
          {tick.mode ? ` · ${tick.mode}` : ''}
          {(tick.executions?.length ?? 0) > 0 ? ` · ${tick.executions?.length} ${t('room.plan.actions')}` : ''}
          {tick.error ? ` · ${tick.error}` : ''}
        </div>
      )}
    </div>
  )
}

/** 记忆区：分诊结果（即时/长线）+ 采集视图。 */
export function MemoryZone({ state }: { state: RoomRuntimeSnapshot }) {
  const t = useT()
  const tick = state.lastTick

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
        {state.collectorView ? (
          <div className="text-[11px] text-fg-secondary">
            <span className="font-mono text-accent">{state.collectorView.name}</span>
            {` · ${state.collectorView.scopes.join('/')} · ${state.collectorView.fields.join('、')}`}
          </div>
        ) : (
          <div className="text-[11px] text-fg-muted">{t('room.collector.viewDefault')}</div>
        )}
      </div>
      {/* 上下文落点（ADR-30 R2/R3）：AI 主动声明自己接着哪条线。
          0.53.18 起只有承载会话这一棵树，故只显示节点 id；未声明时显示「沿用 AI 自己维护的承接线」。 */}
      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3">
        <div className="mb-1 font-mono text-[11px] tracking-wider text-fg-muted">{t('room.landing.title')}</div>
        {state.landing ? (
          <div className="text-[11px] text-fg-secondary">
            <span className="font-mono text-accent">{t('room.landing.tree')}</span>
            {` → ${state.landing.internalId}`}
          </div>
        ) : (
          <div className="text-[11px] text-fg-muted">{t('room.landing.none')}</div>
        )}
      </div>
      <div className="rounded-card border-2 border-border-subtle bg-bg-surface p-3 text-[11px] text-fg-muted">
        <div className="mb-1 font-mono tracking-wider">{t('room.memory.chain')}</div>
        {t('room.memory.chainHint')}
      </div>
    </div>
  )
}
