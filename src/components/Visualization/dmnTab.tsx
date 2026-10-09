/**
 * 为什么存在：监控面板按域拆 Tab，DMN 域（RAW/错误/工作流/记忆摘要）独立成组件
 * （批次 E-5c 拆分产物），便于聚焦与复用。
 * 作用：渲染 DMN 监控 Tab——最新 RAW 展示、错误日志列表、工作流实例进度汇总
 * 与记忆总览统计卡。
 */
import { RefreshCw, AlertTriangle, FileText, Activity, FolderOpen } from 'lucide-react'
import { openFilePreview } from '../Workshop/FileWorkshopPanel'
import type { VisualizationData, ErrorLogEntry, WorkflowInstanceSummary, RawMemoryLatest } from '@shared/types'
import { SectionTitle, EmptyHint, StatCard } from './common'
import { formatDateTime } from '../../utils/time'

/** DMN 监控 Tab（批次 E-5c 从 VisualizationPanel.tsx 拆出） */
export function DmnTab({ data, loading }: { data: VisualizationData | null; loading: boolean }) {
  if (!data) {
    // 加载中显示骨架提示，否则用醒目卡片提示无数据（虚线边框 + 图标 + 说明文字）
    if (loading) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 rounded-btn border border-dashed border-border-subtle px-4 py-10 text-center">
          <RefreshCw size={20} className="animate-spin text-fg-muted" />
          <div className="text-caption text-fg-secondary">加载中...</div>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-btn border border-dashed border-border-subtle px-4 py-10 text-center">
        <AlertTriangle size={22} className="text-fg-muted" />
        <div className="text-body text-fg-secondary">暂无监控数据</div>
        <div className="text-caption text-fg-muted">请确认后端监控服务已启动</div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* 最新 RAW（raw_memory 最新一条，监控面板 RAW 接口） */}
      <section>
        <SectionTitle icon={FileText} title="最新 RAW" />
        {data.latestRawMemory ? (
          <LatestRawItem raw={data.latestRawMemory} />
        ) : (
          <EmptyHint text="暂无 raw_memory 记录（对话尚未落盘或 raw_memory 目录为空）" />
        )}
      </section>

      {/* 工作流进度（进度来自工作流引擎实例；旧心跳 .dmn_shared/进度.json 已停更废弃） */}
      <section>
        <SectionTitle icon={RefreshCw} title={`工作流进度（${data.workflowInstances.length}）`} />
        {data.workflowInstances.length === 0 ? (
          <EmptyHint text="当前无工作流实例（前端 AI 忙或流水线未启动；运行中的批次会实时显示在这里）" />
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
        <SectionTitle icon={AlertTriangle} title={`错误日志（${data.errorLogs.length}）`} />
        {data.errorLogs.length === 0 ? (
          <EmptyHint text="无错误记录" />
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
          <SectionTitle icon={Activity} title="文件监控器" />
          <div className="grid grid-cols-2 gap-2">
            <StatCard label="创建事件" value={data.monitorState?.统计?.create_events ?? 0} />
            <StatCard label="修改事件" value={data.monitorState?.统计?.modify_events ?? 0} />
            <StatCard label="删除事件" value={data.monitorState?.统计?.delete_events ?? 0} />
            <StatCard label="移动事件" value={data.monitorState?.统计?.move_events ?? 0} />
          </div>
          <div className="mt-2 text-[10px] text-fg-muted">
            启动：{data.monitorState?.启动时间 ? new Date(data.monitorState.启动时间).toLocaleString('zh-CN') : '未知'}
          </div>
        </section>
      )}
    </div>
  )
}

const WF_STATUS_STYLE: Record<string, { label: string; dot: string }> = {
  running: { label: '运行中', dot: 'bg-accent animate-pulse' },
  paused: { label: '已暂停', dot: 'bg-blue-400' },
  completed: { label: '已完成', dot: 'bg-green-400' },
  failed: { label: '失败', dot: 'bg-red-400' },
  cancelled: { label: '已取消', dot: 'bg-fg-muted' }
}

const WF_NODE_STYLE: Record<string, string> = {
  running: 'bg-accent/15 text-accent',
  done: 'bg-bg-muted text-fg-secondary',
  failed: 'bg-red-400/15 text-red-400',
  skipped: 'bg-yellow-400/15 text-yellow-400'
}

function WorkflowInstanceItem({ inst }: { inst: WorkflowInstanceSummary }) {
  const st = WF_STATUS_STYLE[inst.status] ?? { label: inst.status, dot: 'bg-fg-muted' }
  const lastNodes = inst.nodes.slice(-6)
  return (
    <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${st.dot}`} />
        <span className="flex-1 truncate text-caption text-fg-primary">{inst.templateName ?? inst.templateId}</span>
        <span className="shrink-0 text-[10px] text-fg-muted">{st.label}</span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[10px] text-fg-muted">
        <span className="truncate font-mono">{inst.id}</span>
        <span className="shrink-0">开始 {formatDateTime(inst.startedAt)}</span>
        {inst.completedAt != null && (
          <span className="shrink-0">→ {formatDateTime(inst.completedAt)}</span>
        )}
      </div>
      {inst.status === 'running' && inst.currentNode && (
        <div className="mt-1 text-[10px] text-accent">当前节点：{inst.currentNode}</div>
      )}
      {inst.error && <div className="mt-1 truncate text-[10px] text-red-400" title={inst.error}>失败：{inst.error}</div>}
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
  return (
    <div className={`rounded-btn border px-3 py-2 ${entry.permanent_failure ? 'border-red-400/40 bg-red-400/5' : 'border-border-subtle bg-bg-elevated'}`}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-secondary">{entry.task.type}</span>
        {entry.permanent_failure && <span className="text-[10px] text-red-400">永久失败</span>}
        <span className="ml-auto text-[10px] text-fg-muted">{new Date(entry.timestamp).toLocaleString('zh-CN')}</span>
      </div>
      <div className="mt-1 text-[11px] text-red-400">{entry.error}</div>
      {entry.task.path && <div className="mt-0.5 truncate text-[10px] text-fg-muted">{entry.task.path}</div>}
      <div className="mt-0.5 text-[10px] text-fg-muted">重试 {entry.retry_count} 次</div>
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
  // 整卡可点击需键盘可达：补 role/tabIndex 与 Enter/Space 处理；
  // e.target 判定防止内层「在文件夹中显示」按钮聚焦回车时冒泡误触发预览
  return (
    <div
      role="button"
      tabIndex={0}
      className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2 cursor-pointer hover:bg-bg-muted/40 transition-colors"
      title={`点击打开全文：${raw.path}`}
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
          title={`在文件夹中显示：${raw.path}`}
          aria-label={`在文件夹中显示：${raw.path}`}
          onClick={(e) => {
            e.stopPropagation()
            void window.lunareclipse.showItemInFolder(raw.path)
          }}
        >
          <FolderOpen size={11} />
        </button>
        <span className="shrink-0 text-[10px] text-fg-muted">{(raw.size / 1024).toFixed(1)}KB</span>
        {raw.truncated && <span className="shrink-0 text-[10px] text-yellow-400">已截断</span>}
        <span className="ml-auto shrink-0 text-[9px] text-accent">点击看全文</span>
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