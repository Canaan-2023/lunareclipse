/**
 * 社交 preload 域（好友/聊天室/AI 代理/发布板）。
 * 为什么存在：社交网络依托 LAN 直连与多实例 P2P 通道，连接状态与消息由主进程持有，前端
 * 聊天 UI 只能经桥订阅与发送。
 * 作用：暴露 friend* / chatRoom* / aiSocial* / publishBoard* 系列 IPC 方法与事件订阅。
 */
import { ipcRenderer } from 'electron'
import type { ChatRoomListItem, ChatRoomInfo, ChatRoomMessage } from '../../main/multi-instance/chat-rooms/chat-room-types'
import type { PendingInvite } from '../../main/multi-instance/chat-rooms/pending-invite-store'
import type { PublishBoard, PublishArticle, PublishListItem, PublishComment, PublishEvent } from '../../main/multi-instance/publish-board/publish-board-types'
import type { AiSocialContact, AiSocialChatListItem, AiChatMessage, AiSocialChatEvent } from '../../main/multi-instance/ai-social/ai-social-types'
import type { RelayEvent, RelayListItem } from '../../main/multi-instance/relay/relay-types'

export const api = {
  // ===== 好友系统（L1，局域网直连） =====
  friendList: () =>
    ipcRenderer.invoke('friend:list') as Promise<{
      ok: boolean
      error?: string
      list?: Array<{
        uid: number
        昵称: string
        备注?: string
        分组: string
        status: 'friend' | 'blocked' | 'pending'
        online: boolean
        lastMessage: string | null
        lastTs: number | null
        unread: number
      }>
    }>,
  friendCandidates: () =>
    ipcRenderer.invoke('friend:candidates') as Promise<{
      ok: boolean
      error?: string
      candidates?: Array<{ uid: number; 用户名: string; online: boolean }>
    }>,
  friendSearch: (keyword: string, uid?: number, limit?: number) =>
    ipcRenderer.invoke('friend:search', keyword, uid, limit) as Promise<{
      ok: boolean
      error?: string
      contacts?: Array<{ uid: number; 昵称: string; 备注?: string; 分组: string; status: 'friend' | 'blocked' | 'pending'; online: boolean; lastMessage: string | null; lastTs: number | null; unread: number }>
      messages?: Array<{ uid: number; message: { id: string; from: number; to: number; text: string; ts: number; read: boolean; isAiGenerated?: boolean } }>
    }>,
  friendRequest: (uid: number, note?: string) =>
    ipcRenderer.invoke('friend:request', uid, note) as Promise<{ ok: boolean; error?: string }>,
  friendAccept: (uid: number) =>
    ipcRenderer.invoke('friend:accept', uid) as Promise<{ ok: boolean; error?: string }>,
  friendReject: (uid: number) =>
    ipcRenderer.invoke('friend:reject', uid) as Promise<{ ok: boolean; error?: string }>,
  friendBlock: (uid: number) =>
    ipcRenderer.invoke('friend:block', uid) as Promise<{ ok: boolean; error?: string }>,
  friendUnblock: (uid: number) =>
    ipcRenderer.invoke('friend:unblock', uid) as Promise<{ ok: boolean; error?: string }>,
  friendRemove: (uid: number) =>
    ipcRenderer.invoke('friend:remove', uid) as Promise<{ ok: boolean; error?: string }>,
  friendUpdate: (uid: number, patch: { 备注?: string; 分组?: string }) =>
    ipcRenderer.invoke('friend:update', uid, patch) as Promise<{ ok: boolean; error?: string }>,
  friendMessages: (uid: number) =>
    ipcRenderer.invoke('friend:messages', uid) as Promise<{
      ok: boolean
      error?: string
      messages?: Array<{ id: string; from: number; to: number; text: string; ts: number; read: boolean; isAiGenerated?: boolean }>
    }>,
  friendMarkRead: (uid: number) =>
    ipcRenderer.invoke('friend:markRead', uid) as Promise<{ ok: boolean; error?: string }>,
  friendSendMessage: (uid: number, text: string) =>
    ipcRenderer.invoke('friend:sendMessage', uid, text) as Promise<{ ok: boolean; mode?: string; error?: string }>,
  // ===== 好友邀请制文件/文件夹传输（发送方只发邀请信封；接收方同意后发送方推流） =====
  friendInviteFile: (uid: number, mode: 'file' | 'dir') =>
    ipcRenderer.invoke('friend:inviteFile', uid, mode) as Promise<{
      ok: boolean
      canceled?: boolean
      error?: string
      transferId?: string
    }>,
  friendAcceptFileInvite: (uid: number, transferId: string) =>
    ipcRenderer.invoke('friend:acceptFileInvite', uid, transferId) as Promise<{ ok: boolean; error?: string }>,
  friendRejectFileInvite: (uid: number, transferId: string) =>
    ipcRenderer.invoke('friend:rejectFileInvite', uid, transferId) as Promise<{ ok: boolean; error?: string }>,
  friendCancelFileInvite: (uid: number, transferId: string) =>
    ipcRenderer.invoke('friend:cancelFileInvite', uid, transferId) as Promise<{ ok: boolean; error?: string }>,
  friendSwitchToRelay: (uid: number, transferId: string) =>
    ipcRenderer.invoke('friend:switchToRelay', uid, transferId) as Promise<{ ok: boolean; error?: string }>,
  friendOpenFileLocation: (uid: number, transferId: string) =>
    ipcRenderer.invoke('friend:openFileLocation', uid, transferId) as Promise<{ ok: boolean; error?: string }>,
  onFriendEvent: (callback: (event: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown) => callback(event)
    ipcRenderer.on('friend:event', handler)
    return () => void ipcRenderer.removeListener('friend:event', handler)
  },

  // ===== AI 社交（好友面板「我的 AI」+ AI 私聊会话） =====
  aiSocialContacts: () => ipcRenderer.invoke('ai-social:contacts') as Promise<{ ok: boolean; contacts?: AiSocialContact[]; error?: string }>,
  aiSocialChats: () => ipcRenderer.invoke('ai-social:chats') as Promise<{ ok: boolean; list?: AiSocialChatListItem[]; error?: string }>,
  aiSocialMessages: (aiId: number) => ipcRenderer.invoke('ai-social:messages', aiId) as Promise<{ ok: boolean; messages?: AiChatMessage[]; error?: string }>,
  aiSocialMarkRead: (aiId: number) => ipcRenderer.invoke('ai-social:markRead', aiId) as Promise<{ ok: boolean; error?: string }>,
  aiSocialSend: (aiId: number, text: string) => ipcRenderer.invoke('ai-social:send', aiId, text) as Promise<{ ok: boolean; message?: AiChatMessage; error?: string }>,
  aiSocialAiSend: (fromAiId: number, text: string, toAiId?: number) =>
    ipcRenderer.invoke('ai-social:aiSend', fromAiId, text, toAiId) as Promise<{ ok: boolean; message?: AiChatMessage; error?: string }>,
  onAiSocialEvent: (callback: (event: AiSocialChatEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: AiSocialChatEvent) => callback(event)
    ipcRenderer.on('ai-social:event', handler)
    return () => void ipcRenderer.removeListener('ai-social:event', handler)
  },

  // ===== 聊天室功能（L2）=====
  chatRoomList: () => ipcRenderer.invoke('chat-room:list') as Promise<{ ok: boolean; list?: ChatRoomListItem[]; error?: string }>,
  chatRoomSearch: (keyword: string, gid?: string, limit?: number) =>
    ipcRenderer.invoke('chat-room:search', keyword, gid, limit) as Promise<{
      ok: boolean
      error?: string
      rooms?: ChatRoomListItem[]
      messages?: Array<{ gid: string; message: ChatRoomMessage }>
    }>,
  chatRoomDetail: (gid: string) => ipcRenderer.invoke('chat-room:detail', gid) as Promise<{ ok: boolean; detail?: ChatRoomInfo | null; error?: string }>,
  chatRoomCreate: (name: string, desc?: string) => ipcRenderer.invoke('chat-room:create', name, desc) as Promise<{ ok: boolean; gid?: string; error?: string }>,
  chatRoomInvite: (gid: string, uid: number) => ipcRenderer.invoke('chat-room:invite', gid, uid) as Promise<{ ok: boolean; error?: string }>,
  chatRoomAcceptInvite: (gid: string, ownerUid?: number) => ipcRenderer.invoke('chat-room:acceptInvite', gid, ownerUid) as Promise<{ ok: boolean; error?: string }>,
  chatRoomLeave: (gid: string) => ipcRenderer.invoke('chat-room:leave', gid) as Promise<{ ok: boolean; error?: string }>,
  chatRoomKick: (gid: string, uid: number) => ipcRenderer.invoke('chat-room:kick', gid, uid) as Promise<{ ok: boolean; error?: string }>,
  chatRoomDisband: (gid: string) => ipcRenderer.invoke('chat-room:disband', gid) as Promise<{ ok: boolean; error?: string }>,
  chatRoomUpdate: (gid: string, patch: { name?: string; desc?: string }) => ipcRenderer.invoke('chat-room:update', gid, patch) as Promise<{ ok: boolean; error?: string }>,
  chatRoomMessages: (gid: string) => ipcRenderer.invoke('chat-room:messages', gid) as Promise<{ ok: boolean; messages?: ChatRoomMessage[]; error?: string }>,
  chatRoomSendMessage: (gid: string, text: string, aiId?: number) => ipcRenderer.invoke('chat-room:sendMessage', gid, text, aiId) as Promise<{ ok: boolean; mode?: string; error?: string }>,
  chatRoomAddAiSpeaker: (gid: string, name?: string, aiId?: number) => ipcRenderer.invoke('chat-room:addAiSpeaker', gid, name, aiId) as Promise<{ ok: boolean; aiId?: number; name?: string; avatar?: string; error?: string }>,
  chatRoomRemoveAiSpeaker: (gid: string, aiIdentity: string) => ipcRenderer.invoke('chat-room:removeAiSpeaker', gid, aiIdentity) as Promise<{ ok: boolean; error?: string }>,
  chatRoomListInvites: () => ipcRenderer.invoke('chat-room:listInvites') as Promise<{ ok: boolean; list?: PendingInvite[]; error?: string }>,
  chatRoomDeclineInvite: (gid: string) => ipcRenderer.invoke('chat-room:declineInvite', gid) as Promise<{ ok: boolean; error?: string }>,
  onChatRoomEvent: (callback: (event: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: unknown) => callback(event)
    ipcRenderer.on('chat-room:event', handler)
    return () => void ipcRenderer.removeListener('chat-room:event', handler)
  },

  // ===== AI 代理配置 =====
  aiAgentSetGlobal: (enabled: boolean) => ipcRenderer.invoke('ai-agent:setGlobal', enabled) as Promise<{ ok: boolean; error?: string }>,
  aiAgentGetGlobal: () => ipcRenderer.invoke('ai-agent:getGlobal') as Promise<{ ok: boolean; enabled?: boolean; error?: string }>,
  aiAgentSetChatRoom: (gid: string, enabled: boolean) => ipcRenderer.invoke('ai-agent:setChatRoom', gid, enabled) as Promise<{ ok: boolean; error?: string }>,
  aiAgentGetChatRoom: (gid: string) => ipcRenderer.invoke('ai-agent:getChatRoom', gid) as Promise<{ ok: boolean; enabled?: boolean; error?: string }>,
  aiAgentSetDirectChat: (peerUid: number, enabled: boolean) => ipcRenderer.invoke('ai-agent:setDirectChat', peerUid, enabled) as Promise<{ ok: boolean; error?: string }>,
  aiAgentGetDirectChat: (peerUid: number) => ipcRenderer.invoke('ai-agent:getDirectChat', peerUid) as Promise<{ ok: boolean; enabled?: boolean; error?: string }>,
  aiAgentSetProactive: (enabled: boolean) => ipcRenderer.invoke('ai-agent:setProactive', enabled) as Promise<{ ok: boolean; error?: string }>,
  aiAgentGetProactive: () => ipcRenderer.invoke('ai-agent:getProactive') as Promise<{ ok: boolean; enabled?: boolean; intervalMs?: number; error?: string }>,

  // ===== 内部发布板（L3）=====
  publishBoardListBoards: () => ipcRenderer.invoke('publish-board:listBoards') as Promise<{ ok: boolean; list?: PublishBoard[]; error?: string }>,
  publishBoardCreateBoard: (name: string, desc?: string) => ipcRenderer.invoke('publish-board:createBoard', name, desc) as Promise<{ ok: boolean; board?: PublishBoard; error?: string }>,
  publishBoardDeleteBoard: (boardId: string) => ipcRenderer.invoke('publish-board:deleteBoard', boardId) as Promise<{ ok: boolean; error?: string }>,
  publishBoardListArticles: (boardId?: string, limit?: number) => ipcRenderer.invoke('publish-board:listArticles', boardId, limit) as Promise<{ ok: boolean; list?: PublishListItem[]; total?: number; error?: string }>,
  publishBoardSearchArticles: (keyword: string, boardId?: string, limit?: number) => ipcRenderer.invoke('publish-board:searchArticles', keyword, boardId, limit) as Promise<{ ok: boolean; list?: PublishListItem[]; error?: string }>,
  publishBoardGetArticle: (boardId: string, articleId: string) => ipcRenderer.invoke('publish-board:getArticle', boardId, articleId) as Promise<{ ok: boolean; article?: PublishArticle; error?: string }>,
  publishBoardPublish: (boardId: string, title: string, summary: string, body: string, aiId?: number) => ipcRenderer.invoke('publish-board:publish', boardId, title, summary, body, aiId) as Promise<{ ok: boolean; article?: PublishArticle; error?: string }>,
  publishBoardDeleteArticle: (boardId: string, articleId: string) => ipcRenderer.invoke('publish-board:deleteArticle', boardId, articleId) as Promise<{ ok: boolean; error?: string }>,
  publishBoardUpdateArticle: (boardId: string, articleId: string, patch: { title?: string; summary?: string; body?: string; pinned?: boolean }) =>
    ipcRenderer.invoke('publish-board:updateArticle', boardId, articleId, patch) as Promise<{ ok: boolean; article?: PublishArticle; error?: string }>,
  publishBoardTogglePin: (boardId: string, articleId: string) => ipcRenderer.invoke('publish-board:togglePin', boardId, articleId) as Promise<{ ok: boolean; error?: string }>,
  publishBoardListComments: (articleId: string, limit?: number) => ipcRenderer.invoke('publish-board:listComments', articleId, limit) as Promise<{ ok: boolean; list?: PublishComment[]; error?: string }>,
  publishBoardPostComment: (articleId: string, text: string, replyTo?: string, aiId?: number) => ipcRenderer.invoke('publish-board:postComment', articleId, text, replyTo, aiId) as Promise<{ ok: boolean; comment?: PublishComment; error?: string }>,
  publishBoardRequestSync: () => ipcRenderer.invoke('publish-board:requestSync') as Promise<{ ok: boolean; error?: string }>,
  onPublishBoardEvent: (callback: (event: PublishEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: PublishEvent) => callback(event)
    ipcRenderer.on('publish-board:event', handler)
    return () => void ipcRenderer.removeListener('publish-board:event', handler)
  },

  // ===== 中继异步传输（L1.5 主系统中继大云盘）=====
  relayList: () =>
    ipcRenderer.invoke('relay:list') as Promise<{
      ok: boolean
      error?: string
      list?: RelayListItem[]
      info?: { isHub: boolean; downloadDir: string; retentionDays: number }
    }>,
  relayPickAndUpload: (receiverUid: number, mode: 'file' | 'dir') =>
    ipcRenderer.invoke('relay:pickAndUpload', receiverUid, mode) as Promise<{
      ok: boolean
      error?: string
      canceled?: boolean
      itemId?: string
      name?: string
      kind?: 'file' | 'dir'
      totalBytes?: number
      files?: number
      dirs?: number
    }>,
  relayConfirm: (itemId: string) => ipcRenderer.invoke('relay:confirm', itemId) as Promise<{ ok: boolean; error?: string }>,
  relayRevoke: (itemId: string) => ipcRenderer.invoke('relay:revoke', itemId) as Promise<{ ok: boolean; error?: string }>,
  relayInfo: () =>
    ipcRenderer.invoke('relay:info') as Promise<{
      ok: boolean
      error?: string
      info?: { isHub: boolean; downloadDir: string; retentionDays: number }
    }>,
  onRelayEvent: (callback: (event: RelayEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, event: RelayEvent) => callback(event)
    ipcRenderer.on('relay:event', handler)
    return () => void ipcRenderer.removeListener('relay:event', handler)
  },
}