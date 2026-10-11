/**
 * 为什么存在：多个设置 section 都需要一致的"标签 + 状态"展示（如连接正常/异常），
 * 抽成共用组件避免各处样式漂移。
 * 作用：状态行展示——label + ok/bad 两个状态文本（Settings 各 section 共用）。
 */
export function StatusRow({ label, ok, okText, badText }: { label: string; ok: boolean; okText: string; badText: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          ok ? 'bg-emerald-500' : 'bg-fg-muted/40'
        }`}
      />
      <span className="text-fg-muted">{label}</span>
      <span className={`ml-auto ${ok ? 'text-emerald-500' : 'text-fg-muted'}`}>
        {ok ? okText : badText}
      </span>
    </div>
  )
}
