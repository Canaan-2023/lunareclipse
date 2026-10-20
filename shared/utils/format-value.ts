/**
 * 格式化任意值为可读字符串（前后端共用）。
 *
 * 后端 Worker 线程的 console 输出和前端沙箱面板的结果展示共用此逻辑，
 * 避免两处实现分叉。Worker 通过 .toString() 注入函数源码，
 * 前端通过 import 直接引用。
 */
export function formatValue(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  if (v instanceof Error) return v.stack || v.message
  if (v instanceof Date) return v.toISOString()
  try { return JSON.stringify(v, null, 2) || String(v) } catch { return String(v) }
}
