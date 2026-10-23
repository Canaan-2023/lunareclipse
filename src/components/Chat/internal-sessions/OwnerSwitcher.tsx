/**
 * 逆生树视角的**归属切换器**（ADR-30 R3）：看「当前会话」的树，还是看「房间（自主）」的树。
 *
 * 为什么需要：自主模式开启时有**两棵树**——承载会话树（当前会话）与房间自持树
 * （`room-autonomous-U{uid}-AI{aiId}`）。用户原话：「点击切换要可以看到自主模式的 AI
 * 自己管理的会话」。**切换发生在树视角内部**，而不是给「普通 ↔ 逆生树」按钮加第三态——
 * 那个按钮表达的是「视图密度」，与「看谁的树」是两个维度（ADR-30 §3.5）。
 *
 * 为什么独立成组件：`InternalSessionsView` 经 `useSyncExternalStore` 读 store，SSR 下固定取
 * 初始空态，无法被渲染探针注入种子；本组件**纯 props 驱动**（无取数、无时间调用），
 * 可直接 `renderToStaticMarkup` 验证「两态 / 选中态 / 房间不可用时不渲染」。
 *
 * 不删理由：删掉即「自主 AI 自己管理的会话」没有入口，用户只能看到承载会话那一棵树。
 */
import { useT } from '../../../i18n/useT'

/** 树视角看谁的树：`current` = 承载会话；`room` = 房间（自主） */
export type TreeOwner = 'current' | 'room'

const OPTIONS: Array<{ id: TreeOwner; labelKey: string }> = [
  { id: 'current', labelKey: 'view.treeOwner.current' },
  { id: 'room', labelKey: 'view.treeOwner.room' }
]

export function OwnerSwitcher({
  owner,
  roomAvailable,
  onSelect
}: {
  owner: TreeOwner
  /** 该 AI 的房间是否存在（跑过自主才有房间树）。false = **不渲染**：只有一棵树可看时控件是噪声 */
  roomAvailable: boolean
  onSelect: (owner: TreeOwner) => void
}) {
  const t = useT()
  if (!roomAvailable) return null
  return (
    <div
      role="group"
      aria-label={t('view.treeOwner')}
      className="flex shrink-0 items-center gap-0.5 rounded-btn border border-border-subtle bg-bg-muted/40 p-0.5"
    >
      {OPTIONS.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={owner === o.id}
          onClick={() => onSelect(o.id)}
          className={`rounded-btn px-2 py-0.5 text-caption transition-colors ${
            owner === o.id ? 'bg-accent/15 text-accent' : 'text-fg-muted hover:text-fg-secondary'
          }`}
        >
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  )
}
