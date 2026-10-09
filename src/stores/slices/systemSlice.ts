/**
 * 为什么存在：装配/身份/配置/布局等横切状态（前端链路最长的一域）需要集中管理，
 * 独立 slice 使 WS 生命周期与 UI 状态放在同一权威位置，避免分散在各组件。
 * @category 前端状态
 * @summary appStore 的 system 域 slice：应用装配（initApp/cleanupApp/refreshTodos）、身份
 * （login/register/logout/deleteAccount/switchUser）、设置面板与配置（saveConfig/工作流开关）、
 * DMN 问答、可视化监控、布局面板（侧边栏/计划/工坊/右侧标签/抽屉）、动态模块面板、语言与预览。
 * WS 生命周期相关的可变状态（守卫/订阅集合/重连计数与定时器）统一走 wsRuntime。
 * 对应 AppState 中 config/settings/ws/auth/viz/sidebar/tabs/drawer/dynamicPanels/todos 等字段。
 */
import { computeBackoffDelay } from '@shared/utils/backoff'
import type { AppConfig, VisualizationData } from '@shared/types'
import { DEFAULT_CONFIG } from '@shared/types'
import { DEFAULT_AI_ID } from '@shared/types'
import { getDictEntry } from '../../i18n/locales'
import { useWorkflowStore } from '../workflowStore'
import { useSkillStore } from '../skillStore'
import { handleWSMessage, handleDmnEvent, safeSave } from '../appStore-handlers'
import type { AppState, RightPanelTabId } from '../appStore-types'
import {
  WS_RECONNECT_MAX_DELAY_MS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  TODO_PANEL_MIN_WIDTH,
  TODO_PANEL_MAX_WIDTH,
  DEFAULT_TODO_PANEL_WIDTH,
  WORKSHOP_MIN_WIDTH,
  WORKSHOP_MAX_WIDTH,
  DEFAULT_WORKSHOP_WIDTH,
  LIGHT_PANELS,
  wsRuntime,
  createWS,
  syncActiveStream,
  disposeAppSubscriptions,
  syncBrowserVisibility,
  type SliceSet,
  type SliceGet
} from './appStore-shared'

export type SystemSlice = Pick<AppState,
  | 'config' | 'settingsOpen' | 'ws' | 'memoryWorkflowEnabled' | 'diaryWorkflowEnabled'
  | 'dmnAskPrompt' | 'dmnLog' | 'dmnConditionWait' | 'currentUser' | 'authReady'
  | 'visualization' | 'visualizationLoading' | 'vizPanelOpen'
  | 'sidebarWidth' | 'todoPanelWidth' | 'workshopWidth' | 'workshopFullscreen' | 'sidebarCollapsed'
  | 'lang' | 'previewingFilePath' | 'rightPanelTabs' | 'activeRightPanel' | 'activeDrawer'
  | 'dynamicPanels' | 'todos'
  | 'initApp' | 'cleanupApp' | 'refreshTodos' | 'login' | 'register' | 'logout' | 'confirmLogout'
  | 'deleteAccount'
  | 'switchUser' | 'openSettings' | 'closeSettings' | 'saveConfig' | 'setMemoryWorkflowEnabled'
  | 'setDiaryWorkflowEnabled' | 'answerDmnQuestion' | 'dismissDmnAsk' | 'refreshVisualization'
  | 'healthCheckRun' | 'cancelTimer' | 'setVizPanelOpen' | 'setTodoPanelWidth' | 'setWorkshopWidth'
  | 'setWorkshopFullscreen' | 'setSidebarWidth' | 'setSidebarCollapsed' | 'setLang'
  | 'setPreviewingFilePath' | 'openRightPanelTab' | 'closeRightPanelTab' | 'setActiveRightPanel'
  | 'openDrawer' | 'closeDrawer' | 'refreshDynamicPanels'
  | 'aiPickerOpen' | 'setAiPickerOpen' | 'requestNewSession'
>

export function createSystemSlice(set: SliceSet, get: SliceGet): SystemSlice {
  return {
    // ===== 系统/装配状态 =====
    config: DEFAULT_CONFIG,
    settingsOpen: false,
    ws: null,
    memoryWorkflowEnabled: true,
    diaryWorkflowEnabled: true,
    dmnAskPrompt: null,
    dmnLog: [],
    dmnConditionWait: null,
    currentUser: null,
    authReady: false,

    // 可视化监控
    visualization: null,
    visualizationLoading: false,
    vizPanelOpen: false,

    // 布局面板
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
    todoPanelWidth: DEFAULT_TODO_PANEL_WIDTH,
    workshopWidth: DEFAULT_WORKSHOP_WIDTH,
    workshopFullscreen: false,
    sidebarCollapsed: false,
    lang: (() => {
      try {
        const saved = localStorage.getItem('app.lang')
        if (saved === 'zh' || saved === 'en') return saved
      } catch { /* localStorage 不可用时回退默认中文，不影响启动 */ }
      return 'zh' as 'zh' | 'en'
    })(),
    previewingFilePath: null,
    rightPanelTabs: ['chat' as RightPanelTabId],
    activeRightPanel: 'chat' as RightPanelTabId,
    activeDrawer: null,
    /** 新建会话选择器：多 AI 时点 "+" 弹出（仅系统月蚀启用时直接建会话不弹窗） */
    aiPickerOpen: false,
    dynamicPanels: [],
    todos: [],

    initApp: async () => {
      // 守卫：StrictMode 下 useEffect 双触发会重复调用 initApp，导致 WebSocket/interval 重复创建、
      // 心跳关闭日志重复打印。已初始化或进行中则直接返回。
      if (wsRuntime.initStarted) return
      wsRuntime.initStarted = true

      // 防御：preload 未注入时降级为未登录状态，避免整个应用卡死在加载页
      const api = window.lunareclipse
      if (!api) {
        console.warn('[appStore] window.lunareclipse not available, entering offline mode')
        wsRuntime.initStarted = false
        set({ authReady: true, currentUser: null })
        return
      }

      try {
        const [existingUser, config] = await Promise.all([
          api.authGetCurrentUser(),
          api.getConfig()
        ])
        set({
          currentUser: existingUser,
          authReady: true,
          config,
          // 持续激活全局开关：启动时从 config 读取
          currentSessionContinuousActivation: config?.continuousActivation === true
        })

        // 订阅 config 变化：AI 通过 update_abyss_md/update_ai_name 等工具改 config 后，
        // 后端 ConfigStore.save 触发 subscribe → 主进程推送 'config:changed' → 前端同步 appStore.config。
        // 否则 Settings 页显示旧值，用户保存还会覆盖 AI 的修改。
        if (api.onConfigChange) {
          wsRuntime.appUnsubscribers.push(api.onConfigChange((newConfig: AppConfig) => {
            const prev = get()
            set({
              config: newConfig,
              // 持续激活全局开关：config 变化时同步（切会话/设置页改动都走这里）
              currentSessionContinuousActivation: newConfig.continuousActivation === true
            })
            // 关闭莉莉丝总开关时，自动收起莉莉丝窗口并恢复切走前的会话
            if (newConfig.lilith?.enabled === false && prev.lilithChatOpen) {
              get().closeLilithChat()
            }
          }))
        }

        // 初始化浏览器事件监听（IPC 推送 → store）
        wsRuntime.appUnsubscribers.push(get().initBrowserEvents())
        // 全宽标签页模式：触发一次浏览器视图布局对齐（参数已废弃，setWidthPct 忽略 pct）
        void window.lunareclipse?.browserResize?.(0)
        // 初始化代码沙箱流式订阅（stdout/stderr/done → store）
        wsRuntime.appUnsubscribers.push(get().initSandboxStreams())
        // 工作流引擎：订阅主进程 workflow:event，加载模板和活跃实例
        // 内部有 if (_unsubscribe) return 守卫，重复调用安全
        void useWorkflowStore.getState().init()
        // 动态模块面板：从主进程拉取已注册的 panel 声明（插件 manifest.panel 声明时出现）
        void get().refreshDynamicPanels()

        if (existingUser) {
          await get().loadSessions()
          await get().loadAis()
          await get().refreshTodos()
        }

        const ws = createWS()
        ws.onopen = () => { wsRuntime.wsRetryCount = 0 }
        ws.onmessage = (event) => {
          let msg: unknown
          try {
            msg = JSON.parse(event.data)
            handleWSMessage(msg as Parameters<typeof handleWSMessage>[0], set, get)
          } catch (err) {
            // 区分两类失败：JSON.parse 本身失败 vs 处理消息时抛异常（如 React 渲染循环）。
            // 后者被误报成「消息解析失败」会掩盖真实根因——打印 msg.type 便于定位。
            const type = (msg as { type?: string } | null)?.type
            console.error(
              `[ws] 消息处理失败 (type=${type ?? '?'}):`,
              err instanceof SyntaxError ? 'JSON 解析失败' : err
            )
          }
        }
        ws.onerror = (err) => {
          console.error('[ws] 连接错误:', err)
        }
        ws.onclose = () => {
          // 防止旧 WS 的延迟 onclose 创建多余重连：检查当前 store 中的 ws 是否还是自己
          if (get().ws !== ws) return
          // WS 断开时若仍处于 streaming，说明是异常断开（非正常 done/abort）
          // 不应让 UI 一直显示 streaming 状态——改为温和提示
          const cur = get()
          if (cur.status === 'streaming' && cur.streamingMessageId) {
            set((s) => ({
              status: 'idle',
              streamingMessageId: null,
              activeToolCalls: [],
              currentMessages: s.currentMessages.map((m) =>
                m.id === cur.streamingMessageId
                  ? { ...m, aborted: true }
                  : m
              )
            }))
            if (cur.currentSessionId) {
              safeSave(cur.currentSessionId, get().currentMessages)
            }
          }
          const delay = computeBackoffDelay({
            attempt: wsRuntime.wsRetryCount,
            baseDelayMs: 1000,
            maxDelayMs: WS_RECONNECT_MAX_DELAY_MS
          })
          wsRuntime.wsRetryCount++
          console.warn(`[ws] 连接关闭，${delay}ms 后重连`)
          if (wsRuntime.wsReconnectTimer) clearTimeout(wsRuntime.wsReconnectTimer)
          wsRuntime.wsReconnectTimer = setTimeout(() => {
            wsRuntime.wsReconnectTimer = undefined
            try {
              const newWs = createWS()
              // 复制全部事件处理器，包括 onopen（确保 wsRuntime.wsRetryCount 在重连成功后归零）
              newWs.onopen = ws.onopen
              newWs.onmessage = ws.onmessage
              newWs.onclose = ws.onclose
              newWs.onerror = ws.onerror
              set({ ws: newWs })
              syncActiveStream(get)
            } catch (err) {
              console.error('[ws] 重连失败:', err)
            }
          }, delay)
        }
        set({ ws })
        syncActiveStream(get)

        wsRuntime.appUnsubscribers.push(api.onDmnEvent((event: unknown) => {
          handleDmnEvent(event as { type: string; [key: string]: unknown }, set, get)
        }))

        // 从后端同步记忆工作流开关实际状态（工作流默认开启，但用户可能在上次会话关闭过）
        try {
          const mwStatus = await window.lunareclipse.memoryWorkflowGetStatus()
          if (mwStatus) {
            set({ memoryWorkflowEnabled: mwStatus.enabled })
          }
        } catch (err) {
          console.warn('[appStore] 同步记忆工作流状态失败:', err)
        }

        // 从后端同步日记工作流开关状态
        try {
          const diaryStatus = await window.lunareclipse.diaryGetStatus()
          if (diaryStatus) {
            set({ diaryWorkflowEnabled: diaryStatus.enabled })
          }
        } catch (err) {
          console.warn('[appStore] 同步日记工作流状态失败:', err)
        }

        // 本地推理环境下记忆工作流和前端 AI 并行，互不干扰。
      } catch (err) {
        console.error('[appStore] initApp failed:', err)
        wsRuntime.initStarted = false
        set({ authReady: true, currentUser: null })
      }
    },

    /** 清理 initApp 创建的副作用：关闭 WebSocket、清除轮询定时器、释放 IPC 订阅、重置初始化标志 */
    cleanupApp: () => {
      // 先释放 IPC 订阅：config/dmn/浏览器/沙箱流，避免下次 initApp 叠加监听
      disposeAppSubscriptions()
      const { ws } = get()
      if (ws) {
        ws.onclose = null  // 防止 onclose 触发重连
        ws.onerror = null
        ws.onmessage = null
        ws.onopen = null
        try { ws.close() } catch { /* 连接已关闭/从未打开时 close 抛错可忽略，状态已置 null */ }
        set({ ws: null })
      }
      if (wsRuntime.wsReconnectTimer) {
        clearTimeout(wsRuntime.wsReconnectTimer)
        wsRuntime.wsReconnectTimer = undefined
      }
      if (wsRuntime.sandboxRunFallbackTimer) {
        clearTimeout(wsRuntime.sandboxRunFallbackTimer)
        wsRuntime.sandboxRunFallbackTimer = undefined
      }
      wsRuntime.wsRetryCount = 0
      wsRuntime.initStarted = false
    },

    /** 从主进程读取 .activation/todos-{sessionId}.json（TodoWrite 工具持久化的任务清单，会话级隔离） */
    refreshTodos: async () => {
      try {
        const { currentSessionId } = get()
        const res = await window.lunareclipse?.todosGet?.(currentSessionId ?? undefined)
        if (res?.ok && Array.isArray(res.todos)) {
          const nextTodos = res.todos
          // 内容比较去重——每次轮询都 set 新数组会让订阅组件强制重渲染
          // （HMR 竞态下形成渲染循环）。内容相同则复用旧引用，不触发更新。
          set((s) => {
            if (s.todos.length === nextTodos.length &&
                s.todos.every((t, i) => t.id === nextTodos[i].id && t.status === nextTodos[i].status && t.content === nextTodos[i].content)) {
              return {}
            }
            return { todos: nextTodos }
          })
        }
      } catch (err) {
        console.warn('[appStore] refreshTodos failed:', err)
      }
    },

    // ===== 身份 / 认证 =====
    login: async (username, password) => {
      const res = await window.lunareclipse.authLogin(username, password)
      if (!res.ok || !res.user) {
        throw new Error(res.error ?? '登录失败')
      }
      // SKILL 数据按 {uid}/{aiId} 分层，先清空上一账号残留再加载本账号数据
      useSkillStore.getState().reset()
      set({ currentUser: res.user })
      await get().loadSessions()
      await get().loadAis()
      void useSkillStore.getState().refresh()
    },

    register: async (username, password, intent?: 'local' | 'createMaster' | 'joinSatellite') => {
      const res = await window.lunareclipse.authRegister(username, password, intent)
      if (!res.ok || !res.user) {
        throw new Error(res.error ?? '注册失败')
      }
      useSkillStore.getState().reset()
      set({ currentUser: res.user })
      await get().loadSessions()
      await get().loadAis()
      void useSkillStore.getState().refresh()
    },

    logout: async () => {
      await window.lunareclipse.authLogout()
      useSkillStore.getState().reset()
      set({ currentUser: null, currentSessionId: null, currentMessages: [], sessions: [], ais: [], currentAiId: DEFAULT_AI_ID, aiPickerOpen: false })
    },

    // 登出双确认（TitleBar / Sidebar 共用人机界面）：先确认退出，再询问是否清空本账号
    // 本机工作域数据（记忆/技能/对话/配置/备份等一切用户工作域内容，不可恢复）。
    // 为什么存在——用户政策：注销时须询问是否需要清理数据，避免误触登出导致数据残留
    // 或误删；清理仅作用于当前账号的工作域（purgeUserWorkspace(uid)），不动账号记录
    // 与全局共享数据（plugins/master_seq/AI 注册表等）。
    confirmLogout: async () => {
      const lang = get().lang ?? 'zh'
      const t = (key: string): string => getDictEntry(key)?.[lang] ?? key
      if (!window.confirm(t('auth.confirmLogoutTitle'))) return
      const purge = window.confirm(t('auth.confirmLogoutPurge'))
      if (purge) {
        const res = await window.lunareclipse.authPurgeWorkspace()
        if (!res.ok) {
          window.alert(res.error ?? t('auth.confirmLogoutPurgeFail'))
          return
        }
      }
      await get().logout()
    },

    // 注销账号：删除账号记录但保留所有记忆数据（解放用户名可重新注册）
    // 注意：仅删除 users.json 中的账号记录，不动 raw_memory/memory/NNG/cache/DMN 任何数据
    deleteAccount: async () => {
      const { currentUser } = get()
      if (!currentUser) return
      const res = await window.lunareclipse.authDeleteAccount(currentUser.UID)
      if (!res.ok) {
        throw new Error(res.error || '注销账号失败')
      }
      // 账号已删除，回到登录界面
      useSkillStore.getState().reset()
      set({
        currentUser: null,
        currentSessionId: null,
        currentMessages: [],
        sessions: [],
        ais: [],
        currentAiId: DEFAULT_AI_ID,
        aiPickerOpen: false,
        status: 'idle',
        streamingMessageId: null,
        errorMessage: null,
        activeToolCalls: []
      })
    },

    // 切换用户：清除当前会话状态（不调用 authLogout，避免清空 last_login_uid，登录新用户时会自动覆盖）
    switchUser: async () => {
      useSkillStore.getState().reset()
      set({
        currentUser: null,
        currentSessionId: null,
        currentMessages: [],
        sessions: [],
        ais: [],
        currentAiId: DEFAULT_AI_ID,
        aiPickerOpen: false,
        status: 'idle',
        streamingMessageId: null,
        errorMessage: null
      })
    },

    // ===== 设置面板 / 配置 =====
    openSettings: () => {
      set({ settingsOpen: true })
      // 设置面板是全屏浮层，打开时隐藏浏览器原生 view（OS 层 view 盖不住）
      syncBrowserVisibility(get)
    },
    closeSettings: () => {
      set({ settingsOpen: false })
      syncBrowserVisibility(get)
    },

    saveConfig: async (config) => {
      // 为什么存在：设置面板唯一保存入口；主进程 config:set 可能因磁盘写入失败
      // 或白名单过滤返回 {ok:false}，此前不检查返回直接 set({config}) 会制造
      // 「面板关了、内存有新值、磁盘是旧值」的三重状态分裂，且下次 config:changed
      // 推送把 UI 打回旧值——用户以为保存成功实则没有。
      // 作用：调用主进程并校验结果，成功才更新本地 store；失败抛出错误由调用方
      // （SettingsPanel）展示，不关闭面板。
      const res: { ok: boolean; error?: string } = await window.lunareclipse.setConfig(config)
      if (!res?.ok) {
        throw new Error(res?.error || '保存配置失败')
      }
      const prev = get()
      set({ config })
      // 关闭莉莉丝总开关时，自动收起莉莉丝窗口并恢复切走前的会话
      if (config.lilith?.enabled === false && prev.lilithChatOpen) {
        get().closeLilithChat()
      }
    },

    // 上下文块树改造：switchDmnMode 已移除（模式概念退役）

    setMemoryWorkflowEnabled: async (enabled) => {
      set({ memoryWorkflowEnabled: enabled })
      // IPC 层 memoryWorkflowToggle / dmnHeartbeatToggle 已统一转调 updateMemoryWorkflowEnabled
      await window.lunareclipse.memoryWorkflowToggle(enabled)
    },

    setDiaryWorkflowEnabled: async (enabled) => {
      set({ diaryWorkflowEnabled: enabled })
      await window.lunareclipse.diaryToggle(enabled)
    },

    answerDmnQuestion: async (dmnId, answer) => {
      await window.lunareclipse.dmnAnswer(dmnId, answer)
      set({ dmnAskPrompt: null })
    },

    dismissDmnAsk: () => set({ dmnAskPrompt: null }),

    // ===== 可视化监控 =====
    refreshVisualization: async () => {
      const api = window.lunareclipse
      if (!api?.vizGetAll) return
      set({ visualizationLoading: true })
      try {
        const data = (await api.vizGetAll()) as VisualizationData | null
        set({ visualization: data, visualizationLoading: false })
      } catch (err) {
        console.warn('[viz] refresh failed:', err)
        set({ visualizationLoading: false })
      }
    },

    healthCheckRun: async () => {
      const api = window.lunareclipse
      if (!api?.vizHealthCheckRun) return
      // 先置 loading，立即检查可能耗时数秒（跑 typecheck/test）
      set({ visualizationLoading: true })
      try {
        await api.vizHealthCheckRun()
      } catch (err) {
        console.warn('[viz] healthCheckRun failed:', err)
      } finally {
        // 无论成功失败都刷新可视化数据拿最新快照
        await get().refreshVisualization()
      }
    },

    /** 取消 AI 倒计时（监控面板「定时器」tab），取消后刷新可视化数据 */
    cancelTimer: async (id: string) => {
      const api = window.lunareclipse
      if (!api?.vizTimerCancel) return
      try {
        await api.vizTimerCancel(id)
      } catch (err) {
        console.warn('[viz] timerCancel failed:', err)
      } finally {
        await get().refreshVisualization()
      }
    },

    setVizPanelOpen: (open: boolean) => {
      set({ vizPanelOpen: open })
      // 监控面板打开/关闭时统一同步浏览器 view 显隐（监控打开时 view 必须隐藏，关闭后若浏览器激活则恢复）
      syncBrowserVisibility(get)
    },

    // ===== 布局面板 =====
    setTodoPanelWidth: (px: number) => {
      // 动态上限：不超过窗口宽 45%，防止窄窗口下计划面板挤压聊天区
      const maxW = Math.min(TODO_PANEL_MAX_WIDTH, Math.floor(window.innerWidth * 0.45))
      set({ todoPanelWidth: Math.max(TODO_PANEL_MIN_WIDTH, Math.min(maxW, px)) })
    },

    setWorkshopWidth: (px: number) => {
      const clamped = Math.max(WORKSHOP_MIN_WIDTH, Math.min(WORKSHOP_MAX_WIDTH, px))
      set({ workshopWidth: clamped })
    },

    setWorkshopFullscreen: (on: boolean) => {
      set({ workshopFullscreen: on })
    },

    setSidebarWidth: (px: number) => {
      const clamped = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, px))
      set({ sidebarWidth: clamped })
    },

    setSidebarCollapsed: (collapsed: boolean) => {
      set({ sidebarCollapsed: collapsed })
    },

    setLang: (lang: 'zh' | 'en') => {
      set({ lang })
      try { localStorage.setItem('app.lang', lang) } catch { /* 持久化失败不阻塞语言切换，内存态优先 */ }
    },

    setPreviewingFilePath: (path: string | null) => {
      set({ previewingFilePath: path })
      // 同步推送主进程，供 AI 工作区上下文注入
      void window.lunareclipse?.workspaceSetPreviewFile?.(path)
    },

    // ===== 右侧标签页 / 抽屉 =====
    openRightPanelTab: (tab: RightPanelTabId) => {
      // 轻量面板走抽屉，不走标签页
      if (LIGHT_PANELS.includes(tab)) {
        get().openDrawer(tab)
        return
      }
      // sandbox/file 已迁移到文件工坊侧栏，重定向到 workshop 抽屉
      if (tab === 'sandbox' || tab === 'file') {
        get().openDrawer('workshop')
        return
      }
      // 'chat' 标签永远存在，只需激活
      if (tab === 'chat') {
        set({ activeRightPanel: 'chat' })
        syncBrowserVisibility(get)
        return
      }
      const state = get()
      const tabs = state.rightPanelTabs.includes(tab)
        ? state.rightPanelTabs
        : [...state.rightPanelTabs, tab]
      set({
        rightPanelTabs: tabs,
        activeRightPanel: tab,
        browserPanelOpen: tab === 'browser' ? true : state.browserPanelOpen,
        sandboxPanelOpen: tab === 'sandbox' ? true : state.sandboxPanelOpen
      })
      syncBrowserVisibility(get)
    },

    closeRightPanelTab: (tab: RightPanelTabId) => {
      // 'chat' 标签不可关闭
      if (tab === 'chat') return
      const state = get()
      const idx = state.rightPanelTabs.indexOf(tab)
      if (idx === -1) return
      const tabs = state.rightPanelTabs.filter((t) => t !== tab)
      // 关闭激活标签时切换到相邻标签，无相邻则回退到 'chat'
      const nextActive = state.activeRightPanel === tab
        ? (tabs[Math.min(idx, tabs.length - 1)] ?? 'chat')
        : state.activeRightPanel
      set({
        rightPanelTabs: tabs,
        activeRightPanel: nextActive,
        browserPanelOpen: tabs.includes('browser') ? state.browserPanelOpen : false,
        sandboxPanelOpen: tabs.includes('sandbox') ? state.sandboxPanelOpen : false,
        previewingFilePath: tabs.includes('file') ? state.previewingFilePath : null
      })
      syncBrowserVisibility(get)
    },

    setActiveRightPanel: (tab: RightPanelTabId) => {
      const state = get()
      if (!state.rightPanelTabs.includes(tab)) return
      set({ activeRightPanel: tab })
      // 统一显隐：浏览器 view 跟随激活标签，且受全屏浮层约束
      syncBrowserVisibility(get)
    },

    openDrawer: (tab: RightPanelTabId) => {
      // 同一面板重复点击 = 关闭
      if (get().activeDrawer === tab) {
        set({ activeDrawer: null })
      } else {
        set({ activeDrawer: tab })
      }
      syncBrowserVisibility(get)
    },

    closeDrawer: () => {
      set({ activeDrawer: null })
      syncBrowserVisibility(get)
    },

    setAiPickerOpen: (open) => {
      set({ aiPickerOpen: open })
      // 选择器是居中模态，不涉及浏览器 view 显隐，但保持与其他全屏浮层一致的成本极低
      syncBrowserVisibility(get)
    },

    // 新建会话统一入口：Sidebar「+」/ 标签栏「+」共用。
    // 仅系统月蚀一个启用 AI（或注册表尚未加载）时直接建会话；多个可用 AI 时弹选择器。
    requestNewSession: () => {
      const enabledAis = get().ais.filter((a) => !a.deactivated)
      if (enabledAis.length <= 1) {
        void get().createSession()
      } else {
        set({ aiPickerOpen: true })
      }
    },

    refreshDynamicPanels: async () => {
      try {
        const res = await window.lunareclipse?.pluginPanels?.()
        if (res?.ok && Array.isArray(res.panels)) {
          const existing = get().dynamicPanels
          // 内容比较去重——避免无变化时触发重渲染
          const same = existing.length === res.panels.length &&
            existing.every((p, i) => p.id === res.panels![i].id && p.component === res.panels![i].component)
          if (!same) {
            set({ dynamicPanels: res.panels })
          }
        }
      } catch (err) {
        console.warn('[appStore] refreshDynamicPanels failed:', err)
      }
    }
  }
}