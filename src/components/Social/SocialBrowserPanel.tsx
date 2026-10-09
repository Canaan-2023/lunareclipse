/**
 * 为什么存在：好友/聊天室/发布板同属"社交"域且都以 LAN 直连为数据源，
 * 聚合为浏览器式面板统一入口，便于整体展示连接状态。
 * 作用：渲染社交面板——三 Tab（好友/聊天室/发布板）切换、LAN 连接状态检测、
 * 面包屑返回与搜索入口聚合。
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Users, MessagesSquare, Newspaper, X, Wifi, WifiOff,
  ChevronRight, Search
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { FriendsPanel } from '../Friends/FriendsPanel'
import { ChatRoomsPanel } from '../ChatRooms/ChatRoomsPanel'
import { PublishBoardPanel } from '../PublishBoard/PublishBoardPanel'

type SocialTab = 'friends' | 'chatRooms' | 'publishBoard'

interface Breadcrumb {
  label: string
  onClick?: () => void
}

export function SocialBrowserPanel() {
  const open = useAppStore((s) => s.activeRightPanel === 'social' && !s.vizPanelOpen && !s.settingsOpen)
  const closeTab = useAppStore((s) => s.closeRightPanelTab)
  const t = useT()

  const [tab, setTab] = useState<SocialTab>('friends')
  const [lanReady, setLanReady] = useState<boolean | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([])

  // 检测 LAN 状态
  useEffect(() => {
    if (!open) return
    window.lunareclipse?.multiGetStatus?.()
      .then((s) => setLanReady(s.role === 'master' || s.role === 'satellite'))
      .catch(() => setLanReady(false))
  }, [open])

  // 根据当前标签和搜索更新面包屑
  useEffect(() => {
    const base: Breadcrumb[] = [{ label: t('tab.social') }]
    if (tab === 'friends') {
      base.push({ label: t('tab.friend'), onClick: () => setTab('friends') })
      if (searchQuery) base.push({ label: `${t('common.search')}: "${searchQuery}"` })
    } else if (tab === 'chatRooms') {
      base.push({ label: t('tab.chatRoom'), onClick: () => setTab('chatRooms') })
      if (searchQuery) base.push({ label: `${t('common.search')}: "${searchQuery}"` })
    } else if (tab === 'publishBoard') {
      base.push({ label: t('tab.publishBoard'), onClick: () => setTab('publishBoard') })
      if (searchQuery) base.push({ label: `${t('common.search')}: "${searchQuery}"` })
    }
    setBreadcrumbs(base)
  }, [tab, searchQuery, t])

  const handleClose = useCallback(() => {
    closeTab('social')
  }, [closeTab])

  if (!open) return null

  const tabs: { key: SocialTab; icon: typeof Users; label: string }[] = [
    { key: 'friends', icon: Users, label: t('tab.friend') },
    { key: 'chatRooms', icon: MessagesSquare, label: t('tab.chatRoom') },
    { key: 'publishBoard', icon: Newspaper, label: t('tab.publishBoard') },
  ]

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-base">
      {/* 顶部工具栏：仿浏览器地址栏 */}
      <div className="flex items-center gap-2 border-b border-border-subtle bg-bg-surface px-3 py-2">
        {/* 关闭按钮 */}
        <button
          onClick={handleClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-btn text-fg-muted hover:bg-bg-muted hover:text-fg-primary"
          title={t('tab.close')}
          aria-label={t('tab.close')}
        >
          <X size={14} />
        </button>

        <div className="h-4 w-px bg-border-subtle" />

        {/* 面包屑导航 */}
        <div className="flex min-w-0 flex-1 items-center gap-1 text-caption text-fg-secondary">
          {breadcrumbs.map((crumb, i) => (
            <div key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={12} className="text-fg-muted" />}
              {crumb.onClick ? (
                <button
                  onClick={crumb.onClick}
                  className="truncate hover:text-accent"
                >
                  {crumb.label}
                </button>
              ) : (
                <span className={i === breadcrumbs.length - 1 ? 'text-fg-primary' : ''}>
                  {crumb.label}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* 搜索框 */}
        <div className="relative flex w-48 shrink-0 items-center sm:w-56 md:w-64">
          <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('common.search')}
            className="w-full rounded-btn border border-border bg-bg-elevated py-1.5 pl-7 pr-3 text-caption text-fg-primary placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-muted hover:text-fg-primary"
              title="清除搜索"
              aria-label="清除搜索"
            >
              <X size={10} />
            </button>
          )}
        </div>

        {/* LAN 状态 */}
        <div className="shrink-0">
          {lanReady === false && (
            <span className="flex items-center gap-1 text-[10px] text-danger">
              <WifiOff size={10} />
              {t('social.lanOffline')}
            </span>
          )}
          {lanReady === true && (
            <span className="flex items-center gap-1 text-[10px] text-accent">
              <Wifi size={10} />
              {t('social.lanOnline')}
            </span>
          )}
        </div>
      </div>

      {/* 二级标签栏：好友 / 聊天室 / 发布板 */}
      <div className="flex shrink-0 border-b border-border-subtle bg-bg-surface">
        {tabs.map((tItem) => {
          const Icon = tItem.icon
          const isActive = tab === tItem.key
          return (
            <button
              key={tItem.key}
              onClick={() => setTab(tItem.key)}
              className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-caption font-medium transition-colors ${
                isActive
                  ? 'border-accent text-accent'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary'
              }`}
            >
              <Icon size={13} />
              {tItem.label}
            </button>
          )
        })}
      </div>

      {/* 内容区：三个面板常驻挂载（仅切换可见性），
          保证任一标签页在后台也能持续接收好友请求/聊天室邀请/发布板事件 */}
      <div className="flex-1 overflow-hidden">
        <div className={tab === 'friends' ? 'h-full' : 'hidden'}>
{/* 三子面板统一接收地址栏搜索词：地址栏输入不再只是面包屑文案，
              而是真正驱动子面板的过滤/搜索（friends/chatRooms 搜索、publishBoard 列表过滤） */}
          <FriendsPanel embedded externalQuery={searchQuery} />
          <ChatRoomsPanel embedded externalQuery={searchQuery} />
          <PublishBoardPanel embedded externalQuery={searchQuery} />
        </div>
      </div>
    </div>
  )
}
