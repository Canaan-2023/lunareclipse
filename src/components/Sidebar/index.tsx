/**
 * 为什么存在：主聊天区左侧需要会话管理、功能入口与记忆开关的集合导航，交互密度高，
 * 独立组件承载并内聚侧栏逻辑。
 * 作用：会话列表（增删改/置顶/切换）、右侧功能标签入口、记忆胶囊（记忆开关/条数）、
 * 模型切换与登出。
 */
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Plus, MessageSquare, Trash2, Edit2, Check, X, BarChart3, Repeat, LogOut, Settings, ChevronsLeft, ChevronsRight, Heart, Moon, ChevronDown, Globe, ListTodo, GraduationCap, CalendarDays, Puzzle, Timer, Webhook, Pin, FileTerminal, ShieldCheck, DatabaseBackup, Users, UserCircle, Wand2 } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { DEFAULT_AI_ID, type Session } from '@shared/types'
import type { RightPanelTabId } from '../../stores/appStore'
import { ModelSwitcher } from './ModelSwitcher'
import { useT } from '../../i18n/useT'
import type { TFunc } from '../../i18n/useT'
import { resolveAiName, aiAvatarFallback } from '../Ai/AiManagerPanel'
import { AiAvatar } from '../Ai/AiAvatar'

/** 相对时间格式化（i18n） */
function formatRelativeTime(ts: number, t: TFunc): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('sidebar.time.justNow')
  if (diff < 3600_000) return t('sidebar.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('sidebar.time.hoursAgo', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('sidebar.time.daysAgo', { n: Math.floor(diff / 86400_000) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 取会话最后一条消息内容预览（空白合并 + 截断 30 字） */
function getLastMessagePreview(s: Session): string | null {
  if (!s.messages || s.messages.length === 0) return null
  const last = s.messages[s.messages.length - 1]
  const text = last.content?.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 30 ? text.slice(0, 30) + '...' : text
}

/** 记忆状态胶囊：替代 DMN/MW/DW 三按钮
 * 平时显示一行摘要 + 三个圆点（金色=开），点击内联展开开关列表（非浮层 popover） */
function MemoryCapsule() {
  const memoryWorkflowEnabled = useAppStore((s) => s.memoryWorkflowEnabled)
  const setMemoryWorkflowEnabled = useAppStore((s) => s.setMemoryWorkflowEnabled)
  const diaryWorkflowEnabled = useAppStore((s) => s.diaryWorkflowEnabled)
  const setDiaryWorkflowEnabled = useAppStore((s) => s.setDiaryWorkflowEnabled)
  const t = useT()

  const [open, setOpen] = useState(false)

  const items = [
    { label: t('sidebar.memoryWorkflow'), desc: t('sidebar.memoryWorkflowDesc'), on: memoryWorkflowEnabled, toggle: () => setMemoryWorkflowEnabled(!memoryWorkflowEnabled) },
    { label: t('sidebar.diaryWorkflow'), desc: t('sidebar.diaryWorkflowDesc'), on: diaryWorkflowEnabled, toggle: () => setDiaryWorkflowEnabled(!diaryWorkflowEnabled) },
  ]

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-btn px-2 py-1 text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
        title={t('sidebar.memoryStatus')}
      >
        <Moon size={11} className="shrink-0 text-fg-muted" />
        <span className="flex-1 text-left">{t('sidebar.memory')}</span>
        <div className="flex items-center gap-0.5">
          {items.map((item) => (
            <span
              key={item.label}
              className={`h-1.5 w-1.5 rounded-full ${item.on ? 'bg-accent' : 'bg-fg-muted/30'}`}
              title={`${item.label}: ${item.on ? '开' : '关'}`}
            />
          ))}
        </div>
        <ChevronDown size={10} className={`text-fg-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 rounded-btn border border-border-subtle bg-bg-muted/30 px-1.5 py-1.5">
          {items.map((item) => (
            <button
              key={item.label}
              onClick={item.toggle}
              className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 text-left transition-colors hover:bg-bg-muted"
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${item.on ? 'bg-accent' : 'bg-fg-muted/30'}`} />
              <div className="min-w-0 flex-1">
                <div className="text-caption text-fg-secondary">{item.label}</div>
                <div className="text-micro text-fg-muted">{item.desc}</div>
              </div>
              <span className={`shrink-0 text-[10px] font-medium ${item.on ? 'text-accent' : 'text-fg-muted'}`}>
                {item.on ? 'ON' : 'OFF'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 头像菜单：替代 TitleBar 登出/设置 + 侧栏用户行切换/登出 */
function AvatarMenu() {
  const currentUser = useAppStore((s) => s.currentUser)
  const switchUser = useAppStore((s) => s.switchUser)
  const logout = useAppStore((s) => s.confirmLogout)
const openSettings = useAppStore((s) => s.openSettings)
  const openRightPanelTab = useAppStore((s) => s.openRightPanelTab)
  const t = useT()

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  if (!currentUser) return null

  const displayName = currentUser.昵称 || currentUser.用户名

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-btn px-2 py-1.5 transition-colors hover:bg-bg-muted"
        title={displayName}
      >
        <AiAvatar avatar={currentUser.头像} fallback={displayName.charAt(0).toUpperCase()} className="h-7 w-7 text-sm" />
        <span className="min-w-0 flex-1 truncate text-left text-xs text-fg-primary">{displayName}</span>
        <ChevronDown size={10} className="shrink-0 text-fg-muted" />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 w-full min-w-[140px] rounded-btn border border-border bg-bg-elevated py-1 shadow-lg">
          <button
            onClick={() => { setOpen(false); openRightPanelTab('profile') }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
          >
            <UserCircle size={12} className="shrink-0 text-fg-muted" />
            <span>{t('sidebar.profile')}</span>
          </button>
          <button
            onClick={() => { setOpen(false); openSettings() }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
          >
            <Settings size={12} className="shrink-0 text-fg-muted" />
            <span>{t('sidebar.settings')}</span>
          </button>
          <button
            onClick={() => { setOpen(false); void switchUser() }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
          >
            <Repeat size={12} className="shrink-0 text-fg-muted" />
            <span>{t('sidebar.switchUser')}</span>
          </button>
          <button
            onClick={() => { setOpen(false); void logout() }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-caption text-fg-secondary transition-colors hover:bg-bg-muted"
          >
            <LogOut size={12} className="shrink-0 text-fg-muted" />
            <span>{t('sidebar.logout')}</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** 面板快捷入口：横向图标行，点击直接打开对应面板标签
 * 替代旧 2×2 网格，保留可发现性但更精简 */
const PANEL_BUTTONS: { tabId: RightPanelTabId; icon: typeof Globe; labelKey: string }[] = [
  { tabId: 'browser', icon: Globe, labelKey: 'tab.browser' },
  { tabId: 'social', icon: Users, labelKey: 'tab.social' },
  { tabId: 'workshop', icon: FileTerminal, labelKey: 'tab.workshop' },
  { tabId: 'todo', icon: ListTodo, labelKey: 'tab.todo' },
  { tabId: 'skill', icon: GraduationCap, labelKey: 'tab.skill' },
{ tabId: 'calendar', icon: CalendarDays, labelKey: 'tab.calendar' },
  { tabId: 'plugin', icon: Puzzle, labelKey: 'tab.plugin' },
  { tabId: 'cron', icon: Timer, labelKey: 'tab.cron' },
  { tabId: 'hook', icon: Webhook, labelKey: 'tab.hook' },
]

function PanelQuickRow({ isMaster, isSatellite }: { isMaster: boolean; isSatellite: boolean }) {
  const openRightPanelTab = useAppStore((s) => s.openRightPanelTab)
  const rightPanelTabs = useAppStore((s) => s.rightPanelTabs)
  const activeDrawer = useAppStore((s) => s.activeDrawer)
  const vizPanelOpen = useAppStore((s) => s.vizPanelOpen)
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

export function Sidebar() {
  const sessions = useAppStore((s) => s.sessions)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const requestNewSession = useAppStore((s) => s.requestNewSession)
  const createSession = useAppStore((s) => s.createSession)
  const ais = useAppStore((s) => s.ais)
  const aiNameFallback = useAppStore((s) => s.config?.aiName ?? '月蚀')
  const selectSession = useAppStore((s) => s.selectSession)
  const renameSession = useAppStore((s) => s.renameSession)
  const deleteSession = useAppStore((s) => s.deleteSession)
const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed)
  const openRightPanelTab = useAppStore((s) => s.openRightPanelTab)
  const activeDrawer = useAppStore((s) => s.activeDrawer)
  const lilithChatOpen = useAppStore((s) => s.lilithChatOpen)
  const openLilithChat = useAppStore((s) => s.openLilithChat)
  const closeLilithChat = useAppStore((s) => s.closeLilithChat)
  const currentUser = useAppStore((s) => s.currentUser)
  const switchUser = useAppStore((s) => s.switchUser)
  const lilithEnabled = useAppStore((s) => s.config.lilith?.enabled !== false)
  const pinnedSessions = useAppStore((s) => s.pinnedSessions)
  const togglePinSession = useAppStore((s) => s.togglePinSession)
  const t = useT()

const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [lilithPreview, setLilithPreview] = useState<string | null>(null)
  const [lilithTotal, setLilithTotal] = useState(0)

  // 主系统角色（master 时显示左下角管理入口）
  const [isMaster, setIsMaster] = useState(false)
  const [isSatellite, setIsSatellite] = useState(false)
  useEffect(() => {
    window.lunareclipse?.multiGetStatus?.()
      .then((s) => {
        setIsMaster(s.role === 'master')
        setIsSatellite(s.role === 'satellite')
      })
      .catch(() => {
        setIsMaster(false)
        setIsSatellite(false)
      })
  }, [])

  const refreshLilithPreview = useCallback(async () => {
    try {
      const port = window.lunareclipse?.getApiPort?.()
      if (!port) return
      const r = await fetch(`http://127.0.0.1:${port}/api/lilith/history`)
      const data = await r.json()
      if (Array.isArray(data.messages)) {
        const last = data.messages[data.messages.length - 1]
        const text = last?.content?.replace(/\s+/g, ' ').trim()
        setLilithPreview(text ? (text.length > 24 ? text.slice(0, 24) + '...' : text) : null)
        setLilithTotal(typeof data.total === 'number' ? data.total : data.messages.length)
      }
    } catch {
      /* 月蚀后端未就绪，忽略 */
    }
  }, [])

  useEffect(() => {
    if (!lilithEnabled) return
    refreshLilithPreview()
    const t = setInterval(refreshLilithPreview, 3000)
    return () => clearInterval(t)
  }, [refreshLilithPreview, lilithEnabled])

const sortedSessions = useMemo(() => {
    const pinned = sessions.filter((s) => pinnedSessions.includes(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const rest = sessions.filter((s) => !pinnedSessions.includes(s.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return [...pinned, ...rest]
  }, [sessions, pinnedSessions])

  // 会话按 AI 拆分分组：组序 = 本月蚀(1) 优先，其余按 aiId 升序（莉莉丝独立窗口不占会话列表）
  const sessionGroups = useMemo(() => {
    const map = new Map<number, Session[]>()
    for (const s of sortedSessions) {
      const k = s.aiId ?? DEFAULT_AI_ID
      const arr = map.get(k)
      if (arr) arr.push(s)
      else map.set(k, [s])
    }
    return [...map.entries()]
      .map(([aiId, sessions]) => ({ aiId, sessions, rec: ais.find((a) => a.id === aiId) ?? null }))
      .sort((a, b) => {
        const a0 = a.aiId === DEFAULT_AI_ID ? -1 : 0
        const b0 = b.aiId === DEFAULT_AI_ID ? -1 : 0
        return a0 - b0 || a.aiId - b.aiId
      })
  }, [sortedSessions, ais])

  const startEdit = (s: Session) => {
    setEditingId(s.id)
    setEditValue(s.title)
  }

  const confirmEdit = async () => {
    if (editingId && editValue.trim()) {
      await renameSession(editingId, editValue.trim())
    }
    setEditingId(null)
    setEditValue('')
  }

  // ===== 折叠态：图标条（48px 宽，仅显示核心操作图标） =====
  if (sidebarCollapsed) {
    return (
      <aside
        className="titlebar-seamless flex w-12 shrink-0 flex-col items-center overflow-hidden border-r border-border-subtle bg-bg-surface py-2"
      >
{/* 展开 */}
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="flex h-8 w-8 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-95"
          title={t('sidebar.expand')}
        >
          <ChevronsRight size={16} />
        </button>

{/* AI 管理（魔法棒）— 折叠态侧栏 "+" 上方的等价入口；'ai' 为 LIGHT_PANEL，openRightPanelTab 即打开抽屉 */}
        <button
          onClick={() => openRightPanelTab('ai')}
          className="mt-2 flex h-8 w-8 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-95"
          title={t('tab.ai')}
        >
          <Wand2 size={16} />
        </button>

{/* 新建会话 */}
        <button
          onClick={requestNewSession}
          className="mt-2 flex h-8 w-8 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-95"
          title={t('sidebar.newSession')}
        >
          <Plus size={16} />
        </button>

{/* 会话图标列表：选中会话右下角小绿点指示 */}
        <div className="mt-2 flex flex-1 flex-col items-center gap-1 overflow-y-auto px-1">
          {sortedSessions.slice(0, 20).map((s) => {
            const isSelected = currentSessionId === s.id
            return (
              <button
                key={s.id}
                onClick={() => selectSession(s.id)}
                className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                  isSelected
                    ? 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/30'
                    : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
                }`}
                title={s.title}
              >
                <MessageSquare size={14} />
                {isSelected && <span className="absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.8)]" />}
              </button>
            )
          })}
        </div>

        {/* 底部：面板快捷入口 + 监控可视化 + 莉莉丝 + 头像 */}
        <div className="flex flex-col items-center gap-1 border-t border-border-subtle pt-1.5">
          {/* 常用面板快捷入口 */}
          <div className="flex flex-col items-center gap-0.5 pb-1">
            {PANEL_BUTTONS
              .filter((p) => p.tabId !== 'social' || isMaster || isSatellite)
              .slice(0, 4)
              .map((p) => {
              const Icon = p.icon
              const openRightPanelTab = useAppStore.getState().openRightPanelTab
              return (
                <button
                  key={p.tabId}
                  onClick={() => openRightPanelTab(p.tabId)}
                  className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-secondary active:scale-95"
                  title={t(p.labelKey)}
                >
                  <Icon size={12} />
                </button>
              )
            })}
          </div>
          <div className="w-6 border-t border-border-subtle" />
          {lilithEnabled && (
            <button
              onClick={() => {
                if (lilithChatOpen) closeLilithChat()
                else openLilithChat()
              }}
              className={`flex h-7 w-7 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                lilithChatOpen
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
              title={lilithChatOpen ? t('sidebar.lilithClose') : t('sidebar.lilithOpen')}
            >
              <Heart size={14} />
            </button>
          )}
<button
            onClick={() => {
              useAppStore.getState().setVizPanelOpen(true)
              void useAppStore.getState().refreshVisualization()
            }}
            className="flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-fg-secondary active:scale-95"
            title={t('sidebar.vizOpen')}
          >
            <BarChart3 size={14} />
          </button>
          {isMaster && (
            <button
              onClick={() => useAppStore.getState().openDrawer('admin')}
              className={`flex h-7 w-7 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
                activeDrawer === 'admin'
                  ? 'bg-accent/15 text-accent'
                  : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
              }`}
              title={t('tab.admin')}
            >
              <ShieldCheck size={14} />
            </button>
          )}
          {currentUser && (
<button
              onClick={() => void switchUser()}
              className="mt-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all duration-150 hover:bg-bg-muted active:scale-95"
              title={`${currentUser.昵称 || currentUser.用户名}（${t('sidebar.switchUser')}）`}
            >
              <AiAvatar avatar={currentUser.头像} fallback={(currentUser.昵称 || currentUser.用户名).charAt(0).toUpperCase()} className="h-7 w-7 text-xs" />
            </button>
          )}
        </div>
      </aside>
    )
  }

  return (
    <aside
className="titlebar-seamless flex shrink-0 flex-col overflow-hidden border-r border-border-subtle bg-bg-surface"
      style={{ width: `${sidebarWidth}px` }}
    >
      {/* 头部：新建会话 + 折叠 */}
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className="text-caption uppercase tracking-wider text-fg-muted">
          {t('sidebar.sessions')}
        </span>
<div className="flex items-center gap-1">
{/* AI 管理（魔法棒）— 置于新建会话 "+" 左侧；'ai' 为 LIGHT_PANEL，openRightPanelTab 即打开 AI 管理抽屉 */}
          <button
            onClick={() => openRightPanelTab('ai')}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-95"
            title={t('tab.ai')}
          >
            <Wand2 size={14} />
          </button>
          <button
            onClick={requestNewSession}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-95"
            title={t('sidebar.newSession')}
          >
            <Plus size={14} />
          </button>
          <button
            onClick={() => setSidebarCollapsed(true)}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all duration-150 hover:bg-bg-muted hover:text-accent active:scale-95"
            title={t('sidebar.collapse')}
          >
            <ChevronsLeft size={14} />
          </button>
        </div>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {/* 莉莉丝 · 置顶独立会话栏 */}
        {lilithEnabled && (
                      <div
              role="button"
              tabIndex={0}
              onClick={() => {
                if (lilithChatOpen) closeLilithChat()
                else openLilithChat()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  if (lilithChatOpen) closeLilithChat()
                  else openLilithChat()
                }
              }}
              className={`group relative mb-1 flex cursor-pointer items-center gap-2 rounded-btn px-3 py-2 transition-all duration-150 ${
              lilithChatOpen
                ? 'bg-accent/15 text-fg-primary ring-1 ring-inset ring-accent/30'
                : 'text-fg-secondary hover:bg-bg-muted/70 active:bg-bg-muted'
            }`}
            title={lilithChatOpen ? t('sidebar.lilithClose') : t('sidebar.lilithOpen')}
          >
            {/* 莉莉丝会话行是可点击整行（切换对话）：补 role/tabIndex/键盘处理保证键盘可达，
                整行点击是桌面临时对话的主入口，不能删。 */}
            {lilithChatOpen && (
              <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-accent" />
            )}
            <Heart size={14} className={`shrink-0 ${lilithChatOpen ? 'text-accent' : 'text-fg-muted'}`} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-body">{t('sidebar.lilith')}</span>
                <span className="shrink-0 text-micro text-fg-muted">
                  {lilithTotal > 0 ? `${lilithTotal}` : t('sidebar.lilithDesktop')}
                </span>
              </div>
              <span className="mt-0.5 block truncate text-caption text-fg-muted">
                {lilithPreview ?? t('sidebar.lilithShared')}
              </span>
            </div>
          </div>
        )}

{sessionGroups.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-fg-muted">
            {t('sidebar.emptyHint')}
          </div>
        ) : (
          <div className="mx-2 mb-1 border-t border-border-subtle" />
        )}
        {sessionGroups.length > 0 &&
          sessionGroups.map((g) => {
            const info = resolveAiName(g.aiId, ais, aiNameFallback)
            const disabled = g.rec?.deactivated === true
            return (
            <div key={g.aiId} className="mb-1.5">
              {/* 组头：AI 徽标 + 新建该 AI 会话 */}
              <div className="flex items-center justify-between gap-2 px-1 pb-0.5 pt-1">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="shrink-0">
                    <AiAvatar avatar={info.avatar} fallback={aiAvatarFallback(g.aiId)} className="h-4.5 w-4.5 text-[11px]" />
                  </span>
                  <span className="truncate text-caption font-medium text-fg-secondary">{info.name}</span>
                  <span className="shrink-0 text-micro text-fg-muted">#{g.aiId}</span>
                </span>
                {!disabled && (
                  <button
                    onClick={() => void createSession(g.aiId)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-accent active:scale-95"
                    title={`${t('sidebar.newSession')} · ${info.name}`}
                  >
                    <Plus size={12} />
                  </button>
                )}
              </div>
              {/* 组内该 AI 的会话：选中会话标题旁小绿点指示 */}
              {g.sessions.map((s) => {
                const isSelected = currentSessionId === s.id
                const preview = getLastMessagePreview(s)
                return (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => editingId !== s.id && selectSession(s.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (editingId !== s.id) selectSession(s.id)
                    }
                  }}
                  className={`group relative mb-1 flex cursor-pointer items-start gap-2 rounded-btn px-3 py-2 transition-all duration-150 ${
                    isSelected
                      ? 'bg-accent/15 text-fg-primary ring-1 ring-inset ring-accent/30'
                      : 'text-fg-secondary hover:bg-bg-muted/70 active:bg-bg-muted'
                  }`}
                >
                  {isSelected && (
                    <span className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-accent" />
                  )}
                  <MessageSquare size={14} className={`mt-0.5 shrink-0 ${isSelected ? 'text-accent' : 'text-fg-muted'}`} />
                  {pinnedSessions.includes(s.id) && (
                    <Pin size={10} className="mt-0.5 shrink-0 fill-accent/20 text-accent" />
                  )}
                  {editingId === s.id ? (
                    <div className="flex flex-1 items-center gap-1">
                      <input
                        autoFocus
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') confirmEdit()
                          if (e.key === 'Escape') {
                            setEditingId(null)
                            setEditValue('')
                          }
                        }}
                        className="min-w-0 flex-1 bg-transparent text-body text-fg-primary outline-none"
                        onClick={(e) => e.stopPropagation()}
                      />
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          confirmEdit()
                        }}
                        className="text-fg-muted hover:text-accent"
                      >
                        <Check size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingId(null)
                          setEditValue('')
                        }}
                        className="text-fg-muted hover:text-red-400"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <>
                <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-1.5">
                          {isSelected && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-400 shadow-[0_0_5px_rgba(74,222,128,0.8)]" />
                          )}
                          <span className="truncate text-body">
                            {s.title}
                          </span>
                        </span>
                        <span className="shrink-0 text-micro text-fg-muted">
                          {formatRelativeTime(s.updatedAt, t)}
                        </span>
                      </div>
                      {preview && (
                        <span className="mt-0.5 block truncate text-caption text-fg-muted">
                          {preview}
                        </span>
                      )}
                    </div>
                    {/* 会话行操作（钉住/改名/删除）：
                       为什么不用 hidden group-hover:flex：display:none 使键盘/触屏无法触达
                       其中的删除等操作（评审 MAJOR-1），改 opacity + group-focus-within
                       保证 hover 与键盘聚焦时都可见可点。 */}
                    <div className="flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          togglePinSession(s.id)
                        }}
                        className="text-fg-muted hover:text-accent"
                        title={pinnedSessions.includes(s.id) ? t('sidebar.unpin') : t('sidebar.pin')}
                        aria-label={pinnedSessions.includes(s.id) ? t('sidebar.unpin') : t('sidebar.pin')}
                      >
                        <Pin size={11} className={pinnedSessions.includes(s.id) ? 'fill-accent text-accent' : ''} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          startEdit(s)
                        }}
                        className="text-fg-muted hover:text-accent"
                        title={t('sidebar.rename')}
                        aria-label={t('sidebar.rename')}
                      >
                        <Edit2 size={11} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          // 删除会话为不可逆操作：先确认再执行，防 hover 展开后误触（评审 MAJOR-1/NIT-2）
                          const name = s.title || t('internal.titlePlaceholder')
                          if (confirm(`删除会话「${name}」？此操作不可撤销。`)) void deleteSession(s.id)
                        }}
                        className="text-fg-muted hover:text-red-400"
                        title={t('common.delete')}
                        aria-label={t('common.delete')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </>
                )}
                </div>
                )
              })}
            </div>
            )
          })}
      </div>

      {/* 底部：ModelSwitcher + 记忆胶囊 + 面板快捷入口 + 监控 + 头像菜单 */}
      <div className="shrink-0 space-y-1.5 border-t border-border-subtle p-2">
<ModelSwitcher />
        <MemoryCapsule />
        <PanelQuickRow isMaster={isMaster} isSatellite={isSatellite} />
        <AvatarMenu />
      </div>
    </aside>
  )
}
