/**
 * ROOM **旧独立窗口分支**的根组件（灰度回滚用，默认不达）——ADR-29 已把承载面改为会话页
 * **原位视图**（`RoomView`）。本组件只在 `config.room.viewMode === 'window'` 时可达
 * （见 `electron/main/room-window.ts`），保留一个发布周期供一键回滚，B-F 观察期零回滚后删除。
 *
 * 六分区（规划/工作/工具/记忆/局域网/模型）是**旧形态**：原位视图已按 ADR-29 归并为三主区
 * （执行器/采集器/设备），`model` 移出回设置页、`work` 删除。**勿在此继续加功能**——
 * 改动只应发生在 `RoomView` 侧。
 *
 * 不删理由（限时）：作为 `viewMode='window'` 的回滚目标存在。
 */
import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { X, Compass, Wrench, Brain, Network, Cpu, Plus, Minus } from 'lucide-react'
import { DEFAULT_AI_ID } from '@shared/types'
import { useT } from '../../i18n/useT'
import { OverlayChat } from '../Chat/OverlayChat'
import { LanMapSection } from '../Settings/sections/LanMapSection'
import { ModelConfigZone } from './ModelConfigZone'
import { PlanZone, MemoryZone } from './RuntimeZones'
import { ToolZone } from './ToolZone'

type Zone = 'plan' | 'work' | 'tools' | 'memory' | 'lan' | 'model'

interface AiOption {
  id: number
  name: string
  deactivated?: boolean
}

const THEME_CLASSES = ['frost-glass', 'parchment', 'night', 'violet-night', 'eclipse', 'gilded']

/** 分区骨架（B4~B7 在此填充） */
const ZONES: Array<{ id: Zone; key: string; icon: typeof Compass }> = [
  { id: 'plan', key: 'room.zone.plan', icon: Compass },
  { id: 'work', key: 'room.zone.work', icon: Wrench },
  { id: 'tools', key: 'room.zone.tools', icon: Cpu },
  { id: 'memory', key: 'room.zone.memory', icon: Brain },
  { id: 'lan', key: 'room.zone.lan', icon: Network },
  { id: 'model', key: 'room.zone.model', icon: Cpu }
]

export function RoomApp() {
  const t = useT()
  const [zone, setZone] = useState<Zone>('work')
  const [workPanes, setWorkPanes] = useState(2)
  // 房间所属 AI（ADR-25 L3）：每个 AI 一个独立房间实例（会话/RAW 各归各）
  const [aiId, setAiId] = useState(DEFAULT_AI_ID)
  const [ais, setAis] = useState<AiOption[]>([])
  const [roomEnabled, setRoomEnabled] = useState(false)
  const [loopError, setLoopError] = useState<string | null>(null)

  // 主题与主窗口一致（副窗口有独立 store，需自行应用 html 主题类）+ 取 AI 清单
  useEffect(() => {
    const api = window.lunareclipse
    if (!api?.getConfig) return
    const applyTheme = (theme: string): void => {
      const html = document.documentElement
      for (const c of THEME_CLASSES) html.classList.remove(c)
      html.classList.add(theme)
    }
    void api.getConfig().then((raw: unknown) => {
      const cfg = raw as { theme?: string; room?: { enabled?: boolean } } | null
      if (cfg?.theme) applyTheme(cfg.theme)
      // 独立开关口径（§7「开启后 ROOM 才运作」）：房间开启则启动自主循环，关闭窗口时停
      setRoomEnabled(cfg?.room?.enabled === true)
    })
    // AI 枚举（含已下线——其数据保留但不运行）
    void api.aiList?.().then((r) => {
      const list = (r?.ais ?? []) as AiOption[]
      if (list.length > 0) setAis(list.map((a) => ({ id: a.id, name: a.name, deactivated: a.deactivated })))
    })
    // 主窗口切主题会广播 theme:change，房间跟随
    const offTheme = api.onThemeChange?.((theme: string) => applyTheme(theme))
    return () => offTheme?.()
  }, [])

  // 自主循环跟随「选中 AI」：切换 AI 时停旧房间、起新房间（各 AI 互不影响）
  useEffect(() => {
    if (!roomEnabled) return
    const api = window.lunareclipse
    setLoopError(null)
    void api?.roomStartLoop?.(aiId).then((r) => {
      if (r && r.ok === false) setLoopError(r.error ?? null)
    })
    return () => {
      // 关窗/切 AI 即停循环（不留常驻定时器）
      void api?.roomStopLoop?.(aiId)
    }
  }, [aiId, roomEnabled])

  const close = useCallback(() => {
    void window.lunareclipse?.roomClose?.()
  }, [])

  const paneBody = (index: number) => {
    if (index === 0) return <OverlayChat />
    return (
      <div className="flex h-full items-center justify-center rounded-card border-2 border-dashed border-border-subtle text-caption text-fg-muted">
        {t('room.emptyPane')}
      </div>
    )
  }

  return (
    <div className="room-pixel flex h-screen w-screen flex-col bg-bg-base text-fg-primary">
      {/* ===== 顶栏（可拖拽） ===== */}
      <div
        className="flex h-9 shrink-0 items-center justify-between border-b-2 border-border-subtle bg-bg-elevated px-3"
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <span className="font-mono text-caption tracking-widest text-accent">ROOM · {t('room.title')}</span>
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
          {/* 房间所属 AI（ADR-25 L3）：每个 AI 一个独立房间 */}
          <span className="font-mono text-[11px] text-fg-muted">{t('room.selectAi')}</span>
          <select
            value={aiId}
            onChange={(e) => setAiId(Number(e.target.value))}
            className="rounded-btn border-2 border-border-subtle bg-bg-surface px-1 py-0.5 font-mono text-[11px] text-fg-secondary"
          >
            {(ais.length > 0 ? ais : [{ id: DEFAULT_AI_ID, name: `AI${DEFAULT_AI_ID}` }]).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.deactivated ? ` ${t('room.aiOffline')}` : ''}
              </option>
            ))}
          </select>
          {loopError && <span className="font-mono text-[11px] text-red-400">{loopError}</span>}
        </div>
        <button
          onClick={close}
          className="rounded-btn px-2 py-1 text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-primary active:scale-95"
          style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}
          title={t('room.close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ===== 左侧分区栏（像素风；左侧栏不在「工作区铺满」范围内） ===== */}
        <nav className="w-36 shrink-0 space-y-1 border-r-2 border-border-subtle bg-bg-surface p-2">
          {ZONES.map(({ id, key, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setZone(id)}
              className={`flex w-full items-center gap-2 rounded-btn border-2 px-2 py-2 text-caption transition-all duration-150 active:scale-95 ${
                zone === id
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-transparent text-fg-muted hover:border-border-subtle hover:text-fg-secondary'
              }`}
            >
              <Icon size={12} />
              {t(key)}
            </button>
          ))}
        </nav>

        {/* ===== 分区内容 ===== */}
        <main className="min-w-0 flex-1 overflow-hidden p-3">
          {zone === 'work' && (
            <div className="flex h-full flex-col">
              <div className="mb-2 flex shrink-0 items-center justify-between">
                <span className="font-mono text-caption tracking-wider text-fg-muted">{t('room.zone.work')}</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setWorkPanes((n) => Math.max(1, n - 1))}
                    className="rounded-btn border-2 border-border-subtle px-2 py-1 text-fg-muted active:scale-95"
                    title={t('room.removePane')}
                  >
                    <Minus size={12} />
                  </button>
                  <button
                    onClick={() => setWorkPanes((n) => Math.min(6, n + 1))}
                    className="rounded-btn border-2 border-border-subtle px-2 py-1 text-fg-muted active:scale-95"
                    title={t('room.addPane')}
                  >
                    <Plus size={12} />
                  </button>
                </div>
              </div>
              <div
                className="grid min-h-0 flex-1 gap-2"
                style={{ gridTemplateColumns: `repeat(${workPanes > 1 ? 2 : 1}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: workPanes }, (_, i) => (
                  <div key={i} className="min-h-0 overflow-hidden rounded-card border-2 border-border-subtle bg-bg-surface">
                    {paneBody(i)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {zone === 'lan' && (
            <div className="h-full overflow-y-auto">
              <LanMapSection />
            </div>
          )}

          {zone === 'model' && (
            <div className="h-full">
              <ModelConfigZone />
            </div>
          )}

          {zone === 'plan' && <PlanZone aiId={aiId} />}
          {zone === 'memory' && <MemoryZone aiId={aiId} />}

          {zone === 'tools' && <ToolZone />}
        </main>
      </div>
    </div>
  )
}
