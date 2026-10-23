/**
 * @category 工具
 * @summary 多实例聊天室功能 IPC 注册（L2，LAN 直连；未启动时返回 unready）
 * 为什么存在：聊天室 UI 需经 IPC 访问房间操作，且 LAN 未启动时应明确返回 unready 而非静默出错。
 */
import type { ipcMain as ipcMainType } from 'electron'
import { safeHandle } from '../../ipc/handlers/safe-handle'
import type { ChatRoomService } from '../chat-rooms/chat-room-service'

/** 聊天室域所需上下文：以 getter 形式注入 MultiInstanceService 私有状态 */
export interface ChatRoomIpcCtx {
  getChatRooms(): ChatRoomService | null
}

/** 注册聊天室功能 IPC 通道（16 个 chat-room:*） */
export function registerChatRoomIpc(ipc: typeof ipcMainType, ctx: ChatRoomIpcCtx): void {
  // ===== 聊天室功能（L2，LAN 直连；未启动时返回 unready） =====
  const withChatRooms = <T>(fn: (g: ChatRoomService) => T): T | { ok: false; error: string } => {
    const chatRooms = ctx.getChatRooms()
    if (!chatRooms) return { ok: false, error: '局域网协作未启动' }
    try {
      return fn(chatRooms)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  safeHandle(
    ipc, 'chat-room:list',
    () => withChatRooms((g) => ({ ok: true as const, list: g.list() })),
    { ok: false, error: '读取聊天室列表失败' }
  )
  safeHandle(
    ipc, 'chat-room:search',
    (_e, keyword: unknown, gid?: unknown, limit?: unknown) => {
      if (typeof keyword !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => {
        const res = g.search(keyword, typeof gid === 'string' ? gid : undefined, typeof limit === 'number' ? limit : undefined)
        return { ok: true as const, rooms: res.rooms, messages: res.messages }
      })
    },
    { ok: false, error: '搜索聊天室失败' }
  )
  safeHandle(
    ipc, 'chat-room:detail',
    (_e, gid: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => ({ ok: true as const, detail: g.detail(gid) }))
    },
    { ok: false, error: '读取聊天室详情失败' }
  )
  safeHandle(
    ipc, 'chat-room:create',
    (_e, name: unknown, desc?: unknown) => {
      if (typeof name !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.create(name, typeof desc === 'string' ? desc : undefined))
    },
    { ok: false, error: '创建聊天室失败' }
  )
  safeHandle(
    ipc, 'chat-room:invite',
    (_e, gid: unknown, uid: unknown) => {
      if (typeof gid !== 'string' || typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.invite(gid, uid))
    },
    { ok: false, error: '邀请失败' }
  )
  safeHandle(
    ipc, 'chat-room:acceptInvite',
    (_e, gid: unknown, ownerUid?: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.acceptInvite(gid, typeof ownerUid === 'number' ? ownerUid : undefined))
    },
    { ok: false, error: '接受邀请失败' }
  )
  safeHandle(
    ipc, 'chat-room:leave',
    (_e, gid: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.leave(gid))
    },
    { ok: false, error: '离开聊天室失败' }
  )
  safeHandle(
    ipc, 'chat-room:kick',
    (_e, gid: unknown, uid: unknown) => {
      if (typeof gid !== 'string' || typeof uid !== 'number') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.kick(gid, uid))
    },
    { ok: false, error: '踢人失败' }
  )
  safeHandle(
    ipc, 'chat-room:disband',
    (_e, gid: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.disband(gid))
    },
    { ok: false, error: '解散聊天室失败' }
  )
  safeHandle(
    ipc, 'chat-room:update',
    (_e, gid: unknown, patch: unknown) => {
      if (typeof gid !== 'string' || typeof patch !== 'object' || patch === null) {
        return { ok: false, error: '参数不合法' }
      }
      const p = patch as { name?: unknown; desc?: unknown }
      return withChatRooms((g) => g.update(gid, {
        name: typeof p.name === 'string' ? p.name : undefined,
        desc: typeof p.desc === 'string' ? p.desc : undefined
      }))
    },
    { ok: false, error: '更新聊天室信息失败' }
  )
  safeHandle(
    ipc, 'chat-room:messages',
    (_e, gid: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => ({ ok: true as const, messages: g.messages(gid) }))
    },
    { ok: false, error: '读取聊天室消息失败' }
  )
  safeHandle(
    ipc, 'chat-room:sendMessage',
    (_e, gid: unknown, text: unknown, aiId?: unknown) => {
      if (typeof gid !== 'string' || typeof text !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.sendMessage(gid, text, undefined, typeof aiId === 'number' ? aiId : undefined))
    },
    { ok: false, error: '发送聊天室消息失败' }
  )
  safeHandle(
    ipc, 'chat-room:addAiSpeaker',
    (_e, gid: unknown, name?: unknown, aiId?: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      // ：name 可选——装配层注入注册表档案后，名称以档案为准；缺省/空串也行
      return withChatRooms((g) => g.addAiSpeaker(gid, typeof name === 'string' ? name : '', typeof aiId === 'number' ? aiId : undefined))
    },
    { ok: false, error: '添加 AI 发言身份失败' }
  )
  safeHandle(
    ipc, 'chat-room:removeAiSpeaker',
    (_e, gid: unknown, aiIdentity: unknown) => {
      if (typeof gid !== 'string' || typeof aiIdentity !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.removeAiSpeaker(gid, aiIdentity))
    },
    { ok: false, error: '移除 AI 发言身份失败' }
  )
  safeHandle(
    ipc, 'chat-room:listInvites',
    () => withChatRooms((g) => ({ ok: true as const, list: g.listInvites() })),
    { ok: false, error: '读取邀请失败' }
  )
  safeHandle(
    ipc, 'chat-room:declineInvite',
    (_e, gid: unknown) => {
      if (typeof gid !== 'string') return { ok: false, error: '参数不合法' }
      return withChatRooms((g) => g.declineInvite(gid))
    },
    { ok: false, error: '忽略邀请失败' }
  )
}