/**
 * ROOM 的「细节」面板：**一次点击之后**的那一层。
 *
 * 用户裁决：「没必要什么都摆在明面上，留出一个输出，**其余的**…」。所以常驻只剩
 * 顶栏 + 房间画面 + 输出流；**其余一切**（它打算做什么 / 它能看到什么 / 它能碰什么 /
 * 日记 / 授权 / 关于）全部收进这里——不是删除，是**降一层**。
 *
 * 六页与「它在做什么」的心智模型对齐（不是按实现模块分）：
 * 动作（计划 + 落点 + 工具）/ 感知（分诊 + 采集视图 + 用户层开关）/ 设备（设备 + 局域网）/
 * 日记 / 授权 / 关于。
 *
 * **按需取数**：只挂载当前页的组件——切到哪页才取哪页；**关闭时整块不渲染**
 * （不是「渲染了再隐藏」，否则里面的组件仍会取数）。
 *
 * 可访问性：`role="dialog"` + `aria-modal`；打开时焦点移入、`Esc` 关闭、关闭后焦点还原；
 * tab 用 `role="tablist"` / `aria-selected` / `aria-controls` / `aria-labelledby`。
 *
 * 不删理由：删掉即「其余一切」在房间里无处可看——极简不等于没有深度。
 */
import { useEffect, useRef } from 'react'
import { useT } from '../../i18n/useT'
import { GLYPH, PixelGlyph } from './pixel-icons'
import type { RoomRuntimeSnapshot } from './room-status'
import { MemoryZone, PlanZone } from './RuntimeZones'
import { ToolZone } from './ToolZone'
import { ModelConfigZone } from './ModelConfigZone'
import { DeviceZone } from './DeviceZone'
import { LanMapSection } from '../Settings/sections/LanMapSection'
import { DiaryPanel } from './drawer/DiaryPanel'
import { AboutPanel, SensorsPanel } from './drawer/RoomPanels'
import { AppearancePanel } from './drawer/AppearancePanel'
import { SecurityPanel } from '../Security/SecurityPanel'

export type DetailTab = 'act' | 'sense' | 'device' | 'diary' | 'look' | 'grants' | 'about'

const TABS: Array<{ id: DetailTab; key: string }> = [
  { id: 'act', key: 'room.detail.act' },
  { id: 'sense', key: 'room.detail.sense' },
  { id: 'device', key: 'room.detail.device' },
  { id: 'diary', key: 'room.drawer.tab.diary' },
  { id: 'look', key: 'room.appearance.tab' },
  { id: 'grants', key: 'room.drawer.tab.grants' },
  { id: 'about', key: 'room.drawer.tab.about' }
]

const tabId = (t: DetailTab): string => `room-detail-tab-${t}`
const panelId = (t: DetailTab): string => `room-detail-panel-${t}`

export function DetailPanel({
  open,
  tab,
  onTab,
  onClose,
  state,
  aiId,
  aiName,
  hostSessionId
}: {
  open: boolean
  tab: DetailTab
  onTab: (tab: DetailTab) => void
  onClose: () => void
  state: RoomRuntimeSnapshot
  aiId: number
  aiName: string
  /** 承载会话（0.53.18：自主模式继承的那个会话的逆生树） */
  hostSessionId?: string
}) {
  const t = useT()
  const boxRef = useRef<HTMLDivElement>(null)

  // 打开时焦点移入、Esc 关闭、关闭后把焦点还给「打开它的那个按钮」
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
      {/* 遮罩：主题无关的压暗层（任何主题下遮罩都该是黑的） */}
      <div className="absolute inset-0 z-20 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('room.drawer')}
        tabIndex={-1}
        className="room-panel absolute inset-y-2 right-2 z-30 flex w-[min(32rem,calc(100%-1rem))] flex-col gap-2 p-3 outline-none"
      >
        <div className="flex shrink-0 items-center gap-2">
          <PixelGlyph rows={GLYPH.drawer} size={14} className="text-accent" />
          <span className="text-caption text-fg-secondary">{t('room.drawer')}</span>
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

        <div role="tablist" aria-label={t('room.drawer')} className="flex shrink-0 flex-wrap gap-1">
          {TABS.map((x) => (
            <button
              key={x.id}
              id={tabId(x.id)}
              type="button"
              role="tab"
              aria-selected={tab === x.id}
              aria-controls={panelId(x.id)}
              onClick={() => onTab(x.id)}
              className={`room-press px-2 py-1 text-caption ${tab === x.id ? 'text-accent' : 'text-fg-muted'}`}
            >
              {t(x.key)}
            </button>
          ))}
        </div>

        {/* 按需挂载：只取当前页的数据 */}
        <div id={panelId(tab)} role="tabpanel" aria-labelledby={tabId(tab)} className="flex min-h-0 flex-1 flex-col">
          {tab === 'act' && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              <PlanZone aiId={aiId} state={state} />
              <ToolZone />
              {/* AUTO 模型路由（AI 自主选模型）：用户侧配置 + 切换审计 + 余额。
                  0.53.6 接回——之前改版把它落成了孤儿组件。 */}
              <ModelConfigZone />
            </div>
          )}
          {tab === 'sense' && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              <MemoryZone state={state} />
              <SensorsPanel state={state} aiId={aiId} onOpenGrants={() => onTab('grants')} />
            </div>
          )}
          {tab === 'device' && (
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
              <DeviceZone />
              <LanMapSection />
            </div>
          )}
          {tab === 'diary' && <DiaryPanel />}
          {tab === 'look' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <AppearancePanel aiId={aiId} />
            </div>
          )}
          {/* 授权页 = 与设置页**同一个组件**（授予界面只允许有一份实现，两处必然漂移） */}
          {tab === 'grants' && (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SecurityPanel />
            </div>
          )}
          {tab === 'about' && (
            <AboutPanel aiId={aiId} aiName={aiName} {...(hostSessionId ? { hostSessionId } : {})} />
          )}
        </div>
      </div>
    </>
  )
}
