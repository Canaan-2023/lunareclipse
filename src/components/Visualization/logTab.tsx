/**
 * 为什么存在：记忆工作流运行日志是排障的重要依据，独立 Tab 以时间倒序呈现
 * （批次 E-5c 拆分产物）。
 * 作用：渲染运行日志 Tab——记忆工作流运行日志列表（时间 + 内容），空态提示。
 */
import { EmptyHint } from './common'
import { formatDateTime } from '../../utils/time'

/** 运行日志 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */
export function LogTab({ workflowLog }: { workflowLog: Array<{ workflowId: string; text: string; ts: number }> }) {
  if (workflowLog.length === 0) {
    return <EmptyHint text="暂无记忆工作流运行日志（记忆工作流运行时输出会实时显示在这里）" />
  }
  return (
    <div className="space-y-1 font-mono">
      {workflowLog.slice(-100).reverse().map((log, i) => (
        <div key={i} className="rounded-btn border border-border-subtle bg-bg-base/50 px-3 py-1.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">
              {log.workflowId}
            </span>
            <span className="shrink-0 text-[10px] text-fg-muted">
              {formatDateTime(log.ts)}
            </span>
          </div>
          <div className="mt-1 whitespace-pre-wrap break-all text-[11px] text-fg-secondary">
            {log.text}
          </div>
        </div>
      ))}
    </div>
  )
}