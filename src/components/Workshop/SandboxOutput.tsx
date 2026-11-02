/**
 * 为什么存在：沙箱运行时输出是流式追加的高频更新源（每次追加都会改动 store 里的 output 字符串）。
 * 若由文件工坊主组件订阅，则每次输出 tick 都会连带重渲染代码编辑器、语言栏、头部按钮等无关子树。
 * 作用：输出区（输出头部 / 流式文本 / 运行结果 / 底部执行栏）独立订阅 sandboxOutput/sandboxResult/
 * sandboxRunning，流式期间只重渲染本组件；主组件只订阅布尔派生值（是否已有输出、是否运行中）。
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal, Loader2, Clock, Play } from 'lucide-react'
import { useAppStore } from '../../stores/appStore'
import { useT } from '../../i18n/useT'
import { formatValue } from '@shared/utils/format-value'

export function SandboxOutput({ splitRatio }: { splitRatio: number }) {
  const t = useT()
  const output = useAppStore((s) => s.sandboxOutput)
  const result = useAppStore((s) => s.sandboxResult)
  const running = useAppStore((s) => s.sandboxRunning)
  const run = useAppStore((s) => s.sandboxRun)

  const outputRef = useRef<HTMLDivElement>(null)
  // 结果块显隐：有结果后保持展示，避免同一次运行内输出追加时反复闪动
  const [showResult, setShowResult] = useState(false)

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight
    }
  }, [output])

  useEffect(() => {
    if (result) setShowResult(true)
  }, [result])

  const hasOutput = !!(output || result)

  return (
    <div className="flex flex-col overflow-hidden" style={{ height: `${(1 - splitRatio) * 100}%` }}>
      <div className="flex items-center gap-1.5 border-b border-border-subtle bg-bg-surface/50 px-2.5 py-0.5">
        <Terminal size={9} className="text-fg-muted" />
        <span className="text-[10px] uppercase tracking-wider text-fg-muted">{t('panelui.workshop.sandbox.output')}</span>
        {running && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-accent">
            <Loader2 size={9} className="animate-spin" />
            {t('panelui.workshop.sandbox.running')}
          </span>
        )}
        {result && !running && (
          <span className="ml-auto flex items-center gap-1 text-[10px] text-fg-muted">
            <Clock size={9} />
            {result.durationMs}ms
            {result.timedOut && <span className="text-warning">{t('panelui.workshop.sandbox.timeout')}</span>}
          </span>
        )}
      </div>

      <div
        ref={outputRef}
        className="flex-1 overflow-auto bg-bg-base px-2.5 py-2 font-mono"
        style={{
          fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, Monaco, monospace',
          fontSize: '11px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all'
        }}
      >
        {!hasOutput ? (
          <div className="flex h-full items-center justify-center text-fg-muted">
            <div className="text-center">
              <Terminal size={20} className="mx-auto mb-1.5 opacity-30" />
              <div className="text-caption">{t('panelui.workshop.sandbox.runHint')}</div>
            </div>
          </div>
        ) : (
          <>
            {output && (
              <pre className="whitespace-pre-wrap break-all">{output}</pre>
            )}
            {showResult && result && (
              <div className="mt-2 border-t border-border-subtle pt-2">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-fg-muted">
                  {t('panelui.workshop.sandbox.result')} {result.ok ? 'OK' : 'FAIL'}
                </div>
                {result.result !== undefined && (
                  <pre className="whitespace-pre-wrap break-all text-success">
                    {formatValue(result.result)}
                  </pre>
                )}
                {result.errorMessage && (
                  <pre className="whitespace-pre-wrap break-all text-danger">
                    {result.errorMessage}
                  </pre>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 底部执行栏 */}
      <div className="flex items-center gap-2 border-t border-border-subtle bg-bg-surface px-2.5 py-1.5">
        {!running ? (
          <button
            onClick={() => void run()}
            className="flex items-center gap-1.5 rounded-btn bg-accent px-3 py-1 text-caption text-accent-fg hover:bg-accent/90"
            title={t('panelui.workshop.sandbox.runTitle')}
          >
            <Play size={11} />
            {t('panelui.workshop.sandbox.run')}
          </button>
        ) : (
          <button
            disabled
            className="flex items-center gap-1.5 rounded-btn bg-bg-muted px-3 py-1 text-caption text-fg-muted cursor-not-allowed"
          >
            {/* 运行中禁用 + 旋转指示：原名 Square 停止图标对 disabled 按钮
                是 affordance 误导（评审 MINOR-3）——改为 Loader2 表达「进行中」，
                避免用户误以为可以手动停止却点击无反馈。 */}
            <Loader2 size={11} className="animate-spin" />
            {t('panelui.workshop.sandbox.runningEllipsis')}
          </button>
        )}
        <div className="text-[10px] text-fg-muted">
          {running ? t('panelui.workshop.sandbox.timeoutAutoStop') : t('panelui.workshop.sandbox.ready')}
        </div>
      </div>
    </div>
  )
}
