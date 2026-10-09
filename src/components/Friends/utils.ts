/**
 * 为什么存在：好友面板的时间展示与输入框行为需要与侧栏会话时间策略保持一致，
 * 且被多个子视图复用，集中成纯函数文件。
 * 作用：提供好友面板工具函数——相对时间格式化（与侧栏策略一致）、
 * 气泡时间格式化与输入框自动增高。
 */
import type { TFunc } from '../../i18n/useT'
import { formatDateTime } from '../../utils/time'

/** 相对时间（与侧栏会话时间策略保持一致） */
export function formatRelativeTime(ts: number, t: TFunc): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('sidebar.time.justNow')
  if (diff < 3600_000) return t('sidebar.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('sidebar.time.hoursAgo', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('sidebar.time.daysAgo', { n: Math.floor(diff / 86400_000) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 消息时间戳（气泡内：始终显示 日期+时刻，同年 M/D HH:mm，跨年 YYYY/M/D HH:mm） */
export function formatBubbleTime(ts: number): string {
  return formatDateTime(ts)
}

/** 字节数人性化：B/KB/MB/GB（传输卡片与进度共用） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  do {
    v /= 1024
    u += 1
  } while (v >= 1024 && u < units.length - 1)
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`
}

/** 文本域高度自适应（单行~4 行，上限 120px） */
export function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
}