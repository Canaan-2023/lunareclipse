/**
 * @category 前端组件
 * @summary 侧栏共用小工具（相对时间格式化 + 会话末条消息预览）
 * @note 为什么存在：`index.tsx` 曾达 804 行破 800 硬红线（ADR-28 拆分）；这两个纯函数与会话列表渲染耦合最松，先外移。
 * @note 不删理由：相对时间与会话预览是侧栏会话列表的基础信息面，重复实现会导致同一时间/预览在别处显示不一致。
 */

import { type Session } from '@shared/types'
import { TFunc } from '../../i18n/useT'

/** 相对时间格式化（i18n） */
export function formatRelativeTime(ts: number, t: TFunc): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('sidebar.time.justNow')
  if (diff < 3600_000) return t('sidebar.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('sidebar.time.hoursAgo', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('sidebar.time.daysAgo', { n: Math.floor(diff / 86400_000) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 取会话最后一条消息内容预览（空白合并 + 截断 30 字） */
export function getLastMessagePreview(s: Session): string | null {
  if (!s.messages || s.messages.length === 0) return null
  const last = s.messages[s.messages.length - 1]
  const text = last.content?.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 30 ? text.slice(0, 30) + '...' : text
}
