/**
 * 为什么存在：浏览器面板操作密、事件多（导航/点击/滚动/截图等都要与主进程双向同步），
 * 独立 slice 承载，避免把 WebContentsView 控制逻辑散落在组件里。
 * @category 前端状态
 * @summary appStore 的 browser 域 slice：浏览器面板（WebContentsView 嵌入）的开关/导航/点击/
 * 输入/滚动/截图/求值，以及主进程 browser:* 事件订阅（initBrowserEvents）。
 * 对应 AppState 中 browser* 字段与 browser* / initBrowserEvents actions。
 */
import type { BrowserEvent } from '../../../electron/main/tools/browser-view-manager'
import type { AppState } from '../appStore-types'
import {
  BROWSER_HISTORY_MAX,
  type SliceSet,
  type SliceGet
} from './appStore-shared'

export type BrowserSlice = Pick<AppState,
  | 'browserPanelOpen' | 'browserViewVisible' | 'browserUrl' | 'browserTitle' | 'browserLoading'
  | 'browserCanGoBack' | 'browserCanGoForward' | 'browserCurrentAction' | 'browserHistory'
  | 'browserOpen' | 'browserClose' | 'browserNavigate' | 'browserBack' | 'browserForward'
  | 'browserClick' | 'browserType' | 'browserScroll' | 'browserScreenshot' | 'browserEvaluate'
  | 'initBrowserEvents'
>

export function createBrowserSlice(set: SliceSet, get: SliceGet): BrowserSlice {
  return {
    browserPanelOpen: false,
    browserViewVisible: false,
    browserUrl: '',
    browserTitle: '',
    browserLoading: false,
    browserCanGoBack: false,
    browserCanGoForward: false,
    browserCurrentAction: null,
    browserHistory: [],

    // ===== 浏览器面板 =====
    browserOpen: async () => {
      const api = window.lunareclipse
      if (!api?.browserShow) return
      const res = await api.browserShow()
      if (res?.ok) {
        // 拉取历史
        const histRes = await api.browserGetHistory()
        set({
          browserPanelOpen: true,
          browserHistory: histRes?.history ?? []
        })
      }
    },

    browserClose: async () => {
      const api = window.lunareclipse
      if (!api?.browserHide) return
      await api.browserHide()
      set({ browserPanelOpen: false })
    },

    browserNavigate: async (url: string) => {
      const api = window.lunareclipse
      if (!api?.browserNavigate) return
      await api.browserNavigate(url)
    },
    browserBack: async () => {
      const api = window.lunareclipse
      if (!api?.browserBack) return
      const r = await api.browserBack()
      if (r?.ok && r.data) {
        set({
          browserUrl: r.data.url,
          browserCanGoBack: r.data.canGoBack,
          browserCanGoForward: r.data.canGoForward
        })
      }
    },
    browserForward: async () => {
      const api = window.lunareclipse
      if (!api?.browserForward) return
      const r = await api.browserForward()
      if (r?.ok && r.data) {
        set({
          browserUrl: r.data.url,
          browserCanGoBack: r.data.canGoBack,
          browserCanGoForward: r.data.canGoForward
        })
      }
    },

    browserClick: async (selector: string) => {
      const api = window.lunareclipse
      if (!api?.browserClick) return
      await api.browserClick(selector)
    },

    browserType: async (selector: string, text: string, clear?: boolean) => {
      const api = window.lunareclipse
      if (!api?.browserType) return
      await api.browserType(selector, text, clear)
    },

    browserScroll: async (direction: 'up' | 'down', amount?: number) => {
      const api = window.lunareclipse
      if (!api?.browserScroll) return
      await api.browserScroll(direction, amount)
    },

    browserScreenshot: async (fullPage?: boolean) => {
      const api = window.lunareclipse
      if (!api?.browserScreenshot) return undefined
      const res = await api.browserScreenshot(fullPage)
      return res
    },

    browserEvaluate: async (script: string) => {
      const api = window.lunareclipse
      if (!api?.browserEvaluate) return undefined
      return api.browserEvaluate(script)
    },

    initBrowserEvents: () => {
      const api = window.lunareclipse
      if (!api?.onBrowserEvent) return () => {}
      // 启动兜底：主进程视图可能早于事件监听器注册就可见（AI 工具直接 show），事件流会丢第一条
      // browser:state——主动查询一次真实可见性，保证聊天区让位永远对齐实际占用
      void api.browserIsVisible?.().then((r) => {
        if (r?.visible) {
          const st = get()
          set({
            browserViewVisible: true,
            browserPanelOpen: true,
            rightPanelTabs: st.rightPanelTabs.includes('browser')
              ? st.rightPanelTabs
              : [...st.rightPanelTabs, 'browser'],
            activeRightPanel: st.activeRightPanel ?? 'chat'
          })
        }
      })

      const unsubscribe = api.onBrowserEvent((event: BrowserEvent) => {
        switch (event.type) {
          case 'browser:state':
            set({
              browserPanelOpen: event.visible,
              browserViewVisible: event.visible,
              browserUrl: event.url,
              browserTitle: event.title,
              browserLoading: event.loading,
              browserCanGoBack: event.canGoBack,
              browserCanGoForward: event.canGoForward
            })
            // 主进程侧 show() view（browser:show/navigate IPC 触发，包括 AI 导航后前端
            // syncBrowserVisibility 统一判定）时，前端标签栏可能不知道 → 用户会看到光秃秃
            // 的 view 没有工具栏/关闭按钮。收到 visible=true 且浏览器标签不在列表时，
            // 自动激活浏览器标签，保证工具栏/关闭框始终在场。
            if (event.visible) {
              const st = get()
              if (!st.rightPanelTabs.includes('browser')) {
                set({
                  rightPanelTabs: [...st.rightPanelTabs, 'browser'],
                  activeRightPanel: 'browser'
                })
              }
              // 标签页全宽模式——浏览器视图 layoutView() 改为全宽布局
            }
            break
          case 'browser:closed':
            // 主进程显式关闭（viewManager.close()）：移除浏览器标签，工具栏框随之消失。
            // （浮层遮挡用的 hide() 只发 visible=false 不发 closed，保留标签供浮层关闭后恢复）
            set((s) => {
              if (!s.rightPanelTabs.includes('browser')) return s
              const tabs = s.rightPanelTabs.filter((t) => t !== 'browser')
              const nextActive = tabs.length === 0 ? 'chat' : (s.activeRightPanel === 'browser' ? tabs[0] : s.activeRightPanel)
              return {
                rightPanelTabs: tabs,
                activeRightPanel: s.activeRightPanel === 'browser' ? nextActive : s.activeRightPanel,
                browserPanelOpen: false
              }
            })
            break
          case 'browser:actionStart':
            set({
              browserCurrentAction: { action: event.action, detail: event.detail }
            })
            break
          case 'browser:actionEnd':
            set({ browserCurrentAction: null })
            break
          case 'browser:history':
            // 新历史条目插到最前
            set((s) => ({
              browserHistory: [event.entry, ...s.browserHistory].slice(0, BROWSER_HISTORY_MAX)
            }))
            break
          default:
            // 其他事件（highlight/mouseMove/label）已由页面注入脚本处理，前端不再重复渲染
            break
        }
      })
      return unsubscribe
    }
  }
}