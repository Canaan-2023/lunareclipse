/**
 * 为什么存在：多开后的 AI 实体（以 AIID 为身份）也是社交成员，需要与真人一样可聊天、可被 AI 自动应答。
 * 作用：AI 社交业务门面：聚合 AiChatStore 与身份解析，提供聊天记录查询、发送消息、事件派发与 AI 应答钩子。
 */

import { randomUUID } from 'crypto'
import type { AiRecord } from '../../models/ai-registry'
import { readAiRegistry } from '../../models/ai-registry'
import { AiChatStore } from './ai-social-store'
import type {
  AiChatMessage,
  AiSocialChatEvent,
  AiSocialChatListItem,
  AiSocialContact
} from './ai-social-types'
import { aiChatId } from './ai-social-types'

/**
 * AI 社交服务（ 引入）：以 AIID 为唯一标识，将本机注册表（ai-registry.json）
 * 中的全部 AI 实体接入社交数据模型。

 * 能力：
 * - listContacts：好友面板「我的 AI」分组数据源（永久在线；停用 AI 不出现）
 * - AI 私聊会话：真人↔AI（ai_{uid}_{0}_{aiId}）与 AI↔AI（ai_{uid}_{i}_{j}）
 * - AI 回复生成器：收到真人消息触发对端 AI 回复；收到别的 AI 消息触发对端 AI
 * 回复（防自聊：同一 AI 收到的消息若是自己发的则跳过）

 * 本服务不依赖 LAN 直连：同账号内的 AI 实体都在本机，会话本地落盘 + 事件推送。
 * 装配：multi-instance/index.ts 在 LLM 链路就绪后注入 aiReply 生成器。
 */
export interface AiSocialServiceDeps {
  /** 数据根目录（federation/ai-chats 挂其下） */
  root: string
  /** AI 注册表路径（abyssac_data/ai-registry.json） */
  registryPath: string
  /** 当前登录用户（未登录返回 null） */
  getIdentity: () => { uid: number; 用户名: string } | null
  /** 事件推送（mainWindow.webContents.send('ai-social:event', event)） */
  emit: (event: AiSocialChatEvent) => void
  /**
   * AI 会话回复生成器：收到发给某 AI 的消息时调用，返回回复正文（null = 不回复）。
   * peer 为被触发回复的目标 AI；trigger 为触发消息；history 为该会话完整历史。
   */
  aiReply?: (
    peer: { uid: number; aiId: number; name: string },
    trigger: AiChatMessage,
    history: AiChatMessage[]
  ) => Promise<string | null>
}

export class AiSocialService {
  readonly chats: AiChatStore

  constructor(private readonly deps: AiSocialServiceDeps) {
    this.chats = new AiChatStore(deps.root)
  }

  // ===== AI 社交联系人 =====

  /** 注册表全部 AI 记录（含停用；供内部判断身份合法性） */
  allAi(): AiRecord[] {
    return readAiRegistry(this.deps.registryPath).ais
  }

  /** 好友面板「我的 AI」：全部未停用 AI 联系人（本机 uid；恒在线） */
  listContacts(): AiSocialContact[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    return readAiRegistry(this.deps.registryPath).ais
      .filter((a) => !a.deactivated)
      .map((a) => this.toContact(identity.uid, a))
  }

  /** 按 aiId 查联系人详细（未停用；找不到返回 null） */
  getContact(aiId: number): AiSocialContact | null {
    const identity = this.deps.getIdentity()
    if (!identity) return null
    const a = readAiRegistry(this.deps.registryPath).ais.find((x) => x.id === aiId && !x.deactivated)
    return a ? this.toContact(identity.uid, a) : null
  }

  /** 好友面板列表项：contacts 合并最近消息/未读 */
  listChats(): AiSocialChatListItem[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    return this.listContacts().map((contact) => {
      const chatId = aiChatId(identity.uid, 0, contact.aiId)
      const last = this.chats.last(chatId)
      return {
        contact,
        aiId: contact.aiId,
        chatId,
        lastMessage: last?.text ?? null,
        lastTs: last?.ts ?? null,
        unread: this.chats.countUnread(chatId, identity.uid)
      }
    })
  }

  /** AI 与真人的会话消息（真人↔AI_i：ai_{uid}_{0}_{aiId}） */
  messages(aiId: number): AiChatMessage[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    if (!this.getContact(aiId)) return []
    return this.chats.load(aiChatId(identity.uid, 0, aiId))
  }

  /** 任意两个 AI 之间的会话消息（AI_i↔AI_j） */
  aiMessages(avA: number, avB: number): AiChatMessage[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    return this.chats.load(aiChatId(identity.uid, avA, avB))
  }

  /** 真人标记与某 AI 的会话已读 */
  markRead(aiId: number): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const contact = this.getContact(aiId)
    if (!contact) return
    const chatId = aiChatId(identity.uid, 0, aiId)
    this.chats.markRead(chatId, identity.uid)
    this.deps.emit({ type: 'read', chatId })
  }

  // ===== 发送 =====

  /** 真人给 AI 发消息：落盘 + 推送 + 触发该 AI 回复 */
  sendFromHuman(aiId: number, text: string): { ok: boolean; error?: string; message?: AiChatMessage } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const contact = this.getContact(aiId)
    if (!contact) return { ok: false, error: `AI 不存在或已停用（aiId=${aiId}）` }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '消息为空' }
    const chatId = aiChatId(identity.uid, 0, aiId)
    const message: AiChatMessage = {
      id: `${identity.uid}_${randomUUID()}`,
      from: identity.uid,
      to: identity.uid,
      toAiId: aiId,
      text: trimmed,
      ts: Date.now(),
      read: true
    }
    this.chats.append(chatId, message)
    this.deps.emit({ type: 'message', chatId, message })
    void this.maybeAiReply(contact, message, chatId)
    return { ok: true, message }
  }

  /** AI 给 AI（或给真人，toAiId 缺省）发消息：落盘 + 推送 + 触发对端回复 */
  sendFromAi(
    fromAiId: number,
    text: string,
    toAiId?: number
  ): { ok: boolean; error?: string; message?: AiChatMessage } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const fromContact = this.getContact(fromAiId)
    if (!fromContact) return { ok: false, error: `发起 AI 不存在或已停用（aiId=${fromAiId}）` }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '消息为空' }
    // 目标缺省 = 真人；指定时校验目标存在且不是自己（防自聊）
    let targetAiId: number | undefined
    if (toAiId !== undefined) {
      if (toAiId === fromAiId) return { ok: false, error: '不能给自己发消息' }
      const target = this.getContact(toAiId)
      if (!target) return { ok: false, error: `目标 AI 不存在或已停用（aiId=${toAiId}）` }
      targetAiId = toAiId
    }
    // 会话定向：AI 给 AI → ai_{uid}_{fromAiId}_{toAiId}（AI_i↔AI_j 会话）；
    // AI 给真人（toAiId 缺省）→ ai_{uid}_{0}_{fromAiId}（真人↔AI_i 会话）
    const chatId =
      targetAiId !== undefined
        ? aiChatId(identity.uid, fromAiId, targetAiId)
        : aiChatId(identity.uid, 0, fromAiId)
    const message: AiChatMessage = {
      id: `${identity.uid}_${randomUUID()}`,
      from: identity.uid,
      fromAiId,
      to: identity.uid,
      ...(targetAiId !== undefined ? { toAiId: targetAiId } : {}),
      text: trimmed,
      ts: Date.now(),
      read: false,
      isAiGenerated: true
    }
    this.chats.append(chatId, message)
    this.deps.emit({ type: 'message', chatId, message })
    if (targetAiId !== undefined) {
      const targetContact = this.getContact(targetAiId)
      if (targetContact) void this.maybeAiReply(targetContact, message, chatId)
    }
    return { ok: true, message }
  }

  // ===== AI 回复（内部） =====

  /** 尝试让目标 AI 自动回复：真人消息、别的 AI 消息都会触发；本 AI 自己发的跳过 */
  private async maybeAiReply(peer: AiSocialContact, trigger: AiChatMessage, chatId: string): Promise<void> {
    if (!this.deps.aiReply) return
    if (trigger.fromAiId !== undefined && trigger.fromAiId === peer.aiId) return // 防自聊
    let replyText: string | null = null
    try {
      replyText = await this.deps.aiReply(
        { uid: peer.uid, aiId: peer.aiId, name: peer.name },
        trigger,
        this.chats.load(chatId)
      )
    } catch {
      return
    }
    if (!replyText?.trim()) return
    const identity = this.deps.getIdentity()
    if (!identity) return
    const reply: AiChatMessage = {
      id: `${identity.uid}_${randomUUID()}`,
      from: identity.uid,
      fromAiId: peer.aiId,
      to: identity.uid,
      // 回复的接收方：触发者为 AI 时回给该 AI（AI↔AI 会话），触发者为真人时不指定（回给真人）
      ...(trigger.fromAiId !== undefined ? { toAiId: trigger.fromAiId } : {}),
      text: replyText.trim(),
      ts: Date.now(),
      read: false,
      isAiGenerated: true
    }
    this.chats.append(chatId, reply)
    this.deps.emit({ type: 'message', chatId, message: reply })
  }

  private toContact(uid: number, a: AiRecord): AiSocialContact {
    return {
      uid,
      aiId: a.id,
      name: a.name,
      ...(a.avatar !== undefined ? { avatar: a.avatar } : {}),
      ...(a.description !== undefined ? { description: a.description } : {}),
      agent: a.agent,
      ...(a.kind !== undefined ? { kind: a.kind } : {}),
      ...(a.deactivated !== undefined ? { deactivated: a.deactivated } : {}),
      online: true
    }
  }
}