/**
 * 为什么存在：发布帖子是独立于浏览列表的表单交互（批次 E-5b 拆出），
 * 单独成视图便于复用与聚焦输入。
 * 作用：渲染发布视图——文章标题/摘要/正文表单（编辑态复用为编辑表单），
 * 提交/取消与发布中状态。
 */
import { PenSquare, RefreshCw } from 'lucide-react'
import type { TFunc } from '../../i18n/useT'
import { PanelHeader } from './PanelHeader'

/** 焦点可见样式（a11y）：与 ChatRooms/Friends 面板一致的键盘聚焦提示，表单按钮均需，不可删 */
const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

interface PublishViewProps {
  editingId: string | null
  boardName: string
  pubTitle: string
  onPubTitleChange: (v: string) => void
  pubSummary: string
  onPubSummaryChange: (v: string) => void
  pubBody: string
  onPubBodyChange: (v: string) => void
  publishing: boolean
  onCancel: () => void
  onPublish: () => void
  onRefresh: () => void
  showClose: boolean
  onClose: () => void
  t: TFunc
}

/** 发布板面板 · 发布/编辑表单视图（受控组件，状态不下放） */
export function PublishView({
  editingId,
  boardName,
  pubTitle,
  onPubTitleChange,
  pubSummary,
  onPubSummaryChange,
  pubBody,
  onPubBodyChange,
  publishing,
  onCancel,
  onPublish,
  onRefresh,
  showClose,
  onClose,
  t,
}: PublishViewProps) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-surface">
      <PanelHeader
        title={editingId ? t('publishBoard.edit') : t('publishBoard.publish')}
        icon={<PenSquare size={13} className="text-accent" />}
        onBack={onCancel}
        onRefresh={onRefresh}
        showClose={showClose}
        onClose={onClose}
        t={t}
      />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mb-2 rounded-card border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-[10px] text-fg-secondary">
          {t('publishBoard.publishTo', { board: boardName })}
        </div>
        <input
          value={pubTitle}
          onChange={(e) => onPubTitleChange(e.target.value)}
          placeholder={t('publishBoard.titlePlaceholder')}
          autoFocus
          className="mb-2 w-full rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption font-medium text-fg-primary outline-none focus:border-accent"
        />
        <textarea
          value={pubSummary}
          onChange={(e) => onPubSummaryChange(e.target.value)}
          placeholder={t('publishBoard.summaryPlaceholder')}
          rows={2}
          className="mb-2 w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
        <textarea
          value={pubBody}
          onChange={(e) => onPubBodyChange(e.target.value)}
          placeholder={t('publishBoard.bodyPlaceholder')}
          rows={10}
          className="mb-2 w-full resize-none rounded-btn border border-border-subtle bg-bg-base px-2.5 py-1.5 text-caption text-fg-primary outline-none focus:border-accent"
        />
      </div>
      <div className="flex justify-end gap-1.5 border-t border-border-subtle p-2">
        <button
          onClick={onCancel}
          className={`rounded-btn bg-bg-muted px-3 py-1.5 text-caption text-fg-secondary hover:bg-bg-muted/70 ${FOCUS}`}
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={() => void onPublish()}
          disabled={publishing || !pubTitle.trim()}
          className={`flex items-center gap-1 rounded-btn bg-accent px-3 py-1.5 text-caption text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`}
        >
          {publishing && <RefreshCw size={11} className="animate-spin" />}
          {publishing
            ? editingId ? t('publishBoard.updating') : t('publishBoard.submitting')
            : editingId ? t('publishBoard.update') : t('publishBoard.publishSubmit')}
        </button>
      </div>
    </div>
  )
}