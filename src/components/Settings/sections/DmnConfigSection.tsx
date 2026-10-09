/**
 * 为什么存在：DMN 已并入记忆处理工作流（MEMORY_PIPELINE_TEMPLATE），但保留小块
 * 配置入口以控制 RAW 上限与重置工具策略，独立成区避免占用完整 Tab。
 * 作用：渲染 DMN 配置区域——RAW 输出上限说明与编辑、重置 DMN 工具策略按钮。
 */
import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { Field } from '../Field'
import { useT } from '../../../i18n/useT'

/**
 * DMN 配置区域（DMN 已合并到记忆处理工作流 MEMORY_PIPELINE_TEMPLATE）
 */
export function DmnConfigSection({
  config,
  onChange
}: {
  config: AppConfig
  onChange: (config: AppConfig) => void
}) {
  const t = useT()
  // 重置结果反馈：操作完成后短暂提示成功/失败（3 秒自动消失），防止失败被静默吞掉
  const [resetMsg, setResetMsg] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null)

  const resetAllToolPolicy = async () => {
    setResetMsg(null)
    // 破坏性操作护栏：重置会把全部 AI 工具策略打回默认，自定义开关与参数被覆盖且无
    // 撤销入口，先 confirm 再执行（项目删除/清理类操作统一惯例，防手滑误清）
    if (!confirm('重置将把所有 AI 工具策略恢复为默认值，自定义的开关与参数会被覆盖。确定继续？')) return
    try {
      const result = await window.lunareclipse.resetToolPolicy()
      if (result.ok && result.config) {
        onChange(result.config)
        setResetMsg({ text: 'DMN 工具策略已重置为默认', kind: 'ok' })
      } else {
        setResetMsg({ text: `重置失败：${result.error ?? '未知错误'}`, kind: 'err' })
      }
    } catch (err) {
      setResetMsg({ text: `重置失败：${err instanceof Error ? err.message : String(err)}`, kind: 'err' })
    } finally {
      setTimeout(() => setResetMsg(null), 3000)
    }
  }

  return (
    <div className="space-y-4">
      {/* 说明提示 + 重置按钮 */}
      <div className="flex items-center justify-between gap-2 rounded-btn border border-border-subtle bg-bg-muted/40 px-3 py-2">
        <div className="text-caption text-fg-muted">
          {t('settings.dmnPolicyDesc')} {t('settings.dmnPromptSrc')}
        </div>
        <button
          onClick={resetAllToolPolicy}
          className="flex shrink-0 items-center gap-1 rounded-btn px-2 py-1 text-caption text-fg-muted transition-all duration-150 hover:text-accent active:scale-95"
          title={t('settings.dmnResetTitle')}
        >
          <RotateCcw size={12} />
          {t('settings.dmnResetBtn')}
        </button>
      </div>

      {/* 重置提示（一次性成功/失败反馈，3 秒自动消失） */}
      {resetMsg && (
        <div className={`text-[11px] ${resetMsg.kind === 'ok' ? 'text-success' : 'text-danger'}`}>
          {resetMsg.text}
        </div>
      )}

      {/* 记忆工作流说明 */}
      <div className="rounded-btn border border-border-subtle bg-bg-muted/30 px-3 py-2.5">
        <div className="text-caption font-medium text-fg-secondary">{t('settings.dmnWorkflowTitle')}</div>
        <div className="mt-1 text-[11px] leading-relaxed text-fg-muted">
          {t('settings.dmnWorkflowSteps')}
          <br />
          {t('settings.dmnWorkflowDesc')}
          {t('settings.dmnWorkflowToggle')}
        </div>
        {/* RAW 记忆字符上限（可配置调小实测，默认 20000） */}
        <div className="mt-2">
          <Field label={t('settings.dmnRawLimit')}>
            <input
              type="number"
              min="100"
              step="100"
              value={config.rawMaxChars ?? 20000}
              onChange={(e) =>
                onChange({ ...config, rawMaxChars: e.target.value ? Number(e.target.value) : undefined })
              }
              className="w-full rounded-btn border border-border bg-bg-elevated px-3 py-2 text-body text-fg-primary focus:border-accent focus:outline-none"
            />
          </Field>
          <div className="mt-1 text-[10px] leading-relaxed text-fg-muted">
            {t('settings.dmnRawLimitDesc')}
          </div>
        </div>
      </div>
    </div>
  )
}