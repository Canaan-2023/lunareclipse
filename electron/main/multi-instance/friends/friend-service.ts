/**
 * 为什么存在：多开实例用户需要跨实例建立好友关系与私聊，且消息直连 LAN 不经主系统，需独立业务服务承载。
 * 作用：好友系统业务门面：聚合联系人/消息两个存储，提供好友增删、状态同步、私聊（含 AI 应答钩子）与
 * 邀请制文件传输（发送方只发邀请信封，接收方同意后本端才推流，不阻塞聊天通道），并统一事件派发。
 */

import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { LanEnvelope, LanPeer, LanPeerStatusEvent } from '../lan/lan-types'
import { MAIN_AI_ID } from '../lan/lan-types'
import type { LanSendResult } from '../lan/lan-service'
import type { LanDirectoryProgress, LanDirectoryResult, SendStreamResult } from '../lan/lan-stream'
import { ContactStore } from './contact-store'
import { ChatStore } from './chat-store'
import { TransferStore, type FriendTransferRecord } from './transfer-store'
import type {
  FriendChatMessage,
  FriendContact,
  FriendEvent,
  FriendFileAcceptPayload,
  FriendFileDonePayload,
  FriendFileMeta,
  FriendFileProgressPayload,
  FriendFileRejectPayload,
  FriendFileRelayedPayload,
  FriendFileResumePayload,
  FriendListItem,
  FriendMessagePayload
} from './friend-types'

/** transferId 白名单（与 TransferStore 同源约定）：uuid 形态，防路径穿越 */
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

/** 邀请选择器返回值（主进程 dialog 选择 + 统计后传入） */
export interface FriendFilePick {
  path: string
  name: string
  kind: 'file' | 'dir'
  totalBytes: number
  files: number
  dirs: number
}

/**
 * 中继上传端口（L1.5 主系统中继）：FriendService 只消费「登记 → 流式上传」三个动作，
 * 不持有 RelayService 内部状态；直传改走中继后，接收方同意制仍由中继端 confirm 流程保证。
 */
export interface RelayUploadPort {
  beginUpload(input: {
    receiverUid: number
    kind: 'file' | 'dir'
    name: string
    totalBytes: number
    files: number
    dirs: number
  }): { ok: boolean; itemId?: string; error?: string }
  uploadFile(filePath: string, opts: { itemId: string; name: string }): Promise<{ ok: boolean; error?: string }>
  uploadDirectory(dirPath: string, opts: { itemId: string; name: string }): Promise<{ ok: boolean; error?: string }>
}

/**
 * 好友系统（L1）业务门面：好友簿 + 私聊 + 邀请制直传，基于 L0 局域网底座。
 * - 好友请求/接受/拒绝/拉黑/删除全部经局域网信封直连（friend.* 前缀）
 * - 私聊消息：直连送达；对端离线时 L0 自动入 outbox 补投，本模块不重复处理
 * - 文件传输：发送方只发 friend.message（带 file 元数据）邀请；接收方同意后回
 * friend.file-accept，发送方凭 transfers 登记表启动文件流（sendLanFile/Directory）；
 * 接收方收齐后按 file-done 把暂存区整体挪进用户下载文件夹。全程信封可补投，
 * 双方任意一方离线都不丢邀请（补发时间戳由 outbox 原信封 ts 保证）。
 * - 会话存储：chats/{chatId}.json（双方一致 chatId，消息幂等去重）
 * - 前端事件：FriendEvent 经 webContents 推送（由装配层注入 emit）
 */
export interface FriendServiceDeps {
  /** 数据根目录（federation/ 挂其下） */
  root: string
  /** 当前登录用户（未登录返回 null；加好友/发消息前校验） */
  getIdentity: () => { uid: number; 用户名: string } | null
  /** 经 L0 直连发送信封（返回模式：direct/outbox/no-identity） */
  sendLan: (uid: number, type: string, payload: unknown) => LanSendResult
  /** 对端在线态（LanService.listPeers） */
  listPeers: () => LanPeer[]
  /** 全员名册（添加好友候选：roster） */
  listRoster: () => LanPeer[]
  /** 事件推送（mainWindow.webContents.send('friend:event', event)） */
  emit: (event: FriendEvent) => void
  /** 邀请制直传推流：单文件（transferId 关联收件端暂存区与卡片） */
  sendLanFile: (uid: number, filePath: string, options?: { name?: string; transferId?: string }) => Promise<SendStreamResult>
  /** 邀请制直传推流：整目录（结构 + 文件并发；目录级逐文件进度回调） */
  sendLanDirectory: (uid: number, dirPath: string, options?: { transferId?: string; onProgress?: (p: LanDirectoryProgress) => void }) => Promise<LanDirectoryResult>
  /** 接收方下载位置（系统下载文件夹优先，fallback 数据目录内） */
  getDownloadDir: () => string
  /**
   * AI 代理配置（私聊自动回复开关）：按 chatId 查询是否启用。
   * 缺省（undefined）= 不启用自动回复，仅保留手动收发。
   */
  aiConfig?: { isDirectChatEnabled: (chatId: string) => boolean }
  /**
   * AI 自动回复生成器：收到好友消息时调用，返回回复正文（null = 不回复）。
   * 回复以本机用户身份发出，消息标记 isAiGenerated=true。
   */
  aiReply?: (peerUid: number, msg: FriendChatMessage) => Promise<string | null>
  /**
   * 中继上传端口（L1.5）：直传不可达/失败时，发送方把同一本地文件改走中继通道，
   * 接收方在中继面板确认后由中继端下发（同意制见 ：confirm 后才回发 download 流）。
   * 用 getter 注入：FriendService 装配早于 RelayService（index.ts 顺序），
   * 运行时才取当前实例（可能尚未初始化 → 返回 null → switchToRelay 明确报错而非静默）。
   */
  getRelay?: () => RelayUploadPort | null
}

export class FriendService {
  readonly contacts: ContactStore
  readonly chats: ChatStore
  /** 发送方待发文件登记（transferId → 本地路径；完成/拒绝/取消后删除） */
  readonly transfers: TransferStore

  constructor(private readonly deps: FriendServiceDeps) {
    this.contacts = new ContactStore(deps.root)
    this.chats = new ChatStore(deps.root)
    this.transfers = new TransferStore(deps.root)
  }

  // ===== 局域网信封入口（L0 onMessage 转发） =====

  handleLanEnvelope(env: LanEnvelope): void {
    switch (env.type) {
      case 'friend.request':
        this.handleRequest(env)
        break
      case 'friend.accept':
        this.handleAccept(env)
        break
      case 'friend.reject':
        this.handleReject(env)
        break
      case 'friend.blocked':
        this.handleRemoteBlock(env)
        break
      case 'friend.message':
        this.handleMessage(env)
        break
      case 'friend.file-accept':
        void this.handleFileAccept(env)
        break
      case 'friend.file-reject':
        this.handleFileReject(env)
        break
      case 'friend.file-cancel':
        this.handleFileCancel(env)
        break
      case 'friend.file-done':
        void this.handleFileDone(env)
        break
      case 'friend.file-progress':
        this.handleFileProgress(env)
        break
      case 'friend.file-resume':
        this.handleFileResume(env)
        break
      case 'friend.file-relayed':
        this.handleFileRelayed(env)
        break
      default:
        break
    }
  }

  /** 对端在线状态变化（好友列表徽标） */
  handlePeerStatus(ev: LanPeerStatusEvent): void {
    const contact = this.contacts.get(ev.peer.uid)
    if (!contact || contact.status !== 'friend') return
    this.deps.emit({ type: 'peer-online', uid: ev.peer.uid, online: ev.online })
  }

  /** 是否好友（收件端权限判定：enableLanFileSink.allowPeer 注入） */
  isFriend(uid: number): boolean {
    return this.contacts.get(uid)?.status === 'friend'
  }

  // ===== 好友簿操作 =====

  /** 列表页数据：contacts 合并在线态/最近消息/未读；排序置顶（在线>分组>添加时间） */
  list(): FriendListItem[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    const peers = new Map(this.deps.listPeers().map((p) => [p.uid, p]))
    const isOnline = (uid: number): boolean => peers.get(uid)?.online === true
    // 最近消息/未读取每条联系人各自会话
    const enrich = (c: FriendContact): FriendListItem => {
      const chatId = ChatStore.chatId(identity.uid, c.uid)
      const last = this.chats.last(chatId)
      return {
        uid: c.uid,
        昵称: c.昵称,
        备注: c.备注,
        分组: c.分组,
        status: c.status,
        online: isOnline(c.uid),
        lastMessage: last?.text ?? null,
        lastTs: last?.ts ?? null,
        unread: c.status === 'friend' ? this.chats.countUnread(chatId, c.uid) : 0
      }
    }
    return this.contacts
      .load()
      .map(enrich)
      .sort((a, b) => {
        const order = { friend: 0, pending: 1, blocked: 2 } as const
        const so = (s: FriendListItem['status']): number => order[s] ?? 3
        return so(a.status) - so(b.status) || Number(b.online) - Number(a.online) || a.uid - b.uid
      })
  }

  /** 添加好友候选：roster 中未在 contacts 且非本人 */
  candidates(): LanPeer[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    const existing = new Set(this.contacts.load().map((c) => c.uid))
    return this.deps.listRoster().filter((p) => p.uid !== identity.uid && !existing.has(p.uid))
  }

  /**
   * 关键词搜索（本地全量，不外发）：
   * - uid 指定：只搜该会话的私聊消息；
   * - uid 省略：搜联系人资料（昵称/备注/分组）+ 全部会话消息。
   * 两类结果各按 limit 截断（默认 50，硬上限 200），避免全量注入撑爆上下文。
   */
  search(keyword: string, uid?: number, limit = 50): {
    contacts: FriendListItem[]
    messages: Array<{ uid: number; message: FriendChatMessage }>
  } {
    const identity = this.deps.getIdentity()
    if (!identity) return { contacts: [], messages: [] }
    const kw = keyword.trim().toLowerCase()
    if (!kw) return { contacts: [], messages: [] }
    const max = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50
    const contacts: FriendListItem[] = []
    const messages: Array<{ uid: number; message: FriendChatMessage }> = []
    for (const item of this.list()) {
      if (uid !== undefined && item.uid !== uid) continue
      if (
        item.昵称.toLowerCase().includes(kw) ||
        (item.备注 ?? '').toLowerCase().includes(kw) ||
        item.分组.toLowerCase().includes(kw)
      ) {
        contacts.push(item)
      }
      const chatId = ChatStore.chatId(identity.uid, item.uid)
      for (const m of this.chats.load(chatId)) {
        if (m.text.toLowerCase().includes(kw)) messages.push({ uid: item.uid, message: m })
      }
    }
    return { contacts: contacts.slice(0, max), messages: messages.slice(-max) }
  }

  /** 发起好友请求：本地写入 pending(out) + 局域网直连送达；对端离线由 outbox 补投 */
  request(uid: number, note?: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (uid === identity.uid) return { ok: false, error: '不能添加自己' }
    const existing = this.contacts.get(uid)
    if (existing?.status === 'friend') return { ok: false, error: '已是好友' }
    if (existing?.status === 'blocked') return { ok: false, error: '对方已被拉黑，请先解除' }
    const peer = this.deps.listRoster().find((p) => p.uid === uid)
    this.contacts.upsert({
      uid,
      昵称: peer?.用户名 ?? existing?.昵称 ?? `UID ${uid}`,
      分组: existing?.分组 ?? '默认',
      addedAt: existing?.addedAt ?? Date.now(),
      status: 'pending',
      direction: 'out'
    })
    this.deps.sendLan(uid, 'friend.request', { fromName: identity.用户名, note })
    return { ok: true }
  }

  /** 接受请求：本机转 friend + 回发 accept（对端收到后转 friend）；重复接受幂等 */
  accept(uid: number): { ok: boolean; error?: string } {
    const existing = this.contacts.get(uid)
    if (!existing) return { ok: false, error: '请求不存在' }
    if (existing.status === 'friend') return { ok: true }
    if (existing.status === 'blocked') return { ok: false, error: '对方已被拉黑' }
    this.contacts.setStatus(uid, 'friend')
    this.deps.sendLan(uid, 'friend.accept', {})
    return { ok: true }
  }

  /** 拒绝请求：本机移除 + 回发 reject（对端收到后移除自己记录） */
  reject(uid: number): { ok: boolean; error?: string } {
    const existing = this.contacts.get(uid)
    if (!existing) return { ok: false, error: '请求不存在' }
    this.contacts.remove(uid)
    if (existing.direction === 'in') {
      this.deps.sendLan(uid, 'friend.reject', {})
    }
    return { ok: true }
  }

  /** 拉黑：本机 blocked + 通知对端（对端删除自己的人并收不到后续消息） */
  block(uid: number): { ok: boolean; error?: string } {
    const existing = this.contacts.get(uid)
    if (!existing) return { ok: false, error: '联系人不存在' }
    this.contacts.setStatus(uid, 'blocked')
    this.deps.sendLan(uid, 'friend.blocked', {})
    return { ok: true }
  }

  /** 解除拉黑（可重新添加） */
  unblock(uid: number): { ok: boolean; error?: string } {
    const existing = this.contacts.get(uid)
    if (!existing) return { ok: false, error: '联系人不存在' }
    this.contacts.remove(uid)
    return { ok: true }
  }

  /** 删除好友：本机移除 + 通知对端（对端删除其记录，保留聊天记录文件） */
  remove(uid: number): { ok: boolean; error?: string } {
    if (!this.contacts.get(uid)) return { ok: false, error: '联系人不存在' }
    this.contacts.remove(uid)
    this.deps.sendLan(uid, 'friend.reject', {})
    return { ok: true }
  }

  /** 备注/分组编辑 */
  update(uid: number, patch: { 备注?: string; 分组?: string }): { ok: boolean; error?: string } {
    const updated = this.contacts.patch(uid, patch)
    return updated ? { ok: true } : { ok: false, error: '联系人不存在' }
  }

  // ===== 私聊 =====

  /** 拉取某好友全部消息（时间升序） */
  messages(uid: number): FriendChatMessage[] {
    const identity = this.deps.getIdentity()
    if (!identity) return []
    return this.chats.load(ChatStore.chatId(identity.uid, uid))
  }

  /** 标记某好友消息已读（打开聊天窗口/收到新消息时调用） */
  markRead(uid: number): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    this.chats.markRead(ChatStore.chatId(identity.uid, uid), uid)
  }

  /** 发私聊消息：仅好友可发；直连/outbox 交由 L0；本机同步落盘（read=true） */
  sendMessage(
    uid: number,
    text: string,
    isAiGenerated = false,
    aiId?: number
  ): { ok: boolean; mode?: string; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const contact = this.contacts.get(uid)
    if (!contact || contact.status !== 'friend') return { ok: false, error: '仅好友可发起私聊' }
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, error: '消息为空' }
    const id = `${identity.uid}_${randomUUID()}`
    const message: FriendChatMessage = {
      id,
      from: identity.uid,
      to: uid,
      text: trimmed,
      ts: Date.now(),
      read: true,
      ...(isAiGenerated ? { isAiGenerated: true } : {}),
      ...(aiId !== undefined ? { aiId } : {})
    }
    this.chats.append(ChatStore.chatId(identity.uid, uid), message)
    const result = this.deps.sendLan(uid, 'friend.message', {
      id,
      text: trimmed,
      ...(isAiGenerated ? { isAiGenerated: true } : {}),
      ...(aiId !== undefined ? { aiId } : {})
    } satisfies FriendMessagePayload)
    return { ok: true, mode: result.mode, error: result.error }
  }

  // ===== 邀请制文件传输（发送方：邀请 → 接收方同意 → 本端推流；不占用聊天通道） =====

  /**
   * 邀请发送方入口（文件/文件夹已由主进程 dialog 选出并统计，本方法只登记 + 发邀请信封）：
   * 1. transfers/{transferId}.json 登记本地路径（本方离线重启后仍可凭它恢复推流）
   * 2. 私聊落一条带 file 元数据的邀请消息（卡片态 pending）
   * 3. friend.message 信封携带 file 元数据发往对端（离线由 outbox 补投，时间戳=发送时刻）
   */
  inviteFile(uid: number, pick: FriendFilePick): { ok: boolean; error?: string; transferId?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const contact = this.contacts.get(uid)
    if (!contact || contact.status !== 'friend') return { ok: false, error: '仅好友可传输文件' }
    if (!pick || typeof pick.path !== 'string' || (pick.kind !== 'file' && pick.kind !== 'dir')) {
      return { ok: false, error: '未选择有效文件' }
    }
    const transferId = randomUUID()
    const file: FriendFileMeta = {
      transferId,
      name: pick.name || basename(pick.path),
      size: pick.totalBytes,
      kind: pick.kind,
      ...(pick.kind === 'dir' ? { files: pick.files, dirs: pick.dirs } : {}),
      state: 'pending'
    }
    const rec: FriendTransferRecord = {
      transferId,
      uid,
      localPath: pick.path,
      name: file.name,
      size: file.size,
      kind: pick.kind,
      ...(pick.kind === 'dir' ? { files: pick.files, dirs: pick.dirs } : {}),
      ts: Date.now(),
      status: 'pending'
    }
    // 先登记后发信封：登记失败不发邀请（避免对端同意时本方无记录可推）
    this.transfers.put(rec)
    const id = `${identity.uid}_${randomUUID()}`
    const message: FriendChatMessage = {
      id,
      from: identity.uid,
      to: uid,
      text: `${pick.kind === 'dir' ? '[文件夹]' : '[文件]'} ${file.name}`,
      ts: Date.now(),
      read: true,
      file
    }
    this.chats.append(ChatStore.chatId(identity.uid, uid), message)
    const payload = {
      id,
      text: message.text,
      file: {
        transferId,
        name: file.name,
        size: file.size,
        kind: file.kind,
        ...(pick.kind === 'dir' ? { files: pick.files, dirs: pick.dirs } : {})
      }
    } satisfies FriendMessagePayload
    const result = this.deps.sendLan(uid, 'friend.message', payload)
    this.deps.emit({ type: 'file-invite-sent', uid, message })
    if (!result.ok && result.error) return { ok: false, error: result.error, transferId }
    return { ok: true, transferId }
  }

  /**
   * 接收方同意邀请：回发 friend.file-accept（对方离线会进 outbox 补投，对方上线后自动开始推流），
   * 并把本端邀请卡片置为 accepted。重复点击幂等（发送方 streaming 守卫只推一次）。
   */
  acceptFileInvite(uid: number, transferId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (!TRANSFER_ID_RE.test(transferId)) return { ok: false, error: '参数不合法' }
    const contact = this.contacts.get(uid)
    if (!contact || contact.status !== 'friend') return { ok: false, error: '仅好友可传输文件' }
    if (!this.findInvite(identity.uid, uid, transferId)) return { ok: false, error: '邀请不存在' }
    this.deps.sendLan(uid, 'friend.file-accept', { transferId } satisfies FriendFileAcceptPayload)
    const chatId = ChatStore.chatId(identity.uid, uid)
    const msg = this.findInviteMessage(chatId, transferId)
    if (msg?.id) {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) m.file.state = 'accepted'
      })
    }
    this.deps.emit({ type: 'file-accepted', uid, transferId })
    return { ok: true }
  }

  /** 接收方拒绝邀请：回发 reject 并置卡片为 rejected（发送方清理登记记录） */
  rejectFileInvite(uid: number, transferId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (!TRANSFER_ID_RE.test(transferId)) return { ok: false, error: '参数不合法' }
    const msg = this.findInvite(identity.uid, uid, transferId)
    if (!msg) return { ok: false, error: '邀请不存在' }
    this.deps.sendLan(uid, 'friend.file-reject', { transferId } satisfies FriendFileRejectPayload)
    this.chats.updateMessage(ChatStore.chatId(identity.uid, uid), msg.id, (m) => {
      if (m.file) m.file.state = 'rejected'
    })
    this.deps.emit({ type: 'file-rejected', uid, transferId })
    return { ok: true }
  }

  /** 发送方撤回邀请（仅待同意状态可撤）：删登记 + 通知对端 + 本端卡片置 canceled */
  cancelFileInvite(uid: number, transferId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (!TRANSFER_ID_RE.test(transferId)) return { ok: false, error: '参数不合法' }
    const rec = this.transfers.get(transferId)
    if (!rec || rec.uid !== uid || rec.status !== 'pending') return { ok: false, error: '邀请已不可撤回' }
    this.transfers.remove(transferId)
    this.deps.sendLan(uid, 'friend.file-cancel', { transferId } satisfies FriendFileRejectPayload)
    const chatId = ChatStore.chatId(identity.uid, uid)
    const msg = this.findInviteMessage(chatId, transferId)
    if (msg?.id) {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) m.file.state = 'canceled'
      })
    }
    this.deps.emit({ type: 'file-canceled', uid, transferId })
    return { ok: true }
  }

  /** 接收方定位已下载文件（file.path 在 done 时落盘）：IPC 层据此 shell.showItemInFolder */
  openFileLocation(uid: number, transferId: string): { ok: boolean; error?: string; path?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (!TRANSFER_ID_RE.test(transferId)) return { ok: false, error: '参数不合法' }
    const msg = this.findInvite(identity.uid, uid, transferId)
    if (!msg?.file?.path) return { ok: false, error: '文件位置未知' }
    return { ok: true, path: msg.file.path }
  }

  /** 发送方收到 accept：凭登记表启动推流，进度经 file-progress 上报，完成/失败回 file-done */
  private async handleFileAccept(env: LanEnvelope): Promise<void> {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as FriendFileAcceptPayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    const rec = this.transfers.get(payload.transferId)
    // 登记缺失（邀请已撤回）或来源不符（防冒领）→ 忽略；streaming = 重复 accept，防双推
    if (!rec || rec.uid !== env.from || rec.status !== 'pending') return
    rec.status = 'streaming'
    this.transfers.put(rec)
    this.deps.emit({ type: 'file-accepted', uid: env.from, transferId: rec.transferId })
    const chatId = ChatStore.chatId(identity.uid, env.from)
    const msg = this.findInviteMessage(chatId, rec.transferId)
    if (msg?.id) {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) m.file.state = 'accepted'
      })
    }

    const finish = (ok: boolean, error?: string) => {
      if (ok) {
        this.transfers.remove(rec.transferId)
      } else {
        // 推流失败：恢复待同意态，接收方卡片可再次同意重试
        rec.status = 'pending'
        this.transfers.put(rec)
      }
      this.deps.sendLan(env.from, 'friend.file-done', { transferId: rec.transferId, ok, error } satisfies FriendFileDonePayload)
      this.deps.emit({ type: 'file-done', uid: env.from, transferId: rec.transferId, ok, error })
      const m = this.findInviteMessage(chatId, rec.transferId)
      if (m?.id) {
        this.chats.updateMessage(chatId, m.id, (m2) => {
          if (!m2.file) return
          m2.file.state = ok ? 'done' : 'failed'
          if (!ok) m2.file.error = error
        })
      }
    }

    if (rec.kind === 'dir') {
      void this.deps
        .sendLanDirectory(env.from, rec.localPath, {
          transferId: rec.transferId,
          onProgress: (p) => {
            const prog = {
              transferId: rec.transferId,
              doneBytes: p.doneBytes,
              totalBytes: p.totalBytes,
              doneFiles: p.doneFiles,
              totalFiles: p.totalFiles
            } satisfies FriendFileProgressPayload
            this.deps.sendLan(env.from, 'friend.file-progress', prog)
            this.deps.emit({ type: 'file-progress', uid: env.from, ...prog })
          }
        })
        .then((res) => finish(res.ok, res.error))
        .catch((err) => finish(false, (err as Error).message))
    } else {
      void this.deps
        .sendLanFile(env.from, rec.localPath, { name: rec.name, transferId: rec.transferId })
        .then((res) => finish(res.ok, res.error))
        .catch((err) => finish(false, (err as Error).message))
    }
  }

  /** 发送方收到 reject（对方拒绝/已删除好友）：清理登记，卡片置 rejected */
  private handleFileReject(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as FriendFileRejectPayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    const rec = this.transfers.get(payload.transferId)
    if (rec && rec.uid === env.from) this.transfers.remove(payload.transferId)
    const chatId = ChatStore.chatId(identity.uid, env.from)
    const msg = this.findInviteMessage(chatId, payload.transferId)
    if (msg?.id) {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) m.file.state = 'rejected'
      })
    }
    this.deps.emit({ type: 'file-rejected', uid: env.from, transferId: payload.transferId })
  }

  /** 接收方收到 cancel（发送方撤回）：卡片置 canceled */
  private handleFileCancel(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as FriendFileRejectPayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    const chatId = ChatStore.chatId(identity.uid, env.from)
    const msg = this.findInviteMessage(chatId, payload.transferId)
    if (msg?.id) {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) m.file.state = 'canceled'
      })
    }
    this.deps.emit({ type: 'file-canceled', uid: env.from, transferId: payload.transferId })
  }

  /** 接收方收到进度：透传给前端卡片（瞬态，刷新/重启后由终态兜底） */
  private handleFileProgress(env: LanEnvelope): void {
    const payload = env.payload as FriendFileProgressPayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    this.deps.emit({
      type: 'file-progress',
      uid: env.from,
      transferId: payload.transferId,
      doneBytes: payload.doneBytes,
      totalBytes: payload.totalBytes,
      doneFiles: payload.doneFiles,
      totalFiles: payload.totalFiles
    })
  }

  /** 接收方收到推流结果：成功后把 invites 暂存区整体挪进下载文件夹，卡片置 done/failed + 终态路径 */
  private async handleFileDone(env: LanEnvelope): Promise<void> {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as FriendFileDonePayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    const chatId = ChatStore.chatId(identity.uid, env.from)
    const msg = this.findInviteMessage(chatId, payload.transferId)
    if (!msg?.file?.name) return
    const staging = join(this.deps.root, 'federation', 'incoming', String(env.from), 'invites', payload.transferId)
    if (payload.ok) {
      try {
        const saved = await this.moveTransferToDownloads(staging, msg.file)
        this.chats.updateMessage(chatId, msg.id, (m) => {
          if (!m.file) return
          m.file.state = 'done'
          m.file.path = saved
        })
        this.deps.emit({ type: 'file-done', uid: env.from, transferId: payload.transferId, ok: true, path: saved })
      } catch (err) {
        const error = `保存到下载文件夹失败: ${(err as Error).message}`
        this.chats.updateMessage(chatId, msg.id, (m) => {
          if (m.file) {
            m.file.state = 'failed'
            m.file.error = error
          }
        })
        this.deps.emit({ type: 'file-done', uid: env.from, transferId: payload.transferId, ok: false, error })
      } finally {
        this.cleanupStaging(staging)
      }
    } else {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) {
          m.file.state = 'failed'
          m.file.error = payload.error ?? '传输失败'
        }
      })
      this.deps.emit({ type: 'file-done', uid: env.from, transferId: payload.transferId, ok: false, error: payload.error })
      this.cleanupStaging(staging)
    }
  }

  // ===== 邀请制直传（内部工具） =====

  /**
   * 启动恢复：扫描 TransferStore 里残留的 streaming 记录（推流中断/崩溃重启后状态卡死）。
   * - 记录存在且对端仍是好友：重置为 pending + 向对端发 friend.file-resume，
   * 对端 accepted 卡片拉回「可再次同意」态——恢复推流同样遵循同意制，不强行续传；
   * - 记录对端已不是好友/本地文件已不存在：直接删除记录（对端卡片由 reject/cancel 兜底）。
   * 返回恢复（重置为待同意）的条数。
   */
  recoverInterruptedTransfers(): number {
    let recovered = 0
    for (const rec of this.transfers.list()) {
      if (rec.status !== 'streaming') continue
      const contact = this.contacts.get(rec.uid)
      const sourceExists = existsSync(rec.localPath)
      if (contact?.status !== 'friend' || !sourceExists) {
        // 关系已解除或文件已失去：登记再无意义，移除后让对端卡片自然失效（重新邀请即可重传）
        this.transfers.remove(rec.transferId)
        continue
      }
      rec.status = 'pending'
      this.transfers.put(rec)
      const payload = { transferId: rec.transferId } satisfies FriendFileResumePayload
      this.deps.sendLan(rec.uid, 'friend.file-resume', payload)
      this.deps.emit({ type: 'file-resume', uid: rec.uid, transferId: rec.transferId })
      recovered++
    }
    return recovered
  }

  /**
   * 手动切换中继发送：直传不可达/失败时，把同一本地文件改走中继通道送达同一接收方。
   * - 登记表中记录必须存在且主系统中继可用（getRelay 延迟注入，可能为 null → 明确报错）；
   * - 上传成功后：直传登记删除（不再接受直传 accept）、本端卡片置 relayed、
   * 向对端发 friend.file-relayed（对端卡片同样置 relayed，指引其在传输面板确认领取）；
   * - 中继侧的「接收方同意」由 RelayService 固有确认制保证：上传完成后只向接收方发
   * relay:notify，接收方在 RelayPanel confirm 后才回发 download 流（ 守卫，不强行落盘）。
   */
  async switchToRelay(uid: number, transferId: string): Promise<{ ok: boolean; error?: string }> {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    if (!TRANSFER_ID_RE.test(transferId)) return { ok: false, error: '参数不合法' }
    const contact = this.contacts.get(uid)
    if (!contact || contact.status !== 'friend') return { ok: false, error: '仅好友可传输文件' }
    const rec = this.transfers.get(transferId)
    if (!rec || rec.uid !== uid) return { ok: false, error: '传输记录不存在' }
    const relay = this.deps.getRelay?.() ?? null
    if (!relay) return { ok: false, error: '中继服务暂不可用' }
    const begin = relay.beginUpload({
      receiverUid: uid,
      kind: rec.kind,
      name: rec.name,
      totalBytes: rec.size,
      files: rec.kind === 'dir' ? (rec.files ?? 0) : 1,
      dirs: rec.kind === 'dir' ? (rec.dirs ?? 0) : 0
    })
    if (!begin.ok || !begin.itemId) return { ok: false, error: begin.error ?? '中继登记失败' }
    const uploaded = rec.kind === 'dir'
      ? await relay.uploadDirectory(rec.localPath, { itemId: begin.itemId, name: rec.name })
      : await relay.uploadFile(rec.localPath, { itemId: begin.itemId, name: rec.name })
    if (!uploaded.ok) return { ok: false, error: uploaded.error ?? '中继上传失败' }

    // 上传成功：直传使命结束，登记删除；本端与对端卡片一并置 relayed
    this.transfers.remove(transferId)
    const chatId = ChatStore.chatId(identity.uid, uid)
    const msg = this.findInviteMessage(chatId, transferId)
    if (msg?.id) {
      this.chats.updateMessage(chatId, msg.id, (m) => {
        if (m.file) m.file.state = 'relayed'
      })
    }
    this.deps.sendLan(uid, 'friend.file-relayed', { transferId } satisfies FriendFileRelayedPayload)
    this.deps.emit({ type: 'file-relayed', uid, transferId })
    return { ok: true }
  }

  /**
   * 接收方收到 file-resume（发送方重启后恢复待同意）：把本端 accepted（卡死的「发送中」）
   * 卡片拉回 pending，重新显示「同意/拒绝」操作——恢复推流等待接收方再次确认，不强行续传。
   */
  private handleFileResume(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as FriendFileResumePayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    const chatId = ChatStore.chatId(identity.uid, env.from)
    const msg = this.findInviteMessage(chatId, payload.transferId)
    if (!msg?.id || msg.file?.state !== 'accepted') return
    this.chats.updateMessage(chatId, msg.id, (m) => {
      if (m.file) m.file.state = 'pending'
    })
    this.deps.emit({ type: 'file-resume', uid: env.from, transferId: payload.transferId })
  }

  /** 接收方收到 file-relayed（发送方已改用中继）：本端卡片置 relayed（去传输面板确认领取） */
  private handleFileRelayed(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const payload = env.payload as FriendFileRelayedPayload | undefined
    if (!payload?.transferId || !TRANSFER_ID_RE.test(payload.transferId)) return
    const chatId = ChatStore.chatId(identity.uid, env.from)
    const msg = this.findInviteMessage(chatId, payload.transferId)
    if (!msg?.id) return
    this.chats.updateMessage(chatId, msg.id, (m) => {
      if (m.file) m.file.state = 'relayed'
    })
    this.deps.emit({ type: 'file-relayed', uid: env.from, transferId: payload.transferId })
  }

  /** 会话内按 transferId 找邀请消息（无则 null） */
  private findInviteMessage(chatId: string, transferId: string): FriendChatMessage | null {
    return this.chats.load(chatId).find((m) => m.file?.transferId === transferId) ?? null
  }

  /** 会话内按 transferId 找邀请消息（简写，供前端动作校验存在性） */
  private findInvite(myUid: number, peerUid: number, transferId: string): FriendChatMessage | null {
    return this.findInviteMessage(ChatStore.chatId(myUid, peerUid), transferId)
  }

  /**
   * 把 invites 暂存区挪进下载文件夹：
   * - 单文件：暂存区里唯一文件 → {dlDir}（重名自动加序号，防覆盖已有下载）
   * - 文件夹：暂存区 tree/ 整体 → {dlDir}/{name}（结构原样保留）
   * 同卷 rename 原子迁移；跨卷（数据盘 → C 盘下载夹）退化为复制+删除。
   */
  private async moveTransferToDownloads(staging: string, meta: FriendFileMeta): Promise<string> {
    const dlDir = this.deps.getDownloadDir()
    mkdirSync(dlDir, { recursive: true })
    if (meta.kind === 'dir') {
      const srcDir = join(staging, 'tree')
      if (!existsSync(srcDir)) throw new Error('目录暂存区缺失')
      const destDir = this.uniquePath(join(dlDir, basename(meta.name)))
      await this.movePath(srcDir, destDir)
      return destDir
    }
    const entries = readdirSync(staging).filter((n) => n !== '.part')
    if (entries.length !== 1) throw new Error('文件暂存区异常')
    const srcFile = join(staging, entries[0])
    const destFile = this.uniquePath(join(dlDir, entries[0]))
    await this.movePath(srcFile, destFile)
    return destFile
  }

  /** 跨卷安全迁移：优先 rename（同卷原子），EXDEV 时复制后删源；校验源存在且非目录 */
  private async movePath(src: string, dest: string): Promise<void> {
    const st = statSync(src, { throwIfNoEntry: false })
    if (!st) throw new Error('源文件缺失')
    try {
      renameSync(src, dest)
      return
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    }
    if (st.isDirectory()) {
      mkdirSync(dest, { recursive: true })
      for (const name of readdirSync(src)) {
        await this.movePath(join(src, name), join(dest, name))
      }
    } else {
      copyFileSync(src, dest)
    }
    rmSync(src, { recursive: true, force: true })
  }

  /** 重名防覆盖：已存在则追加 (1)/(2)… 直到可用 */
  private uniquePath(target: string): string {
    if (!existsSync(target)) return target
    const dir = dirname(target)
    const name = basename(target)
    const idx = name.lastIndexOf('.')
    // 点开头（.gitignore）或没有扩展名 → 整名当基名
    const stem = idx > 0 ? name.slice(0, idx) : name
    const ext = idx > 0 ? name.slice(idx) : ''
    for (let i = 1; i < 1000; i++) {
      const candidate = join(dir, `${stem} (${i})${ext}`)
      if (!existsSync(candidate)) return candidate
    }
    return join(dir, `${stem} (${Date.now()})${ext}`)
  }

  /** 删除暂存区（含 .part 残留与空目录树）；不存在时静默 */
  private cleanupStaging(staging: string): void {
    if (!existsSync(staging)) return
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // 清理失败不阻断主线（残留暂存区由用户或后续清理兜底）
    }
  }

  /**
   * AI 自动回复：收到好友消息后，若该私聊的 AI 代理开关打开，则生成回复并发出。
   * 真人消息与「别的月蚀实例」的 AI 消息都会触发（跨实例协作）；本机自己发出的不触发（防自聊）。
   * 文件邀请消息（带 file 元数据）不触发自动回复（收文件不是对话，AI 不应替用户决定）。
   * 信封 from 仍是机主 uid（私聊按 uid 寻址），另带 aiId 标明是本机哪个 AI 实体代答
   * （对外身份 = `UID-AIID`）。
   * 失败/空回复一律静默跳过（不阻断消息接收）。
   */
  private async maybeAiReply(peerUid: number, trigger: FriendChatMessage): Promise<void> {
    if (!this.deps.aiReply || trigger.file) return
    const identity = this.deps.getIdentity()
    if (!identity) return
    // 只挡本机自己发出的消息（入站路径已排除 env.from === identity.uid，此处为防御）
    if (trigger.from === identity.uid) return
    const chatId = ChatStore.chatId(identity.uid, peerUid)
    if (this.deps.aiConfig && !this.deps.aiConfig.isDirectChatEnabled(chatId)) return
    let replyText: string | null = null
    try {
      replyText = await this.deps.aiReply(peerUid, trigger)
    } catch {
      return
    }
    if (!replyText?.trim()) return
    this.sendMessage(peerUid, replyText, true, MAIN_AI_ID)
  }

  // ===== 信封处理（内部） =====

  /** 收到好友请求：本机写入 pending(in) + 推送（若已拉黑/已是好友则忽略；重复请求幂等） */
  private handleRequest(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const existing = this.contacts.get(env.from)
    if (existing?.status === 'friend' || existing?.status === 'blocked') return
    if (existing?.status === 'pending' && existing.direction === 'in') return
    const payload = env.payload as { fromName?: string; note?: string } | undefined
    const contact: FriendContact = {
      uid: env.from,
      昵称: payload?.fromName ?? existing?.昵称 ?? `UID ${env.from}`,
      分组: existing?.分组 ?? '默认',
      addedAt: existing?.addedAt ?? Date.now(),
      status: 'pending',
      direction: 'in'
    }
    this.contacts.upsert(contact)
    this.deps.emit({ type: 'request', contact })
  }

  /** 收到接受回执：pending(out) → friend + 推送 */
  private handleAccept(env: LanEnvelope): void {
    const contact = this.contacts.get(env.from)
    if (!contact || contact.status !== 'pending' || contact.direction !== 'out') return
    this.contacts.setStatus(env.from, 'friend')
    this.deps.emit({ type: 'accepted', uid: env.from, 昵称: contact.昵称 })
  }

  /** 收到拒绝回执：删除我方记录（对方 delete/拒绝统一用 reject 回执） */
  private handleReject(env: LanEnvelope): void {
    if (this.contacts.get(env.from)) {
      this.contacts.remove(env.from)
      this.deps.emit({ type: 'rejected', uid: env.from })
    }
  }

  /** 收到拉黑通知：删除我方记录（对方单方面解除关系） */
  private handleRemoteBlock(env: LanEnvelope): void {
    if (this.contacts.get(env.from)) {
      this.contacts.remove(env.from)
      this.deps.emit({ type: 'rejected', uid: env.from })
    }
  }

  /** 收到私聊消息：仅好友接收；幂等去重；落盘 + 已读标记交给前端（打开面板时 markRead） */
  private handleMessage(env: LanEnvelope): void {
    const identity = this.deps.getIdentity()
    if (!identity || env.from === identity.uid) return
    const contact = this.contacts.get(env.from)
    if (!contact || contact.status !== 'friend') return
    const payload = env.payload as FriendMessagePayload | undefined
    if (!payload?.id || typeof payload.text !== 'string') return
    // aiId 只接受正整数（AI 身份约定：UID-AIID）；非法一律丢弃，防伪造
    const aiId = typeof payload.aiId === 'number' && Number.isInteger(payload.aiId) && payload.aiId > 0 ? payload.aiId : undefined
    // 文件邀请元数据：走白名单校验（transferId 形态 + 类型），非法视作普通文本消息
    const fileMeta = this.normalizeFileMeta(payload.file)
    const message: FriendChatMessage = {
      id: payload.id,
      from: env.from,
      to: identity.uid,
      text: payload.text,
      ts: env.ts,
      read: false,
      ...(payload.isAiGenerated ? { isAiGenerated: true } : {}),
      ...(aiId !== undefined ? { aiId } : {}),
      ...(fileMeta ? { file: { ...fileMeta, state: 'pending' } } : {})
    }
    const chatId = ChatStore.chatId(identity.uid, env.from)
    // 幂等：同发送方同 id 仅落一次（outbox 补投重试/重连重复可能）
    if (this.chats.load(chatId).some((m) => m.id === payload.id)) return
    this.chats.append(chatId, message)
    this.deps.emit({ type: 'message', uid: env.from, message })
    // 收到消息后触发本机 AI（真人消息与别的月蚀实例的 AI 消息都会触发；文件邀请不触发；
    // 开关关闭/生成器缺失时内部直接返回）
    void this.maybeAiReply(env.from, message)
  }

  /** 白名单化信封里的文件元数据；非法返回 null（防路径注入/结构伪造） */
  private normalizeFileMeta(raw: unknown): FriendFileMeta | null {
    if (typeof raw !== 'object' || raw === null) return null
    const o = raw as Record<string, unknown>
    if (typeof o.transferId !== 'string' || !TRANSFER_ID_RE.test(o.transferId)) return null
    if (typeof o.name !== 'string' || !o.name.trim()) return null
    const kind = o.kind === 'file' ? 'file' : o.kind === 'dir' ? 'dir' : null
    if (!kind) return null
    const size = typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0 ? o.size : 0
    return {
      transferId: o.transferId,
      name: o.name.slice(0, 240),
      size,
      kind,
      ...(kind === 'dir' && typeof o.files === 'number' ? { files: o.files } : {}),
      ...(kind === 'dir' && typeof o.dirs === 'number' ? { dirs: o.dirs } : {})
    }
  }
}