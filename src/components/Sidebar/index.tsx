/**
 * 为什么存在：主聊天区左侧需要会话管理、功能入口与记忆开关的集合导航，交互密度高，
 * 独立组件承载并内聚侧栏逻辑。
 * 作用：会话列表（增删改/置顶/切换）、右侧功能标签入口、记忆胶囊（记忆开关/条数）、
 * 模型切换与登出。
 */
import {
  useState,
  useMemo,
  useEffect,
  useCallback
} from 'react'
import {
  Plus,
  MessageSquare,
  Trash2,
  Edit2,
  Check,
  X,
  BarChart3,
  ChevronsLeft,
  ChevronsRight,
  Heart,
  Pin,
  ShieldCheck,
  Wand2,
  Network
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import {
  DEFAULT_AI_ID,
  type Session
} from '@shared/types'
import { ModelSwitcher } from './ModelSwitcher'
import { ConfirmDialog } from '../ConfirmDialog'
import { useT } from '../../i18n/useT'
import {
  resolveAiName,
  aiAvatarFallback
} from '../Ai/AiManagerPanel'
import { AiAvatar } from '../Ai/AiAvatar'
// ADR-28 拆分：小工具 / 记忆胶囊 / 头像菜单 / 面板快捷行 已外移至同目录各文件。
import {
  formatRelativeTime,
  getLastMessagePreview
} from './sidebar-helpers'
import { MemoryCapsule } from './MemoryCapsule'
import { AvatarMenu } from './AvatarMenu'
import {
  PANEL_BUTTONS,
  PanelQuickRow
} from './PanelQuickRow'

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
  const memoryGraphOpen = useAppStore((s) => s.memoryGraphOpen)
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
  // 待删除会话：非 null 时弹出月蚀风格确认弹窗（替代原生 confirm，评审 MAJOR-1 后续）
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null)

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
          {/* 记忆/图谱数据开关（折叠态入口，与展开态 PanelQuickRow 一致） */}
          <button
            onClick={() => useAppStore.getState().setMemoryGraphOpen(!memoryGraphOpen)}
            className={`flex h-7 w-7 items-center justify-center rounded-btn transition-all duration-150 active:scale-95 ${
              memoryGraphOpen
                ? 'bg-accent/15 text-accent'
                : 'text-fg-muted hover:bg-bg-muted hover:text-fg-secondary'
            }`}
            title={t('sidebar.memoryGraphOpen')}
          >
            <Network size={14} />
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
                          // 删除会话为不可逆操作：弹月蚀风格确认框，防 hover 展开后误触（评审 MAJOR-1/NIT-2）
                          setPendingDelete(s)
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

      {/* 删除会话确认弹窗（月蚀风格，替代原生 confirm） */}
      <ConfirmDialog
        open={pendingDelete != null}
        title={t('sidebar.confirmDeleteTitle')}
        message={t('sidebar.confirmDeleteMessage', {
          name: pendingDelete?.title || t('internal.titlePlaceholder')
        })}
        icon={<Trash2 size={14} />}
        confirmLabel={t('common.delete')}
        danger
        onConfirm={() => {
          if (pendingDelete) void deleteSession(pendingDelete.id)
          setPendingDelete(null)
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </aside>
  )
}
