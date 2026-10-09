/**
 * 为什么存在：行协议消息（turnHeader/reasoning/toolCall/subagent/timeline 等）
 * 需要按行类型分部件渲染而非整段 markdown，独立渲染器保证协议与 UI 解耦。
 * 作用：按 rowId 平铺渲染各类型行——turnHeader/reasoning/toolCall（含文件预览）、
 * subagent 调用链与 timeline 标记。
 */
import { memo, useState } from 'react'
import { Loader2, Check, X, ChevronDown, Brain, Split } from 'lucide-react'
import type { ConversationRow, SubagentRow, TimelineMarkerRow } from '@shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'
import { openFilePreview } from '../Workshop/FileWorkshopPanel'

/**
 * 行协议渲染器：按行类型渲染部件。
 * 消息有 rows 时优先走这里（MessageBubble 判断），无 rows 回退整段 markdown。

 * 行类型 → 部件：
 * - turnHeader 轮次分隔条（状态转圈/✓/✗ + 耗时 + 文件变更）
 * - userInput 用户输入（消息体已由 MessageBubble 渲染，这里通常不出现）
 * - assistantText markdown 正文（流式光标由父组件 streaming 控制）
 * - reasoning 可折叠思考块
 * - toolCall 工具卡片（复用 ToolCallCard 渲染逻辑）
 * - subagent 子代理卡片（类型 + 状态 + 摘要）
 * - timelineMarker 时间线标记条（modelChange 等）
 */

interface RowRendererProps {
  rows: ConversationRow[]
  /** 当前消息是否正在流式输出（assistantText 光标 + subagent 转圈） */
  streaming: boolean
}

export const RowRenderer = memo(function RowRenderer({ rows, streaming }: RowRendererProps) {
  // 渲染策略：按 rowId 真实时间线平铺渲染，
  // 每个行都是独立可见块（卡片化：边框+背景+间距），不聚合不折叠。
  // 思考1 → 正文1 → 工具1 → 思考2 → 正文2 → 工具2，每个片段单独一块，
  // "上次的思考/正文"与"下次的"天然隔离，肉眼可辨。
  // rows 由 appStore 按 rowId 升序排好，这里原样渲染。
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <RowItem key={row.rowId} row={row} streaming={streaming} />
      ))}
    </div>
  )
})

function RowItem({ row, streaming }: { row: ConversationRow; streaming: boolean }) {
  switch (row.kind) {
    case 'turnHeader':
      return <TurnHeaderRow row={row} />
    case 'userInput':
      return null // 用户消息由 MessageBubble 自己渲染，行内不重复
    case 'assistantText':
      return (
        <div className="message-content break-words text-body leading-relaxed">
          <MarkdownRenderer content={row.text ?? ''} streaming={streaming && row.state === 'streaming'} />
        </div>
      )
    case 'reasoning':
      return <ReasoningRowBlock row={row} streaming={streaming} />
    case 'toolCall':
      return <ToolCallRowBlock row={row} />
    case 'subagent':
      return <SubagentRowBlock row={row} />
    case 'timelineMarker':
      return <TimelineMarkerBlock row={row} />
    default:
      return null
  }
}

function TurnHeaderRow({ row }: { row: Extract<ConversationRow, { kind: 'turnHeader' }> }) {
  const running = row.state === 'running'
  const ok = row.state === 'completedSuccess'
  const failed = row.state === 'failed'
  const duration = row.activeMs != null ? formatMs(row.activeMs) : null
  const fc = row.fileChanges
  return (
    <div className="my-1 flex items-center gap-2 rounded-btn border border-border-subtle/50 bg-bg-muted/30 px-2.5 py-1.5">
      {running ? (
        <Loader2 size={11} className="animate-spin text-accent" />
      ) : ok ? (
        <Check size={11} className="text-success" />
      ) : failed ? (
        <X size={11} className="text-red-400" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-fg-muted/40" />
      )}
      <span className="text-[10px] font-medium text-fg-secondary">回合</span>
      {duration && <span className="text-[10px] text-fg-muted">{duration}</span>}
      {fc && (fc.additions > 0 || fc.deletions > 0) && (
        <span className="ml-auto rounded-full bg-bg-muted px-1.5 py-px text-[9px] text-fg-muted">
          +{fc.additions} −{fc.deletions} · {fc.files} 文件
        </span>
      )}
    </div>
  )
}

function ReasoningRowBlock({
  row,
  streaming
}: {
  row: Extract<ConversationRow, { kind: 'reasoning' }>
  streaming: boolean
}) {
  // 思考块默认收起成一行小标签（思考 · N字），
  // 只有点击才展开看全文——流式中也不自动展开。
  const [expanded, setExpanded] = useState(false)
  const thinking = streaming && row.state === 'streaming'
  const text = row.text ?? ''
  const showBody = expanded
  return (
    <div className="rounded-btn border border-border-subtle/50 bg-bg-muted/40 px-2.5 py-1.5">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left transition-opacity hover:opacity-80"
      >
        <Brain size={11} className="shrink-0 text-fg-muted" />
        <span className="text-[10px] font-medium text-fg-muted/70">思考</span>
        {thinking && (
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fg-muted/50" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-fg-muted/70" />
          </span>
        )}
        {!showBody && text && (
          <span className="truncate text-[10px] text-fg-muted/60">{text.slice(0, 40)}{text.length > 40 ? '…' : ''}</span>
        )}
        {row.durationMs != null && (
          <span className="text-[9px] text-fg-muted/60">{formatMs(row.durationMs)}</span>
        )}
        <ChevronDown
          size={10}
          className={`ml-auto shrink-0 text-fg-muted/60 transition-transform ${showBody ? 'rotate-180' : ''}`}
        />
      </button>
      {showBody && text && (
        <div className="mt-1 text-[12px] italic leading-relaxed text-fg-secondary whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

/** 从工具参数提取文件路径（供点击打开）：Read/Write/Edit 等的 file_path、Grep/LS 的 path 等 */
function extractFilePaths(toolName: string, input: unknown): string[] {
  if (input == null || typeof input !== 'object') return []
  const obj = input as Record<string, unknown>
  const paths: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) paths.push(v.trim())
  }
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MoveFile':
    case 'CopyFile':
    case 'DeleteFile':
    case 'Mkdir':
    case 'read_md':
      push(obj.file_path)
      push(obj.path)
      break
    case 'Grep':
    case 'LS':
      push(obj.path)
      break
    case 'Glob':
      // Glob 的 pattern 是 glob 模式不是具体文件，只有给了 path 才可点
      push(obj.path)
      break
    case 'run_command':
      // 有明确 cwd 时可点开目录
      push(obj.cwd)
      break
    case 'Agent': {
      // 子任务里的文件操作路径
      if (Array.isArray(obj.tasks)) {
        for (const t of obj.tasks) {
          if (t && typeof t === 'object') {
            push((t as Record<string, unknown>).file_path)
            push((t as Record<string, unknown>).path)
          }
        }
      }
      break
    }
    default:
      break
  }
  // 去重保序
  return [...new Set(paths)].slice(0, 3)
}

/** 点击打开文件/目录：应用内预览（月蚀窗口内打开，主窗口右侧标签 / 独立窗口面板） */
function openPath(path: string) {
  openFilePreview(path)
}

/** 从工具参数提炼一句话摘要：让用户一眼看到"操作了啥" */
function summarizeToolInput(toolName: string, input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input.length > 60 ? `${input.slice(0, 60)}…` : input
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  // 按工具类型挑关键字段
  const pick = (keys: string[]): string | null => {
    for (const k of keys) {
      const v = obj[k]
      if (v == null) continue
      if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 60)}…` : v
      return JSON.stringify(v)
    }
    return null
  }
  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
    case 'MoveFile':
    case 'CopyFile':
    case 'DeleteFile':
    case 'Mkdir':
    case 'read_md':
      return pick(['file_path', 'path', 'pattern']) ?? ''
    case 'Grep':
      return pick(['pattern']) ? `/${obj.pattern}/ ${obj.path ?? ''}`.trim() : ''
    case 'run_command':
      return pick(['command']) ?? ''
    case 'web_search':
      return pick(['query']) ?? ''
    case 'LS':
      return pick(['path']) ?? ''
    case 'browser_navigate':
      return pick(['url']) ?? ''
    case 'Agent':
      return obj.tasks ? `${Array.isArray(obj.tasks) ? obj.tasks.length : 1} 个子任务` : ''
    default:
      return JSON.stringify(obj).slice(0, 60)
  }
}

/** 工具调用卡片：每个工具单独一行，显示操作摘要（看了啥/干了啥）+ 可点开文件路径 */
function ToolCallRowBlock({ row }: { row: Extract<ConversationRow, { kind: 'toolCall' }> }) {
  const running = row.status === 'running'
  const ok = row.status === 'success'
  const err = row.status === 'error'
  const duration = row.startedAt && row.endedAt ? `${row.endedAt - row.startedAt}ms` : null
  const summary = summarizeToolInput(row.toolName, row.input)
  const paths = extractFilePaths(row.toolName, row.input)
  return (
    <div className="rounded-btn border border-border-subtle/60 bg-bg-muted/30 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        {running ? (
          <Loader2 size={11} className="animate-spin text-accent" />
        ) : ok ? (
          <Check size={11} className="text-success" />
        ) : err ? (
          <X size={11} className="text-red-400" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-fg-muted/40" />
        )}
        <span className="text-[11px] font-medium text-fg-primary">{row.toolName}</span>
        {summary && (
          <span className="truncate text-[10px] text-fg-muted/80">{summary}</span>
        )}
        <span className="ml-auto shrink-0 text-[9px] text-fg-muted">
          {running ? '运行中' : duration ?? ''}
        </span>
      </div>
      {paths.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {paths.map((p) => (
            <button
              key={p}
              onClick={() => openPath(p)}
              title={`点击打开：${p}`}
              className="max-w-full truncate text-[10px] text-accent underline decoration-accent/40 underline-offset-2 transition-opacity hover:opacity-80"
            >
              📄 {p}
            </button>
          ))}
        </div>
      )}
      {err && row.error && (
        <div className="mt-1 text-[10px] text-red-400">{row.error.message}</div>
      )}
    </div>
  )
}

function SubagentRowBlock({ row }: { row: SubagentRow }) {
  const [expanded, setExpanded] = useState(false)
  const running = row.status === 'running'
  const ok = row.status === 'success'
  const err = row.status === 'failed'
  return (
    <div className="rounded-btn border border-border-subtle/60 bg-bg-muted/30 px-2.5 py-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
      >
        {running ? (
          <Loader2 size={11} className="animate-spin text-accent" />
        ) : ok ? (
          <Check size={11} className="text-success" />
        ) : err ? (
          <X size={11} className="text-red-400" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-fg-muted/40" />
        )}
        <span className="text-[11px] font-medium text-fg-primary">
          {row.subagentType === 'parallel-agent' ? '并行子代理' : '子代理'}
        </span>
        {running && row.summaryText && (
          <span className="ml-2 truncate text-[10px] text-fg-muted">{row.summaryText}</span>
        )}
        <ChevronDown
          size={10}
          className={`ml-auto shrink-0 text-fg-muted/60 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && row.summaryText && (
        <div className="mt-1 max-h-[200px] overflow-y-auto whitespace-pre-wrap rounded bg-bg-surface/40 px-2 py-1.5 text-[10px] leading-relaxed text-fg-secondary">
          {row.summaryText}
        </div>
      )}
      {row.endedAt && row.startedAt && (
        <div className="mt-0.5 text-[9px] text-fg-muted">{row.endedAt - row.startedAt}ms</div>
      )}
    </div>
  )
}

function TimelineMarkerBlock({ row }: { row: TimelineMarkerRow }) {
  const m = row.marker
  if (!m) return null
  switch (m.type) {
    case 'modelChange':
      return (
        <div className="my-1 flex items-center gap-1.5 rounded-btn border border-dashed border-border-subtle/60 px-2.5 py-1">
          <Split size={10} className="text-fg-muted" />
          <span className="text-[10px] text-fg-muted">
            模型切换{m.fromModel ? `：${m.fromModel} → ${m.toModel}` : `：${m.toModel}`}
          </span>
        </div>
      )
    default:
      return null
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
