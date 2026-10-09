/**
 * 为什么存在：好友面板类型（好友/候选/消息/AI 社交会话）被主文件与各子视图共用，
 * 拆出成类型文件避免循环依赖（批次 E-5a 拆分产物）。
 * 作用：好友面板领域类型——重新导出 AI 社交类型并定义 FriendItem/CandidateItem/FriendMsg/View 等。
 */
import type { AiSocialContact, AiSocialChatListItem, AiChatMessage } from '../../../electron/main/multi-instance/ai-social/ai-social-types'
import type { FriendFileMeta } from '../../../electron/main/multi-instance/friends/friend-types'

export type { AiSocialContact, AiSocialChatListItem, AiChatMessage }
export type { FriendFileMeta }

export interface FriendItem {
  uid: number
  昵称: string
  备注?: string
  分组: string
  status: 'friend' | 'blocked' | 'pending'
  online: boolean
  lastMessage: string | null
  lastTs: number | null
  unread: number
}

export interface CandidateItem {
  uid: number
  用户名: string
  online: boolean
}

export interface FriendMsg {
  id: string
  from: number
  to: number
  text: string
  ts: number
  read: boolean
  /** 是否由本机 AI 代答生成 */
  isAiGenerated?: boolean
  /** 代答 AI 的实体编号（与 from 组成 `UID-AIID`） */
  aiId?: number
  /** 文件/文件夹邀请（邀请制直传）：携带 = 本消息渲染为传输卡片而非纯文本 */
  file?: FriendFileMeta
}

export type View = 'list' | 'chat'

/** 统一焦点可见样式（a11y：键盘可感知） */
export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40'