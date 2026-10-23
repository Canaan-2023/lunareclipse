/**
 * @category 前端组件
 * @summary 内部会话卡片（逆生树节点，宽度固定 / 高度自适应 + 密集降级形态）
 * @note 为什么存在：原 `InternalSessionsView.tsx` 1408 行破 800 硬红线（ADR-27 拆分）；卡片是画布节点的独立渲染单元。
 * @note 不删理由：树画布中每个节点都是一张卡片，其「固定宽 + 高度自适应」是文字不出框的关键约束。
 */

import {
  useEffect,
  useRef,
  useState
} from 'react'
import {
  ChevronDown,
  ChevronRight,
  Clock,
  MessageSquare,
  Pencil,
  Trash2,
  ChevronLeft
} from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import { InternalSessionSummary } from '@shared/types'
import { useT } from '../../../i18n/useT'
import {
  TREE_CARD_H,
} from '../session-chains'
import { formatTime } from './shared'

/**
 * 单条内部会话卡片（逆生树节点：宽度固定 TREE_CARD_W、高度随内容自适应）。
 * 为什么存在：树画布中的每个节点是一张卡片。宽度固定（TREE_CARD_W=320）保证
 * 森林内所有卡片视觉一致对齐；高度**随内容自适应**（v0.27 修复）——v0.26
 * 固定 96px 高度 + line-clamp-2 强截断，在「多徽章行 + 长摘要」时内容实际
 * 撑爆固定高度、文字溢出卡片边框（用户反馈「文字都出框了」）。改为 h-auto
 * 后卡片高度由徽章行/标题/摘要/元信息实际内容决定，任何内容量都不出框。
 * 内容字段（v0.26 精简，v0.28 增补新话题徽章）：① 徽章行——根/最新/时间副本/
 * 时间锁定/新话题 + 折叠钮 + 更新时间；② 标题（可打开/就地编辑）；③ 摘要
 * （3 行截断，可编辑）；④ 元信息行——消息数·字符数 + 打开。
 * 层级直观：根在上、分支开枝散叶向下，配合徽章一眼可辨「该会话是树中哪一环、
 * 是延续还是新开」。
 * 密集降级形态（v0.29，dense=true）：卡片退化为「圆点 + 单行标题」胶囊——
 * 仍占完整槽位（布局坐标/连线端点不回归），仅渲染内容收敛；
 * 圆点颜色复用徽章语义色（active=强调、latest=绿、时间副本=琥珀、冻结=灰），
 * 保留折叠钮与点击打开，隐藏编辑/摘要/元信息（点形态是浏览结构，详情交给点击）。
 */
export function SessionCard({
  sessionId,
  summary,
  gen,
  isRoot,
  isLatest,
  isFrozen,
  isActive,
  isTimeFork,
  isTimeLocked,
  isNewTopic,
  hasDescendants,
  isCollapsed,
  dense,
  onToggle,
  onOpen
}: {
  sessionId: string
  summary: InternalSessionSummary
  /** 继承代数（根=1；展示用，服务端 gen 缺省视为 1） */
  gen: number
  /** 是否链首（根会话/断链孤儿） */
  isRoot: boolean
  /** 是否最尾端（无继承子 + 无时间下级；路由当前承接的会话） */
  isLatest: boolean
  /** 是否冻结底稿（有继承子 = 已被继承压缩，只读回翻用） */
  isFrozen: boolean
  /** 是否 AI 当前承接的会话（active 指针指向；画布高亮标记） */
  isActive: boolean
  /** 是否时间分叉副本（isTimeFork=true：由 timeFork 复制产生的话题延续会话） */
  isTimeFork: boolean
  /** 是否时间线已延续锁定（自身有 timeBranchId 指向下级 → 本会话只读） */
  isTimeLocked: boolean
  /** 是否新话题分支（isNewTopic=true：AI 判定新开话题，虚线引入） */
  isNewTopic: boolean
  /** 是否有后代（继承子/时间分叉/新话题），决定是否显示折叠按钮 */
  hasDescendants: boolean
  /** 是否已折叠（其后代隐去） */
  isCollapsed: boolean
  /** 是否降级为点形态（v0.29：全局缩放过低或该节点子树过密） */
  dense: boolean
  onToggle: () => void
  onOpen: () => void
}) {
  const t = useT()
  const updateInternalSession = useAppStore((s) => s.updateInternalSession)
  const deleteInternalSession = useAppStore((s) => s.deleteInternalSession)
  const [editingTitle, setEditingTitle] = useState(false)
  const [draftTitle, setDraftTitle] = useState(summary.title)
  const [editingSummary, setEditingSummary] = useState(false)
  const [draftSummary, setDraftSummary] = useState(summary.summary)
  const inputRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editingTitle) inputRef.current?.focus()
    if (editingSummary) areaRef.current?.focus()
  }, [editingTitle, editingSummary])

  const commitTitle = async () => {
    setEditingTitle(false)
    if (draftTitle.trim() && draftTitle.trim() !== summary.title) {
      await updateInternalSession(sessionId, summary.id, { title: draftTitle.trim() })
    }
  }
  const commitSummary = async () => {
    setEditingSummary(false)
    if (draftSummary !== summary.summary) {
      await updateInternalSession(sessionId, summary.id, { summary: draftSummary })
    }
  }

  // —— 密集降级形态（v0.29）：圆点 + 单行标题，点击打开详情 ——
  // 为什么提前 return：dense 与完整形态互斥，分支清晰免去整段 JSX 条件嵌套。
  // 圆点颜色 = 徽章语义色浓缩，画布缩小后仍能分辨「承接/延续/副本/冻结」。
  if (dense) {
    const dotColor = isActive
      ? 'bg-accent'
      : isLatest
        ? 'bg-emerald-400'
        : isTimeFork
          ? 'bg-amber-400'
          : isFrozen
            ? 'bg-fg-muted'
            : 'bg-fg-muted/50'
    // 槽位对齐：距顶 1/4 处放胶囊（父连线从槽位底中心来、去子槽位顶中心，
    // 胶囊居中在槽位垂直中线视觉上偏离连线端点）——vertical-center 更贴近
    // 连线端点（父底部/子顶部），故用 items-center 垂直居中。
    return (
      <div
        className={`group flex w-[320px] flex-col items-center justify-center rounded-card border bg-bg-surface/30 transition-all ${isActive ? 'border-accent bg-accent/10' : 'border-border-subtle'} hover:border-accent/25 hover:bg-bg-surface/60`}
        style={{ minHeight: TREE_CARD_H }}
      >
        <div className="flex max-w-full items-center gap-1.5 px-2 py-1">
          {hasDescendants && (
            <button
              onClick={onToggle}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
              title={isCollapsed ? t('internal.expand') : t('internal.collapse')}
              aria-label={isCollapsed ? t('internal.expand') : t('internal.collapse')}
              aria-expanded={!isCollapsed}
            >
              {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            </button>
          )}
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} aria-hidden="true" />
          <button
            onClick={onOpen}
            className="min-w-0 max-w-[230px] flex-1 truncate text-left text-caption font-medium text-fg-secondary transition-colors hover:text-accent"
            title={summary.title}
          >
            {summary.title || t('internal.titlePlaceholder')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`group flex w-[320px] shrink-0 flex-col rounded-card border bg-bg-surface/30 transition-all ${isActive ? 'border-accent bg-accent/10' : isTimeLocked ? 'border-border-subtle opacity-70' : isLatest ? 'border-accent/40' : 'border-border-subtle'} hover:border-accent/25 hover:bg-bg-surface/60`}>
      {/* 徽章行：可换行（flex-wrap），徽章多时向下折行而非撑出卡片边界；新增折叠按钮（条件=有后代） */}
      <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-1.5">
        {hasDescendants && (
          <button
            onClick={onToggle}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted transition-all hover:bg-bg-muted hover:text-fg-secondary"
            title={isCollapsed ? t('internal.expand') : t('internal.collapse')}
            aria-label={isCollapsed ? t('internal.expand') : t('internal.collapse')}
            aria-expanded={!isCollapsed}
          >
            {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
        <span className={`rounded-full px-1.5 py-0.5 text-caption font-medium ${isRoot ? 'bg-accent/15 text-accent' : isLatest ? 'bg-emerald-500/15 text-emerald-400' : 'bg-bg-muted/80 text-fg-muted'}`}>
          {isRoot
            ? t('internal.genRoot')
            : t('internal.gen', { n: gen })}
        </span>
        {isActive && (
          <span className="rounded-full bg-accent/20 px-1.5 py-0.5 text-caption font-medium text-accent">
            {t('internal.activeBadge')}
          </span>
        )}
        {isLatest && !isActive && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-caption font-medium text-emerald-400">
            {t('internal.latest')}
          </span>
        )}
        {isFrozen && (
          <span
            className="rounded-full bg-bg-muted/80 px-1.5 py-0.5 text-caption font-medium text-fg-secondary"
            title={t('internal.frozenHint')}
          >
            {t('internal.frozenBadge')}
          </span>
        )}
        {isTimeFork && (
          <span className="flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-caption font-medium text-amber-400">
            <Clock size={10} />
            {t('internal.forkBadge')}
          </span>
        )}
        {/* 新话题徽章：AI 判定新开会话（虚线引入），与线段样式对应 */}
        {isNewTopic && (
          <span className="rounded-full border border-dashed border-accent/40 bg-accent/5 px-1.5 py-0.5 text-caption font-medium text-accent">
            {t('internal.newBadge')}
          </span>
        )}
        {isTimeLocked && (
          <span className="rounded-full bg-bg-muted/80 px-1.5 py-0.5 text-caption font-medium text-fg-muted">
            {t('internal.timeLocked')}
          </span>
        )}
        <span className="ml-auto truncate text-caption tabular-nums text-fg-muted/70">
          {formatTime(summary.updatedAt)}
        </span>
      </div>

      {/* 标题行：就地编辑 / 点击打开 */}
      <div className="flex items-center gap-2 px-3 pt-1">
        {editingTitle ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitTitle()
              if (e.key === 'Escape') { setDraftTitle(summary.title); setEditingTitle(false) }
            }}
            className="min-w-0 flex-1 rounded-btn border border-accent/40 bg-bg-elevated px-2 py-1 text-body font-medium text-fg-primary outline-none"
          />
        ) : (
          <>
            <MessageSquare size={14} className="shrink-0 text-accent/70" />
            <button
              onClick={onOpen}
              className="min-w-0 flex-1 truncate text-left text-body font-medium text-fg-primary transition-colors hover:text-accent"
              title={summary.title}
            >
              {summary.title || t('internal.titlePlaceholder')}
            </button>
            <button
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted/40 opacity-0 transition-all hover:bg-bg-muted hover:text-accent group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              title={t('internal.editTitle')}
              aria-label={t('internal.editTitle')}
              onClick={() => { setEditingTitle(true); setDraftTitle(summary.title) }}
            >
              <Pencil size={12} />
            </button>
            <button
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-btn text-fg-muted/40 opacity-0 transition-all hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
              title={t('internal.delete')}
              aria-label={t('internal.delete')}
              onClick={() => {
                // 内部会话连同其全部消息一并落盘删除且无回收站，误删代价高，先确认再执行
                if (!window.confirm(`删除内部会话「${summary.title || summary.id}」将永久移除其中全部消息。确定删除？`)) return
                void deleteInternalSession(sessionId, summary.id)
              }}
            >
              <Trash2 size={12} />
            </button>
          </>
        )}
      </div>

      {/* 摘要行：3 行截断 + 高度随内容自适应（不再依赖固定卡高的 flex-1），可点击打开 / 就地编辑 */}
      <div className="w-full px-3 pb-0.5 pt-0.5">
        {editingSummary ? (
          <textarea
            ref={areaRef}
            value={draftSummary}
            onChange={(e) => setDraftSummary(e.target.value)}
            onBlur={() => void commitSummary()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setDraftSummary(summary.summary); setEditingSummary(false) }
            }}
            rows={2}
            className="w-full resize-none rounded-btn border border-accent/40 bg-bg-elevated px-2.5 py-1.5 text-caption text-fg-secondary outline-none"
          />
        ) : (
          <button
            onClick={onOpen}
            className="line-clamp-3 w-full text-left text-caption leading-relaxed text-fg-muted transition-colors hover:text-fg-secondary"
            title={summary.summary || undefined}
          >
            {summary.summary || <span className="text-fg-muted/50">{t('internal.summaryPlaceholder')}</span>}
          </button>
        )}
      </div>

      {/* 元信息行：消息数·字符数 + 打开按钮 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle/60 px-3 py-1 text-caption tabular-nums text-fg-muted/70">
        <span>{t('internal.messages', { count: summary.messageCount })}</span>
        <span>·</span>
        <span>{t('internal.totalChars', { count: summary.totalChars })}</span>
        <button
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-btn text-fg-muted/50 transition-all hover:bg-bg-muted hover:text-accent"
          title={t('internal.open')}
          aria-label={t('internal.open')}
          onClick={onOpen}
        >
          <ChevronLeft size={14} className="rotate-180" />
        </button>
      </div>
    </div>
  )
}
