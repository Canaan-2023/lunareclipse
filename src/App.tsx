import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { ChatArea } from './components/Chat/ChatArea'
import { RightPanelTabs } from './components/RightPanelTabs'
import { DrawerPanel } from './components/DrawerPanel'
import { PanelErrorBoundary } from './components/PanelErrorBoundary'
import { NewSessionPicker } from './components/Ai/NewSessionPicker'
import { ChatOverlay } from './components/Chat/ChatOverlay'
import { OverlayChat } from './components/Chat/OverlayChat'
import { LoginScreen } from './components/Auth/LoginScreen'
import { PermissionDialog } from './components/PermissionDialog'
import { WorkflowHumanDialog } from './components/Chat/WorkflowHumanDialog'
import { useAppStore } from './stores/appStore'
import { useTheme } from './hooks/useTheme'
import { useT } from './i18n/useT'

/**
 * 重型面板按需加载：模块只在首次打开时下载/解析，之后保持挂载以保留面板内部状态
 * （Tab 选择、草稿、滚动位置）。关闭时是否卸载由面板自身 `open` 判断，行为不变。
 */
const SettingsPanel = lazy(async () => ({ default: (await import('./components/Settings/SettingsPanel')).SettingsPanel }))
const VisualizationPanel = lazy(async () => ({ default: (await import('./components/Visualization/VisualizationPanel')).VisualizationPanel }))
const MemoryGraphPanel = lazy(async () => ({ default: (await import('./components/Visualization/MemoryGraphPanel')).MemoryGraphPanel }))
const BrowserPanel = lazy(async () => ({ default: (await import('./components/Browser/BrowserPanel')).BrowserPanel }))
const SocialBrowserPanel = lazy(async () => ({ default: (await import('./components/Social/SocialBrowserPanel')).SocialBrowserPanel }))

/**
 * 面板首次打开后保持挂载：避免每次关闭/重开都丢失内部状态，同时把模块加载推迟到首次使用。
 * 第二个返回值用于强制卸载：面板级错误卡片点了“关闭”后，需要连带丢弃该面板的错误状态，
 * 否则边界会一直显示错误卡片（面板自身已不可用，无法自行退出）。
 */
function useEverOpened(open: boolean): [boolean, () => void] {
  const [everOpened, setEverOpened] = useState(open)
  useEffect(() => {
    if (open) setEverOpened(true)
  }, [open])
  const reset = useCallback(() => setEverOpened(false), [])
  return [everOpened, reset]
}

/** 面板模块加载占位：固定铺满容器，避免加载完成时出现布局跳动 */
function PanelSpinner() {
  return (
    <div className="flex h-full w-full items-center justify-center text-fg-muted">
      <Loader2 size={16} className="animate-spin" />
    </div>
  )
}

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
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
  // 悬浮小窗路由：?overlay=1 只渲染精简聊天视图（独立置顶 BrowserWindow）
  if (params?.has('overlay')) {
    return <OverlayChat />
  }
  return <MainApp />
}

function MainApp() {
  const initApp = useAppStore((s) => s.initApp)
  const cleanupApp = useAppStore((s) => s.cleanupApp)
  const authReady = useAppStore((s) => s.authReady)
  const currentUser = useAppStore((s) => s.currentUser)
  const activeTab = useAppStore((s) => s.activeRightPanel)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const vizOpen = useAppStore((s) => s.vizPanelOpen)
  const memoryGraphOpen = useAppStore((s) => s.memoryGraphOpen)
  const drawerOpen = useAppStore((s) => s.activeDrawer !== null)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const setVizPanelOpen = useAppStore((s) => s.setVizPanelOpen)
  const setMemoryGraphOpen = useAppStore((s) => s.setMemoryGraphOpen)
  const [settingsMounted, dropSettings] = useEverOpened(settingsOpen)
  const [vizMounted, dropViz] = useEverOpened(vizOpen)
  const [memoryGraphMounted, dropMemoryGraph] = useEverOpened(memoryGraphOpen)
  // 与各面板自身的 open 口径一致：被设置/监控遮罩挡住时不算打开
  const browserOpen = activeTab === 'browser' && !vizOpen && !settingsOpen
  const socialOpen = activeTab === 'social' && !vizOpen && !settingsOpen
  const [browserMounted] = useEverOpened(browserOpen)
  const [socialMounted] = useEverOpened(socialOpen)
  const t = useT()
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
            {/* 功能面板标签：重型面板全宽渲染，首次打开后保持挂载以保留状态 */}
            <div className={!isChatTab ? 'flex flex-1 overflow-hidden' : 'hidden'}>
              {browserMounted && (
                <PanelErrorBoundary label={t('tab.browser')}>
                  <Suspense fallback={<PanelSpinner />}>
                    <BrowserPanel />
                  </Suspense>
                </PanelErrorBoundary>
              )}
              {socialMounted && (
                <PanelErrorBoundary label={t('tab.social')}>
                  <Suspense fallback={<PanelSpinner />}>
                    <SocialBrowserPanel />
                  </Suspense>
                </PanelErrorBoundary>
              )}
            </div>
          </div>
        </div>
        {/* 右侧抽屉：内联 flex 子元素，打开时会话区域自然收缩 */}
        <PanelErrorBoundary
          label={t('error.panel.drawer')}
          active={drawerOpen}
          onDismiss={closeDrawer}
        >
          <DrawerPanel />
        </PanelErrorBoundary>
      </div>
      {settingsMounted && (
        <PanelErrorBoundary
          label={t('settings.title')}
          variant="overlay"
          active={settingsOpen}
          onDismiss={() => {
            closeSettings()
            dropSettings()
          }}
        >
          <Suspense fallback={<PanelSpinner />}>
            <SettingsPanel />
          </Suspense>
        </PanelErrorBoundary>
      )}
      {vizMounted && (
        <PanelErrorBoundary
          label={t('tab.viz')}
          variant="overlay"
          active={vizOpen}
          onDismiss={() => {
            setVizPanelOpen(false)
            dropViz()
          }}
        >
          <Suspense fallback={<PanelSpinner />}>
            <VisualizationPanel />
          </Suspense>
        </PanelErrorBoundary>
      )}
      {memoryGraphMounted && (
        <PanelErrorBoundary
          label={t('memoryGraph.title')}
          variant="overlay"
          active={memoryGraphOpen}
          onDismiss={() => {
            setMemoryGraphOpen(false)
            dropMemoryGraph()
          }}
        >
          <Suspense fallback={<PanelSpinner />}>
            <MemoryGraphPanel />
          </Suspense>
        </PanelErrorBoundary>
      )}
      <PermissionDialog />
      <WorkflowHumanDialog />
      <ChatOverlay />
      <NewSessionPicker />
    </div>
  )
}
