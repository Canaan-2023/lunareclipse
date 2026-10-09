/**
 * 为什么存在：多开实例成员需要一个跨实例共享的群聊空间，且消息信封经 LanService 直连而不经过主系统，需要独立业务服务。
 * 作用：聊天室业务门面：聚合房间/消息/邀请三个存储，封装创建加入退出、成员管理、消息收发、邀请流转与事件派发。
 */

import { randomUUID } from 'crypto'
import type { LanEnvelope, LanPeer, LanPeerStatusEvent } from '../lan/lan-types'
import { MAIN_AI_ID, parseIdentity } from '../lan/lan-types'
import type { LanSendResult } from '../lan/lan-service'
import { ChatRoomStore } from './chat-room-store'
import { ChatRoomChatStore } from './chat-room-chat-store'
import { PendingInviteStore, type PendingInvite } from './pending-invite-store'
import type {
  ChatRoomAiSpeaker,
  ChatRoomEvent,
  ChatRoomInfo,
  ChatRoomInvitePayload,
  ChatRoomListItem,
  ChatRoomMember,
  ChatRoomMemberChangePayload,
  ChatRoomMessage,
  ChatRoomMessagePayload,
} from './chat-room-types'
import { SYSTEM_ROOM_GID } from './chat-room-types'

/**
 * 聊天室功能（L2）业务门面：聊天室 + 聊天室消息，基于 L0 局域网底座。
 * - 创建聊天室/邀请/加入/离开/踢人/解散全部经局域网信封直连（chat-room.* 前缀）
 * - 聊天室消息消息：向所有在线成员逐个发送；离线成员由 L0 outbox 自动补投
 * - 聊天室信息存储：chat-rooms/{gid}.json（室主维护权威副本，成员各持本地副本）
 * - 聊天室消息存储：chat-rooms/{gid}/messages.json（整文件原子覆写，上限 2000 条）
 * - 前端事件：ChatRoomEvent 经 webContents 推送（由装配层注入 emit）

 * 全员频道（SYSTEM_ROOM_GID）：
 * - isSystem 聊天室，所有局域网账号（roster 动态）自动加入，不可退出/解散/改名/邀请
 * - 真人成员不持久化（实时 = roster 全体）
 * - 消息广播目标 = roster 全体；接收校验 = 发送者 uid 在 roster 中
 */
export interface ChatRoomServiceDeps {
  /** 数据根目录（federation/ 挂其下） */
  root: string
  /** 待处理邀请存储（缺省按 root 自建，测试可注入） */
  pendingInvites?: PendingInviteStore
  /** 当前登录用户（未登录返回 null） */
  getIdentity: () => { uid: number; 用户名: string } | null
  /** 经 L0 直连发送信封（单播） */
  sendLan: (uid: number, type: string, payload: unknown) => LanSendResult
  /** 对端在线态 */
  listPeers: () => LanPeer[]
  /** 全体账号名单（roster；全员频道动态成员与消息广播目标） */
  listRoster?: () => LanPeer[]
  /** 事件推送（mainWindow.webContents.send('chat-room:event', event)） */
  emit: (event: ChatRoomEvent) => void
  /** AI 代理配置（聊天室级别开关查询） */
  aiConfig?: { isChatRoomEnabled(gid: string): boolean }
  /**
   * 注册表档案查询（AI 进场身份绑定）。返回该 aiId 在注册表（ai-registry.json）中的档案；
   * 找不到或已停用返回 null。装配层注入后，addAiSpeaker 强制要求 aiId 命中注册表，
   * 且名称/头像取档案值（防伪造 AI 身份进场，社交各入口身份一致）。
   * 未注入（旧调用/测试）时保留调用方自定义 name 的行为。
   */
  getAiProfile?: (aiId: number) => { uid: number; aiId: number; name: string; avatar?: string } | null
  /**
   * AI 回复生成器：本机拥有的 AI 发言身份收到真人消息后调用。
   * 返回回复文本（以该发言身份广播）或 null（不回复）。
   */
  aiReply?: (ai: ChatRoomAiSpeaker, room: ChatRoomInfo, msg: ChatRoomMessage) => Promise<string | null>
}

export class ChatRoomService {
  readonly chatRooms: ChatRoomStore
  readonly chats: ChatRoomChatStore
  readonly pendingInvites: PendingInviteStore

  constructor(private readonly deps: ChatRoomServiceDeps) {
    this.chatRooms = new ChatRoomStore(deps.root)
    this.chats = new ChatRoomChatStore(deps.root)
    this.pendingInvites = deps.pendingInvites ?? new PendingInviteStore(deps.root)
    this.ensureSystemRoom()
  }

  // ===== 全员频道 =====

  /** 确保全员频道存在（本机网络角色变为协作模式时调一次；幂等） */
  private ensureSystemRoom(): void {
    if (this.chatRooms.load(SYSTEM_ROOM_GID)) return
    const now = Date.now()
    const info: ChatRoomInfo = {
      gid: SYSTEM_ROOM_GID,
      name: '全员频道',
      desc: '局域网内所有账号自动加入的系统频道',
      ownerUid: 0,
      members: [],
      isSystem: true,
      createdAt: now,
      updatedAt: now,
    }
    this.chatRooms.save(info)
  }

  /** 当前局域网账号名单（roster；fallback peers） */
  private roster(): LanPeer[] {
    const r = this.deps.listRoster?.() ?? []
    return r.length > 0 ? r : this.deps.listPeers()
  }

  /** 聊天室成员判定：系统频道=任意局域网账号；普通聊天室=成员列表包含（AI 发言身份不计入真人成员） */
  private isMember(g: ChatRoomInfo, uid: number): boolean {
    if (g.isSystem) return this.roster().some((p) => p.uid === uid) || uid === this.deps.getIdentity()?.uid
    return g.members.some((m) => m.uid === uid && !m.isAi)
  }

  /** 聊天室消息广播目标 uid 集合：系统频道=roster 全体（除去自己）；普通=真人成员（除去自己；AI 发言身份无端点） */
  private broadcastTargets(g: ChatRoomInfo, selfUid: number): number[] {
    const uids = g.isSystem
      ? this.roster().map((p) => p.uid)
      : g.members.filter((m) => !m.isAi).map((m) => m.uid)
    return [...new Set(uids)].filter((uid) => uid !== selfUid && uid > 0)
  }

  /** 向真实账号发送信封：AI 发言身份的 uid 是属主 uid，但发言仍由属主代发，不经此路径 */
  private sendTo(uid: number, type: string, payload: unknown): LanSendResult {
    if (uid <= 0) return { ok: false, mode: 'outbox', error: '非法 uid' }
    return this.deps.sendLan(uid, type, payload)
  }

  /** 全员频道真人成员名（roster 用户名），消息 fromName 兜底用 */
  private rosterName(uid: number): string | undefined {
    return this.roster().find((p) => p.uid === uid)?.用户名
  }

  /** 权限校验：普通频道 owner/admin 判定 */
  private canManage(g: ChatRoomInfo, uid: number): boolean {
    const me = g.members.find((m) => m.uid === uid && !m.isAi)
    return !!me && (me.role === 'owner' || me.role === 'admin')
  }

  // ===== 局域网信封入口（L0 onMessage 转发） =====

  handleLanEnvelope(env: LanEnvelope): void {
    switch (env.type) {
      case 'chat-room.invite':
        this.handleInvite(env)
        break
      case 'chat-room.join':
        this.handleJoin(env)
        break
      case 'chat-room.leave':
        this.handleLeave(env)
        break
      case 'chat-room.kick':
        this.handleKick(env)
        break
      case 'chat-room.message':
        this.handleMessage(env)
        break
      case 'chat-room.sync':
        this.handleSync(env)
        break
      case 'chat-room.disband':
        this.handleDisband(env)
        break
      default:
        break
    }
  }

  /** 对端在线状态变化（聊天室成员在线徽标；系统频道成员动态=roster，一并刷新） */
  handlePeerStatus(ev: LanPeerStatusEvent): void {
    // 遍历所有聊天室，若该 peer 是成员则推送更新
    const uid = ev.peer.uid
    for (const g of this.chatRooms.listAll()) {
      if (g.isSystem || g.members.some((m) => m.uid === uid)) {
        this.deps.emit({ type: 'updated', gid: g.gid })
      }
    }
  }

  // ===== 聊天室操作 =====

  /** 创建聊天室：本机为室主，写入本地；不自动广播（邀请后才通知成员） */
  create(name: string, desc?: string): { ok: boolean; gid?: string; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const gid = randomUUID()
    const now = Date.now()
    const info: ChatRoomInfo = {
      gid,
      name: name.trim() || '未命名聊天室',
      desc,
      ownerUid: identity.uid,
      members: [{ uid: identity.uid, role: 'owner', joinedAt: now }],
      createdAt: now,
      updatedAt: now,
    }
    this.chatRooms.save(info)
    return { ok: true, gid }
  }

  /** 列出本机参与的所有聊天室，合并最近消息/未读/在线成员数。全员频道对 roster 全体可见，成员数动态计算 */
  list(): ChatRoomListItem[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    const items: ChatRoomListItem[] = []
    for (const g of this.chatRooms.listAll()) {
      const me = g.members.find((m) => m.uid === identity.uid && !m.isAi)
      const isSystemMember = g.isSystem && this.roster().some((p) => p.uid === identity.uid)
      if (!me && !isSystemMember) continue
      const msgs = this.chats.load(g.gid)
      const last = msgs.at(-1) ?? null
      // 简化未读：统计非己消息数。精确到「距上次已读位置」需引入 per-gid 已读游标，待后续优化
      const unread = msgs.filter((m) => m.from !== identity.uid).length
      items.push({
        gid: g.gid,
        name: g.name,
        desc: g.desc,
        ownerUid: g.ownerUid,
        myRole: me?.role ?? 'member',
        memberCount: g.isSystem ? this.roster().length : g.members.length,
        lastMessage: last?.text ?? null,
        lastTs: last?.ts ?? null,
        unread,
      })
    }
    return items.sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))
  }

  /** 聊天室详情（全员频道返回动态成员=roster 全体） */
  detail(gid: string): ChatRoomInfo | null {
    const identity = this.deps.getIdentity()
    if (!identity) return null
    const g = this.chatRooms.load(gid)
    if (!g) return null
    if (!this.isMember(g, identity.uid)) return null
    if (!g.isSystem) return g
    const rosterMembers = this.roster().map((p) => ({
      uid: p.uid,
      role: 'member' as const,
      joinedAt: g.createdAt,
    }))
    return { ...g, members: rosterMembers }
  }

  /**
   * 邀请成员：仅室主/管理员可发；向目标 UID 单播 invite 信封。
   * 全员频道为系统频道，所有账号自动加入，不支持邀请。
   */
  invite(gid: string, uid: number): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道无需邀请' }
    const me = g.members.find((m) => m.uid === identity.uid)
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      return { ok: false, error: '仅室主或管理员可邀请' }
    }
    if (g.members.some((m) => m.uid === uid)) return { ok: false, error: '已是成员' }
    this.sendTo(uid, 'chat-room.invite', {
      gid,
      chatRoomName: g.name,
      fromName: identity.用户名,
      ownerUid: g.ownerUid,
    } satisfies ChatRoomInvitePayload)
    return { ok: true }
  }

  /** 接受邀请：本地写入聊天室副本（member），向室主发 join 信封同步。全员频道自动加入，无需接受 */
  acceptInvite(gid: string, ownerUid?: number): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const existing = this.chatRooms.load(gid)
    if (existing?.isSystem) return { ok: false, error: '全员频道无需接受邀请' }
    if (existing?.members.some((m) => m.uid === identity.uid && !m.isAi)) {
      return { ok: false, error: '已在聊天室中' }
    }
    // 曾加入过但已离开时本地仍残留旧副本（含旧室主/旧成员），不能直接复用：
    // 用邀请携带的室主重建空壳，确保 join 发给当前室主；旧成员列表随 sync 覆盖
    const now = Date.now()
    const owner = ownerUid ?? existing?.ownerUid ?? 0
    const stub: ChatRoomInfo = {
      gid,
      name: existing?.name ?? '未知聊天室',
      ownerUid: owner,
      members: [{ uid: identity.uid, role: 'member', joinedAt: now }],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (!existing || existing.ownerUid !== owner) this.chatRooms.save(stub)
    // 向室主请求同步完整信息
    if (stub.ownerUid > 0 && stub.ownerUid !== identity.uid) {
      this.sendTo(stub.ownerUid, 'chat-room.join', { gid, uid: identity.uid } satisfies { gid: string; uid: number })
    }
    // 已接受：从待处理邀请中移除，重启后不再出现
    this.pendingInvites.remove(gid)
    return { ok: true }
  }

  /** 待处理邀请列表（入站 invite 落盘，重启后仍可见） */
  listInvites(): PendingInvite[] {
    return this.pendingInvites.list()
  }

  /** 忽略邀请：仅从待处理列表移除，不进入聊天室 */
  declineInvite(gid: string): { ok: boolean; error?: string } {
    if (!gid) return { ok: false, error: '参数不合法' }
    this.pendingInvites.remove(gid)
    return { ok: true }
  }

  /** 离开聊天室：本机移除成员；向室主发 leave。全员频道不可退出 */
  leave(gid: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道不可退出' }
    const idx = g.members.findIndex((m) => m.uid === identity.uid && !m.isAi)
    if (idx < 0) return { ok: false, error: '不在聊天室中' }
    const wasOwner = g.members[idx].role === 'owner'
    g.members.splice(idx, 1)
    // 真人成员全走光（只剩 AI 发言身份）时聊天室随之解散
    const humans = g.members.filter((m) => !m.isAi)
    if (humans.length === 0) {
      this.chatRooms.delete(gid)
      return { ok: true }
    }
    if (wasOwner) {
      // 室主离开：顺延第一个真人成员为新室主
      humans[0].role = 'owner'
      g.ownerUid = humans[0].uid
    }
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    this.sendTo(g.ownerUid, 'chat-room.leave', {
      gid,
      uid: identity.uid,
      action: 'leave',
      actorUid: identity.uid,
    } satisfies ChatRoomMemberChangePayload)
    this.deps.emit({ type: 'member-change', gid, uid: identity.uid, action: 'leave', actorUid: identity.uid })
    return { ok: true }
  }

  /** 踢人：仅室主/管理员。全员频道不可踢（真人成员由 roster 动态计算） */
  kick(gid: string, uid: number): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道不可移除成员' }
    const me = g.members.find((m) => m.uid === identity.uid && !m.isAi)
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      return { ok: false, error: '仅室主或管理员可踢人' }
    }
    const idx = g.members.findIndex((m) => m.uid === uid && !m.isAi)
    if (idx < 0) return { ok: false, error: '成员不在聊天室中' }
    g.members.splice(idx, 1)
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    // 通知被踢者
    this.sendTo(uid, 'chat-room.kick', {
      gid,
      uid,
      action: 'kick',
      actorUid: identity.uid,
    } satisfies ChatRoomMemberChangePayload)
    // 通知其余真人成员
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.kick', {
          gid,
          uid,
          action: 'kick',
          actorUid: identity.uid,
        } satisfies ChatRoomMemberChangePayload)
      }
    }
    this.deps.emit({ type: 'member-change', gid, uid, action: 'kick', actorUid: identity.uid })
    return { ok: true }
  }

  /** 解散聊天室：仅室主。全员频道不可解散 */
  disband(gid: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道不可解散' }
    if (g.ownerUid !== identity.uid) return { ok: false, error: '仅室主可解散' }
    this.chatRooms.delete(gid)
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.disband', { gid })
      }
    }
    this.deps.emit({ type: 'updated', gid })
    return { ok: true }
  }

  /** 更新聊天室信息：仅室主/管理员。全员频道不可改名/改简介 */
  update(gid: string, patch: { name?: string; desc?: string }): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道不可修改' }
    const me = g.members.find((m) => m.uid === identity.uid && !m.isAi)
    if (!me || (me.role !== 'owner' && me.role !== 'admin')) {
      return { ok: false, error: '仅室主或管理员可修改' }
    }
    if (patch.name !== undefined) g.name = patch.name.trim() || g.name
    if (patch.desc !== undefined) g.desc = patch.desc
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    // 广播 sync 给所有真人成员
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.sync', g)
      }
    }
    this.deps.emit({ type: 'updated', gid })
    return { ok: true }
  }

  // ===== AI 发言身份（房间成员可让自己的 AI 进场） =====

  /** 当前聊天室内 AI 发言身份集合（判定是否已存在同名 AI） */
  private aiSpeakers(g: ChatRoomInfo): ChatRoomMember[] {
    return g.members.filter((m) => m.isAi)
  }

  /**
   * 添加 AI 发言身份：让本机某个已存在的 AI 实体（aiId，默认 1=月蚀主 AI，
   * 其余编号见 ai-registry.json 顺延）以室内名字 aiName 加入本室。
   * 身份对外表示为 `UID-AIID`，同一 uid 的不同 AI 可同室共存。
   * 房间内任何成员都可添加「自己属主」的 AI（跨实例协作要求每个实例都能让自己的 AI 进场）。
   * 全员频道不落盘真人成员、动态 = roster，不支持 AI 发言身份（防伪造/避免注入）。
   * ：装配层注入 getAiProfile 后，aiId 必须命中注册表（未停用）且名称/头像取档案值；
   * 未注入时保留调用方自定义 name 的兼容行为（测试/旧调用）。
   */
  addAiSpeaker(gid: string, name: string, aiId: number = MAIN_AI_ID): {
    ok: boolean
    aiId?: number
    name?: string
    avatar?: string
    error?: string
  } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道不支持 AI 发言身份' }
    if (!g.members.some((m) => m.uid === identity.uid && !m.isAi)) {
      return { ok: false, error: '不在聊天室中' }
    }
    if (!Number.isInteger(aiId) || aiId <= 0) return { ok: false, error: 'AI 编号不合法' }
    // ：注册表档案绑定——名称/头像以档案为准，防伪造 AI 身份进场
    let aiName = (name ?? '').trim()
    let aiAvatar: string | undefined
    const profile = this.deps.getAiProfile?.(aiId)
    if (this.deps.getAiProfile) {
      if (!profile) return { ok: false, error: `AI 不存在或已停用（aiId=${aiId}）` }
      aiName = profile.name
      aiAvatar = profile.avatar
    }
    if (!aiName) return { ok: false, error: 'AI 名称不能为空' }
    if (this.aiSpeaker(g, identity.uid, aiId)) return { ok: false, error: '该 AI 已在聊天室中' }
    if (this.aiSpeakers(g).some((m) => m.aiName === aiName)) return { ok: false, error: '同名 AI 已存在' }
    g.members.push({
      uid: identity.uid,
      role: 'member',
      joinedAt: Date.now(),
      isAi: true,
      aiId,
      aiName,
      ...(aiAvatar !== undefined ? { aiAvatar } : {})
    })
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    // 广播给真人成员（非 AI），让对端副本也拥有该 AI 发言身份
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.sync', g)
      }
    }
    this.deps.emit({ type: 'updated', gid })
    return { ok: true, aiId, name: aiName, ...(aiAvatar !== undefined ? { avatar: aiAvatar } : {}) }
  }

  /**
   * 移除 AI 发言身份（aiIdentity = `UID-AIID`）：仅 AI 属主本人或室主。全员频道不支持。
   * 移除后本机副本不再含该 AI；广播 sync 让对端一并移除。
   */
  removeAiSpeaker(gid: string, aiIdentity: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (g.isSystem) return { ok: false, error: '全员频道不支持 AI 发言身份' }
    const parsed = parseIdentity(aiIdentity)
    if (!parsed || parsed.aiId === undefined) return { ok: false, error: 'AI 身份格式应为 UID-AIID' }
    const idx = g.members.findIndex((m) => m.isAi && m.uid === parsed.uid && m.aiId === parsed.aiId)
    if (idx < 0) return { ok: false, error: 'AI 发言身份不存在' }
    const ai = g.members[idx]
    const isOwner = g.ownerUid === identity.uid
    const isAiOwner = ai.uid === identity.uid
    if (!isOwner && !isAiOwner) return { ok: false, error: '仅 AI 属主或室主可移除' }
    g.members.splice(idx, 1)
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.sync', g)
      }
    }
    this.deps.emit({ type: 'updated', gid })
    return { ok: true }
  }

  /** 聊天室内指定 AI 发言身份（uid + aiId 唯一，无则 null） */
  private aiSpeaker(g: ChatRoomInfo, uid: number, aiId: number): ChatRoomMember | undefined {
    return g.members.find((m) => m.isAi && m.uid === uid && m.aiId === aiId)
  }

  // ===== 聊天室消息 =====

  /** 拉取聊天室消息（仅成员可见） */
  messages(gid: string): ChatRoomMessage[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    const g = this.chatRooms.load(gid)
    if (!g || !this.isMember(g, identity.uid)) return []
    return this.chats.load(gid)
  }

  /**
   * 关键词搜索（本地全量，不外发）：
   * - gid 指定：只搜该聊天室的消息；
   * - gid 省略：搜聊天室名/简介 + 全部所在聊天室的消息。
   * 两类结果各按 limit 截断（默认 50，硬上限 200），避免全量注入撑爆上下文。
   */
  search(keyword: string, gid?: string, limit = 50): {
    rooms: ChatRoomListItem[]
    messages: Array<{ gid: string; message: ChatRoomMessage }>
  } {
    const identity = this.deps.getIdentity()
    if (!identity) return { rooms: [], messages: [] }
    const kw = keyword.trim().toLowerCase()
    if (!kw) return { rooms: [], messages: [] }
    const max = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50
    const rooms: ChatRoomListItem[] = []
    const messages: Array<{ gid: string; message: ChatRoomMessage }> = []
    for (const item of this.list()) {
      if (gid !== undefined && item.gid !== gid) continue
      if (item.name.toLowerCase().includes(kw) || (item.desc ?? '').toLowerCase().includes(kw)) {
        rooms.push(item)
      }
      for (const m of this.chats.load(item.gid)) {
        if (m.text.toLowerCase().includes(kw)) messages.push({ gid: item.gid, message: m })
      }
    }
    return { rooms: rooms.slice(0, max), messages: messages.slice(-max) }
  }

  /** 发聊天室消息：向所有真人成员（含自己）单播；本机同步落盘。AI 发言身份由属主代发（isAi + aiId）。 */
  sendMessage(gid: string, text: string, isAiGenerated?: boolean, aiId?: number): { ok: boolean; mode?: string; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const g = this.chatRooms.load(gid)
    if (!g) return { ok: false, error: '聊天室不存在' }
    if (!this.isMember(g, identity.uid)) return { ok: false, error: '不在聊天室中' }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '消息为空' }
    // AI 发言身份发言：只能以「本机 uid 下已进场的 AI」名义；from 仍是属主 uid，另带 aiId
    let fromName = identity.用户名
    const isAi = typeof aiId === 'number'
    if (isAi) {
      const ai = this.aiSpeaker(g, identity.uid, aiId)
      if (!ai) return { ok: false, error: 'AI 发言身份不存在（只能是本机 uid 下已进场的 AI 编号）' }
      fromName = ai.aiName ?? fromName
    }
    const from = identity.uid
    const id = `${from}_${randomUUID()}`
    const message: ChatRoomMessage = {
      id,
      gid,
      from,
      text: trimmed,
      ts: Date.now(),
      fromName,
      isAiGenerated,
      isAi: isAi || undefined,
      aiId: isAi ? aiId : undefined,
    }
    this.chats.append(gid, message)
    const payload: ChatRoomMessagePayload = { id, gid, text: trimmed, fromName, isAiGenerated, isAi: isAi || undefined, aiId: isAi ? aiId : undefined }
    let lastMode = 'direct'
    for (const uid of this.broadcastTargets(g, from)) {
      const res = this.sendTo(uid, 'chat-room.message', payload)
      if (res.mode === 'outbox') lastMode = 'outbox'
    }
    this.deps.emit({ type: 'message', gid, message })
    // 触发 AI 自动回复：真人消息、以及 AI 发言身份消息都触发（同账号 AI 间可互聊）；
    // 仅 AI 自动回复（isAiGenerated）不触发级联（防死循环）。
    if (!isAiGenerated) {
      for (const ai of g.members) {
        if (ai.isAi) void this.maybeAiReply(g, message, ai)
      }
    }
    return { ok: true, mode: lastMode }
  }

  // ===== 信封处理（内部） =====

  private handleInvite(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as ChatRoomInvitePayload | undefined
    if (!payload?.gid) return
    // 已是成员则不再作为待处理邀请落盘（避免重复打扰）
    const existing = this.chatRooms.load(payload.gid)
    const alreadyMember = !!existing?.members.some((m) => m.uid === identity.uid)
    if (!alreadyMember) {
      this.pendingInvites.add({
        gid: payload.gid,
        chatRoomName: payload.chatRoomName ?? '',
        fromUid: env.from,
        fromName: payload.fromName ?? '',
        ownerUid: payload.ownerUid ?? 0,
        ts: env.ts ?? Date.now(),
      })
    }
    // 仅推送事件，由前端决定是否接受
    this.deps.emit({
      type: 'invite',
      gid: payload.gid,
      chatRoomName: payload.chatRoomName,
      fromUid: env.from,
      fromName: payload.fromName,
      ownerUid: payload.ownerUid ?? 0,
    })
  }

  private handleJoin(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as { gid: string; uid: number } | undefined
    if (!payload?.gid) return
    // join 必须声明自己的 uid，防止对端代他人入聊天室
    if (typeof payload.uid !== 'number' || payload.uid !== env.from) return
    const g = this.chatRooms.load(payload.gid)
    if (!g || g.ownerUid !== identity.uid) return
    if (g.members.some((m) => m.uid === payload.uid && !m.isAi)) return
    g.members.push({ uid: payload.uid, role: 'member', joinedAt: env.ts ?? Date.now() })
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    // 向全体真人成员广播完整聊天室信息：新成员补全 + 旧成员感知成员变动
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.sync', g)
      }
    }
    this.deps.emit({ type: 'member-change', gid: g.gid, uid: payload.uid, action: 'join', actorUid: payload.uid })
  }

  private handleLeave(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as ChatRoomMemberChangePayload | undefined
    if (!payload?.gid) return
    const g = this.chatRooms.load(payload.gid)
    if (!g) return
    // 只处理两类来源：
    // 1) 本人主动离开（payload.uid === env.from，信封声明者=被移除者）
    // 2) 室主/管理员移除成员（env.from 角色为 owner/admin）
    const selfDeclared = payload.uid === env.from
    const canRemove = g.members.some((m) => m.uid === env.from && !m.isAi && (m.role === 'owner' || m.role === 'admin'))
    if (!selfDeclared && !canRemove) return
    const idx = g.members.findIndex((m) => m.uid === payload.uid && !m.isAi)
    if (idx < 0) return
    g.members.splice(idx, 1)
    const humans = g.members.filter((m) => !m.isAi)
    if (humans.length === 0) {
      this.chatRooms.delete(payload.gid)
      this.deps.emit({ type: 'member-change', gid: payload.gid, uid: payload.uid, action: 'leave', actorUid: payload.actorUid })
      return
    }
    if (g.ownerUid === payload.uid) {
      humans[0].role = 'owner'
      g.ownerUid = humans[0].uid
    }
    g.updatedAt = Date.now()
    this.chatRooms.save(g)
    // 向其余真人成员广播最新聊天室信息（除被移除者）
    for (const m of g.members) {
      if (!m.isAi && m.uid !== identity.uid) {
        this.sendTo(m.uid, 'chat-room.sync', g)
      }
    }
    this.deps.emit({ type: 'member-change', gid: payload.gid, uid: payload.uid, action: 'leave', actorUid: payload.actorUid })
  }

  private handleKick(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as ChatRoomMemberChangePayload | undefined
    if (!payload?.gid) return
    const g = this.chatRooms.load(payload.gid)
    if (!g) return
    // 只接受两类 kick 信封：本人被踢（自证）或室主/管理员执行（有权限），防成员伪造踢人
    const isSelf = payload.uid === identity.uid
    const canKick = g.members.some((m) => m.uid === env.from && !m.isAi && (m.role === 'owner' || m.role === 'admin'))
    if (!isSelf && !canKick) return
    const idx = g.members.findIndex((m) => m.uid === payload.uid && !m.isAi)
    if (idx >= 0) {
      g.members.splice(idx, 1)
      if (g.members.filter((m) => !m.isAi).length === 0) {
        this.chatRooms.delete(payload.gid)
        return
      }
      g.updatedAt = Date.now()
      this.chatRooms.save(g)
    }
    this.deps.emit({ type: 'member-change', gid: payload.gid, uid: payload.uid, action: 'kick', actorUid: payload.actorUid })
  }

  private handleMessage(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as ChatRoomMessagePayload | undefined
    if (!payload?.id || typeof payload.text !== 'string') return
    const g = this.chatRooms.load(payload.gid)
    if (!g || !this.isMember(g, env.from)) return
    // 幂等：outbox 补投会重复投递同一信封，重复落盘会二次触发整轮 LLM
    if (this.chats.load(payload.gid).some((m) => m.id === payload.id)) return
    // AI 发言身份发言：aiId 必须是本房间内 env.from 名下的 AI 发言身份（防伪造他人 AI）
    const from = env.from
    let fromName = payload.fromName ?? this.rosterName(env.from)
    let isAi = false
    let aiId: number | undefined
    if (payload.isAi) {
      if (typeof payload.aiId !== 'number') return
      const ai = this.aiSpeaker(g, env.from, payload.aiId)
      if (!ai) return
      fromName = ai.aiName ?? fromName
      isAi = true
      aiId = payload.aiId
    }
    const message: ChatRoomMessage = {
      id: payload.id,
      gid: payload.gid,
      from,
      text: payload.text,
      ts: env.ts ?? Date.now(),
      fromName,
      isAiGenerated: payload.isAiGenerated,
      isAi: isAi || undefined,
      aiId,
    }
    this.chats.append(payload.gid, message)
    this.deps.emit({ type: 'message', gid: payload.gid, message })
    // 真人消息、以及「别的月蚀实例」的 AI 发言都触发本机 AI（跨实例协作）。
    // 只挡本机自己拥有的 AI 发言身份（防自聊）——本机 AI 消息本就无法经网络回环到这里。
    if (!isAi || env.from !== identity.uid) {
      for (const ai of g.members) {
        if (ai.isAi) void this.maybeAiReply(g, message, ai)
      }
    }
  }

  /**
   * 尝试 AI 自动回复：真人消息、以及「别的月蚀实例」的 AI 发言都会触发。
   * 只挡本机自己拥有的 AI（防自聊）；是否真的发言由 AI 自行判断，空回复即静默跳过。
   */
  private async maybeAiReply(g: ChatRoomInfo, trigger: ChatRoomMessage, ai: ChatRoomMember): Promise<void> {
    if (!this.deps.aiReply) return
    const identity = this.deps.getIdentity()
    if (!identity || ai.uid !== identity.uid) return
    // 防自聊：本机 AI 收到的消息若正是自己发的（同 uid 且同 aiId）则不回复自己；
    // 同账号其他 AI（不同 aiId）的发言放行（支持同账号 AI 间互聊）；别的实例的 AI 放行（跨实例协作）
    if (trigger.isAi && trigger.from === identity.uid && trigger.aiId === (ai.aiId ?? MAIN_AI_ID)) return
    // aiConfig 缺省视为放行（测试/嵌入式场景）；配置存在时按聊天室开关判定
    if (this.deps.aiConfig && !this.deps.aiConfig.isChatRoomEnabled(g.gid)) return
    const aiId = ai.aiId ?? MAIN_AI_ID
    const ref: ChatRoomAiSpeaker = { uid: ai.uid, aiId, name: ai.aiName ?? 'AI' }
    let replyText: string | null = null
    try {
      replyText = await this.deps.aiReply(ref, g, trigger)
    } catch {
      return
    }
    if (!replyText?.trim()) return
    // AI 自动回复以 isAiGenerated=true 落盘并广播：可被前端识别为"AI 自动代答"，
    // 同时 sendMessage 侧不会因此再触发级联 AI 回复（防死循环）
    this.sendMessage(g.gid, replyText, true, aiId)
  }

  private handleSync(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const g = env.payload as ChatRoomInfo | undefined
    if (!g?.gid) return
    const existing = this.chatRooms.load(g.gid)
    if (g.isSystem) {
      // 全员频道：真人成员动态 = roster（不落盘），name/desc 以本地权威为准。
      // 防伪造：只接受 roster 成员广播。
      if (!existing?.isSystem) return
      if (!this.roster().some((p) => p.uid === env.from)) return
      existing.updatedAt = Math.max(existing.updatedAt, g.updatedAt)
      this.chatRooms.save(existing)
      this.deps.emit({ type: 'updated', gid: g.gid })
      return
    }
    // 仅当自己是真人成员时才接受同步
    if (!g.members.some((m) => m.uid === identity.uid && !m.isAi)) return
    // 信任规则：
    // 1) 室主本人发来的全量同步可采纳（本地无记录、室主一致、或本地是旧版本均放行，覆盖室主变更）
    // 2) 普通成员/管理员广播（update 聊天室信息）仅在本地已有该聊天室、室主一致且版本更新时采纳，
    // 防止任意成员伪造 ChatRoomInfo 篡改本地聊天室副本（提权/踢人）
    const fromOwner = g.ownerUid === env.from
    const trustedOwnerSync = fromOwner && (!existing || existing.ownerUid === g.ownerUid || g.updatedAt > existing.updatedAt)
    const memberUpdateSync = !!existing && !fromOwner && existing.ownerUid === g.ownerUid && g.updatedAt > existing.updatedAt
    if (trustedOwnerSync || memberUpdateSync) {
      this.chatRooms.save(g)
      this.deps.emit({ type: 'updated', gid: g.gid })
    }
  }

  private handleDisband(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    const payload = env.payload as { gid: string } | undefined
    if (!payload?.gid) return
    const g = this.chatRooms.load(payload.gid)
    if (!g || !g.members.some((m) => m.uid === identity.uid && !m.isAi)) return
    this.chatRooms.delete(payload.gid)
    this.deps.emit({ type: 'updated', gid: payload.gid })
  }
}
