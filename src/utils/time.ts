/**
 * 为什么存在：全站时间展示需统一口径（始终带日期、同年/跨年策略），
 * 避免各面板自行实现导致格式漂移。
 * 作用：统一时间戳格式化——同年显示 M/D HH:mm，跨年显示 YYYY/M/D HH:mm。
 */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()} ${hm}`
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`
}