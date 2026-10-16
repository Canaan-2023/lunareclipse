/**
 * 为什么存在：AI 私聊消息需持久化（federation/ai-chats/）并在重启后恢复，且消息数量需限量防膨胀。
 * 作用：按 chatId 读写单个 AI 私聊会话的消息数组（默认上限 2000 条，整文件原子覆写）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AiChatMessage } from './ai-social-types'

/**
 * AI 私聊消息存储（abyssac_data/federation/ai-chats/{chatId}.json）。
 * chatId 约定见 ai-social-types：ai_{uid}_{avA}_{avB}（av 升序，真人=0）。
 * 存储为结构数组（整文件原子覆写，控制上限防单文件无限膨胀）。
 * 不产生 oplog、不进主分记忆汇聚（与好友私聊同一语义）。
 */
export class AiChatStore {
  private readonly dir: string
  /** 单会话消息上限（超出丢弃最旧；防单文件无限膨胀，也防全量注入撑爆上下文） */
  private readonly maxMessages: number

  constructor(root: string, maxMessages = 2000) {
    this.dir = join(root, 'federation', 'ai-chats')
    this.maxMessages = maxMessages
    mkdirSync(this.dir, { recursive: true })
  }

  private path(chatId: string): string {
    return join(this.dir, `${chatId}.json`)
  }

  /** 读取全部消息（时间升序即文件序） */
  load(chatId: string): AiChatMessage[] {
    try {
      if (!existsSync(this.path(chatId))) return []
      const raw = JSON.parse(readFileSync(this.path(chatId), 'utf-8')) as AiChatMessage[]
      return Array.isArray(raw) ? raw.filter((m) => typeof m.id === 'string') : []
    } catch {
      return []
    }
  }

  /** 追加一条并覆写（幂等：同 id 不重复写） */
  append(chatId: string, message: AiChatMessage): void {
    const messages = this.load(chatId)
    if (messages.some((m) => m.id === message.id)) return
    messages.push(message)
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages)
    }
    this.save(chatId, messages)
  }

  /** 标记某方向（真人视角 from 为对方）的全部消息为已读 */
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

  /** 统计未读（真人视角：from === 对方 uid 且 !read） */
  countUnread(chatId: string, fromUid: number): number {
    return this.load(chatId).filter((m) => m.from === fromUid && !m.read).length
  }

  /** 最后一条消息（无则 null） */
  last(chatId: string): AiChatMessage | null {
    const messages = this.load(chatId)
    return messages.length > 0 ? messages[messages.length - 1] : null
  }

  private save(chatId: string, messages: AiChatMessage[]): void {
    const tmp = `${this.path(chatId)}.tmp`
    writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf-8')
    renameSync(tmp, this.path(chatId))
  }
}