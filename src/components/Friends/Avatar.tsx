/**
 * 为什么存在：好友列表/聊天等大量场景需要无图时的头像兜底，用首字色块
 * 轻量实现避免加载真实头像的开销（各视图共用）。
 * 作用：首字母头像色块——中文取首字、英文取首字母，支持自定义尺寸。
 */
export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  const ch = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-accent/10 font-medium text-accent"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {ch}
    </div>
  )
}