import { useEffect } from 'react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/Chat/ChatArea'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { VisualizationPanel } from './components/Visualization/VisualizationPanel'
import { BrowserPanel } from './components/Browser/BrowserPanel'
import { SocialBrowserPanel } from './components/Social/SocialBrowserPanel'
import { RightPanelTabs } from './components/RightPanelTabs'
import { DrawerPanel } from './components/DrawerPanel'
import { NewSessionPicker } from './components/Ai/NewSessionPicker'
import { ChatOverlay } from './components/Chat/ChatOverlay'
import { OverlayChat } from './components/Chat/OverlayChat'
import { LoginScreen } from './components/Auth/LoginScreen'
import { PermissionDialog } from './components/PermissionDialog'
import { WorkflowHumanDialog } from './components/Chat/WorkflowHumanDialog'
import { useAppStore } from './stores/appStore'
import { useTheme } from './hooks/useTheme'

function LoadingScreen() {
  return (
    <div className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-bg-base">
      <div
        className="pointer-events-none absolute h-[520px] w-[520px] rounded-full blur-3xl"
        style={{
          background: 'radial-gradient(circle, var(--color-accent-glow) 0%, transparent 70%)',
          animation: 'app-glow-pulse 4s ease-in-out infinite'
        }}
      />
      <div className="relative z-10 flex flex-col items-center gap-5">
        <div className="relative flex items-center justify-center">
          <div
            className="absolute h-16 w-16 rounded-full border-2 border-accent/30"
            style={{ animation: 'app-ring-rotate 3s linear infinite' }}
          />
          <div
            className="absolute h-12 w-12 rounded-full border-2 border-accent/50 border-t-transparent"
            style={{ animation: 'app-ring-rotate 1.4s linear infinite reverse' }}
          />
          <div
            className="h-3 w-3 rounded-full bg-accent"
            style={{ animation: 'app-core-pulse 1.6s ease-in-out infinite' }}
          />
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <div className="text-heading font-light tracking-[0.4em] text-fg-primary">
            月蚀
          </div>
          <div className="text-[10px] uppercase tracking-[0.3em] text-fg-muted">
            LunarEclipse
          </div>
        </div>
      </div>
      <style>{`
        @keyframes app-glow-pulse {
          0%, 100% { opacity: 0.5; transform: scale(1); }
          50% { opacity: 0.9; transform: scale(1.05); }
        }
        @keyframes app-ring-rotate {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes app-core-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 0 8px rgb(var(--color-accent)); }
          50% { transform: scale(1.4); box-shadow: 0 0 18px rgb(var(--color-accent)); }
        }
      `}</style>
    </div>
  )
}

export default function App() {
  // 悬浮小窗路由：?overlay=1 只渲染精简聊天视图（独立置顶 BrowserWindow）
  const isOverlay =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('overlay')
  if (isOverlay) {
    return <OverlayChat />
  }
// 安全模式独立窗口入口已删除：它绕过登录门控，与「系统必须登录后才可用、
  // 无兜底回退」的强制登录设计冲突；不存在任何未登录可用的渲染路径。
  return <MainApp />
}

function MainApp() {
  const initApp = useAppStore((s) => s.initApp)
  const cleanupApp = useAppStore((s) => s.cleanupApp)
  const authReady = useAppStore((s) => s.authReady)
  const currentUser = useAppStore((s) => s.currentUser)
  const activeTab = useAppStore((s) => s.activeRightPanel)
  useTheme()

  useEffect(() => {
    initApp()
    return () => cleanupApp()
  }, [initApp, cleanupApp])

  // 窗口尺寸变化时通知浏览器视图重新布局（全宽模式）
  useEffect(() => {
    const onResize = () => {
      // 参数已废弃（setWidthPct 忽略 pct），传 0 表示无实际语义
      window.lunareclipse?.browserResize?.(0)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!authReady) {
    return <LoadingScreen />
  }

  if (!currentUser) {
    return <LoginScreen />
  }

  const isChatTab = activeTab === 'chat'

  return (
    <div className="flex h-screen w-screen flex-col bg-bg-base text-fg-primary">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧栏：始终可见，不被标签切换隐藏 */}
        <Sidebar />
        {/* 会话窗口：标签栏（降级到会话窗口内）+ 内容区 */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <RightPanelTabs />
          <div className="flex flex-1 overflow-hidden">
            {/* 会话标签：ChatArea */}
            <div className={isChatTab ? 'flex flex-1 overflow-hidden' : 'hidden'}>
              <ChatArea />
            </div>
            {/* 功能面板标签：重型面板全宽渲染，始终挂载以保留状态 */}
<div className={!isChatTab ? 'flex flex-1 overflow-hidden' : 'hidden'}>
              <BrowserPanel />
              <SocialBrowserPanel />
            </div>
          </div>
        </div>
        {/* 右侧抽屉：内联 flex 子元素，打开时会话区域自然收缩 */}
        <DrawerPanel />
      </div>
      <SettingsPanel />
      <VisualizationPanel />
      <PermissionDialog />
      <WorkflowHumanDialog />
      <ChatOverlay />
      <NewSessionPicker />
    </div>
  )
}
