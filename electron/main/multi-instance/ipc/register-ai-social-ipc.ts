/**
 * @category 工具
 * @summary AI 社交 IPC 注册（好友面板「我的 AI」+ AI 私聊会话；不需要 LAN 直连）
 * 为什么存在：AI 社交面板需在本地访问聊天与会话（不需 LAN），与好友域分离注册以免互相依赖。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import type { AiSocialService } from '../ai-social/ai-social-service'

/** AI 社交域所需上下文：以 getter 形式注入 MultiInstanceService 私有状态 */
export interface AiSocialIpcCtx {
  getAiSocial(): AiSocialService | null
}

/** 注册 AI 社交 IPC 通道（6 个 ai-social:*） */
export function registerAiSocialIpc(ipc: typeof ipcMainType, ctx: AiSocialIpcCtx): void {
  const withAiSocial = <T>(fn: (s: AiSocialService) => T): T | { ok: false; error: string } => {
    const social = ctx.getAiSocial()
    if (!social) return { ok: false, error: 'AI 社交未初始化' }
    try {
      return fn(social)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  safeHandle(
    ipc, 'ai-social:contacts',
    () => withAiSocial((s) => ({ ok: true as const, contacts: s.listContacts() })),
    { ok: false, error: '读取 AI 联系人失败' }
  )
  safeHandle(
    ipc, 'ai-social:chats',
    () => withAiSocial((s) => ({ ok: true as const, list: s.listChats() })),
    { ok: false, error: '读取 AI 会话失败' }
  )
  safeHandle(
    ipc, 'ai-social:messages',
    (_e, aiId: unknown) => {
      if (typeof aiId !== 'number') return { ok: false, error: '参数不合法' }
      return withAiSocial((s) => ({ ok: true as const, messages: s.messages(aiId) }))
    },
    { ok: false, error: '读取 AI 消息失败' }
  )
  safeHandle(
    ipc, 'ai-social:markRead',
    (_e, aiId: unknown) => {
      if (typeof aiId !== 'number') return { ok: false, error: '参数不合法' }
      return withAiSocial((s) => {
        s.markRead(aiId)
        return { ok: true as const }
      })
    },
    { ok: false, error: '标记失败' }
  )
  safeHandle(
    ipc, 'ai-social:send',
    (_e, aiId: unknown, text: unknown) => {
      if (typeof aiId !== 'number' || typeof text !== 'string') return { ok: false, error: '参数不合法' }
      return withAiSocial((s) => s.sendFromHuman(aiId, text))
    },
    { ok: false, error: '发送失败' }
  )
  safeHandle(
    ipc, 'ai-social:aiSend',
    (_e, fromAiId: unknown, text: unknown, toAiId?: unknown) => {
      if (typeof fromAiId !== 'number' || typeof text !== 'string') return { ok: false, error: '参数不合法' }
      return withAiSocial((s) =>
        s.sendFromAi(fromAiId, text, typeof toAiId === 'number' ? toAiId : undefined)
      )
    },
    { ok: false, error: '发送失败' }
  )
}