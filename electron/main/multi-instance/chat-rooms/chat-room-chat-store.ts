/**
 * 为什么存在：房间消息高频更替且与房间元数据生命周期不同，独立文件存放才能按会话限量裁剪、互不干扰。
 * 作用：按群 gid 读写房间聊天消息（federation/chat-rooms/{gid}/messages.json，默认上限 2000 条）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChatRoomMessage } from './chat-room-types'

/**
 * 聊天室消息存储（abyssac_data/federation/chat-rooms/{gid}/messages.json）。
 * 整文件原子覆写，控制上限防单文件无限膨胀（默认保留最近 2000 条）。
 */
export class ChatRoomChatStore {
  private readonly dir: string
  private readonly maxMessages: number

  constructor(root: string, maxMessages = 2000) {
    this.dir = join(root, 'federation', 'chat-rooms')
    this.maxMessages = maxMessages
  }

  private path(gid: string): string {
    const d = join(this.dir, gid)
    mkdirSync(d, { recursive: true })
    return join(d, 'messages.json')
  }

  load(gid: string): ChatRoomMessage[] {
    try {
      const p = this.path(gid)
      if (!existsSync(p)) return []
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as ChatRoomMessage[]
      return Array.isArray(raw) ? raw.filter((m) => typeof m.id === 'string') : []
    } catch {
      return []
    }
  }

  append(gid: string, message: ChatRoomMessage): void {
    const messages = this.load(gid)
    if (messages.some((m) => m.id === message.id)) return // 幂等
    messages.push(message)
    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages)
    }
    this.save(gid, messages)
  }

  private save(gid: string, messages: ChatRoomMessage[]): void {
    const p = this.path(gid)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(messages, null, 2), 'utf-8')
    renameSync(tmp, p)
  }
}
