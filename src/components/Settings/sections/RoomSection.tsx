/**
 * 设置页「自主房间」分区（ADR-29：**承载面 = 会话页原位视图**，不是独立窗口）。
 *
 * 为什么改：此前本分区的开关是「开独立窗口」（`room:open`/`room:toggle` + `onRoomClosed` 同步
 * 窗口开合状态）。用户明确否定那个形态（「不想单独弹出一个窗口」「一点击自主模式，
 * 直接会话界面就变成自主界面」）。现在本分区只做**入口**：点「进入」把当前会话切换成原位房间
 * （`setChatViewMode('room')`）并关掉设置页。
 *
 * **自主开 / 关不在这里**——那是房间内仪表栏的 ARM 开关。视图不持循环生命周期（见 `RoomView` 文件头），
 * 所以「进入房间」与「开启自主」是两件事，不要在这里顺手拉起循环。
 *
 * 采集器配置（§7：默认关、范围可配、用户可见）仍在本分区。
 *
 * 不删理由：删掉即自主房间没有用户可见入口（只能靠改配置或手输 `?room=1`）。
 */
import { useState, useEffect } from 'react'
import { DoorOpen, Eye } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import { useT } from '../../../i18n/useT'

export function RoomSection() {
  const t = useT()
  const setChatViewMode = useAppStore((s) => s.setChatViewMode)
  const closeSettings = useAppStore((s) => s.closeSettings)
  // 采集器（§7：默认关、范围可配、用户可见）
  const [collector, setCollector] = useState({ enabled: false, desktop: false, processes: false, network: false })

  useEffect(() => {
    void window.lunareclipse?.getConfig?.().then((raw: unknown) => {
      const c = (raw as { collector?: { enabled?: boolean; desktop?: boolean; processes?: boolean; network?: boolean } } | null)?.collector
      if (c) {
        setCollector({
          enabled: c.enabled === true,
          desktop: c.desktop === true,
          processes: c.processes === true,
          network: c.network === true
        })
      }
    })
  }, [])

  /** 进入原位房间：切视图 + 关设置页（两者都在 appStore，无需 IPC）。 */
  const enterRoom = (): void => {
    setChatViewMode('room')
    closeSettings()
  }

  const saveCollector = async (next: {
    enabled: boolean
    desktop: boolean
    processes: boolean
    network: boolean
  }): Promise<void> => {
    setCollector(next)
    await window.lunareclipse?.setConfig?.({ collector: next })
  }

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <DoorOpen size={12} />
          {t('room.title')}
        </div>
        <div className="flex items-center justify-between rounded-card border border-border-subtle bg-bg-elevated px-3 py-3">
          <div className="text-body text-fg-primary">{t('room.entryTitle')}</div>
          <button
            onClick={enterRoom}
            className="flex items-center gap-2 rounded-btn bg-accent px-3 py-2 text-caption text-accent-fg transition-all duration-150 active:scale-95"
          >
            <DoorOpen size={12} />
            {t('room.enter')}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-fg-muted">{t('room.hint')}</p>
      </section>

      {/* ===== 采集器（§7：默认关、范围可配、用户可见）===== */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-caption uppercase tracking-wider text-fg-muted">
          <Eye size={12} />
          {t('collector.title')}
        </div>
        <div className="space-y-2 rounded-card border border-border-subtle bg-bg-elevated px-3 py-3">
          <label className="flex items-center justify-between text-body text-fg-primary">
            <span>{t('collector.enable')}</span>
            <input
              type="checkbox"
              checked={collector.enabled}
              onChange={(e) => void saveCollector({ ...collector, enabled: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between text-body text-fg-primary">
            <span>{t('collector.desktop')}</span>
            <input
              type="checkbox"
              checked={collector.desktop}
              disabled={!collector.enabled}
              onChange={(e) => void saveCollector({ ...collector, desktop: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between text-body text-fg-primary">
            <span>{t('collector.processes')}</span>
            <input
              type="checkbox"
              checked={collector.processes}
              disabled={!collector.enabled}
              onChange={(e) => void saveCollector({ ...collector, processes: e.target.checked })}
            />
          </label>
          <label className="flex items-center justify-between text-body text-fg-primary">
            <span>{t('collector.network')}</span>
            <input
              type="checkbox"
              checked={collector.network}
              disabled={!collector.enabled}
              onChange={(e) => void saveCollector({ ...collector, network: e.target.checked })}
            />
          </label>
          <p className="text-[11px] text-fg-muted">{t('collector.hint')}</p>
        </div>
      </section>
    </div>
  )
}
