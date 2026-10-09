/**
 * 飞书适配器（消息接入第一站）

 * 用官方 SDK @larksuiteoapi/node-sdk 的**长连接模式**（WebSocket）接收事件：
 * - 无需公网服务器/内网穿透（本地应用刚需）
 * - 建连时鉴权一次，后续事件明文推送，无需解密验签
 * - 入站：im.message.receive_v1（私聊 p2p + 群聊 group）
 * - 出站：im/v1/message create（普通发送）/ reply（引用回复）

 * ⚠️ 铁律：事件 handler 必须**毫秒级返回**（飞书 3 秒未处理会超时重推）——
 * 入站只做解析 + 入队（回调给 MessagingService 异步处理），绝不在此 await LLM。
 */
import * as Lark from '@larksuiteoapi/node-sdk'

/** 入站消息（统一结构，与平台解耦） */
export interface FeishuInboundMessage {
  platform: 'feishu'
  /** 飞书消息 ID（回复引用用） */
  messageId: string
  /** 会话 ID：私聊=单聊 chat_id，群聊=群 chat_id（出站 receive_id 都用它） */
  chatId: string
  /** 私聊 or 群聊 */
  chatType: 'p2p' | 'group'
  /** 发送者 open_id（白名单校验 + 联系人映射用） */
  senderOpenId: string
  /** 纯文本内容（text 消息解析后的正文） */
  text: string
}

/** 入站消息回调 */
export type FeishuMessageHandler = (msg: FeishuInboundMessage) => void

export class FeishuAdapter {
  private client: Lark.Client | null = null
  private wsClient: Lark.WSClient | null = null
  private started = false
  private onMessage: FeishuMessageHandler | null = null
  private lastError: string = ''

  constructor(
    private appId: string,
    private appSecret: string
  ) {}

  isRunning(): boolean {
    return this.started
  }

  getLastError(): string {
    return this.lastError
  }

  /** 建立长连接并开始收消息（幂等：已启动则忽略） */
  start(handler: FeishuMessageHandler): void {
    if (this.started) return
    this.onMessage = handler
    this.client = new Lark.Client({ appId: this.appId, appSecret: this.appSecret })

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        const parsed = this.parseInbound(data)
        if (parsed) this.onMessage?.(parsed)
      }
    })

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.warn
    })
    this.wsClient.start({ eventDispatcher })
    this.started = true
    this.lastError = ''
    // 隐私：不输出 App ID 具体值（应用账号标识），只记录已启动
    console.log('[messaging:feishu] 长连接已启动（App ID 已设置）')
  }

  stop(): void {
    if (!this.started) return
    this.wsClient?.close()
    this.wsClient = null
    this.client = null
    this.started = false
    this.onMessage = null
    console.log('[messaging:feishu] 长连接已停止')
  }

  /**
   * 发送文本消息（私聊/群通用：receive_id 都是 chat_id）
   * @param chatId 私聊单聊 chat_id 或群 chat_id
   * @param text 文本内容
   * @param replyMessageId 可选：引用回复某条消息
   */
  async sendText(chatId: string, text: string, replyMessageId?: string): Promise<boolean> {
    if (!this.client) return false
    if (replyMessageId) {
      await this.client.im.v1.message.reply({
        path: { message_id: replyMessageId },
        data: { content: JSON.stringify({ text }), msg_type: 'text' }
      })
    } else {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' }
      })
    }
    return true
  }

  /** 解析 im.message.receive_v1 事件 → 统一入站结构（只支持 text 消息） */
  private parseInbound(data: unknown): FeishuInboundMessage | null {
    const d = data as {
      sender?: { sender_id?: { open_id?: string } }
      message?: {
        message_id?: string
        chat_id?: string
        chat_type?: string
        message_type?: string
        content?: string
      }
    }
    const message = d?.message
    if (!message?.message_id || !message.chat_id) {
      // 隐私红线：不整体打印事件 JSON（可能含手机号/邮箱等 PII 字段），只输出关键标识
      console.warn(
        `[messaging:feishu] 收到事件但缺 message_id/chat_id: type=${message?.message_type ?? '?'} chat_type=${message?.chat_type ?? '?'}`
      )
      return null
    }
    // 非文本消息（图片/文件/卡片等）先忽略——文本接入 v1 只处理文字（⚠️ 打日志便于排查"发了消息没回复"）
    if (message.message_type !== 'text') {
      console.log(`[messaging:feishu] 忽略非文本消息: type=${message.message_type} chat_type=${message.chat_type} sender=${d?.sender?.sender_id?.open_id ? '已设置' : '无'}`)
      return null
    }
    let text = ''
    const content = JSON.parse(message.content ?? '{}') as { text?: string }
    text = (content.text ?? '').trim()
    if (!text) {
      console.warn('[messaging:feishu] text 消息内容为空')
      return null
    }
    console.log(`[messaging:feishu] ✅ 入站: ${message.chat_type === 'group' ? '群' : '私聊'} from=${d?.sender?.sender_id?.open_id ? '已设置' : '无'} text="${text.slice(0, 40)}"`)
    return {
      platform: 'feishu',
      messageId: message.message_id,
      chatId: message.chat_id,
      chatType: message.chat_type === 'group' ? 'group' : 'p2p',
      senderOpenId: d?.sender?.sender_id?.open_id ?? '',
      text
    }
  }
}
