/**
 * 为什么存在：多 AI 环境下新建会话必须明确会话归属哪个 AI，需要选择器模态
 * 消除歧义（仅一个 AI 时直接建，不打扰用户）。
 * @category 多 AI 子系统
 * @summary 新建会话选择器：多 AI 时点「+」弹出的居中模态，列出所有启用的 AI，
 * 点击即建会话并跳转。仅系统月蚀一个启用 AI 时不弹出（store.requestNewSession 直接建）。

 * 排序：系统 AI 置顶（月蚀=1 最前），其余按 id 升序，停用的不展示。
 */
import { useEffect } from 'react'
import { Sparkles, X } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { AiAvatar, aiAvatarFallback } from './AiAvatar'

export function NewSessionPicker() {
  const open = useAppStore((s) => s.aiPickerOpen)
  const ais = useAppStore((s) => s.ais)
  const createSession = useAppStore((s) => s.createSession)
  const setAiPickerOpen = useAppStore((s) => s.setAiPickerOpen)
  const closeDrawer = useAppStore((s) => s.closeDrawer)
  const t = useT()

  // 打开时确保注册表新鲜（登录后已加载，这里兜底）
  useEffect(() => {
    if (open) void useAppStore.getState().loadAis()
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAiPickerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setAiPickerOpen])

  if (!open) return null

  // 启用的 AI：系统置顶（月蚀=1 最前），其余按 id 升序
  const enabled = ais
    .filter((a) => !a.deactivated)
    .sort((a, b) => {
      const ak = a.kind === 'system' ? 0 : 1
      const bk = b.kind === 'system' ? 0 : 1
      if (ak !== bk) return ak - bk
      return a.id - b.id
    })

  const pick = (aiId: number) => {
    setAiPickerOpen(false)
    // 若某抽屉面板开着，先收起，让会话区占据完整宽度
    if (useAppStore.getState().activeDrawer) closeDrawer()
    void createSession(aiId)
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setAiPickerOpen(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('ai.pickTitle')}
        className="w-[360px] max-w-[90vw] overflow-hidden rounded-card border border-border bg-bg-elevated shadow-2xl"
      >
        {/* 标题栏 */}
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
          <Sparkles size={14} className="shrink-0 text-accent" />
          <span className="flex-1 truncate text-caption font-medium text-fg-primary">
            {t('ai.pickTitle')}
          </span>
          <button
            onClick={() => setAiPickerOpen(false)}
            aria-label={t('common.close')}
            className="flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-colors hover:bg-bg-muted hover:text-fg-primary"
            title={t('common.close')}
          >
            <X size={13} />
          </button>
        </div>

        {/* AI 列表 */}
        <div className="max-h-[60vh] overflow-y-auto p-2">
          {enabled.length === 0 ? (
            <div className="px-3 py-8 text-center text-caption text-fg-muted">
              {t('ai.pickEmpty')}
            </div>
          ) : (
            enabled.map((ai) => (
              <button
                key={ai.id}
                onClick={() => pick(ai.id)}
                className="group mb-1 flex w-full items-center gap-3 rounded-btn px-3 py-2.5 text-left transition-all duration-150 hover:bg-bg-muted/80 active:scale-[0.99]"
              >
                <AiAvatar
                  avatar={ai.avatar}
                  fallback={aiAvatarFallback(ai.id)}
                  className="h-8 w-8 text-base"
                  title={ai.name}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-body font-medium text-fg-primary">{ai.name}</span>
                    {ai.kind === 'system' && (
                      <span className="shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">
                        {t('ai.system')}
                      </span>
                    )}
                  </div>
                  {ai.description && (
                    <div className="mt-0.5 line-clamp-1 text-caption text-fg-muted">{ai.description}</div>
                  )}
                </div>
                <span className="shrink-0 rounded-full bg-bg-muted px-1.5 py-0.5 text-micro text-fg-muted">
                  #{ai.id}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}