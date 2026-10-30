/**
 * MessagingService 路由层回归测试

 * 覆盖用户硬性要求「健康监控的消息必须给月蚀处理，但不能给吞了」：
 * - 系统注入/健康检查类文本：仍走月蚀完整工具链（onXiChat），回复原路发回平台；
 * - 外部消息不因「看起来像系统消息」被丢弃或静默失败。

 * mock 飞书适配器（不建真实长连接），通过 adapter.start 捕获的 handler 直接注入入站消息。
 */
import { describe, it, expect, vi } from 'vitest'
import type { SessionStore } from '../electron/main/api/session-store'
import type { ChatMessage } from '@shared/types'
import { MessagingService, type InboundMessage } from '../electron/main/messaging/service'

const mocks = vi.hoisted(() => {
  const state = {
    handler: null as null | ((msg: unknown) => void),
    sent: [] as Array<{ chatId: string; text: string; replyMessageId?: string }>
  }
  return {
    state,
    reset: () => {
      state.handler = null
      state.sent = []
    }
  }
})

vi.mock('../electron/main/messaging/feishu', () => ({
  FeishuAdapter: class {
    constructor(
      public appId: string,
      public appSecret: string
    ) {}
    start(cb: (msg: unknown) => void): void {
      mocks.state.handler = cb
    }
    async sendText(chatId: string, text: string, replyMessageId?: string): Promise<boolean> {
      mocks.state.sent.push({ chatId, text, replyMessageId })
      return true
    }
    stop(): void {
      mocks.state.handler = null
    }
    isRunning(): boolean {
      return !!mocks.state.handler
    }
    getLastError(): string {
      return ''
    }
  }
}))

function makeSessionStore(): SessionStore {
  const sessions = new Map<string, { id: string; messages: ChatMessage[] }>()
  return {
    getOrCreate: (id: string) => {
      if (!sessions.has(id)) sessions.set(id, { id, messages: [] })
      return sessions.get(id)!
    },
    get: (id: string) => sessions.get(id) ?? null,
    saveMessages: (id: string, messages: ChatMessage[]) => {
      sessions.set(id, { id, messages })
    },
    delete: (id: string) => {
      sessions.delete(id)
    },
    flush: () => {}
  } as unknown as SessionStore
}

type Call = { text: string; sessionId: string }

function makeService() {
  const calls: Call[] = []
  const deps = {
    configStore: {
      get: () => ({
        messaging: {
          enabled: true,
          feishu: { appId: 'test-app', appSecret: 'test-secret' },
          // 联系人会话固定映射：验证 sessionId 从配置生效
          contacts: [{ type: 'p2p', id: 'u-health-monitor', sessionId: 'msg_feishu_p2p_health' }],
          allowFrom: []
        }
      })
    },
    sessionStore: makeSessionStore(),
    onXiChat: async (text: string, sessionId: string): Promise<string> => {
      calls.push({ text, sessionId })
      return '月蚀完整处理结果'
    },
    isLlmBusy: () => false
  }
  const service = new MessagingService(deps as never)
  return { service, calls, deps }
}

/** 启动后注入一条入站消息，等待串行队列处理完成 */
async function injectAndSettle(service: MessagingService, msg: InboundMessage): Promise<void> {
  mocks.reset()
  service.sync() // 触发 adapter.start → 捕获 handler
  expect(mocks.state.handler).toBeTruthy()
  mocks.state.handler!(msg)
  // 串行队列异步处理，轮询等待有响应发回（或路由已记录）
  const deadline = Date.now() + 2000
  while (mocks.state.sent.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('MessagingService 路由层（外部消息走月蚀完整链路）', () => {
  it('系统注入/健康检查消息：走月蚀完整工具链，回复发回平台（不吞）', async () => {
    const { service, calls } = makeService()
    const injected =
      '【系统注入：本条为系统激活消息，非用户真实发言，请优先响应并明确其来源】\n' +
      '【外部事件】【健康检查】工作区代码自检发现 test 全量 0 test'
    await injectAndSettle(service, {
      platform: 'feishu',
      messageId: 'm-1',
      chatId: 'c-1',
      chatType: 'p2p',
      senderOpenId: 'u-health-monitor',
      text: injected
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe(injected)
    // 联系人配置的 sessionId 生效（用户可控制会话分组）
    expect(calls[0].sessionId).toBe('msg_feishu_p2p_health')
    // 回复原路发回平台——消息没有被吞
    expect(mocks.state.sent).toHaveLength(1)
    expect(mocks.state.sent[0].text).toContain('月蚀完整处理结果')
    expect(mocks.state.sent[0].chatId).toBe('c-1')
  })

  it('普通消息同样走月蚀链路', async () => {
    const { service, calls } = makeService()
    await injectAndSettle(service, {
      platform: 'feishu',
      messageId: 'm-2',
      chatId: 'c-1',
      chatType: 'p2p',
      senderOpenId: 'u-health-monitor',
      text: '今天天气怎么样？'
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toBe('今天天气怎么样？')
    expect(mocks.state.sent[0].text).toContain('月蚀完整处理结果')
  })
})
