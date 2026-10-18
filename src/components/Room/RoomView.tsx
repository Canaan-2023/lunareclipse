/**
 * @category 前端组件
 * @summary 自主房间（ROOM）原位视图：会话页内直接切换成的「月蚀驾驶舱」像素房间
 *
 * 为什么存在（ADR-29）：ROOM 此前是**独立 BrowserWindow**（`?room=1`），且工作区是 1~6 个对话窗格——
 * 用户明确否定这个形态（「不是一个个对话窗口，而是月蚀的功能接口」「不想单独弹出一个窗口」
 * 「一点击自主模式，直接会话界面就变成自主界面」）。本组件是**原位视图**：与「会话树」
 * （`chatViewMode==='tree'` → `InternalSessionsView`）同一个范式，由 `ChatArea` 原位替换渲染。
 *
 * 形态（像素风 v2）：ROOM = 驾驶舱。顶栏仪表（相位灯 / 自主开关 / 急停）+ 左侧三主区导航 +
 * 主区内容 + 底部事件流。像素感来自结构（2px 硬边 + 浮雕 + 0 圆角 + 像素图标），见 `globals.css`
 * 的 `.room-pixel`。像素房间与 AI 拟人化形象见 `RoomScene`（P2）。
 *
 * 两条有意语义（勿回退）：
 * - **房间所属 AI = 当前会话所属 AI**（只读标签，不再有顶栏 `<select>`）——切换 AI 用会话页既有选择器；
 *   这也顺带解决了「一个窗口装不下多 AI 自主态」的结构性问题（运行时可有多实例）。
 * - **视图不持有循环生命周期**：自主开关只表达「要 / 不要」，真正的持有者/释放者是主进程
 *   `RoomLoopSupervisor`（引用计数）；因此**切走视图不会停循环**（自主语义），关窗/退出由主进程兜底。
 *
 * 不删理由：删掉即自主模式退回独立窗口或干脆没有可视化承载面。
 */
import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_AI_ID } from '@shared/types'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { LanMapSection } from '../Settings/sections/LanMapSection'
import { PlanZone, MemoryZone } from './RuntimeZones'
import { ToolZone } from './ToolZone'
import { InstrumentBar, ZoneRail, type RoomPhase, type RoomZone } from './RoomChrome'
import { RoomScene } from './RoomScene'
import { RoomTicker, type RoomEvent } from './RoomTicker'
import { DeviceZone } from './DeviceZone'

/**
 * 原位自主房间。`sessionId` = 承载它的会话（AI 从会话取，见文件头）。
 */
export function RoomView({ sessionId }: { sessionId: string }) {
  const t = useT()
  const sessions = useAppStore((s) => s.sessions)
  const ais = useAppStore((s) => s.ais)
  const aiId = sessions.find((s) => s.id === sessionId)?.aiId ?? DEFAULT_AI_ID
  const aiName = ais.find((a) => a.id === aiId)?.name ?? `AI${aiId}`

  const [zone, setZone] = useState<RoomZone>('executor')
  const [phase, setPhase] = useState<RoomPhase>('stopped')
  const [events, setEvents] = useState<RoomEvent[]>([])
  const [avatarRev, setAvatarRev] = useState(0)
  const [loopError, setLoopError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = phase !== 'stopped'

  // 只读运行态（视图不持生命周期）：刷新不 start/stop，仅同步显示相位、事件流与形象修订号。
  // 3s 轮询让相位灯保持实时（原实现只在挂载/启停后刷一次，灯是死的）。
  // 注：`room:runtime-state` 目前有创建副作用（P2-8），B-D 改为无副作用 getter 后此处不变。
  const refresh = useCallback(() => {
    void window.lunareclipse?.roomRuntimeState?.(aiId).then((r) => {
      if (!r?.ok) return
      const st = r.state as { phase?: RoomPhase; events?: RoomEvent[]; avatarRev?: number } | undefined
      setPhase(st?.phase ?? 'stopped')
      setEvents(st?.events ?? [])
      setAvatarRev(st?.avatarRev ?? 0)
    })
  }, [aiId])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [refresh])

  // 「用户来了」唤醒源（ADR-29 裁决3）：ROOM 视图可见 / 窗口聚焦即**上报**一次。
  // 只上报——是否真的唤醒由主进程 `room/wake.ts` 的仲裁器去抖后决定（同源 5s / 跨源 60s）。
  useEffect(() => {
    const report = (): void => {
      void window.lunareclipse?.roomWake?.(aiId)
    }
    report()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') report()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [aiId])

  const start = useCallback(async () => {
    setBusy(true)
    setLoopError(null)
    try {
      const r = await window.lunareclipse?.roomStartLoop?.(aiId)
      if (r && r.ok === false) setLoopError(r.error ?? null)
    } finally {
      setBusy(false)
      refresh()
    }
  }, [aiId, refresh])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await window.lunareclipse?.roomStopLoop?.(aiId)
    } finally {
      setBusy(false)
      refresh()
    }
  }, [aiId, refresh])

  return (
    <div className="room-pixel flex h-full min-h-0 w-full flex-col gap-2 bg-bg-base p-2">
      <InstrumentBar
        aiName={aiName}
        phase={phase}
        running={running}
        busy={busy}
        error={loopError}
        onToggle={() => void (running ? stop() : start())}
        onEstop={() => void stop()}
      />

      {/* 像素房间：AI 拟人化可视化（相位 → 帧）——ROOM 的视觉主体 */}
      <RoomScene phase={phase} avatarRev={avatarRev} />

      {/* 诚实边界（ADR-29 裁决3）：最小授予下「自主」只到感知+规划+只读动作，必须明示 */}
      {running && <div className="shrink-0 px-1 text-micro text-fg-muted">{t('room.honest')}</div>}

      <div className="flex min-h-0 flex-1 gap-2">
        <ZoneRail zone={zone} onSelect={setZone} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          {zone === 'executor' && (
            <div className="space-y-3">
              {/* 执行器 = 装工具、影响外面、做操作的地方：计划/事件 + 自造工具 */}
              <PlanZone aiId={aiId} />
              <ToolZone />
            </div>
          )}
          {zone === 'collector' && <MemoryZone aiId={aiId} />}
          {zone === 'device' && (
            <div className="space-y-3">
              {/* 设备管理区 = 真设备列表（B-B2）+ 局域网地图（ADR-29：lan 归设备管理区） */}
              <DeviceZone />
              <LanMapSection />
            </div>
          )}
        </main>
      </div>

      <RoomTicker events={events} />
    </div>
  )
}
