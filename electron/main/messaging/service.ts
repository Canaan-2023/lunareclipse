/**
 * 消息接入服务

 * 外部消息平台（飞书等）→ 月蚀大脑 的统一入口：

 * 入站管线：适配器收消息（毫秒级入队，满足飞书 3 秒限制）
 * → 串行队列（同一时间只处理一条外部消息，LLM 单实例串行）
 * → 白名单检查（空 = 默认开放全部；群聊按 chat_id、私聊按 open_id）
 * → 路由（联系人映射表：固定到月蚀 or 莉莉丝；未配置默认月蚀）
 * → 对话（月蚀 = headless runStream 完整工具循环；莉莉丝 = generateLilithReply）
 * → 回复发回平台（引用回复）

 * 并发保护：外部消息进来时若 LLM 正在跑（桌面聊天/其他任务），
 * 直接回"正在处理其他对话"而不是并发抢占（LLMClient 单实例串行，并发会覆盖 abort 控制）。
 */
import type { ConfigStore } from '../api/config-store'
import type { SessionStore } from '../api/session-store'
import { FeishuAdapter, type FeishuInboundMessage } from './feishu'
import { isSystemInjectedText } from '../services/lilith-adapter'

/** 外部消息统一结构（平台解耦后的最小集） */
export interface InboundMessage {
  platform: 'feishu'
  messageId: string
  chatId: string
  chatType: 'p2p' | 'group'
  senderOpenId: string
  text: string
}

/** 对话入口依赖（由 server.ts 注入闭包，避免循环依赖） */
export interface MessagingDeps {
  configStore: ConfigStore
  sessionStore: SessionStore
  /** 月蚀对话：headless runStream（完整上下文 + 工具循环），返回最终回复文本 */
  onXiChat: (text: string, sessionId: string) => Promise<string>
  /** 莉莉丝对话：generateLilithReply（人设 + lore + 玩家记忆 + companion sessions） */
  onLilithChat: (text: string, playerName: string) => Promise<string>
  /** LLM 是否忙碌（外部消息与桌面聊天并发保护） */
  isLlmBusy: () => boolean
  /** 玩家名（莉莉丝 persona 的 {playerName} 占位符；默认 Player） */
  getPlayerName?: () => string
}

export class MessagingService {
  private adapter: FeishuAdapter | null = null
  /** 串行队列：外部消息严格一条接一条处理（LLM 单实例，不能并发） */
  private queue: Promise<unknown> = Promise.resolve()
  private started = false
  /** 已处理消息计数（状态展示用） */
  private handledCount = 0
  /** 当前长连接使用的凭证（变化时重启） */
  private adapterAppId = ''
  private adapterAppSecret = ''

  constructor(private deps: MessagingDeps) {}

  /**
   * 同步配置 → 适配器启停（配置变化后调用，热生效）：
   * - enabled + 凭证齐全 → 启动/保持长连接
   * - 凭证变化 → 重启（重连）
   * - 关闭/凭证清空 → 停止
   */
  sync(): void {
    const cfg = this.deps.configStore.get().messaging
    const feishu = cfg?.feishu
    const shouldRun = !!cfg?.enabled && !!feishu?.appId && !!feishu?.appSecret

    if (!shouldRun) {
      if (this.started) {
        this.stop()
        console.log('[messaging] 已停止（配置关闭或凭证缺失）')
      }
      return
    }

    const appId = feishu!.appId
    const appSecret = feishu!.appSecret
    if (!this.started) {
      this.start(appId, appSecret)
    } else if (this.adapter && (this.adapterAppId !== appId || this.adapterAppSecret !== appSecret)) {
      // 凭证变化 → 重启长连接
      console.log('[messaging] 凭证变化，重启飞书长连接')
      this.stop()
      this.start(appId, appSecret)
    }
  }

  stop(): void {
    this.adapter?.stop()
    this.adapter = null
    this.started = false
    this.adapterAppId = ''
    this.adapterAppSecret = ''
  }

  isRunning(): boolean {
    return this.started
  }

  status(): { running: boolean; handledCount: number; lastError: string } {
    return {
      running: this.started,
      handledCount: this.handledCount,
      lastError: this.adapter?.getLastError() ?? ''
    }
  }

  /** 会话映射：联系人固定路由（未配置默认月蚀，能干活） */
  private resolveAgent(msg: InboundMessage): 'xi' | 'lilith' {
    const cfg = this.deps.configStore.get().messaging
    const contacts = cfg?.contacts ?? []
    const key = msg.chatType === 'group' ? msg.chatId : msg.senderOpenId
    const type = msg.chatType === 'group' ? 'group' : 'p2p'
    const contact = contacts.find((c) => c.type === type && c.id === key)
    return contact?.agent ?? 'xi'
  }

  /** 白名单：空 = 默认开放全部；非空时私聊看 open_id、群聊看 chat_id */
  private isAllowed(msg: InboundMessage): boolean {
    const cfg = this.deps.configStore.get().messaging
    const allowFrom = cfg?.allowFrom ?? []
    if (allowFrom.length === 0) return true
    return msg.chatType === 'group' ? allowFrom.includes(msg.chatId) : allowFrom.includes(msg.senderOpenId)
  }

  /** 外部消息的稳定会话 ID：确定性生成（不依赖映射表持久化，sessionStore 天然持久） */
  private sessionIdFor(msg: InboundMessage): string {
    const cfg = this.deps.configStore.get().messaging
    const contacts = cfg?.contacts ?? []
    const key = msg.chatType === 'group' ? msg.chatId : msg.senderOpenId
    const type = msg.chatType === 'group' ? 'group' : 'p2p'
    const contact = contacts.find((c) => c.type === type && c.id === key)
    // 映射表里显式指定了 sessionId 则用（用户可控制会话分组）；否则确定性生成
    if (contact?.sessionId) return contact.sessionId
    return `msg_${msg.platform}_${type}_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  }

  private start(appId: string, appSecret: string): void {
    this.adapter = new FeishuAdapter(appId, appSecret)
    this.adapter.start((raw) => this.enqueue(raw))
    this.started = true
    this.adapterAppId = appId
    this.adapterAppSecret = appSecret
  }

  /** 入队：毫秒级返回（飞书 3 秒限制），实际处理在串行队列里异步跑 */
  private enqueue(raw: FeishuInboundMessage): void {
    const msg: InboundMessage = { ...raw }
    this.queue = this.queue
      .then(() => this.handle(msg))
  }

  /** 单条消息完整处理管线（串行执行） */
  private async handle(msg: InboundMessage): Promise<void> {
    if (!this.isAllowed(msg)) {
      console.log(`[messaging] 白名单拦截：${msg.platform} ${msg.chatType} 会话标识${msg.senderOpenId || msg.chatId ? '已设置' : '缺失'}`)
      return
    }

const agent = this.resolveAgent(msg)
    // 系统注入/健康检查消息强制分流到月蚀：即使联系人配置为 lilith，也绝不进莉莉丝
    // 人设链路（莉莉丝没有工具，无法真正处理系统事件），而是交给月蚀完整工具链。
    // 只改路由不改内容——消息不被吞掉，月蚀处理后回复原路返回。
    const routingAgent = isSystemInjectedText(msg.text) ? 'xi' : agent
    if (routingAgent !== agent) {
      console.log(`[messaging] 系统注入/健康检查消息强制路由月蚀（联系人 agent=${agent}）: "${msg.text.slice(0, 60)}"`)
    }
    console.log(`[messaging] 处理: ${msg.chatType} 会话标识${msg.senderOpenId || msg.chatId ? '已设置' : '缺失'} → agent=${routingAgent} text="${msg.text.slice(0, 30)}"`)

    // 并发保护：LLM 正在跑（桌面聊天等）→ 礼貌拒绝，不并发抢占
    if (this.deps.isLlmBusy()) {
      console.log('[messaging] LLM 忙，拒绝并提示稍候')
      await this.adapter?.sendText(msg.chatId, '（月蚀正在处理其他对话，稍等片刻再找我哦）', msg.messageId)
      return
    }

    try {
let reply: string
      if (routingAgent === 'lilith') {
        reply = await this.deps.onLilithChat(msg.text, this.deps.getPlayerName?.() ?? 'Player')
      } else {
        const sessionId = this.sessionIdFor(msg)
        reply = await this.deps.onXiChat(msg.text, sessionId)
      }
      // 空回复：LLM 返回空 content / 工具循环耗尽时，暴露问题而非发空消息
      if (!reply || !reply.trim()) throw new Error('LLM returned empty reply')
      console.log(`[messaging] 回复 ${reply.length} 字: "${reply.slice(0, 40)}..."`)
      await this.adapter?.sendText(msg.chatId, reply, msg.messageId)
      this.handledCount += 1
    } catch (err) {
      console.error('[messaging] 对话处理出错:', (err as Error).message)
      await this.adapter?.sendText(msg.chatId, `（处理出错：${(err as Error).message}）`, msg.messageId)
    }
  }
}
