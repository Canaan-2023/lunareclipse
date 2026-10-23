/**
 * @category 前端组件
 * @summary 头像菜单（AI 身份 / 模型切换 / 登出入口）
 * @note 为什么存在：`index.tsx` 曾达 804 行破 800 硬红线（ADR-28 拆分）；头像菜单是独立的下拉交互单元。
 * @note 不删理由：模型切换与登出是侧栏仅有的两个全局操作入口，独立成文件后与侧栏骨架可各自演进。
 */

import {
  useState,
  useEffect,
  useRef
} from 'react'
import {
  Repeat,
  LogOut,
  Settings,
  ChevronDown,
  UserCircle
} from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { AiAvatar } from '../Ai/AiAvatar'

export function AvatarMenu() {
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
