/**
 * 为什么存在：监控面板按域拆 Tab，记忆工作流域（RAW/错误/工作流/记忆摘要）独立成组件
 * （批次 E-5c 拆分产物），便于聚焦与复用。
 * 作用：渲染记忆工作流监控 Tab——最新 RAW 展示、错误日志列表、工作流实例进度汇总
 * 与记忆总览统计卡。
 */
import { RefreshCw, AlertTriangle, FileText, Activity, FolderOpen } from 'lucide-react'
import { openFilePreview } from '../Workshop/filePreviewOpener'
import type { VisualizationData, ErrorLogEntry, WorkflowInstanceSummary, RawMemoryLatest } from '@shared/types'
import { SectionTitle, EmptyHint, StatCard } from './common'
import { formatDateTime } from '../../utils/time'
import { useT } from '../../i18n/useT'

/** 记忆工作流监控 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */
export function MemoryWorkflowTab({ data, loading }: { data: VisualizationData | null; loading: boolean }) {
  const t = useT()
  if (!data) {
    // 加载中显示骨架提示，否则用醒目卡片提示无数据（虚线边框 + 图标 + 说明文字）
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-btn border border-dashed border-border-subtle px-4 py-10 text-center">
          <RefreshCw size={20} className="animate-spin text-fg-muted" />
          <div className="text-caption text-fg-secondary">{t('vizui.workflow.loading')}</div>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-btn border border-dashed border-border-subtle px-4 py-10 text-center">
        <AlertTriangle size={22} className="text-fg-muted" />
        <div className="text-body text-fg-secondary">{t('vizui.workflow.noData')}</div>
        <div className="text-caption text-fg-muted">{t('vizui.workflow.noDataHint')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 最新 RAW（raw_memory 最新一条，监控面板 RAW 接口） */}
      <section>
        <SectionTitle icon={FileText} title={t('vizui.workflow.latestRaw')} />
        {data.latestRawMemory ? (
          <LatestRawItem raw={data.latestRawMemory} />
        ) : (
          <EmptyHint text={t('vizui.workflow.emptyRaw')} />
        )}
      </section>

      {/* 工作流进度（进度来自工作流引擎实例；旧心跳 .dmn_shared/进度.json 已停更废弃） */}
      <section>
        <SectionTitle icon={RefreshCw} title={t('vizui.workflow.progressTitle', { n: data.workflowInstances.length })} />
        {data.workflowInstances.length === 0 ? (
          <EmptyHint text={t('vizui.workflow.emptyInstances')} />
        ) : (
          <div className="space-y-2">
            {data.workflowInstances.map((inst) => (
              <WorkflowInstanceItem key={inst.id} inst={inst} />
            ))}
          </div>
        )}
      </section>

      {/* 错误日志 */}
      <section>
        <SectionTitle icon={AlertTriangle} title={t('vizui.workflow.errorsTitle', { n: data.errorLogs.length })} />
        {data.errorLogs.length === 0 ? (
          <EmptyHint text={t('vizui.workflow.noErrors')} />
        ) : (
          <div className="space-y-1.5">
            {data.errorLogs.slice(0, 5).map((e) => (
              <ErrorLogItem key={e.id} entry={e} />
            ))}
          </div>
        )}
      </section>

      {/* 监控器状态 */}
      {data.monitorState && (
        <section>
          <SectionTitle icon={Activity} title={t('vizui.workflow.monitor')} />
          <div className="grid grid-cols-2 gap-2">
            <StatCard label={t('vizui.workflow.eventCreate')} value={data.monitorState?.统计?.create_events ?? 0} />
            <StatCard label={t('vizui.workflow.eventModify')} value={data.monitorState?.统计?.modify_events ?? 0} />
            <StatCard label={t('vizui.workflow.eventDelete')} value={data.monitorState?.统计?.delete_events ?? 0} />
            <StatCard label={t('vizui.workflow.eventMove')} value={data.monitorState?.统计?.move_events ?? 0} />
          </div>
          <div className="mt-2 text-[10px] text-fg-muted">
            {t('vizui.workflow.startedAt', { time: data.monitorState?.启动时间 ? new Date(data.monitorState.启动时间).toLocaleString('zh-CN') : t('vizui.workflow.unknownTime') })}
          </div>
        </section>
      )}
    </div>
  )
}

const WF_STATUS_STYLE: Record<string, { labelKey: string; dot: string }> = {
  running: { labelKey: 'vizui.workflow.status.running', dot: 'bg-accent animate-pulse' },
  paused: { labelKey: 'vizui.workflow.status.paused', dot: 'bg-blue-400' },
  completed: { labelKey: 'vizui.workflow.status.completed', dot: 'bg-success' },
  failed: { labelKey: 'vizui.workflow.status.failed', dot: 'bg-danger' },
  cancelled: { labelKey: 'vizui.workflow.status.cancelled', dot: 'bg-fg-muted' }
}

const WF_NODE_STYLE: Record<string, string> = {
  running: 'bg-accent/15 text-accent',
  done: 'bg-bg-muted text-fg-secondary',
  failed: 'bg-danger/15 text-danger',
  skipped: 'bg-warning/15 text-warning'
}

function WorkflowInstanceItem({ inst }: { inst: WorkflowInstanceSummary }) {
  const t = useT()
  const st = WF_STATUS_STYLE[inst.status] ?? { labelKey: inst.status, dot: 'bg-fg-muted' }
  const lastNodes = inst.nodes.slice(-6)
  return (
    <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
        <span className="flex-1 truncate text-caption text-fg-primary">{inst.templateName ?? inst.templateId}</span>
        <span className="shrink-0 text-[10px] text-fg-muted">{t(st.labelKey)}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-muted">
        <span className="truncate font-mono">{inst.id}</span>
        <span className="shrink-0">{t('vizui.workflow.started', { time: formatDateTime(inst.startedAt) })}</span>
        {inst.completedAt != null && (
          <span className="shrink-0">→ {formatDateTime(inst.completedAt)}</span>
        )}
      </div>
      {inst.status === 'running' && inst.currentNode && (
        <div className="mt-1 text-[10px] text-accent">{t('vizui.workflow.currentNode', { node: inst.currentNode })}</div>
      )}
      {inst.error && <div className="mt-1 truncate text-[10px] text-danger" title={inst.error}>{t('vizui.workflow.failedWith', { error: inst.error })}</div>}
      {lastNodes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {lastNodes.map((n, i) => (
            <span key={i} className={`rounded px-1 py-0.5 text-[9px] ${WF_NODE_STYLE[n.status] ?? 'bg-bg-muted text-fg-secondary'}`}>
              {n.nodeName}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function ErrorLogItem({ entry }: { entry: ErrorLogEntry }) {
  const t = useT()
  return (
    <div className={`rounded-btn border px-3 py-2 ${entry.permanent_failure ? 'border-danger/40 bg-danger/5' : 'border-border-subtle bg-bg-elevated'}`}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary">{entry.task.type}</span>
        {entry.permanent_failure && <span className="text-[10px] text-danger">{t('vizui.workflow.permanentFailure')}</span>}
        <span className="ml-auto text-[10px] text-fg-muted">{new Date(entry.timestamp).toLocaleString('zh-CN')}</span>
      </div>
      <div className="mt-1 text-[11px] text-danger">{entry.error}</div>
      {entry.task.path && <div className="mt-0.5 truncate text-[10px] text-fg-muted">{entry.task.path}</div>}
      <div className="mt-0.5 text-[10px] text-fg-muted">{t('vizui.workflow.retryCount', { n: entry.retry_count })}</div>
    </div>
  )
}

/**
 * 路径缩短：d:\example\...\raw_memory\2026\08\05\31.json → …\raw_memory\2026\08\05\31.json
 * 只保留最后 3 段，避免面板满屏斜线
 */
function shortenPaths(text: string): string {
  return text.replace(/([a-zA-Z]:[\\/][^\s,;)\]}"']+)/g, (full) => {
    const parts = full.split(/[\\/]/).filter(Boolean)
    if (parts.length <= 3) return full
    return `…/${parts.slice(-3).join('/')}`
  })
}

/** AI 回复美化渲染：文本中的长路径 → 缩短为 …/最后3段 */
function BeautifiedText({ text }: { text: string }) {
  return <>{shortenPaths(text)}</>
}

function LatestRawItem({ raw }: { raw: RawMemoryLatest }) {
  const t = useT()
  // 整卡可点击需键盘可达：补 role/tabIndex 与 Enter/Space 处理；
  // e.target 判定防止内层「在文件夹中显示」按钮聚焦回车时冒泡误触发预览
  return (
    <div
      role="button"
      tabIndex={0}
      className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 cursor-pointer hover:bg-bg-muted/40 transition-colors"
      title={t('vizui.workflow.openFullText', { path: raw.path })}
      onClick={() => openFilePreview(raw.path)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          openFilePreview(raw.path)
        }
      }}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent font-mono">#{raw.seq}</span>
        <span className="shrink-0 text-[10px] text-fg-muted">{raw.date}</span>
        {raw.timestamp && (
          <span className="shrink-0 text-[10px] text-fg-muted">
            {formatDateTime(Number(raw.timestamp))}
          </span>
        )}
        {/* 在文件夹中显示（独立 icon 按钮：不嵌进可点击卡片避免嵌套交互） */}
        <button
          className="ml-auto shrink-0 rounded p-0.5 text-fg-muted hover:bg-bg-muted hover:text-accent"
          title={t('vizui.common.revealInFolder', { path: raw.path })}
          aria-label={t('vizui.common.revealInFolder', { path: raw.path })}
          onClick={(e) => {
            e.stopPropagation()
            void window.lunareclipse.showItemInFolder(raw.path)
          }}
        >
          <FolderOpen size={11} />
        </button>
        <span className="shrink-0 text-[10px] text-fg-muted">{(raw.size / 1024).toFixed(1)}KB</span>
        {raw.truncated && <span className="shrink-0 text-[10px] text-warning">{t('vizui.workflow.truncated')}</span>}
        <span className="ml-auto shrink-0 text-[9px] text-accent">{t('vizui.workflow.openFullTextHint')}</span>
      </div>
      <div className="mt-1.5 space-y-1">
        <div className="text-[11px] text-fg-primary">
          <span className="mr-1 rounded bg-blue-400/15 px-1 py-0.5 text-[9px] text-blue-400">USER</span>
          <span className="whitespace-pre-wrap break-words">{raw.userText}</span>
        </div>
        <div className="text-[11px] text-fg-secondary">
          <span className="mr-1 rounded bg-accent/15 px-1 py-0.5 text-[9px] text-accent">AI</span>
          <span className="whitespace-pre-wrap break-words">
            <BeautifiedText text={raw.aiText} />
          </span>
        </div>
      </div>
    </div>
  )
}