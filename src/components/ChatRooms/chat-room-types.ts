/**
 * 为什么存在：聊天室面板体量大被拆成主组件 + 四子视图，类型必须集中一处
 * 避免四处重复定义与循环依赖。
 * 聊天室面板共享类型（ChatRoomsPanel 拆分产物）。
 * 纯类型定义，由 ChatRoomsPanel 与各子视图组件共用。
 * 上层 API：window.lunareclipse.chatRoom*（主进程 ChatRoomService → L0 LAN 直连）
 */

export interface ChatRoomItem {
  gid: string
  name: string
  desc?: string
  ownerUid: number
  myRole: 'owner' | 'admin' | 'member'
  memberCount: number
  lastMessage: string | null
  lastTs: number | null
  unread: number
}

export interface ChatRoomMsg {
  id: string
  gid: string
  from: number
  text: string
  ts: number
  fromName?: string
  isAiGenerated?: boolean
  isAi?: boolean
  aiId?: number
}

export interface ChatRoomMemberItem {
  uid: number
  role: 'owner' | 'admin' | 'member'
  isAi?: boolean
  aiId?: number
  aiName?: string
  /** AI 发言身份的档案头像（注册表 avatar，emoji 或资源 key；无则前端降级 Bot 图标） */
  aiAvatar?: string
}

export interface ChatRoomDetail {
  gid: string
  name: string
  desc?: string
  ownerUid: number
  isSystem?: boolean
  members: ChatRoomMemberItem[]
}

export interface FriendOption {
  uid: number
  昵称: string
  备注?: string
  status: 'friend' | 'blocked' | 'pending'
}

/** 待处理邀请（主进程落盘，重启后仍在）；事件 push 只做增量追加 */
export interface ChatRoomInvite {
  gid: string
  chatRoomName: string
  fromUid: number
  fromName: string
  ownerUid: number
}

export type ChatRoomView = 'list' | 'chat' | 'members' | 'settings'