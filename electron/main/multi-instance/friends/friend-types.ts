/**
 * 好友系统（L1）类型契约。
 * 建立在 L0 局域网底座之上：好友簿本机持有，信封经 LanService 直连不经过主系统。
 * 信封 type 前缀 'friend.'，业务负载定义见各分支。
 */

/** 好友关系状态（contacts.json 内） */
export type FriendStatus = 'friend' | 'blocked' | 'pending'

/** 请求方向：我发起的（out）/ 对方发来的（in）；仅 status=pending 时有意义 */
export type PendingDirection = 'in' | 'out'

/** 好友簿条目（abyssac_data/federation/contacts.json 单文件，所有联系人一张表） */
export interface FriendContact {
  uid: number
  /** roster 快照昵称（对端改名后以 roster 为准，不留历史别名） */
  昵称: string
  /** 本机备注（可选，展示优先于昵称） */
  备注?: string
  /** 分组（默认"默认"组） */
  分组: string
  /** 添加时间（epoch ms） */
  addedAt: number
  status: FriendStatus
  /** pending 时的请求方向 */
  direction?: PendingDirection
}

/** contacts.json 文件结构 */
export interface ContactsFile {
  updatedAt: string
  contacts: FriendContact[]
}

/** 私聊单条消息（federation/chats/{chatId}/messages.json 数组元素） */
export interface FriendChatMessage {
  id: string
  from: number
  to: number
  text: string
  ts: number
  /** 本机是否已读（from === 本机 uid 的消息恒 true；对端收到即读，不回执） */
  read: boolean
  /** 是否 AI 代理生成（以用户身份发言但由 AI 自动回复） */
  isAiGenerated?: boolean
  /** 代答 AI 的实体编号（1=月蚀主 AI，其余编号见 ai-registry.json 顺延，见 lan-types 的 MAIN_AI_ID）；isAiGenerated 时有意义 */
  aiId?: number
  /** 文件传输邀请（邀请制直传）：携带 = 本消息是文件/文件夹邀请卡片，非普通文本 */
  file?: FriendFileMeta
}

/** 好友列表项（list() 返回：contacts 合并在线态/最近消息/未读；与 preload/frontend FriendItem 同构） */
export interface FriendListItem {
  uid: number
  昵称: string
  备注?: string
  分组: string
  status: FriendStatus
  online: boolean
  lastMessage: string | null
  lastTs: number | null
  unread: number
}

/** 文件/文件夹邀请的元数据（发送方只发这份清单，文件实体在接收方同意后再推流） */
export interface FriendFileMeta {
  /** 传输会话号（发送方生成 uuid；整个邀请-同意-推流-完成全链路关联） */
  transferId: string
  name: string
  size: number
  kind: 'file' | 'dir'
  /** 文件夹时的文件数（kind='dir'；单文件为无） */
  files?: number
  /** 文件夹时的子目录数（kind='dir'；单文件为无） */
  dirs?: number
  /** 卡片流转状态（发送/接收两侧各自维护；'pending' 为初始邀请态，不随信封在两端间传递；'relayed' = 已改用中继发送） */
  state?: 'pending' | 'accepted' | 'rejected' | 'canceled' | 'done' | 'failed' | 'relayed'
  /** 接收侧完成后的本地保存位置（done 时填充；发送侧无） */
  path?: string
  /** 接收侧失败原因（failed 时填充） */
  error?: string
}

/** 局域网信封负载：私聊消息 */
export interface FriendMessagePayload {
  /** 发送方生成的消息 ID（接收方幂等去重） */
  id: string
  text: string
  /** AI 代理生成标记（接收侧保留，供本机 AI 判断对面是 AI 还是人） */
  isAiGenerated?: boolean
  /** 代答 AI 的实体编号（与信封 from 的机主 uid 组成 `UID-AIID`） */
  aiId?: number
  /** 文件邀请元数据：携带 = 文件/文件夹邀请（接收方落盘成卡片消息，不当作纯文本） */
  file?: FriendFileMeta
}

/** 局域网信封负载：文件/文件夹邀请（发送方 → 接收方，仅元数据，不携带文件字节） */
export interface FriendFileInvitePayload {
  transferId: string
  name: string
  size: number
  kind: 'file' | 'dir'
  files?: number
  dirs?: number
}

/** 局域网信封负载：接收方同意邀请（接收方 → 发送方，触发推流） */
export interface FriendFileAcceptPayload {
  transferId: string
}

/** 局域网信封负载：接收方拒绝邀请（接收方 → 发送方；发送方清理传输记录） */
export interface FriendFileRejectPayload {
  transferId: string
}

/** 局域网信封负载：推流完成/失败通知（发送方 → 接收方，收件端据此更新卡片终态） */
export interface FriendFileDonePayload {
  transferId: string
  ok: boolean
  error?: string
}

/** 局域网信封负载：推送中断恢复提醒（发送方 → 接收方；本方重启后发现 streaming 残留，把对端 accepted 卡片拉回待同意态） */
export interface FriendFileResumePayload {
  transferId: string
}

/** 局域网信封负载：已改用中继发送（发送方 → 接收方；对端卡片置 relayed，后续在中继面板确认领取） */
export interface FriendFileRelayedPayload {
  transferId: string
}

/** 局域网信封负载：推流进度（发送方 → 接收方；文件夹传输逐文件上报，单文件不细分） */
export interface FriendFileProgressPayload {
  transferId: string
  doneBytes: number
  totalBytes: number
  doneFiles: number
  totalFiles: number
}

/** 前端事件（webContents.send('friend:event')） */
export type FriendEvent =
  | { type: 'request'; contact: FriendContact }
  | { type: 'accepted'; uid: number; 昵称: string }
  | { type: 'rejected'; uid: number }
  | { type: 'message'; uid: number; message: FriendChatMessage }
  | { type: 'peer-online'; uid: number; online: boolean }
  | { type: 'file-invite-sent'; uid: number; message: FriendChatMessage }
  | { type: 'file-accepted'; uid: number; transferId: string }
  | { type: 'file-rejected'; uid: number; transferId: string }
  | { type: 'file-progress'; uid: number; transferId: string; doneBytes: number; totalBytes: number; doneFiles: number; totalFiles: number }
  | { type: 'file-done'; uid: number; transferId: string; ok: boolean; error?: string; path?: string }
  | { type: 'file-canceled'; uid: number; transferId: string }
  | { type: 'file-relayed'; uid: number; transferId: string }
  | { type: 'file-resume'; uid: number; transferId: string }