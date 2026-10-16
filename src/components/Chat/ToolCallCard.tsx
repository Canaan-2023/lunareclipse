/**
 * 为什么存在：工具调用是行协议消息的高频内容，内联紧凑卡片比整页渲染更轻量，
 * 且需按工具分类着色与状态展示（memo 优化列表性能）。
 * 作用：渲染工具调用卡片——图标/名称/状态/耗时一行展示，支持展开详情与
 * 文件预览，按分类着色并暴露 CATEGORY_COLORS 供外部复用。
 */
import { memo } from 'react'
import { Loader2, Check, X, ChevronDown, FileText } from 'lucide-react'
import type { ToolCall, ToolCategory, SubAgentInfo } from '@shared/types'
import { CATEGORY_ICONS, CATEGORY_LABELS, TOOL_MAP } from '@shared/tools/registry'
import { useState } from 'react'

// 分类色（简化：只用于左侧小色点；保留 soft 字段兼容旧接口/测试）
export const CATEGORY_COLORS: Record<ToolCategory, { bar: string; soft: string; text: string }> = {
  'file-read':   { bar: 'bg-blue-500',     soft: 'bg-blue-500/8',     text: 'text-blue-500' },
  'file-write':  { bar: 'bg-emerald-500',  soft: 'bg-emerald-500/8',  text: 'text-emerald-500' },
  browser:       { bar: 'bg-purple-500',   soft: 'bg-purple-500/8',   text: 'text-purple-500' },
  'self-shape':  { bar: 'bg-orange-500',   soft: 'bg-orange-500/8',   text: 'text-orange-500' },
  account:       { bar: 'bg-stone-500',    soft: 'bg-stone-500/8',    text: 'text-stone-500' },
  system:        { bar: 'bg-red-500',      soft: 'bg-red-500/8',      text: 'text-red-500' },
  network:       { bar: 'bg-cyan-500',     soft: 'bg-cyan-500/8',     text: 'text-cyan-500' },
  graph:         { bar: 'bg-teal-500',     soft: 'bg-teal-500/8',     text: 'text-teal-500' },
  mechanism:     { bar: 'bg-accent',       soft: 'bg-accent/8',       text: 'text-accent' },
  'dmn-exclusive': { bar: 'bg-pink-500',   soft: 'bg-pink-500/8',     text: 'text-pink-500' },
  workflow:      { bar: 'bg-indigo-500',   soft: 'bg-indigo-500/8',   text: 'text-indigo-500' },
  plugin:        { bar: 'bg-amber-500',    soft: 'bg-amber-500/8',    text: 'text-amber-500' },
  'task-mode':   { bar: 'bg-fuchsia-500',  soft: 'bg-fuchsia-500/8',  text: 'text-fuchsia-500' },
  generation:   { bar: 'bg-lime-500',     soft: 'bg-lime-500/8',     text: 'text-lime-500' },
  lan:          { bar: 'bg-sky-500',      soft: 'bg-sky-500/8',      text: 'text-sky-500' },
  device:       { bar: 'bg-violet-500',   soft: 'bg-violet-500/8',   text: 'text-violet-500' }
}

/**
 * 工具调用展示（内联紧凑版）：
 * - 不再是大卡片/汇总条/分类分组三层结构
 * - 每次工具调用一行小字：图标 + 工具名 + 主信息 + 状态 + 耗时
 * - 文件操作可点击打开预览；搜索/命令结果点击行展开详情
 * - 视觉重量极低，"一行字夹在会话里"
 */
interface ToolCallCardProps {
  toolCalls: ToolCall[]
  onPreviewFile?: (path: string) => void
  onOpenInBrowser?: (url: string) => void
}

export const ToolCallCard = memo(function ToolCallCard({
  toolCalls,
  onPreviewFile,
  onOpenInBrowser
}: ToolCallCardProps) {
  // 折叠态：全部调用完成后收敛成一行摘要，点击展开明细
  const [collapsed, setCollapsed] = useState(true)
  if (!toolCalls || toolCalls.length === 0) return null

  const hasRunning = toolCalls.some((tc) => tc.status === 'running')
  const hasError = toolCalls.some((tc) => tc.status === 'error')
  const totalSecs = calcTotalSeconds(toolCalls)

  // 本轮生成产物（image_gen/video_gen/audio_gen/create_document 的 data.mediaUrl）：
  // 在折叠开关外常驻展示——工具行收起后图片/音视频仍直接可见可播
  const mediaItems = toolCalls
    .map((tc) => {
      const d = tc.result?.data as { category?: string; mediaUrl?: string; path?: string } | undefined
      return d?.mediaUrl ? { category: d.category ?? 'image', mediaUrl: d.mediaUrl, path: d.path ?? '' } : null
    })
    .filter((x): x is { category: string; mediaUrl: string; path: string } => x !== null)

  const rows = toolCalls.map((tc) => (
    <ToolCallRow
      key={tc.id}
      toolCall={tc}
      onPreviewFile={onPreviewFile}
      onOpenInBrowser={onOpenInBrowser}
    />
  ))

  // 流式执行中：保持平铺（用户要看进度）；全部完成后收敛成摘要行
  if (hasRunning) {
    return (
      <div className="mt-1.5 space-y-0.5">
        {rows}
        <MediaStrip items={mediaItems} onPreviewFile={onPreviewFile} />
      </div>
    )
  }

  return (
    <div className="mt-1">
      {mediaItems.length > 0 && (
        <MediaStrip items={mediaItems} onPreviewFile={onPreviewFile} />
      )}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 rounded px-1 py-px text-[10px] text-fg-muted transition-colors hover:bg-bg-muted/40 hover:text-fg-secondary"
        title={collapsed ? '展开工具调用明细' : '收起工具调用明细'}
      >
        {hasError ? (
          <X size={10} className="shrink-0 text-danger" />
        ) : (
          <Check size={10} className="shrink-0 text-success/70" />
        )}
        <span className="shrink-0">
          {hasError ? '工具调用有错误' : `工具调用 · ${toolCalls.length} 次`}
        </span>
        {totalSecs > 0 && (
          <span className="shrink-0 tabular-nums text-fg-muted/60">{totalSecs}s</span>
        )}
        <ChevronDown
          size={10}
          className={`shrink-0 text-fg-muted/60 transition-transform ${
            collapsed ? '' : 'rotate-180'
          }`}
        />
      </button>
      {!collapsed && <div className="mt-0.5 space-y-0.5">{rows}</div>}
    </div>
  )
}, (prev, next) => {
  return prev.toolCalls === next.toolCalls &&
    prev.onPreviewFile === next.onPreviewFile &&
    prev.onOpenInBrowser === next.onOpenInBrowser
})

/** 单条工具调用行 */
function ToolCallRow({
  toolCall,
  onPreviewFile,
  onOpenInBrowser
}: {
  toolCall: ToolCall
  onPreviewFile?: (path: string) => void
  onOpenInBrowser?: (url: string) => void
}) {
  const [showDetail, setShowDetail] = useState(false)
  const meta = TOOL_MAP[toolCall.toolName]
  const category = toolCall.category ?? meta?.category ?? 'mechanism'
  const colors = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.mechanism

  const isRunning = toolCall.status === 'running'
  const isError = toolCall.status === 'error'

  const seconds = toolCall.endedAt
    ? Math.round((toolCall.endedAt - toolCall.startedAt) / 1000)
    : Math.round((Date.now() - toolCall.startedAt) / 1000)

  const summary = toolCall.result?.summary
  const primary = summary?.primary ?? toolCall.toolLabel ?? toolCall.toolName
  const secondary = summary?.secondary

  const isFileOp = category === 'file-read' || category === 'file-write'
  const isNetwork = category === 'network'
  const isCommand = category === 'system'
  const hasDetail = !!(summary?.terminalOutput || summary?.searchResults?.length)

  const icon = meta ? CATEGORY_ICONS[meta.category] : '🔧'
  const isClickableFile = isFileOp && onPreviewFile && primary
  const isClickableUrl = (category === 'browser' || isNetwork) && onOpenInBrowser && primary

  return (
    <div className="rounded px-1 py-px hover:bg-bg-muted/30 transition-colors">
      {/* 行内容（flex） */}
      <div className="flex items-center gap-1.5 text-[11px] leading-relaxed">
      {/* 分类色点 */}
      <span className={`h-1 w-1 shrink-0 rounded-full ${colors.bar}`} />
      {/* 状态图标 */}
      {isRunning ? (
        <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
      ) : isError ? (
        <X size={10} className="shrink-0 text-danger" />
      ) : (
        <Check size={10} className="shrink-0 text-success/80" />
      )}
      {/* 工具图标 */}
      <span className="shrink-0 text-[10px] opacity-80">{icon}</span>
      {/* 工具名 */}
      <span className="shrink-0 font-medium text-fg-secondary">
        {toolCall.toolLabel ?? toolCall.toolName}
      </span>
      {/* 主信息（文件可点 / URL 可点 / 普通文本） */}
      {isClickableFile ? (
        <span
          className="cursor-pointer truncate text-accent hover:underline"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onPreviewFile!(primary)
          }}
          onKeyDown={(e) => {
            // 可点击文本用 span 实现，补键盘语义：Enter/Space 触发预览，行为与鼠标点击一致
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onPreviewFile!(primary)
            }
          }}
          title={primary}
        >
          {basename(primary)}
        </span>
      ) : isClickableUrl ? (
        <span
          className="cursor-pointer truncate text-accent hover:underline"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation()
            onOpenInBrowser!(primary)
          }}
          onKeyDown={(e) => {
            // 可点击文本用 span 实现，补键盘语义：Enter/Space 触发浏览器打开，行为与鼠标点击一致
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onOpenInBrowser!(primary)
            }
          }}
          title={primary}
        >
          {primary}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-fg-muted">{primary}</span>
      )}
      {/* 次信息（行数/结果数） */}
      {secondary && (
        <span className="shrink-0 text-fg-muted/70">{secondary}</span>
      )}
      {/* 文件 diff */}
      {isFileOp && (summary?.addedLines || summary?.removedLines) && (
        <span className="shrink-0 tabular-nums">
          {summary?.addedLines ? <span className="text-success">+{summary.addedLines}</span> : null}
          {summary?.removedLines ? <span className="text-danger"> -{summary.removedLines}</span> : null}
        </span>
      )}
      {/* 耗时 */}
      <span className={`shrink-0 tabular-nums ${isRunning ? 'text-accent' : isError ? 'text-danger' : 'text-fg-muted/60'}`}>
        {seconds}s
      </span>
      {/* 详情展开按钮（有详情时） */}
      {hasDetail && (
        <button
          onClick={() => setShowDetail(!showDetail)}
          className="shrink-0 rounded p-0.5 text-fg-muted/60 hover:text-fg-secondary"
          title={showDetail ? '收起详情' : '展开详情'}
          aria-label={showDetail ? '收起详情' : '展开详情'}
        >
          <ChevronDown size={10} className={`transition-transform ${showDetail ? 'rotate-180' : ''}`} />
        </button>
      )}
      {/* 错误信息 */}
      {isError && toolCall.result?.error && (
        <span className="shrink-0 max-w-[200px] truncate text-danger/80" title={toolCall.result.error}>
          {toolCall.result.error}
        </span>
      )}
      </div>
      {/* 详情展开层（命令输出 / 搜索结果）——在 flex 行外，独立块 */}
      {showDetail && hasDetail && (
        <div className="w-full">
          {isCommand && summary?.terminalOutput && (
            <pre className="max-h-[180px] overflow-y-auto rounded-btn bg-bg-base/80 p-2 text-[10px] text-fg-secondary whitespace-pre-wrap font-mono border border-border-subtle/40">
              {summary.terminalOutput}
            </pre>
          )}
          {isNetwork && summary?.searchResults && summary.searchResults.length > 0 && (
            <div className="space-y-1">
              {summary.searchResults.map((r, i) => (
                <div key={i} className="rounded-btn bg-bg-base/60 p-1 border border-border-subtle/40">
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 text-[9px] text-fg-muted tabular-nums">{i + 1}.</span>
                    {r.url && onOpenInBrowser ? (
                      <button
                        className="min-w-0 flex-1 text-left text-[10px] font-medium text-accent hover:underline truncate"
                        onClick={(e) => { e.stopPropagation(); onOpenInBrowser(r.url!) }}
                        title={r.url}
                      >
                        {r.title || r.url}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 text-[10px] font-medium text-fg-primary truncate">
                        {r.title || r.url || '(无标题)'}
                      </span>
                    )}
                  </div>
                  {r.url && (
                    <div className="ml-4 truncate text-[9px] text-fg-muted font-mono">{r.url}</div>
                  )}
                  {r.snippet && (
                    <div className="ml-4 mt-0.5 text-[10px] leading-relaxed text-fg-secondary line-clamp-2">
                      {r.snippet}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {/* 子 agent 面板（Agent 工具专用）——运行中实时更新，结束后可展开查看
          子 agent 内部工具调用与最终输出。事件由主进程 subagent_* 推送，挂在本工具卡上。 */}
      {toolCall.toolName === 'Agent' && toolCall.subAgents && toolCall.subAgents.length > 0 && (
        <SubAgentPanel
          subAgents={toolCall.subAgents}
          onPreviewFile={onPreviewFile}
          onOpenInBrowser={onOpenInBrowser}
        />
      )}
    </div>
  )
}

/**
 * 子 agent 面板（Agent 工具卡内嵌）。
 * 每个子 agent 一行：序号 + 状态 + 任务指令摘要 + 工具数 + 耗时；
 * 点击展开内部工具调用序列（复用 ToolCallRow）与最终输出。
 */
function SubAgentPanel({
  subAgents,
  onPreviewFile,
  onOpenInBrowser
}: {
  subAgents: SubAgentInfo[]
  onPreviewFile?: (path: string) => void
  onOpenInBrowser?: (url: string) => void
}) {
  return (
    <div className="mt-1 space-y-0.5 border-l border-border-subtle/50 pl-2">
      {subAgents.map((sa) => (
        <SubAgentRow
          key={sa.agentId}
          subAgent={sa}
          onPreviewFile={onPreviewFile}
          onOpenInBrowser={onOpenInBrowser}
        />
      ))}
    </div>
  )
}

/** 单个子 agent 行（可展开） */
function SubAgentRow({
  subAgent: sa,
  onPreviewFile,
  onOpenInBrowser
}: {
  subAgent: SubAgentInfo
  onPreviewFile?: (path: string) => void
  onOpenInBrowser?: (url: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [showOutput, setShowOutput] = useState(false)
  const isRunning = sa.status === 'running'
  const isError = sa.status === 'error'
  const seconds = sa.endedAt
    ? Math.round((sa.endedAt - sa.startedAt) / 1000)
    : Math.round((Date.now() - sa.startedAt) / 1000)
  const toolCount = sa.toolCalls?.length ?? 0

  return (
    <div className="rounded-btn bg-bg-muted/20 px-1.5 py-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 text-left transition-colors hover:opacity-80"
        title={expanded ? '收起子 agent 详情' : '展开子 agent 详情'}
      >
        {isRunning ? (
          <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
        ) : isError ? (
          <X size={10} className="shrink-0 text-danger" />
        ) : (
          <Check size={10} className="shrink-0 text-success/80" />
        )}
        <span className="shrink-0 text-[10px] font-medium text-fg-secondary">
          子任务 {sa.index + 1}/{sa.total}
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-fg-muted" title={sa.prompt}>
          {sa.prompt}
        </span>
        {toolCount > 0 && (
          <span className="shrink-0 text-[10px] text-fg-muted/70">{toolCount} 次工具</span>
        )}
        <span className={`shrink-0 tabular-nums text-[10px] ${isRunning ? 'text-accent' : 'text-fg-muted/60'}`}>
          {seconds}s
        </span>
        <ChevronDown
          size={10}
          className={`shrink-0 text-fg-muted/60 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="mt-1 space-y-0.5">
          {sa.toolCalls && sa.toolCalls.length > 0 && (
            <div className="space-y-0.5">
              {sa.toolCalls.map((tc) => (
                <ToolCallRow
                  key={tc.id}
                  toolCall={tc}
                  onPreviewFile={onPreviewFile}
                  onOpenInBrowser={onOpenInBrowser}
                />
              ))}
            </div>
          )}
          {sa.output && (
            <div className="pt-0.5">
              <button
                onClick={() => setShowOutput(!showOutput)}
                className="flex items-center gap-1 rounded px-1 py-px text-[10px] text-fg-muted transition-colors hover:bg-bg-muted/40 hover:text-fg-secondary"
              >
                <ChevronDown size={9} className={`transition-transform ${showOutput ? 'rotate-180' : ''}`} />
                输出
              </button>
              {showOutput && (
                <pre className="mt-0.5 max-h-[200px] overflow-y-auto whitespace-pre-wrap rounded-btn bg-bg-base/80 p-2 font-mono text-[10px] leading-relaxed text-fg-secondary border border-border-subtle/40">
                  {sa.output}
                </pre>
              )}
            </div>
          )}
          {sa.error && (
            <div className="text-[10px] text-danger/90">{sa.error}</div>
          )}
          {!sa.toolCalls && !sa.output && (
            <div className="text-[10px] text-fg-muted/60 italic">（无过程记录）</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 取文件名（最后一段路径） */
export function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

/**
 * 生成产物常驻展示条：图片直显 / 视频音频可播 / 文稿可点开。
 * 数据来自生成类工具 result.data（category + mediaUrl，lune-media:// 协议加载，
 * 主进程只放行 generated/ 目录白名单扩展，见 api/gen/media-protocol.ts）。
 */
function MediaStrip({
  items,
  onPreviewFile
}: {
  items: Array<{ category: string; mediaUrl: string; path: string }>
  onPreviewFile?: (path: string) => void
}) {
  return (
    <div className="mt-1.5 space-y-1.5">
      {items.map((m, i) => {
        if (m.category === 'image') {
          return (
            <img
              key={i}
              src={m.mediaUrl}
              alt={basename(m.path)}
              loading="lazy"
              className="max-h-[360px] max-w-[420px] rounded-btn border border-border-subtle object-contain"
            />
          )
        }
        if (m.category === 'video') {
          return (
            <video
              key={i}
              src={m.mediaUrl}
              controls
              preload="metadata"
              className="max-h-[320px] max-w-[480px] rounded-btn border border-border-subtle"
            />
          )
        }
        if (m.category === 'audio') {
          return (
            <audio key={i} src={m.mediaUrl} controls preload="metadata" className="w-full max-w-[420px]" />
          )
        }
        // document：可点开预览（复用文件预览通道），点不了就展示文件名
        return onPreviewFile ? (
          <button
            key={i}
            onClick={(e) => { e.stopPropagation(); onPreviewFile(m.path) }}
            className="flex items-center gap-1.5 rounded-btn border border-border-subtle bg-bg-base/60 px-2 py-1 text-[11px] text-accent transition-colors hover:bg-bg-muted/40"
            title={m.path}
          >
            <FileText size={11} className="shrink-0" />
            {basename(m.path)}
          </button>
        ) : (
          <div key={i} className="text-[11px] text-fg-muted">{basename(m.path)}</div>
        )
      })}
    </div>
  )
}

/** 汇总条状态色映射（旧版接口，测试/向后兼容保留真实实现） */
export function getStatusBar(hasRunning: boolean, hasError: boolean): { bg: string; text: string; bar: string } {
  if (hasRunning) return { bg: 'bg-accent/10', text: 'text-accent', bar: 'bg-accent' }
  if (hasError) return { bg: 'bg-danger/10', text: 'text-danger', bar: 'bg-danger' }
  return { bg: 'bg-success/8', text: 'text-success', bar: 'bg-success' }
}

/** 单条工具调用状态徽章色映射（旧版接口） */
export function getStatusBadge(status: 'running' | 'error' | 'done'): string {
  if (status === 'running') return 'bg-accent/15 text-accent'
  if (status === 'error') return 'bg-danger/15 text-danger'
  return 'bg-success/15 text-success'
}

/** 计算批次总耗时秒数 */
export function calcTotalSeconds(toolCalls: ToolCall[]): number {
  if (toolCalls.length === 0) return 0
  const maxEnd = toolCalls.reduce((max, tc) => Math.max(max, tc.endedAt ?? Date.now()), -Infinity)
  const minStart = toolCalls.reduce((min, tc) => Math.min(min, tc.startedAt), Infinity)
  return Math.round((maxEnd - minStart) / 1000)
}

/** 构建汇总条文案片段（按分类） */
export function buildSummaryParts(byCategory: Map<ToolCategory, ToolCall[]>): string[] {
  const parts: string[] = []
  for (const [cat, calls] of byCategory) {
    parts.push(`${CATEGORY_ICONS[cat] ?? '🔧'} ${calls.length} ${CATEGORY_LABELS[cat] ?? cat}`)
  }
  return parts
}

/** 按分类分组 */
export function groupByCategory(calls: ToolCall[]): Map<ToolCategory, ToolCall[]> {
  const map = new Map<ToolCategory, ToolCall[]>()
  for (const tc of calls) {
    const arr = map.get(tc.category) ?? []
    arr.push(tc)
    map.set(tc.category, arr)
  }
  return map
}
