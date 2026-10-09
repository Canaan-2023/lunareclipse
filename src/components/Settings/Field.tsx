/**
 * 为什么存在：设置表单的"label + 控件"结构全站一致，抽成通用包装
 * 避免各 section 重复实现并统一视觉层级。
 * 作用：通用设置字段包装——渲染 label + children（Settings 各 section 共用）。
 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-caption text-fg-secondary">{label}</label>
      {children}
    </div>
  )
}
