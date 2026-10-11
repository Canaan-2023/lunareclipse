/**
 * 为什么存在：莉莉丝窗口开合涉及主会话快照/恢复语义（只翻标志会导致会话"丢失"
 * 假象），独立 slice 承载这份状态机修复逻辑。
 * @category 前端状态
 * @summary appStore 的 lilith 域 slice：莉莉丝聊天窗的打开/关闭。
 * 关键语义：openLilithChat 把当前主会话快照到 wsRuntime.lilithPrevSession 并切走，
 * closeLilithChat 恢复切走前的会话（原实现只翻标志 → 聊天区永久空壳，用户以为会话丢了）。
 * 对应 AppState 中 lilithChatOpen 字段与 open/close actions。
 */
import type { AppState } from '../appStore-types'
import {
  SESSION_RESET_FIELDS,
  wsRuntime,
  type SliceSet,
  type SliceGet
} from './appStore-shared'

export type LilithSlice = Pick<AppState, 'lilithChatOpen' | 'openLilithChat' | 'closeLilithChat'>

export function createLilithSlice(set: SliceSet, get: SliceGet): LilithSlice {
  return {
    lilithChatOpen: false,

    /**
     * 打开莉莉丝聊天窗：快照当前会话上下文到 wsRuntime.lilithPrevSession，
     * 并按 SESSION_RESET_FIELDS 清空会话残留，进入莉莉丝专属空上下文。
     */
    openLilithChat: () => {
      const s = get()
      wsRuntime.lilithPrevSession = { sessionId: s.currentSessionId, messages: s.currentMessages }
      set({
        lilithChatOpen: true,
        currentSessionId: null,
        currentMessages: [],
        status: 'idle',
        streamingMessageId: null,
        errorMessage: null,
        ...SESSION_RESET_FIELDS
      })
    },

    closeLilithChat: () => {
      const s = get()
      set({
        lilithChatOpen: false,
        // 恢复切走前的会话（原实现只翻标志 → 聊天区永久空壳，用户以为会话丢了）
        currentSessionId: wsRuntime.lilithPrevSession?.sessionId ?? s.currentSessionId,
        currentMessages: wsRuntime.lilithPrevSession?.messages ?? s.currentMessages
      })
      wsRuntime.lilithPrevSession = null
    }
  }
}