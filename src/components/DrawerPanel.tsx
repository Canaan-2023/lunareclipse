/**
 * 为什么存在：轻量边缘工具（Todo/日历/SKILL/插件/Cron/好友等）用抽屉而非标签页承载，
 * 需要一个统一容器按 activeDrawer 开关态渲染对应面板，并集中管理工坊抽屉的特殊交互（拖拽调宽/全屏）。
 * 作用：按 activeDrawer 分发渲染各面板；工坊支持左侧拖拽调宽与全屏开关。
 * 注：各面板自身的关闭按钮与 Esc 关闭由面板内部实现（如 SkillPanel/AiManagerPanel），这里只做容器分发，
 * 不重复实现 Esc 监听，避免与子面板的 Esc 处理冲突。
 */
import { useRef, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import { TodoPanel } from './TodoPanel'
import { CalendarPanel } from './CalendarPanel'
import { SkillPanel } from './Skill/SkillPanel'
import { HookPanel } from './Hook/HookPanel'
import { PluginPanel } from './Plugin/PluginPanel'
import { CronPanel } from './Cron/CronPanel'
import { FileWorkshopPanel } from './Workshop/FileWorkshopPanel'
import { AccountBoardPanel } from './Admin/AccountBoardPanel'
import { BackupCenterPanel } from './BackupCenter/BackupCenterPanel'
import { FriendsPanel } from './Friends/FriendsPanel'
import { ChatRoomsPanel } from './ChatRooms/ChatRoomsPanel'
import { PublishBoardPanel } from './PublishBoard/PublishBoardPanel'
import { AiManagerPanel } from './Ai/AiManagerPanel'
import { ProfilePanel } from './Profile/ProfilePanel'

/**
 * 右侧抽屉面板：内联 flex 布局，打开时会话区域自然收缩。

 * 轻量面板（todo/calendar/skill/hook/plugin/cron）：固定 340px 宽。
 * 文件工坊（workshop）：可变宽度（280-600px），左侧拖拽手柄，支持全屏展开。
 */
export function DrawerPanel() {
  const activeDrawer = useAppStore((s) => s.activeDrawer)
  const workshopWidth = useAppStore((s) => s.workshopWidth)
  const workshopFullscreen = useAppStore((s) => s.workshopFullscreen)
  const setWorkshopWidth = useAppStore((s) => s.setWorkshopWidth)
  const draggingRef = useRef(false)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    draggingRef.current = true
    const startX = e.clientX
    const startWidth = workshopWidth

    const onMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return
      const delta = startX - ev.clientX
      setWorkshopWidth(startWidth + delta)
    }
    const onUp = () => {
      draggingRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [workshopWidth, setWorkshopWidth])

  if (!activeDrawer) return null

  const isWorkshop = activeDrawer === 'workshop'
  const isFullscreen = isWorkshop && workshopFullscreen
  // friend / chatRoom / publishBoard 使用 440px：聊天消息气泡、成员列表与正文需要额外横向空间
  const isWideDrawer =
    activeDrawer === 'backup' || activeDrawer === 'friend' || activeDrawer === 'chatRoom' ||
    activeDrawer === 'publishBoard'
  const panelWidth = isFullscreen
    ? '100%'
    : isWorkshop
      ? `${workshopWidth}px`
      : isWideDrawer
        ? '440px'
        : '340px'

  return (
    <div
      className={`titlebar-seamless flex h-full ${isFullscreen ? 'w-full' : 'shrink-0'} flex-col border-l border-border bg-bg-surface shadow-2xl relative`}
      style={{ width: panelWidth }}
    >
      {/* 文件工坊：左侧拖拽手柄（非全屏时显示） */}
      {isWorkshop && !workshopFullscreen && (
        <div
          onMouseDown={handleDragStart}
          className="absolute left-0 top-0 z-10 flex h-full w-1 cursor-col-resize hover:bg-accent/30 transition-colors"
          title="拖拽调整宽度"
        >
          <div className="w-full h-full bg-border-subtle hover:bg-accent/50 transition-colors" />
        </div>
      )}
      {/* 面板内容 */}
      <div className="flex-1 overflow-hidden">
        {activeDrawer === 'todo' && <TodoPanel />}
        {activeDrawer === 'calendar' && <CalendarPanel />}
        {activeDrawer === 'skill' && <SkillPanel />}
        {activeDrawer === 'hook' && <HookPanel />}
        {activeDrawer === 'plugin' && <PluginPanel />}
        {activeDrawer === 'cron' && <CronPanel />}
        {activeDrawer === 'workshop' && <FileWorkshopPanel />}
        {activeDrawer === 'admin' && <AccountBoardPanel />}
        {activeDrawer === 'backup' && <BackupCenterPanel />}
        {activeDrawer === 'friend' && <FriendsPanel />}
        {activeDrawer === 'chatRoom' && <ChatRoomsPanel />}
        {activeDrawer === 'publishBoard' && <PublishBoardPanel />}
        {activeDrawer === 'ai' && <AiManagerPanel />}
        {activeDrawer === 'profile' && <ProfilePanel />}
      </div>
    </div>
  )
}
