/**
 * 为什么存在：可视化面板五个 Tab 需要共用板块标题/统计卡/空态小组件，
 * 集中定义避免各 Tab 重复实现（批次 E-5c 拆分产物）。
 * 作用：可视化面板共用小组件——SectionTitle（区块标题）、StatCard（统计卡）、EmptyHint（空态提示）。
 */
import { Activity } from 'lucide-react'

/** 可视化面板共用小组件（批次 E-5c 从 VisualizationPanel.tsx 拆出） */

export function SectionTitle({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 text-caption uppercase tracking-wider text-fg-muted">
      <Icon size={12} />
      {title}
    </div>
  )
}

export function StatCard({ label, value, accent }: { label: string; value: number; accent?: 'normal' | 'warn' | 'danger' }) {
  const color = accent === 'warn' ? 'text-yellow-400' : accent === 'danger' ? 'text-red-400' : 'text-fg-primary'
  return (
    <div className="rounded-btn border border-border-subtle bg-bg-elevated px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-fg-muted">{label}</div>
      <div className={`text-title font-medium ${color}`}>{value}</div>
    </div>
  )
}

export function EmptyHint({ text }: { text: string }) {
  return <div className="rounded-btn border border-dashed border-border-subtle px-3 py-3 text-center text-caption text-fg-muted">{text}</div>
}