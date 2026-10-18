/**
 * 为什么存在：聊天室面板的焦点样式、时间格式化、文本域自增高与 AI 发言身份解析
 * 被多个子视图（列表/聊天/成员/设置）复用，集中成纯函数文件。
 * 作用：导出 FOCUS（a11y 焦点样式）、formatRelativeTime/formatBubbleTime、
 * autoGrow（输入框自增高）与 aiIdOf/aiIdentityOf（AI 发言身份编解码）。
 */
import type { TFunc } from '../../i18n/useT'
import type { ChatRoomMemberItem } from './chat-room-types'
import { formatDateTime } from '../../utils/time'
import { DEFAULT_AI_ID } from '@shared/types'

/** 统一焦点可见样式（a11y） */
export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'

/** 列表时间：与侧栏会话/好友列表一致的相对时间 */
export function formatRelativeTime(ts: number, t: TFunc): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return t('sidebar.time.justNow')
  if (diff < 3600_000) return t('sidebar.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86400_000) return t('sidebar.time.hoursAgo', { n: Math.floor(diff / 3600_000) })
  if (diff < 7 * 86400_000) return t('sidebar.time.daysAgo', { n: Math.floor(diff / 86400_000) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 气泡时间：始终显示 日期+时刻（同年 M/D HH:mm，跨年 YYYY/M/D HH:mm） */
export function formatBubbleTime(ts: number): string {
  return formatDateTime(ts)
}

export function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`
}

/** AI 发言身份（对外身份 = UID-AIID）是本机某个 AI 实体在该室的发言名 */
export const aiIdOf = (m: ChatRoomMemberItem): number => m.aiId ?? DEFAULT_AI_ID
export const aiIdentityOf = (m: ChatRoomMemberItem): string => `${m.uid}-${aiIdOf(m)}`