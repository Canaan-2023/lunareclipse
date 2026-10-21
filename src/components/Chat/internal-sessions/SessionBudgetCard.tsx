/**
 * @category 前端组件
 * @summary 会话上下文上限配置小卡片
 * @note 为什么存在：原 `InternalSessionsView.tsx` 1408 行破 800 硬红线（ADR-27 拆分）；配置卡与树渲染无耦合，只读写配置。
 * @note 不删理由：用户需要在不离开内部会话视图的情况下查看/修改「会话上下文上限」，且自动模式（0）必须展示推导结果。
 */

import {
  useEffect,
  useState
} from 'react'
import {
  Check,
  X,
  Settings2
} from 'lucide-react'
import { SessionSummaryEffectiveInfo } from '@shared/types'
import { useT } from '../../../i18n/useT'

/**
 * 会话上限配置小卡片。
 * 为什么存在：用户需要在不离开内部会话视图的情况下查看/修改「会话上下文上限」
 * （summaryBudgetChars）——超限即触发原会话冻结 + 新建继承会话；
 * 自动模式（0）下需要把模型窗口 ×1/4 的推导结果直接展示出来，纯配置值
 * （0）对用户不可理解。放在头部右上角开关的独立卡片中（max-w-md，不占满面板）。
 * 作用：读 memoryWorkflow:sessionSummary:effective 展示「配置/生效/自动 vs 手动/模型窗口」，
 * 支持输入 0=自动或正整数=手动值，写 memoryWorkflow:config:update 落盘，保存后刷新生效值。
 * 校验纪律：非正整数（含负数/NaN）不提交并给出提示，防止把非法值写进配置。
 */
export function SessionBudgetCard({ onClose }: { onClose: () => void }) {
  const t = useT()
  // effective 拉取结果；null=未加载/加载失败
  const [info, setInfo] = useState<SessionSummaryEffectiveInfo | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // 输入草稿（初始为配置值；编辑时本地持有，Enter 保存）
  const [draft, setDraft] = useState('')
  // 校验错误：非法输入时不提交，提示用户
  const [draftError, setDraftError] = useState(false)
  // 保存反馈：idle=未保存 / saved=成功 / error=失败
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'error'>('idle')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const eff = await window.lunareclipse.memoryWorkflowGetSessionSummaryEffective()
      if (eff) {
        setInfo(eff)
        setDraft(String(eff.configured))
        setLoadFailed(false)
      } else {
        setLoadFailed(true)
      }
    } catch {
      // IPC 异常：视为加载失败，展示重试入口而非静默
      setLoadFailed(true)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    const v = Number(draft)
    if (!Number.isInteger(v) || v < 0) {
      setDraftError(true)
      return
    }
    setDraftError(false)
    setBusy(true)
    setSaveState('idle')
    try {
      const ok = await window.lunareclipse.memoryWorkflowUpdateConfig({ sessionSummary: { summaryBudgetChars: v } })
      // 回执形态防御：先判对象再查 ok 字段（null/原始值直接视为失败，避免 'ok' in 抛错）
      if (!ok || typeof ok !== 'object' || !('ok' in ok) || ok.ok !== true) {
        setSaveState('error')
        return
      }
      setSaveState('saved')
      // 保存成功即刷新生效值：手动值下 effective=configured；自动值（0）下需重新推导
      await load()
    } catch {
      setSaveState('error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5 rounded-card border border-border-subtle bg-bg-surface/80 p-3.5 shadow-lg backdrop-blur-sm">
      {/* 卡片头：标题 + 关闭 */}
      <div className="flex items-center gap-2">
        <Settings2 size={13} className="shrink-0 text-accent" />
        <span className="text-body font-medium text-fg-primary">{t('internal.budgetLabel')}</span>
        <button
          onClick={onClose}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-btn text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
          title={t('common.close')}
          aria-label={t('common.close')}
        >
          <X size={12} />
        </button>
      </div>

      {/* 加载失败：重试入口 */}
      {loadFailed && !info ? (
        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-red-400">{t('internal.budgetLoadFailed')}</span>
          <button
            onClick={() => void load()}
            className="flex h-7 items-center gap-1.5 rounded-btn border border-border-subtle px-2.5 text-caption text-fg-secondary transition-all hover:border-accent/30 hover:text-accent"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></svg>
            {t('view.refresh')}
          </button>
        </div>
      ) : info ? (
        <>
          {/* 当前生效信息 */}
          <div className="space-y-1 rounded-btn border border-border-subtle bg-bg-elevated/60 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-caption text-fg-muted">{t('internal.budgetMode')}</span>
              <span className={`rounded-full px-2 py-0.5 text-caption font-medium ${info.auto ? 'bg-accent/15 text-accent' : 'bg-emerald-500/15 text-emerald-400'}`}>
                {info.auto ? t('internal.budgetAuto') : t('internal.budgetManual')}
              </span>
            </div>
            <div className="text-body tabular-nums text-fg-primary">
              {t('internal.budgetEffective', { n: info.effective.toLocaleString() })}
            </div>
            <div className="text-caption tabular-nums text-fg-muted/70">
              {t('internal.budgetModelWindow', { n: info.modelWindow.toLocaleString() })}
            </div>
          </div>

          {/* 输入 + 保存/取消 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="10000"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setDraftError(false)
                  setSaveState('idle')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void save()
                  if (e.key === 'Escape') { setDraft(String(info.configured)); setDraftError(false); setSaveState('idle') }
                }}
                aria-label={t('internal.budgetInput')}
                aria-invalid={draftError}
                className="min-w-0 flex-1 rounded-btn border border-border-subtle bg-bg-elevated px-2.5 py-1.5 text-body tabular-nums text-fg-primary outline-none focus:border-accent/40"
              />
              <button
                disabled={busy}
                onClick={() => void save()}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-btn bg-accent/15 px-3 text-caption font-medium text-accent transition-all hover:bg-accent/25 disabled:opacity-40"
              >
                <Check size={13} />
                {t('internal.budgetSave')}
              </button>
            </div>
            <div className="text-caption text-fg-muted/80">
              {draftError
                ? <span className="text-red-400">{t('internal.budgetInvalid')}</span>
                : saveState === 'saved'
                  ? <span className="text-accent">{t('internal.budgetSaved')}</span>
                  : saveState === 'error'
                    ? <span className="text-red-400">{t('internal.budgetSaveFailed')}</span>
                    : t('internal.budgetInputHint')}
            </div>
          </div>
        </>
      ) : (
        /* 首次加载中：简短占位，避免布局跳动 */
        <div className="py-2 text-caption text-fg-muted/60">…</div>
      )}
    </div>
  )
}
