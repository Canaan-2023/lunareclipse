/**
 * AI 社交身份层类型契约。
 * 以 AIID 为唯一标识将本机注册表（abyssac_data/ai-registry.json）中的 AI 实体
 * 接入社交数据模型：好友面板「我的 AI」分组、AI 私聊会话（真人↔AI、AI↔AI）。

 * 身份约定（与 lan-types 的 UID-AIID 全局一致）：真人 = 纯 uid；AI = UID-AIID。
 * AI 私聊会话按"参与双方 avId"寻址，真人固定 avId=0：
 * - 真人↔AI_i：chatId = ai_{uid}_{0}_{i}
 * - AI_i↔AI_j（i<j）：chatId = ai_{uid}_{i}_{j}

 * 存储：abyssac_data/federation/ai-chats/{chatId}.json（结构数组，整文件原子覆写）。
 * 不产生 oplog、不进主分记忆汇聚（与好友私聊同一语义）。
 * 为什么存在：多开后的 AI 实体也是社交体系的成员，寻址与身份约定（AIID↔avatars）需要单点定义，防止各模块各写一套导致 chatId 错乱。
 */

/** AI 社交联系人补丁：本机注册表 AiRecord 映射为社交联系人（永远在线，因本机 AI 可用） */
export interface AiSocialContact {
  /** 机主 uid（本机账号） */
  uid: number
  /** AI 实体编号（注册表 id，1=月蚀主 AI，其余按 ai-registry.json 顺延） */
  aiId: number
  /** 显示名（注册表 name） */
  name: string
  /** 头像标识（emoji 或资源 key） */
  avatar?: string
  /** 简介 */
  description?: string
  /** agent 标识（frontend/lilith/custom-{id}） */
  agent: string
  /** 角色类型（system/custom） */
  kind?: 'system' | 'custom'
  /** 停用标记（停用 AI 不出现在社交联系人） */
  deactivated?: boolean
  /** 本机 AI 恒在线 */
  online: true
}

/** AI 私聊会话单条消息（federation/ai-chats/{chatId}.json 数组元素） */
export interface AiChatMessage {
  id: string
  /** 发送方机主 uid（本机账号） */
  from: number
  /** 发送方 AI 编号（无 = 机主真人；AI 发言时 = 自己的 aiId） */
  fromAiId?: number
  /** 接收方机主 uid（本机账号） */
  to: number
  /** 接收方 AI 编号（无 = 机主真人） */
  toAiId?: number
  text: string
  ts: number
  /** 本机真人是否已读（AI 参与方不产生未读标记，仅真人视角） */
  read: boolean
  /** 是否 AI 自动生成（与好友消息语义一致） */
  isAiGenerated?: boolean
}

/** AI 私聊会话列表项（好友面板「我的 AI」分组条目） */
export interface AiSocialChatListItem {
  /** 对端 AI（聊天对象） */
  contact: AiSocialContact
  /** 对端 AI 编号（会话参与方之一；真人侧固定为对方 AI） */
  aiId: number
  /** 会话 chatId（ai_{uid}_{avA}_{avB}，av 升序） */
  chatId: string
  /** 最近一条消息文本（无则 null） */
  lastMessage: string | null
  /** 最近一条消息时间（epoch ms；无则 null） */
  lastTs: number | null
  /** 真人未读数（真人视角 from 为对方且未读） */
  unread: number
}

/** AI 私聊前端事件 */
export type AiSocialChatEvent =
  | { type: 'message'; chatId: string; message: AiChatMessage }
  | { type: 'read'; chatId: string }

/** 构造 AI 私聊会话 chatId：avA/avB 升序（真人=0） */
export function aiChatId(uid: number, avA: number, avB: number): string {
  const [lo, hi] = avA <= avB ? [avA, avB] : [avB, avA]
  return `ai_${uid}_${lo}_${hi}`
}

/** 解析 AI 会话 chatId → 参与双方 avId（非法返回 null） */
export function parseAiChatId(chatId: string): { uid: number; avA: number; avB: number } | null {
  const m = /^ai_(\d+)_(\d+)_(\d+)$/.exec(chatId)
  if (!m) return null
  const uid = Number(m[1])
  const avA = Number(m[2])
  const avB = Number(m[3])
  if (!Number.isInteger(uid) || !Number.isInteger(avA) || !Number.isInteger(avB) || avA >= avB) return null
  return { uid, avA, avB }
}