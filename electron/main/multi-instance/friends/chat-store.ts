/**
 * 为什么存在：好友对等通信必须保证两人读到同一份文件，chatId 与收发方向无关（uid 归一化排序）是硬性约定。
 * 作用：静态生成规范化 chatId，按会话读写好友私聊消息（federation/chats/，默认上限 2000 条）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FriendChatMessage } from './friend-types'

/**
 * 私聊消息存储（abyssac_data/federation/chats/{chatId}/messages.json）。
 * chatId 约定：friend_{minUid}_{maxUid}（双方一致的稳定键）；
 * 存储为结构数组（整文件原子覆写，控制上限防单文件无限膨胀）。
 * 不产生 oplog、不进主分记忆汇聚。
 */
export class ChatStore {
  private readonly dir: string
  /** 单会话消息上限（超出丢弃最旧；防单文件无限膨胀，也防全量注入撑爆上下文） */
  private readonly maxMessages: number

  constructor(root: string, maxMessages = 2000) {
    this.dir = join(root, 'federation', 'chats')
    this.maxMessages = maxMessages
    mkdirSync(this.dir, { recursive: true })
  }

  /** 生成双方一致的 chatId（uid 升序排序） */
  static chatId(uidA: number, uidB: number): string {
    const [lo, hi] = uidA < uidB ? [uidA, uidB] : [uidB, uidA]
    return `friend_${lo}_${hi}`
  }

  private path(chatId: string): string {
    return join(this.dir, `${chatId}.json`)
  }

  /** 读取全部消息（时间升序即文件序） */
  load(chatId: string): FriendChatMessage[] {
    try {
      if (!existsSync(this.path(chatId))) return []
      const raw = JSON.parse(readFileSync(this.path(chatId), 'utf-8')) as FriendChatMessage[]
      return Array.isArray(raw) ? raw.filter((m) => typeof m.id === 'string') : []
    } catch {
      return []
    }
  }

  /** 追加一条并覆写（调用方负责幂等：messageId 去重、前端已读标记更新） */
  append(chatId: string, message: FriendChatMessage): void {
    const messages = this.load(chatId)
    if (messages.some((m) => m.id === message.id)) return // 幂等：同 id 不重复写
    messages.push(message)
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages)
    }
    this.save(chatId, messages)
  }

  /** 按 id 原地修改一条消息（邀请卡片状态流转等）；未找到静默跳过 */
  updateMessage(chatId: string, messageId: string, patch: (m: FriendChatMessage) => void): void {
    const messages = this.load(chatId)
    const target = messages.find((m) => m.id === messageId)
    if (!target) return
    patch(target)
    this.save(chatId, messages)
  }

  /** 标记某方向来的全部消息为已读（打开聊天窗口时调用） */
  markRead(chatId: string, fromUid: number): void {
    const messages = this.load(chatId)
    let changed = false
    for (const m of messages) {
      if (m.from === fromUid && !m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) this.save(chatId, messages)
  }

  /** 统计未读（from === 对方 且 !read） */
  countUnread(chatId: string, fromUid: number): number {
    return this.load(chatId).filter((m) => m.from === fromUid && !m.read).length
  }

  /** 最后一条消息（无则 null） */
  last(chatId: string): FriendChatMessage | null {
    const messages = this.load(chatId)
    return messages.length > 0 ? messages[messages.length - 1] : null
  }

  private save(chatId: string, messages: FriendChatMessage[]): void {
    const tmp = `${this.path(chatId)}.tmp`
    writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf-8')
    renameSync(tmp, this.path(chatId))
  }
}