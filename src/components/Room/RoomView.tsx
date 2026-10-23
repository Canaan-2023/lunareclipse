/**
 * 自主房间（ROOM）原位视图 —— **一个存在 + 一条输出 + 一个开关**。
 *
 * 为什么重做（用户 2026-10-19 裁决）：「自主模式的 UI 和像素图得重新做，太蠢了，其实没必要
 * 什么都摆在明面上，**留出一个输出**，其余的…」「如果是科幻作品里的人工智能，那会是怎样的界面？」
 *
 * 重做前的病：常驻 **8 个元素**（仪表栏 / 相位灯组 / 三 tab 区导航 / 三个区面板 / 状态栏 /
 * 事件流 / 抽屉 / 诚实边界），同一件事（AI 在干什么）被**说了四遍**——信息没有层级，
 * 用户进来不知道该先看哪。**那不是不够漂亮，是没做减法。**
 *
 * 重做后常驻只有三件：
 * 1. `PresenceBar`：它是谁 / **它现在怎么样**（一个小月相：形状 + 呼吸节奏 + 色温 + 状态词）/ 开关；
 * 2. `Presence`：它住的房间（透视直播镜头）+ 窗外系统给的真实光 + 呼吸；
 * 3. `OutputStream`：**唯一输出**——它做过的，一行行。
 * 其余一切（计划 / 落点 / 工具 / 采集 / 设备 / 日记 / 授权 / 关于）**降一层**到 `DetailPanel`。
 *
 * 两条有意语义（勿回退）：
 * - **房间所属 AI = 当前会话所属 AI**（只读标签）；**视图不持有循环生命周期**（开关只表达
 *   「要 / 不要」，持有者是主进程 `RoomLoopSupervisor`）。
 * - **运行态只有一个取数点**（`useRoomRuntimeState`：挂载读一次 + 订阅推送），全房间吃同一份快照。
 *
 * 不删理由：删掉即自主模式没有可视化承载面。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_AI_ID } from '@shared/types'
import { DEFAULT_ROOM_APPEARANCE, sceneKeysOf } from '@shared/room/appearance'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { PresenceBar } from './PresenceBar'
import { Presence } from './Presence'
import { OutputStream } from './OutputStream'
import { RoomLogPanel } from './RoomLogPanel'
import { DetailPanel, type DetailTab } from './DetailPanel'
import { useRoomRuntimeState } from './use-room-state'
import { reloadAppearance, saveAppearance, useAppearance } from './use-appearance'
import { currentStageOf, stageIndex } from './room-status'

/** 常驻输出带高度（px）：舞台字幕要抬到它上面；输入栏变高只抬高带子 */
const OUTPUT_STRIP_H = 112
/**
 * 输出带与输入栏的重叠量（px）。
 * `bottomInset` 来自输入框测量值 `Math.ceil`，输出带 bottom 正好落在输入栏上沿时
 * 会因亚像素取整露出 1px 缝隙（用户 2026-10-23：「下面有一条缝隙漏光」）。
 * 向下多铺 2px，由后绘制的输入栏盖住——视觉上无缝，也不改变舞台/字幕位置。
 */
const OUTPUT_STRIP_OVERLAP = 2

export function RoomView({ sessionId, bottomInset = 0 }: { sessionId: string; bottomInset?: number }) {
  const t = useT()
  const sessions = useAppStore((s) => s.sessions)
  const ais = useAppStore((s) => s.ais)
  const aiId = sessions.find((s) => s.id === sessionId)?.aiId ?? DEFAULT_AI_ID
  const aiName = ais.find((a) => a.id === aiId)?.name ?? `AI${aiId}`

  /** **唯一**运行态快照：顶栏 / 房间画面 / 输出流 / 细节面板全部吃它 */
  const roomState = useRoomRuntimeState(aiId)
  const appearance = useAppearance(aiId)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('act')
  const [logOpen, setLogOpen] = useState(false)
  /**
   * **手动切背景**（用户 2026-10-20；2026-10-23 改为按真实文件名）：只在当前画面生效，不写配置。
   * 背景不再跟随 AI 的 `scene.zone` 或活动阶段自动切换——`manualKey` 只来自这里。
   */
  const [manualKey, setManualKey] = useState<string | null>(null)
  const [bgOpen, setBgOpen] = useState(false)
  // 选项 = scenes 目录里真实存在的图片文件名（去扩展名），自然序；菜单直接显示文件名
  const sceneKeys = sceneKeysOf(appearance.scenes)
  /**
   * 立绘复位（用户 2026-10-23：「有时候立绘拖出图之后就看不到了」）：
   * 拖到画面外后没有可抓的地方，必须有一条不依赖点击人物的逃生通道。
   * 只重置人物位置/高度/大小，保留形象来源与背景模式。
   */
  const resetCharacter = (): void => {
    void saveAppearance(aiId, {
      ...appearance.appearance,
      character: { ...DEFAULT_ROOM_APPEARANCE.character }
    })
  }
  // 小浮层：Esc 关闭（与 LOG 抽屉同口径）
  useEffect(() => {
    if (!bgOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setBgOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [bgOpen])
  const [loopError, setLoopError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const phase = roomState.phase
  const running = roomState.running
  const llmFailed = roomState.lastTick?.llmFailed === true
  /**
   * 当前阶段取自**事件环尾部**（`stageFromEvents`），不是 `lastTick.phase`：
   * 后者只可能是 execute/idle，阶段判定会永远停在 execute（见 `room-status.ts` 的注释）。
   */
  const stage = currentStageOf(roomState)
  const appendRoomMessage = useAppStore((s) => s.appendRoomMessage)
  /** 房间回复落回会话历史：只在 `lastReplyAt` 变化时追加（幂等；不触发普通 AI） */
  const handledReplyRef = useRef<number | null>(null)
  useEffect(() => {
    const at = roomState.lastReplyAt
    const reply = roomState.lastReply
    if (!reply || !at || handledReplyRef.current === at) return
    handledReplyRef.current = at
    appendRoomMessage(reply, 'assistant', at)
  }, [roomState.lastReply, roomState.lastReplyAt, appendRoomMessage])


  // 上报「房间正承载在哪个会话」：仅在 AI 选了 contextMode='session' 时影响房间选路。
  // 卸载时清空（避免留下过期会话）；房间**配置**挂在 AI 上，换会话不会重置它。
  useEffect(() => {
    const api = window.lunareclipse
    void api?.roomSetHostSession?.({ aiId, sessionId })
    return () => {
      void api?.roomSetHostSession?.({ aiId, sessionId: '' })
    }
  }, [aiId, sessionId])

  // 「用户来了」唤醒源（ADR-29 裁决3）：房间视图可见 / 窗口聚焦即**上报**一次。
  // 只上报——是否真的唤醒由主进程 `room/wake.ts` 的仲裁器去抖后决定（同源 5s / 跨源 60s）。
  useEffect(() => {
    const report = (): void => {
      void window.lunareclipse?.roomWake?.(aiId)
    }
    report()
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') report()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [aiId])

  // 外观配置（人物位置/大小 + 背景/分区场景）：按 AI 取一次；保存后由 hook 内部重读，不轮询
  useEffect(() => {
    void reloadAppearance(aiId)
  }, [aiId])

  // 动作后的状态由主进程推送回来（`start-loop` / `stop-loop` 都会触发状态推送），故不取数。
  const start = useCallback(async () => {
    setBusy(true)
    setLoopError(null)
    try {
      const r = await window.lunareclipse?.roomStartLoop?.(aiId)
      if (r && r.ok === false) setLoopError(r.error ?? null)
    } finally {
      setBusy(false)
    }
  }, [aiId])

  const stop = useCallback(async () => {
    setBusy(true)
    try {
      await window.lunareclipse?.roomStopLoop?.(aiId)
    } finally {
      setBusy(false)
    }
  }, [aiId])

  return (
    <div className="room-pixel relative flex h-full min-h-0 w-full flex-col bg-bg-base">
      <PresenceBar
        aiName={aiName}
        phase={phase}
        running={running}
        busy={busy}
        llmFailed={llmFailed}
        {...(roomState.standbyUntil != null ? { standbyUntil: roomState.standbyUntil } : {})}
        stage={stageIndex(stage)}
        sensing={roomState.sensing === true}
        onToggle={() => void (running ? stop() : start())}
        onOpenDetail={() => setDetailOpen(true)}
        onOpenLog={() => setLogOpen(true)}
      />

      {/* 开关失败的原因（如未登录 / 该 AI 已下线）——不静默，但也不占常驻版面 */}
      {loopError && (
        <div className="shrink-0 truncate px-3 pb-1 text-micro text-danger" title={loopError}>
          {loopError}
        </div>
      )}

      {/* 它住的房间：**舞台占满剩余空间**（GALGAME 式：舞台是主体，记录按需打开）。
          `scene` 决定姿态与台词；`reply` 进底部单行字幕。
          输入栏浮在底部（ChatArea）：`bottomInset` 只用来把字幕抬高，**不压缩舞台**
          （用户「上面不要动」）。 */}
      <Presence
        aiId={aiId}
        phase={phase}
        avatarRev={roomState.avatarRev}
        llmFailed={llmFailed}
        {...(stage ? { stage } : {})}
        {...(roomState.scene ? { scene: roomState.scene } : {})}
        {...(roomState.lastReply ? { reply: roomState.lastReply } : {})}
        aiName={aiName}
        bottomInset={bottomInset + OUTPUT_STRIP_H}
        appearance={appearance.appearance}
        appearanceLoaded={appearance.loaded}
        background={appearance.background}
        scenes={appearance.scenes}
        live2d={appearance.live2d}
        backgroundOverride={manualKey}
      />

      {/* **输出常驻**（用户 2026-10-20：「AI 的输出地方一定要有，我目前是没有看到」）。
          它是一条浮在舞台底部的紧凑终端带（约 4 行），完整历史点「记录」打开 LOG 抽屉。
          **绝对定位**：输入栏变高时只把带子抬高，舞台高度不变（「上面不要动」）。 */}
      <div
        className="pointer-events-auto absolute inset-x-0 z-10 flex flex-col border-t border-border-subtle/60 bg-bg-base/85 backdrop-blur-sm"
        style={{
          // 向下重叠 2px：盖住输入栏上沿的亚像素缝隙（见 OUTPUT_STRIP_OVERLAP）
          bottom: Math.max(0, bottomInset - OUTPUT_STRIP_OVERLAP),
          height: OUTPUT_STRIP_H + OUTPUT_STRIP_OVERLAP
        }}
      >
        <div className="flex shrink-0 items-center gap-2 px-3 pt-1">
          <span className="font-mono text-micro tracking-wider text-fg-muted">{t('room.stream')}</span>
          {appearance.appearance.background.mode === 'image' && sceneKeys.length > 0 && (
            <button
              type="button"
              onClick={() => setBgOpen((v) => !v)}
              aria-expanded={bgOpen}
              aria-label={t('room.background.switch')}
              title={t('room.background.switch')}
              className={`room-press px-1.5 py-0.5 text-micro ${bgOpen ? 'text-accent' : 'text-fg-muted'}`}
            >
              {t('room.background.switch')} {bgOpen ? '▾' : '▸'}
            </button>
          )}
          <button
            type="button"
            onClick={() => resetCharacter()}
            className="room-press ml-auto px-1.5 py-0.5 text-micro text-fg-muted"
            title={t('room.appearance.resetCharacterHint')}
            aria-label={t('room.appearance.resetCharacter')}
          >
            {t('room.appearance.resetCharacter')}
          </button>
          <button
            type="button"
            onClick={() => setLogOpen(true)}
            className="room-press px-1.5 py-0.5 text-micro text-fg-muted"
            title={t('room.log')}
            aria-label={t('room.log')}
          >
            {t('room.log')} →
          </button>
        </div>
        {/* 手动切背景：只列 `scenes/` 里**真实存在的图片**，按钮文字就是文件名（去扩展名）；
            没有「跟随 AI」——背景不自动切 */}
        {bgOpen && (
          <div
            role="group"
            aria-label={t('room.background.switch')}
            className="absolute bottom-full right-2 z-20 mb-1 flex max-w-[min(30rem,calc(100%-1rem))] flex-wrap gap-1 rounded-card border border-border-subtle bg-bg-base/95 p-2 shadow-xl backdrop-blur-sm"
          >
            {sceneKeys.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setManualKey(key)
                  setBgOpen(false)
                }}
                aria-pressed={manualKey === key}
                className={`room-press rounded-btn border px-2 py-0.5 text-micro ${
                  manualKey === key
                    ? 'border-accent/60 text-accent'
                    : 'border-border-subtle text-fg-muted'
                }`}
              >
                {key}
              </button>
            ))}
          </div>
        )}
        <div className="flex h-20 min-h-0 flex-col">
          <OutputStream events={roomState.events} live={running} />
        </div>
      </div>

      {/* 「记录」：GALGAME 式 LOG 抽屉——它说过的话 / 做过的事按时间回看。
          内容仍是终端流（不把输出改成 GALGAME 台词），只是不再常驻占版面。 */}
      <RoomLogPanel
        open={logOpen}
        onClose={() => setLogOpen(false)}
        events={roomState.events}
        live={running}
      />

      {/* 其余一切：一次点击之后 */}
      <DetailPanel
        open={detailOpen}
        tab={detailTab}
        onTab={setDetailTab}
        onClose={() => setDetailOpen(false)}
        state={roomState}
        aiId={aiId}
        aiName={aiName}
        {...(roomState.sessionId ? { roomSessionId: roomState.sessionId } : {})}
      />
    </div>
  )
}
