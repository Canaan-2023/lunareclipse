/**
 * @category 前端组件
 * @summary 面板快捷入口行（PANEL_BUTTONS 表 + 横向图标行）
 * @note 为什么存在：`index.tsx` 曾达 804 行破 800 硬红线（ADR-28 拆分）；`PANEL_BUTTONS` 表被折叠态图标条与本组件共用，故表随组件同址导出。
 * @note 不删理由：快捷入口是可发现性的载体（替代旧 2×2 网格），表与渲染同址避免两处漂移。
 */

import {
  BarChart3,
  Globe,
  ListTodo,
  GraduationCap,
  CalendarDays,
  Puzzle,
  Timer,
  Webhook,
  FileTerminal,
  ShieldCheck,
  DatabaseBackup,
  Users,
  Workflow,
  Network
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { RightPanelTabId } from '../../stores/appStore'
import { useT } from '../../i18n/useT'

/** 面板快捷入口：横向图标行，点击直接打开对应面板标签
 * 替代旧 2×2 网格，保留可发现性但更精简 */
export const PANEL_BUTTONS: { tabId: RightPanelTabId; icon: typeof Globe; labelKey: string }[] = [
  { tabId: 'browser', icon: Globe, labelKey: 'tab.browser' },
  { tabId: 'social', icon: Users, labelKey: 'tab.social' },
  { tabId: 'workshop', icon: FileTerminal, labelKey: 'tab.workshop' },
  { tabId: 'todo', icon: ListTodo, labelKey: 'tab.todo' },
  { tabId: 'skill', icon: GraduationCap, labelKey: 'tab.skill' },
{ tabId: 'calendar', icon: CalendarDays, labelKey: 'tab.calendar' },
  { tabId: 'plugin', icon: Puzzle, labelKey: 'tab.plugin' },
  { tabId: 'cron', icon: Timer, labelKey: 'tab.cron' },
  { tabId: 'hook', icon: Webhook, labelKey: 'tab.hook' },
  { tabId: 'workflow', icon: Workflow, labelKey: 'tab.workflow' },
]

export function PanelQuickRow({ isMaster, isSatellite }: { isMaster: boolean; isSatellite: boolean }) {
  const openRightPanelTab = useAppStore((s) => s.openRightPanelTab)
  const rightPanelTabs = useAppStore((s) => s.rightPanelTabs)
  const activeDrawer = useAppStore((s) => s.activeDrawer)
  const vizPanelOpen = useAppStore((s) => s.vizPanelOpen)
  const memoryGraphOpen = useAppStore((s) => s.memoryGraphOpen)
  const t = useT()
  // 备份中心按账号自助使用：主系统与分系统都可见，单机模式不显示
  const canBackup = isMaster || isSatellite

  return (
    <div className="flex flex-wrap items-center gap-0.5">
      {PANEL_BUTTONS.map((p) => {
        const isOpen = rightPanelTabs.includes(p.tabId) || activeDrawer === p.tabId
        return (
          <button
            key={p.tabId}
            onClick={() => openRightPanelTab(p.tabId)}
            className={`flex h-6 w-6 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
              isOpen
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={t(p.labelKey)}
          >
            <p.icon size={13} />
          </button>
        )
      })}
{/* 监控可视化按钮：与面板图标同尺寸同间距，消除错位 */}
      <button
        onClick={() => {
          useAppStore.getState().setVizPanelOpen(true)
          void useAppStore.getState().refreshVisualization()
        }}
        className={`flex h-6 w-6 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
          vizPanelOpen
            ? 'bg-accent/15 text-accent'
            : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
        }`}
        title={t('sidebar.viz')}
      >
        <BarChart3 size={13} />
      </button>
      {/* 记忆/图谱数据开关：与监控面板独立，点击查看记忆列表与 NNG 图谱数据 */}
      <button
        onClick={() => useAppStore.getState().setMemoryGraphOpen(!memoryGraphOpen)}
        className={`flex h-6 w-6 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
          memoryGraphOpen
            ? 'bg-accent/15 text-accent'
            : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
        }`}
        title={t('sidebar.memoryGraph')}
      >
        <Network size={13} />
      </button>
      {/* 主系统管理按钮：仅 master 角色显示（左下角快捷入口） */}
      {isMaster && (
        <button
          onClick={() => openRightPanelTab('admin')}
          className={`flex h-6 w-6 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
            activeDrawer === 'admin'
              ? 'bg-accent/15 text-accent'
              : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
          }`}
          title={t('tab.admin')}
        >
          <ShieldCheck size={13} />
        </button>
      )}
      {/* 备份中心：主/分系统各自自助备份（本机归档 / 从主系统提取），与账号管理局独立成两个入口 */}
      {canBackup && (
        <button
          onClick={() => openRightPanelTab('backup')}
          className={`flex h-6 w-6 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
            activeDrawer === 'backup'
              ? 'bg-accent/15 text-accent'
              : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
          }`}
          title={t('tab.backup')}
        >
          <DatabaseBackup size={13} />
        </button>
      )}
    </div>
  )
}
