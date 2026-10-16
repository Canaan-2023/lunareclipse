/**
 * 为什么存在：右侧标签页系统需要统一的图标/标题元信息映射，供标签渲染与动态模块面板解析，
 * 避免各面板各自维护一份重复清单。
 * 作用：导出 TAB_META（标签图标 + i18n labelKey）与 DYNAMIC_ICON_MAP，渲染右侧标签头。
 */
import { Users, Globe, Code2, FileText, GraduationCap, Heart, Puzzle, Timer, ListTodo, Webhook, Calendar, CalendarDays, LayoutGrid, BookOpenText, MessageSquare, Plus, X, FileTerminal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import type { RightPanelTabId } from '../stores/appStore'
import { useT } from '../i18n/useT'

/** 标签页元信息：图标 + i18n key */
const TAB_META: Record<string, { icon: LucideIcon; labelKey: string }> = {
  chat: { icon: MessageSquare, labelKey: 'tab.chat' },
  browser: { icon: Globe, labelKey: 'tab.browser' },
  social: { icon: Users, labelKey: 'tab.social' },
  workshop: { icon: FileTerminal, labelKey: 'tab.workshop' },
  skill: { icon: GraduationCap, labelKey: 'tab.skill' },
  lilith: { icon: Heart, labelKey: 'tab.lilith' },
  plugin: { icon: Puzzle, labelKey: 'tab.plugin' },
  cron: { icon: Timer, labelKey: 'tab.cron' },
  hook: { icon: Webhook, labelKey: 'tab.hook' },
  todo: { icon: ListTodo, labelKey: 'tab.todo' },
  calendar: { icon: Calendar, labelKey: 'tab.calendar' }
}

/** 动态面板图标名 -> lucide-react 组件映射 */
const DYNAMIC_ICON_MAP: Record<string, LucideIcon> = {
  LayoutGrid,
  BookOpenText,
  GraduationCap,
  FileText,
  Code2,
  Globe,
  Puzzle,
  Calendar,
  CalendarDays,
  Timer,
  ListTodo,
  Webhook,
  Heart
}

/** 获取标签页元信息：先查硬编码 TAB_META，再查动态面板声明 */
function getTabMeta(tabId: RightPanelTabId, dynamicPanels: Array<{ id: string; title: string; icon: string; component: string }>): { icon: LucideIcon; labelKey: string; label?: string } {
  const hardcoded = TAB_META[tabId]
  if (hardcoded) return hardcoded

  if (typeof tabId === 'string' && tabId.startsWith('plugin:')) {
    const panelId = tabId.slice('plugin:'.length)
    const dyn = dynamicPanels.find((p) => p.id === panelId)
    if (dyn) {
      const icon = DYNAMIC_ICON_MAP[dyn.icon] ?? LayoutGrid
      return { icon, labelKey: '', label: dyn.title }
    }
  }

  return { icon: LayoutGrid, labelKey: '', label: String(tabId) }
}

/**
 * 浏览器式全宽标签栏：所有功能面板 + 会话共用同一行标签。
 * 末尾 "+" 按钮 -> 新建会话（浏览器式"新标签页"心智：当前所有面板
 * 均有侧边栏快捷入口，面板目录弹层已移除）。
 * 'chat' 是永久会话标签，不可关闭。
 */
export function RightPanelTabs() {
  const tabs = useAppStore((s) => s.rightPanelTabs)
  const activeTab = useAppStore((s) => s.activeRightPanel)
  const setActive = useAppStore((s) => s.setActiveRightPanel)
  const closeTab = useAppStore((s) => s.closeRightPanelTab)
  const requestNewSession = useAppStore((s) => s.requestNewSession)
  const dynamicPanels = useAppStore((s) => s.dynamicPanels)
  const vizPanelOpen = useAppStore((s) => s.vizPanelOpen)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const t = useT()

  const openChatAndNewSession = () => {
    // 无论当前停在哪个面板标签，点 "+" 都回到会话并新建（标签末尾 "+" = 新建会话页；
    // 多 AI 时弹选择器，仅系统月蚀时直接建会话）
    setActive('chat')
    requestNewSession()
  }

  if (tabs.length === 0 || vizPanelOpen || settingsOpen) return null

  return (
    <div className="titlebar-seamless flex shrink-0 items-stretch overflow-x-auto border-b border-border-subtle bg-bg-surface [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={{ height: '32px' }}
    >
      {tabs.map((tab) => {
        const meta = getTabMeta(tab, dynamicPanels)
        const Icon = meta.icon
        const isActive = activeTab === tab
        const isChat = tab === 'chat'
        const labelText = meta.label ?? t(meta.labelKey)
        return (
          <button
            key={tab}
            onClick={() => setActive(tab)}
            aria-current={isActive ? 'page' : undefined}
            className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border-subtle px-3 transition-colors ${
              isActive
                ? 'bg-bg-base text-fg-primary'
                : 'text-fg-muted hover:bg-bg-muted/50 hover:text-fg-secondary'
            }`}
            title={labelText}
          >
            <Icon size={13} className={isActive ? 'text-accent' : ''} />
            <span className="text-caption whitespace-nowrap">{labelText}</span>
            {!isChat && (
              <span
                role="button"
                tabIndex={0}
                aria-label={t('tab.close')}
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(tab)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    closeTab(tab)
                  }
                }}
                className="ml-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded text-fg-muted opacity-0 transition-all hover:bg-bg-muted hover:text-fg-primary group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                title={t('tab.close')}
              >
                <X size={10} />
              </span>
            )}
          </button>
        )
      })}
      {/* 新建会话 "+"（浏览器式"新标签页"语义）；AI 管理入口位于侧栏「+ 新建会话」左侧 */}
      <button
        onClick={openChatAndNewSession}
        className="flex shrink-0 cursor-pointer items-center gap-1 border-r border-border-subtle px-2.5 text-fg-muted transition-colors hover:bg-bg-muted/50 hover:text-fg-secondary"
        title={t('sidebar.newSession')}
        aria-label={t('sidebar.newSession')}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}