/**
 * 输入区「模式选择」pill + 下拉（含「自主」入口）。
 *
 * 为什么独立成组件：这一个控件里有**三种不同性质**的状态（`aiMode` 持久化配置 / `plan` 后端会话只读闸 /
 * `auto` 纯视图态），逻辑与 JSX 都不小；原先内联在 `InputArea` 里会让后者继续膨胀——
 * 而 `InputArea.tsx` **在体量台账内（硬约束：行数不得增加）**。抽出后宿主只留一行 `<ModeMenu />`。
 *
 * 关键语义（勿回退）：
 * - 「自主」**不是 `aiMode` 取值**，选中它只切视图（`chatViewMode='room'`），**不写 config、不自动 ARM**；
 * - 选任何「回答方式」（coding/chat/task/plan）都会先退出房间视图——自主是「地方」，不是「回答方式」；
 * - 循环生命周期归主进程（切走视图不停循环），故**不在房间时必须显示运行标记**，否则用户会以为已经退出。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ClipboardList, Code2, MessageCircle, Moon, Users } from 'lucide-react'
import { DEFAULT_AI_ID } from '@shared/types'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { resolveCurrentModeKey, shouldShowRunningIndicator } from './mode-selection'

/** 模式选项元数据：图标 + i18n key（label/desc 在组件内用 t() 解析）。plan 是会话级只读闸，不写 config.aiMode */
const MODE_OPTIONS = [
  { value: 'coding' as const, labelKey: 'mode.coding.label', descKey: 'mode.coding.desc', icon: Code2 },
  { value: 'chat' as const, labelKey: 'mode.chat.label', descKey: 'mode.chat.desc', icon: MessageCircle },
  { value: 'task' as const, labelKey: 'mode.task.label', descKey: 'mode.task.desc', icon: Users },
  { value: 'plan' as const, labelKey: 'mode.plan.label', descKey: 'mode.plan.desc', icon: ClipboardList }
]

/**
 * 「自主」条目——**不是 `aiMode` 取值**，而是**视图状态**（`chatViewMode === 'room'`），
 * 与 plan（会话级只读闸）同理：选中它只进入房间视图，**不写 config.aiMode、不自动 ARM**。
 * 单独一项 + 与前四项之间加分隔线：前四项是「用哪种方式回答」，自主是「去哪个地方」。
 */
const AUTO_MODE = { labelKey: 'mode.auto.label', descKey: 'mode.auto.desc', icon: Moon }

export function ModeMenu() {
  const t = useT()
  const config = useAppStore((s) => s.config)
  const saveConfig = useAppStore((s) => s.saveConfig)
  const chatViewMode = useAppStore((s) => s.chatViewMode)
  const setChatViewMode = useAppStore((s) => s.setChatViewMode)
  const planModeActive = useAppStore((s) => s.planModeActive)
  const setPlanModeActive = useAppStore((s) => s.setPlanModeActive)
  const currentSessionId = useAppStore((s) => s.currentSessionId)
  const sessions = useAppStore((s) => s.sessions)

  const [modeOpen, setModeOpen] = useState(false)
  const modeRef = useRef<HTMLDivElement>(null)

  const inRoom = chatViewMode === 'room'
  const modeKey = resolveCurrentModeKey({ inRoom, planModeActive, aiMode: config.aiMode })
  const currentMode = modeKey === 'auto' ? AUTO_MODE : (MODE_OPTIONS.find((m) => m.value === modeKey) ?? MODE_OPTIONS[0])

  /**
   * 「循环仍在跑但已切走视图」必须让用户看得见（否则会出现「界面看起来已退出、它还在后台干活」）。
   * 房间视图内由房间自己显示状态，故只在**不在房间**时关心；且**不轮询**——挂载时读一次
   * （切走视图时可能已经在跑），此后由主进程状态推送（`room:state-changed`）驱动。
   */
  const roomAiId = sessions.find((s) => s.id === currentSessionId)?.aiId ?? DEFAULT_AI_ID
  const [roomRunning, setRoomRunning] = useState(false)
  useEffect(() => {
    if (inRoom) {
      setRoomRunning(false)
      return
    }
    let alive = true
    void window.lunareclipse?.roomStatus?.(roomAiId).then((r) => {
      if (alive) setRoomRunning(r?.status?.running === true)
    })
    const off = window.lunareclipse?.onRoomState?.((payload) => {
      if (payload.aiId !== roomAiId) return
      const st = payload.state as { running?: boolean } | undefined
      if (alive) setRoomRunning(st?.running === true)
    })
    return () => {
      alive = false
      off?.()
    }
  }, [inRoom, roomAiId])
  const showRunning = shouldShowRunningIndicator({ inRoom, roomRunning })

  // 点击外部关闭下拉
  const closeMenu = useCallback((): void => setModeOpen(false), [])
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (modeRef.current && !modeRef.current.contains(e.target as Node)) closeMenu()
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [closeMenu])

  return (
    <div ref={modeRef} className="relative shrink-0">
      <button
        onClick={() => setModeOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={modeOpen}
        className="flex items-center gap-1 rounded-full bg-bg-muted px-2 py-1 text-caption text-fg-secondary transition-all duration-150 hover:text-fg-primary active:scale-95"
        title={t('mode.title')}
      >
        <currentMode.icon size={12} className="text-fg-muted" />
        {/* 已切走视图但循环仍在跑 → pill 上必须有可见标记（含 aria-label） */}
        {showRunning && (
          <span
            role="img"
            aria-label={t('mode.auto.running')}
            className="status-breath inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
          />
        )}
        <span>{t(currentMode.labelKey)}</span>
        <ChevronDown size={10} className={`text-fg-muted transition-transform ${modeOpen ? 'rotate-180' : ''}`} />
      </button>

      {modeOpen && (
        <div role="menu" className="absolute bottom-full left-0 z-30 mb-1 w-56 rounded-btn border border-border bg-bg-elevated py-1 shadow-lg">
          {MODE_OPTIONS.map((opt) => {
            // 在房间里时四项都不算「当前」——pill 显示的是「自主」
            const isActive = !inRoom && (planModeActive ? opt.value === 'plan' : (config.aiMode ?? 'coding') === opt.value)
            return (
              <button
                key={opt.value}
                role="menuitem"
                onClick={() => {
                  // 选任何「回答方式」都先退出房间视图（自主是地方，不是回答方式）；aiMode 本身不受房间影响
                  if (inRoom) setChatViewMode('normal')
                  if (opt.value === 'plan') {
                    // 计划模式是会话级只读闸：只进不写 config.aiMode（后端类型不含 plan）
                    void setPlanModeActive(true)
                  } else {
                    if (planModeActive) void setPlanModeActive(false)
                    saveConfig({ ...config, aiMode: opt.value })
                  }
                  closeMenu()
                }}
                className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors ${
                  isActive ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
                }`}
              >
                <opt.icon size={12} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-caption font-medium">{t(opt.labelKey)}</span>
                    {isActive && <Check size={10} className="text-accent" />}
                  </div>
                  <div className="text-micro text-fg-muted">{t(opt.descKey)}</div>
                </div>
              </button>
            )
          })}

          {/* 分隔线：「自主」是「去哪个地方」，不是「用哪种方式回答」 */}
          <div className="my-1 border-t border-border-subtle" />

          <button
            role="menuitem"
            onClick={() => {
              setChatViewMode('room')
              closeMenu()
            }}
            className={`flex w-full items-start gap-2 px-2.5 py-2 text-left transition-colors ${
              inRoom ? 'bg-accent/10 text-accent' : 'text-fg-secondary hover:bg-bg-muted'
            }`}
          >
            <AUTO_MODE.icon size={12} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-caption font-medium">{t(AUTO_MODE.labelKey)}</span>
                {inRoom && <Check size={10} className="text-accent" />}
                {showRunning && (
                  <span
                    role="img"
                    aria-label={t('mode.auto.running')}
                    className="status-breath inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                  />
                )}
              </div>
              <div className="text-micro text-fg-muted">
                {showRunning ? t('mode.auto.running') : t(AUTO_MODE.descKey)}
              </div>
            </div>
          </button>

          {/* 切走视图后仍可见的快捷入口：回房间 / 立即停止（「暂停=做完当前步」属阶段 B，见任务清单） */}
          {showRunning && (
            <div className="flex gap-1 px-2.5 pb-2">
              <button
                onClick={() => {
                  setChatViewMode('room')
                  closeMenu()
                }}
                className="rounded-btn bg-accent/10 px-2 py-0.5 text-micro text-accent hover:bg-accent/20"
              >
                {t('mode.auto.return')}
              </button>
              <button
                onClick={() => {
                  void window.lunareclipse?.roomStopLoop?.(roomAiId)
                  setRoomRunning(false)
                  closeMenu()
                }}
                className="rounded-btn bg-bg-muted px-2 py-0.5 text-micro text-fg-secondary hover:text-fg-primary"
              >
                {t('mode.auto.stop')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
