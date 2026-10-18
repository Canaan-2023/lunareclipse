/**
 * 聊天室功能（L2）类型契约。
 * 建立在 L0 局域网底座之上：聊天室信息本机持有，信封经 LanService 直连不经过主系统。
 * 信封 type 前缀 'chat-room.'，业务负载定义见各分支。
 */

/** 聊天室成员角色 */
export type ChatRoomRole = 'owner' | 'admin' | 'member'

/**
 * 全员频道（系统频道）固定 ID：所有局域网账号自动加入，不可退出/解散/改名。
 * 成员列表修为动态计算（roster 全体），不做真人持久化。
 */
export const SYSTEM_ROOM_GID = 'system-world-chat'

/** 聊天室成员 */
export interface ChatRoomMember {
  /** 真人=本人账号 uid；AI 发言身份=其属主账号 uid（同一 uid 的 1 号与 2 号 AI 可同室） */
  uid: number
  role: ChatRoomRole
  joinedAt: number
  /**
   * 是否 AI 发言身份（对外身份 = `UID-AIID`）。
   * 注意：这不是「另一个 AI」，而是本机某个 AI 实体在聊天室里用的发言身份（名字 + AI 编号）。
   */
  isAi?: boolean
  /** AI 实体编号（isAi 时有意义；1=月蚀主 AI，其余编号见 ai-registry.json 顺延，见 lan-types 的 MAIN_AI_ID） */
  aiId?: number
  /** 发言身份显示名（isAi 时有意义） */
  aiName?: string
  /** 头像标识（isAi 时可选；进场时取自注册表档案，供社交界面展示） */
  aiAvatar?: string
}

/** AI 发言身份引用（自动回复回调入参） */
export interface ChatRoomAiSpeaker {
  /** 属主账号 uid（AI 身份 = `uid-aiId`） */
  uid: number
  /** AI 实体编号 */
  aiId: number
  name: string
}

/** 聊天室 AI 自动回复生成请求（装配层注入生成器时使用） */
export interface ChatRoomAiReplyRequest {
  /** 触发回复的 AI 发言身份 */
  ai: ChatRoomAiSpeaker
  /** 所在聊天室 */
  room: ChatRoomInfo
  /** 触发回复的真人消息 */
  msg: ChatRoomMessage
  /** 该聊天室最近消息（升序，供生成器组装上下文） */
  history: ChatRoomMessage[]
}

/** 聊天室 AI 自动回复生成器（返回 null 表示不回复） */
export type ChatRoomAiReplyGenerator = (req: ChatRoomAiReplyRequest) => Promise<string | null>

/** 聊天室信息（abyssac_data/federation/chat-rooms/{gid}.json） */
export interface ChatRoomInfo {
  /** 聊天室 ID（本机生成 UUID） */
  gid: string
  name: string
  /** 聊天室简介（可选） */
  desc?: string
  /** 室主 UID */
  ownerUid: number
  /** 成员列表（含室主） */
  members: ChatRoomMember[]
  /** 是否系统频道（全员频道，不可删除、不可退出） */
  isSystem?: boolean
  /** 创建时间（epoch ms） */
  createdAt: number
  /** 更新时间（epoch ms） */
  updatedAt: number
}

/** 聊天室消息 */
export interface ChatRoomMessage {
  id: string
  gid: string
  from: number
  text: string
  ts: number
  /** 发送者显示名（冗余存储免查表） */
  fromName?: string
  /** 是否 AI 代理生成（以用户身份发言但由 AI 自动回复） */
  isAiGenerated?: boolean
  /** 是否以 AI 发言身份发出（from = 属主 uid，配合 aiId 组成 `UID-AIID`） */
  isAi?: boolean
  /** AI 实体编号（isAi 时有意义） */
  aiId?: number
}

/** 聊天室列表项（面板展示用：合并最近消息预览） */
export interface ChatRoomListItem {
  gid: string
  name: string
  desc?: string
  ownerUid: number
  /** 本机在该聊天室的角色 */
  myRole: ChatRoomRole
  /** 成员数量 */
  memberCount: number
  lastMessage: string | null
  lastTs: number | null
  unread: number
}

/** 局域网信封负载：聊天室邀请 */
export interface ChatRoomInvitePayload {
  gid: string
  chatRoomName: string
  fromName: string
  ownerUid: number
}

/** 局域网信封负载：成员变动（加入/离开/踢出） */
export interface ChatRoomMemberChangePayload {
  gid: string
  uid: number
  action: 'join' | 'leave' | 'kick'
  actorUid: number
}

/** 局域网信封负载：聊天室消息 */
export interface ChatRoomMessagePayload {
  id: string
  gid: string
  text: string
  fromName?: string
  /** AI 代理生成标记 */
  isAiGenerated?: boolean
  /** AI 发言身份标记 */
  isAi?: boolean
  /** AI 实体编号（isAi 时必填；与信封 from 的 uid 组成 `UID-AIID`） */
  aiId?: number
}

/** 前端事件（webContents.send('chat-room:event')） */
export type ChatRoomEvent =
  | { type: 'invite'; gid: string; chatRoomName: string; fromUid: number; fromName: string; ownerUid: number }
  | { type: 'member-change'; gid: string; uid: number; action: 'join' | 'leave' | 'kick'; actorUid: number }
  | { type: 'message'; gid: string; message: ChatRoomMessage }
  | { type: 'updated'; gid: string }
