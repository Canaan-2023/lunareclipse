/**
 * @category 工具
 * @summary 多实例：主/分系统接入注册与数据同步
 * 为什么存在：主从多开实例各自持有独立本地存储与账号，必须在此按角色装配接入/认证/同步链路，才能跨实例共享记忆。
 */
import type { ipcMain as ipcMainType, BrowserWindow } from 'electron'
import { app } from 'electron'
import { join } from 'path'
import { networkInterfaces } from 'os'
import type { Router } from 'express'
import type { UserStore } from '../models/user-store'
import type { AuthUser } from './types'
import { InstanceConfigStore } from './instance-config'
import { MasterRegistry } from './master/master-registry'
import { SatelliteStore } from './master/satellite-store'
import { createMasterRouter, type MasterRouterDeps } from './master/master-router'
import { SatelliteTokenCache } from './auth/satellite-token'
import { MasterAuth, SatelliteAuth, type AuthService } from './auth/auth-service'
import { OplogCapture } from './satellite/oplog-capture'
import { SyncEngine } from './satellite/sync-engine'
import { SatelliteClient } from './satellite/satellite-client'
import { parseJoinLink } from './join-link'
import { safeHandle } from '../ipc/handlers/safe-handle'
import { LanService, type LanSendResult } from './lan/lan-service'
import { LanFileSink } from './lan/lan-file-sink'
import type { LanEnvelope, LanPeer } from './lan/lan-types'
import { LAN_DEFAULT_PORT } from './lan/lan-types'
import { FriendService } from './friends/friend-service'
import { ChatRoomService } from './chat-rooms/chat-room-service'
import { PublishBoardService } from './publish-board/publish-board-service'
import { AiAgentConfigStore } from './ai-agent-config-store'
import type { ChatRoomAiReplyGenerator } from './chat-rooms/chat-room-types'
import type { FriendChatMessage } from './friends/friend-types'
import { AiSocialService } from './ai-social/ai-social-service'
import type { AiChatMessage } from './ai-social/ai-social-types'
import { registerFriendIpc } from './ipc/register-friend-ipc'
import { registerAiSocialIpc } from './ipc/register-ai-social-ipc'
import { registerChatRoomIpc } from './ipc/register-chat-room-ipc'
import { registerPublishBoardIpc } from './ipc/register-publish-board-ipc'
import { registerAccountIpc } from './ipc/register-account-ipc'
import { registerBackupIpc } from './ipc/register-backup-ipc'
import { registerRelayIpc } from './ipc/register-relay-ipc'
import type { MultiInstanceIpcCtx } from './ipc/ipc-context'
import { RelayService, RELAY_DEFAULT_RETENTION_DAYS, resolveRelayDownloadDir } from './relay/relay-service'
import type { LanStreamRelayTag } from './lan/lan-stream'
import { SyncStreamSink, SYNC_STREAM_PREFIX } from './master/sync-stream-sink'
import { BackupStreamSink } from './master/backup-stream-sink'
import type { AppConfig } from '@shared/types'

/**
 * 主分系统门面：按 instance.json 角色装配认证与主系统侧资源。
 * - standalone：现状单机，注册页可选升级/接入
 * - master：暴露 /api/v1（注册/登录/令牌/同步/管理/归档）
 * - satellite：认证直达主系统，本地仅缓存令牌
 */
export class MultiInstanceService {
  readonly config: InstanceConfigStore
  private readonly tokenCache: SatelliteTokenCache
  private registry: MasterRegistry | null = null
  private satelliteStore: SatelliteStore | null = null
  private capture: OplogCapture | null = null
  private syncEngine: SyncEngine | null = null
  private lan: LanService | null = null
  private lanOnMessage: ((env: LanEnvelope) => void) | null = null
  private lanOnPeerStatus: ((ev: import('./lan/lan-types').LanPeerStatusEvent) => void) | null = null
  /** 二进制流接收回调（任意外部模块订阅；见 registerLanCallbacks） */
  private lanOnStream: import('./lan/lan-stream').LanStreamCallbacks | null = null
  /**
   * 文件收件器（默认安全：allowPeer 未放开时对端字节完全不落盘）。
   * 由 enableLanFileSink 显式启用：把信封通道的权限/路径/幂等/威胁防线语义落到文件收端。
   */
  private lanFileSink: LanFileSink | null = null
  /** 同步实体收件器（仅 master 装配）：承接分系统 staged 条目的分块面字节，落 sync_staging 待 applyPush 校验消费 */
  private syncStreamSink: SyncStreamSink | null = null
  /** 备份包收件器（仅 satellite 装配）：承接主系统大备份的 LAN 分块面推送，按 transferId 落 backup_dl 供下载/恢复 */
  private backupStreamSink: BackupStreamSink | null = null
  private friends: FriendService | null = null
  /** 中继异步传输（L1.5 大云盘）：master 持有存储端；任意角色可上传/取件（stopLan 时一并清理） */
  private relay: RelayService | null = null
  private chatRooms: ChatRoomService | null = null
  private publishBoard: PublishBoardService | null = null
  /** AI 社交：好友面板「我的 AI」+ AI 私聊会话；不需要 LAN 直连，startLan 时装配 */
  private aiSocial: AiSocialService | null = null
  /** AI 代理配置：聊天室/私聊 AI 自动回复开关（abyssac_data/ai-agent-config.json） */
  private readonly aiAgentConfig: AiAgentConfigStore
  /** 聊天室 AI 回复生成器（LLM 链路就绪后由 index.ts 注入；未注入则 AI 发言身份不自动回复） */
  private aiReplyGenerator: ChatRoomAiReplyGenerator | null = null
  private friendAiReplyGenerator:
    | ((peerUid: number, msg: FriendChatMessage) => Promise<string | null>)
    | null = null
  /** AI 社交回复生成器：收到发给某 AI 的消息时调用（真人→AI、AI→AI 均触发） */
  private aiSocialReplyGenerator:
    | ((
        peer: { uid: number; aiId: number; name: string },
        trigger: AiChatMessage,
        history: AiChatMessage[]
      ) => Promise<string | null>)
    | null = null
  /** 主窗口获取器（registerIpc 注入；FriendService.emitted 事件推送目标） */
  private mainWindowGetter: (() => BrowserWindow | null) | null = null
  private apiPort = 62002
  /** 主系统本机局域网地址（master 模式启动 LanService 后写入；roster 组装用） */
  private masterLan: { lanIp: string | null; lanPort: number } | null = null

  constructor(private readonly root: string) {
    this.config = new InstanceConfigStore(root)
    this.tokenCache = new SatelliteTokenCache(join(root, 'satellite-token.json'))
    this.aiAgentConfig = new AiAgentConfigStore(root)
    if (this.config.isMaster()) {
      this.registry = new MasterRegistry(root)
      this.satelliteStore = new SatelliteStore(root)
    }
  }

  /**
   * 注入聊天室 AI 回复生成器（LLM 链路就绪后由 index.ts 调用；传 null 关闭自动回复）。
   * 生成器按 (AI 发言身份, 聊天室, 触发消息, 历史) 产出回复文本，由 ChatRoomService 以该身份广播。
   */
  setAiReplyGenerator(gen: ChatRoomAiReplyGenerator | null): void {
    this.aiReplyGenerator = gen
  }

  /**
   * 注入私聊 AI 自动回复生成器（LLM 链路就绪后由 index.ts 调用）。
   * 生成器按 (对端 uid, 触发消息) 产出回复文本，由 FriendService 以本机用户身份发出。
   */
  setFriendAiReplyGenerator(
    gen: ((peerUid: number, msg: FriendChatMessage) => Promise<string | null>) | null
  ): void {
    this.friendAiReplyGenerator = gen
  }

  /**
   * 注入 AI 社交回复生成器（AI 私聊会话自动回复；LLM 链路就绪后由 index.ts 调用）。
   * 生成器按（目标 AI, 触发消息, 会话历史）产出回复文本，由 AiSocialService 以该 AI 身份写入会话。
   */
  setAiSocialReplyGenerator(
    gen: ((
      peer: { uid: number; aiId: number; name: string },
      trigger: AiChatMessage,
      history: AiChatMessage[]
    ) => Promise<string | null>) | null
  ): void {
    this.aiSocialReplyGenerator = gen
  }

  /**
   * 注入公示板 AI 参与生成器（公示板自动交流）。
   * 生成器按（AI, 触发对象, 上下文节选）产出评论正文，由 PublishBoardService 以该 AI 身份发表。
   */
  private publishBoardAiReplyGenerator:
    | ((
        ai: { uid: number; aiId: number; name: string },
        trigger: { kind: 'article' | 'comment'; article?: import('./publish-board/publish-board-types').PublishArticle; comment?: import('./publish-board/publish-board-types').PublishComment },
        history: Array<import('./publish-board/publish-board-types').PublishArticle | import('./publish-board/publish-board-types').PublishComment>
      ) => Promise<string | null>)
    | null = null

  setPublishBoardAiReplyGenerator(
    gen: ((
      ai: { uid: number; aiId: number; name: string },
      trigger: { kind: 'article' | 'comment'; article?: import('./publish-board/publish-board-types').PublishArticle; comment?: import('./publish-board/publish-board-types').PublishComment },
      history: Array<import('./publish-board/publish-board-types').PublishArticle | import('./publish-board/publish-board-types').PublishComment>
    ) => Promise<string | null>) | null
  ): void {
    this.publishBoardAiReplyGenerator = gen
  }

  /** 注入实际监听端口（startApiServer 返回后调用；回退动态端口时保持真实值） */
  setApiPort(port: number): void {
    this.apiPort = port
  }

  getRole(): 'standalone' | 'master' | 'satellite' {
    return this.config.getRole()
  }

  /** 该 uid 是否为已注册分系统账号（master 模式查询账本；其余模式恒 false）。主系统 CacheSync 据此排除分账号 cache 本机派生，直接信任同步镜像。 */
  isSatelliteUid(uid: number): boolean {
    return this.registry?.listSatellites().some((s) => s.uid === uid) ?? false
  }

  createAuthService(userStore: UserStore): AuthService {
    if (this.config.isSatellite()) {
      return new SatelliteAuth(userStore, this.config, this.tokenCache)
    }
    return new MasterAuth(userStore, this.config)
  }

  /**
   * 幂等装配主系统资产（registry/satelliteStore）。
   * 为什么存在：注册成为主系统走运行时路径（MasterAuth.register → becomeMaster 只写 instance.json），
   * 而构造器仅在启动时按 config.isMaster() 装配一次——两者脱节导致「运行时升级为主系统后
   * registry 仍为 null」：账号管理局全链路失效、备份中心通道不注册、/api/v1 不挂载（历史打包版 BUG）。
   * 作用：任何主系统能力入口（IPC getter / createMasterRouter / 归档）先调用本方法补齐资产，
   * 幂等无副作用——已是 master 且已装配则空操作，standalone/satellite 恒不装配。
   * 留存理由：不删的原因——热升级不重启配合本方法，才保证注册成功后账号管理局/备份中心立即可用。
   */
  private ensureMasterAssets(): void {
    if (this.config.isMaster() && !this.registry) {
      this.registry = new MasterRegistry(this.root)
      this.satelliteStore = new SatelliteStore(this.root)
    }
  }

  /** master 模式：构造 /api/v1 路由；非 master 返回 null（不暴露端口）。
   * 注：先 ensureMasterAssets 再判空，使「运行时升级为主系统」后调用方立即拿到路由。 */
  createMasterRouter(userStore: UserStore): Router | null {
    this.ensureMasterAssets()
    if (!this.registry || !this.satelliteStore) return null
    const deps: MasterRouterDeps = {
      registry: this.registry,
      satelliteStore: this.satelliteStore,
      userStore,
      instanceConfig: this.config,
      getMasterLan: () => this.masterLan,
      // 局域网推流门面（大备份分级专用）：未启动 LAN 时明确返回 null，/backup/download 大包分支报错不降级
      getLanPush: () =>
        this.lan
          ? {
              sendBytes: (uid, name, data, options) => this.sendLanBytes(uid, name, data, options),
              listPeers: () => this.lan?.listPeers() ?? []
            }
          : null
    }
    return createMasterRouter(deps)
  }

  /** 注册页意图：satellite 接入前探测主系统可达性 */
  async probeMaster(baseUrl: string): Promise<{ ok: boolean; appName?: string; error?: string }> {
    try {
      const url = baseUrl.replace(/\/+$/, '') + '/api/v1/hello'
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) return { ok: false, error: `主系统响应异常（HTTP ${res.status}）` }
      const body = (await res.json()) as { ok?: boolean; appName?: string }
      return { ok: body.ok === true, appName: body.appName }
    } catch (err) {
      return { ok: false, error: `无法连接主系统：${(err as Error).message}` }
    }
  }

  /**
   * 注册页意图：粘贴主系统接入链接 → 解析出 baseUrl + joinCode 暂存。
   * 尚未注册前无令牌；joinCode 随注册请求带回主系统做准入校验。
   */
  setPendingSatellite(link: string): { ok: boolean; error?: string } {
    if (this.config.isMaster()) return { ok: false, error: '本机已是主系统，不能接入其他主系统' }
    if (this.config.isSatellite()) return { ok: false, error: '本机已是分系统' }
    const parsed = parseJoinLink(link)
    if ('error' in parsed) return { ok: false, error: parsed.error }
    this.config.becomeSatellite({ baseUrl: parsed.baseUrl, instanceId: '', accessToken: '', joinCode: parsed.joinCode })
    return { ok: true }
  }

  /**
   * 主系统接入信息（设置页展示）：局域网可达地址 + 接入码 + 完整链接。
   * 非 master 返回 null。多网卡时取首个 IPv4（优先非回环、非内网虚拟网卡）。
   */
  getJoinInfo(): { baseUrl: string; code: string; link: string } | null {
    if (!this.config.isMaster()) return null
    const code = this.config.getJoinCode()
    if (!code) return null
    const host = this.pickLanIPv4() ?? '127.0.0.1'
    const baseUrl = `http://${host}:${this.apiPort}`
    return { baseUrl, code, link: `${baseUrl}/join?code=${code}` }
  }

  rotateJoinCode(): { ok: boolean; code?: string; link?: string; error?: string } {
    if (!this.config.isMaster()) return { ok: false, error: '仅主系统可轮换接入码' }
    const code = this.config.rotateJoinCode()
    const info = this.getJoinInfo()
    return { ok: true, code, link: info?.link }
  }

  /** 局域网可达 IPv4：优先 192.168/10/172.16 段，回退首个非回环 IPv4 */
  private pickLanIPv4(): string | null {
    const ifaces = networkInterfaces()
    const candidates: string[] = []
    for (const list of Object.values(ifaces)) {
      for (const item of list ?? []) {
        if (item.family !== 'IPv4' || item.internal) continue
        if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) {
          return item.address
        }
        candidates.push(item.address)
      }
    }
    return candidates[0] ?? null
  }

  /** 注册失败或误操作：无令牌缓存时允许退回单机模式 */
  resetRole(): { ok: boolean; error?: string } {
    if (this.config.isSatellite()) {
      const token = this.tokenCache.load()
      if (token) return { ok: false, error: '已持有主系统令牌，请先注销账号再操作' }
      this.config.standalone()
      return { ok: true }
    }
    return { ok: false, error: '仅分系统（未注册）可退回单机模式' }
  }

  /** master 启动补扫：对每个已注册分系统与主系统本机账号评估被动日归档（无变化零 IO）。
   * 先 ensureMasterAssets：运行时升级为主系统后再次进入也有资产可用（与 createMasterRouter 同源修复）。 */
  runArchiveSweep(): void {
    this.ensureMasterAssets()
    if (!this.registry || !this.satelliteStore) return
    for (const s of this.registry.listSatellites()) {
      this.satelliteStore.maybeArchiveDaily(s.instanceId)
    }
    const satelliteUids = new Set(this.registry.listSatellites().map((s) => s.uid))
    this.satelliteStore.maybeArchiveLocalDaily(satelliteUids)
  }

  getStatus(): { role: string; master: { baseUrl: string; instanceId: string } | null } {
    const master = this.config.get().master
    return {
      role: this.config.getRole(),
      master: master ? { baseUrl: master.baseUrl, instanceId: master.instanceId } : null
    }
  }

  /** satellite 免密恢复（启动时） */
  async restoreSatellite(userStore: UserStore): Promise<AuthUser | null> {
    if (!this.config.isSatellite()) return null
    const auth = this.createAuthService(userStore)
    return auth.restoreSatellite()
  }

  /** satellite 模式启动单向同步（oplog 采集 → outbox → 推送主系统）；其他角色空操作 */
  async startSync(): Promise<void> {
    if (!this.config.isSatellite()) return
    const master = this.config.get().master
    if (!master || !master.instanceId) return
    if (this.capture || this.syncEngine) return
    const client = new SatelliteClient(master.baseUrl)
    const engine = new SyncEngine(this.root, client, {
      instanceId: master.instanceId,
      getToken: () => this.tokenCache.load()?.accessToken ?? null,
      /**
       * 实体字节推送（同步分块面）：把本地 {root}/{entry.key} 经 lan-stream 分块推送到主系统
       * sync_staging（块 sha256 + 整体 sha256 终校验），push 元数据后由 applyPush 校验落镜像。
       * master uid 从 LAN peers 动态取（startSync 先于 startLan：首推时 LAN 未就绪返回 false，
       * sync-engine 的 30s 退避重试兜底，LAN 起来后下一轮 flush 送达）。
       */
      sendStagedEntity: async (entry) => {
        const masterPeer = this.lan?.listPeers().find((p) => p.role === 'master')
        if (!masterPeer) return false
        try {
          const abs = join(this.root, entry.key)
          const res = await this.sendLanFile(masterPeer.uid, abs, {
            // 流名承载 instanceId 与 key：收端 SyncStreamSink 按 'sync:' 前缀路由、实例白名单校验
            // 后落 {root}/sync_staging/U{uid}/{instanceId}/{key}（key 经 isValidKey 禁冒号，可安全切分）
            name: `${SYNC_STREAM_PREFIX}${master.instanceId}:${entry.key}`,
            // entry.hash = 'sha256:'+hex；lan-stream 终校验期望 hex 摘要（与发送循环 digest('hex') 对齐）
            totalSha256: entry.hash ? entry.hash.slice(7) : undefined
          })
          return res.ok
        } catch {
          return false
        }
      },
      // 运行期令牌过期（7 天 TTL）恢复：主动调 /auth/refresh 换新令牌并落盘，
      // 避免长跑分系统在令牌过期后同步永久 401（原来只能靠重启 restoreSatellite 恢复）
      refreshToken: async () => {
        const cached = this.tokenCache.load()
        if (!cached?.accessToken) return null
        try {
          const refreshed = await client.refresh(cached.accessToken)
          if (refreshed.ok && refreshed.token) {
            this.tokenCache.save({
              ...cached,
              accessToken: refreshed.token,
              exp: refreshed.tokenExp ?? cached.exp
            })
            return refreshed.token
          }
        } catch {
          // 主系统不可达：保持旧令牌交由退避重试
        }
        return null
      }
    })
    const capture = new OplogCapture(this.root, (op) => engine.enqueue(op))
    this.syncEngine = engine
    this.capture = capture
    await capture.start()
    engine.start()
  }

  /** satellite 模式停止同步（onBeforeQuit 调用，保证 outbox 落盘完整） */
  async stopSync(): Promise<void> {
    if (this.capture) {
      await this.capture.stop()
      this.capture = null
    }
    if (this.syncEngine) {
      this.syncEngine.stop()
      this.syncEngine = null
    }
  }

  // ===== 局域网通信层（L0：名册发现 + 终端直连 + 离线补偿，好友/聊天室/新闻共用底座） =====

  /**
   * 启动局域网直连服务（master/satellite 角色；standalone 无协作对端不启动）。
   * 启动流程：绑定端口 → 上报在线 → 拉名册刷 peers → 回连在线对端。
   * getAppConfig：给中继异步传输读取 AppConfig.relay（自定义下载位置/保留天数）；
   * 可选——未传时中继回退默认（下载位置 {root}/relay/downloads、保留 7 天）。
   */
  async startLan(userStore: UserStore, getAppConfig?: () => AppConfig): Promise<{ ok: boolean; port?: number; error?: string }> {
    const role = this.config.getRole()
    if (role === 'standalone' || this.lan) return { ok: true }
    this.lan = new LanService({
      root: this.root,
      role,
      getIdentity: () => {
        const u = userStore.getCurrentUser()
        return u ? { uid: u.UID, 用户名: u.用户名 } : null
      },
      pickLanIp: () => this.pickLanIPv4(),
      ...(role === 'master'
        ? {
            // 主系统本机即名册数据源：端口绑定后写入主系统 LAN 地址（roster 组装用）
            onLanStarted: (port) => {
              this.masterLan = { lanIp: this.pickLanIPv4(), lanPort: port }
            },
            getLocalRoster: () => this.buildLocalRoster(userStore)
          }
        : {
            // 分系统：经主系统上报在线/拉名册（令牌缓存命中时）
            reportLanStatus: async (info) => {
              const token = this.tokenCache.load()?.accessToken
              const master = this.config.get().master
              if (!token || !master) return { ok: false, error: '未连接主系统' }
              try {
                return await new SatelliteClient(master.baseUrl).reportLanOnline(token, info)
              } catch (err) {
                return { ok: false, error: (err as Error).message }
              }
            },
            fetchRoster: async () => {
              const token = this.tokenCache.load()?.accessToken
              const master = this.config.get().master
              if (!token || !master) return []
              const r = await new SatelliteClient(master.baseUrl).getRoster(token)
              if (!r.ok || !r.roster) return []
              return r.roster
                .filter((i) => i.status === 'active')
                .map((i): LanPeer => ({
                  uid: i.uid,
                  用户名: i.用户名,
                  role: i.role,
                  lanIp: i.lanIp ?? null,
                  lanPort: i.lanPort ?? LAN_DEFAULT_PORT,
                  online: i.online === true,
                  lastSeen: i.lastSeen ?? null
                }))
            }
          }),
      onMessage: (env) => {
        // L1 好友系统优先消费 friend.* 信封；L2 聊天室系统消费 chat-room.* 信封；L3 发布板消费 publish-board.* 信封；
        // L1.5 中继异步传输消费 relay.* 信封（上传登记/完成/通知/确认/下载完成/撤回）；其余转外部回调
        if (env.type.startsWith('friend.')) {
          this.friends?.handleLanEnvelope(env)
        } else if (env.type.startsWith('relay.')) {
          this.relay?.handleLanEnvelope(env)
        } else if (env.type.startsWith('chat-room.')) {
          this.chatRooms?.handleLanEnvelope(env)
        } else if (env.type.startsWith('publish-board.')) {
          this.publishBoard?.handleLanEnvelope(env)
        } else {
          this.lanOnMessage?.(env)
        }
      },
      onPeerStatus: (ev) => {
        this.friends?.handlePeerStatus(ev)
        this.chatRooms?.handlePeerStatus(ev)
        this.publishBoard?.handlePeerStatus(ev)
        this.lanOnPeerStatus?.(ev)
      },
      onStream: {
        onBegin: (peerUid, streamId, meta) => this.lanOnStream?.onBegin?.(peerUid, streamId, meta),
        onData: (peerUid, streamId, offset, data) => this.lanOnStream?.onData(peerUid, streamId, offset, data),
        onEnd: (peerUid, streamId, meta, error) => this.lanOnStream?.onEnd(peerUid, streamId, meta, error),
        onAbort: (peerUid, streamId, reason) => this.lanOnStream?.onAbort(peerUid, streamId, reason),
        onProgress: (peerUid, streamId, received, total) => this.lanOnStream?.onProgress?.(peerUid, streamId, received, total)
      }
    })
    const result = await this.lan.start()
    if (!result.ok) {
      this.lan = null
      return result
    }
    // L1 好友系统：装配业务门面（信封流转/离线补投/事件推送已在 LanService 回调中接线）
    this.friends = new FriendService({
      root: this.root,
      getIdentity: () => {
        const u = userStore.getCurrentUser()
        return u ? { uid: u.UID, 用户名: u.用户名 } : null
      },
      sendLan: (uid, type, payload) => this.sendLan(uid, type, payload),
      listPeers: () => this.lan?.listPeers() ?? [],
      listRoster: () => this.lan?.listRoster() ?? [],
      // 邀请制直传推流：接收方同意后本端经 LAN 二进制流发送文件/目录
      sendLanFile: (uid, filePath, options) => this.sendLanFile(uid, filePath, options),
      sendLanDirectory: (uid, dirPath, options) => this.sendLanDirectory(uid, dirPath, options),
      // 接收方下载位置：系统下载文件夹优先；异常（无桌面会话等）回退数据目录内 downloads/
      getDownloadDir: () => {
        try {
          return app.getPath('downloads')
        } catch {
          return join(this.root, 'downloads')
        }
      },
      emit: (event) => {
        const win = this.mainWindowGetter?.()
        if (win && !win.isDestroyed()) {
          win.webContents.send('friend:event', event)
        }
      },
      // AI 代理：私聊级开关 + 回复生成器（生成器由 index.ts 在 LLM 就绪后注入，
      // 未注入时私聊不自动回复，仅保留手动收发）
      aiConfig: this.aiAgentConfig,
      aiReply: async (peerUid, msg) => {
        const gen = this.friendAiReplyGenerator
        if (!gen) return null
        return gen(peerUid, msg)
      },
      // 中继切换：延迟注入（RelayService 装配晚于 FriendService，getter 运行时才取值；
      // 中继未就绪时 switchToRelay 明确报错而非静默降级）
      getRelay: () => this.relay
    })
    // 邀请制直传收件端：仅好友可向本机落盘（enableLanFileSink 由前端/装配链路唯一调用点）
    this.enableLanFileSink((uid) => this.friends?.isFriend(uid) ?? false)
    // 同步实体收件端（master 专有）：分系统 staged 大条目经 LAN 分块面先行到达。
    // 权限收紧到"已注册卫星"（好友列表更宽，会误纳主系统本机账号；注册账本是同步实体的精确对端集）
    if (role === 'master' && this.registry) {
      this.syncStreamSink?.reset()
      this.syncStreamSink = new SyncStreamSink({
        root: this.root,
        allowPeer: (uid) => this.registry?.listSatellites().some((s) => s.uid === uid) ?? false
      })
      this.lanOnStream = this.wireLanStream(this.lanOnStream)
    }
    // 备份包收件端（satellite 专有）：主系统大备份分级后经 LAN 分块面推送，按 transferId 落 backup_dl。
    // 收端不做对端白名单——转移方向固定为 master → satellite 且文件名带随机 transferId（防猜测），
    // 与 sync_staging 同构但归属键是业务 transferId（备份归属 uid 在 transferId 中，非 LAN 对端 uid）
    if (role === 'satellite') {
      this.backupStreamSink?.reset()
      this.backupStreamSink = new BackupStreamSink({ root: this.root })
      this.lanOnStream = this.wireLanStream(this.lanOnStream)
    }
    // 启动恢复：扫描残留 streaming 登记，重置为待同意并通知对端（恢复推流同样遵循同意制）
    this.friends?.recoverInterruptedTransfers()
    // L2 聊天室功能：装配业务门面
    this.chatRooms = new ChatRoomService({
      root: this.root,
      getIdentity: () => {
        const u = userStore.getCurrentUser()
        return u ? { uid: u.UID, 用户名: u.用户名 } : null
      },
      sendLan: (uid, type, payload) => this.sendLan(uid, type, payload),
      listPeers: () => this.lan?.listPeers() ?? [],
      listRoster: () => this.lan?.listRoster() ?? [],
      emit: (event) => {
        const win = this.mainWindowGetter?.()
        if (win && !win.isDestroyed()) {
          win.webContents.send('chat-room:event', event)
        }
      },
      // AI 代理：聊天室级开关 + 回复生成器（生成器由 index.ts 在 LLM 就绪后注入，
      // 未注入时 AI 发言身份仅作为可 @ 的发言名存在，不自动回复）
      aiConfig: this.aiAgentConfig,
      // ：AI 进场绑定注册表档案（同一账号的 AI 以 AIID 唯一身份进入群聊，
      // 名称/头像取自 ai-registry.json，防伪造且与好友面板/公示板身份一致）
      getAiProfile: (aiId) => {
        const c = this.aiSocial?.getContact(aiId) ?? null
        return c ? { uid: c.uid, aiId: c.aiId, name: c.name, avatar: c.avatar } : null
      },
      aiReply: async (ai, room, msg) => {
        const gen = this.aiReplyGenerator
        if (!gen) return null
        return gen({ ai, room, msg, history: this.chatRooms?.messages(room.gid) ?? [] })
      }
    })
    // L3 内部发布板：装配业务门面
    this.publishBoard = new PublishBoardService({
      root: this.root,
      getIdentity: () => {
        const u = userStore.getCurrentUser()
        return u ? { uid: u.UID, 用户名: u.用户名 } : null
      },
      sendLan: (uid, type, payload) => this.sendLan(uid, type, payload),
      listPeers: () => this.lan?.listPeers() ?? [],
      emit: (event) => {
        const win = this.mainWindowGetter?.()
        if (win && !win.isDestroyed()) {
          win.webContents.send('publish-board:event', event)
        }
      },
      // AI 上板：公示板级开关（沿用 AI 代理配置）+ 注册表身份解析 + 参与生成器（LLM 就绪后注入）
      aiConfig: this.aiAgentConfig,
      getAiProfile: (aiId) => {
        const c = this.aiSocial?.getContact(aiId) ?? null
        return c ? { uid: c.uid, aiId: c.aiId, name: c.name } : null
      },
      listAiProfiles: () =>
        (this.aiSocial?.listContacts() ?? []).map((c) => ({ uid: c.uid, aiId: c.aiId, name: c.name })),
      aiReply: async (ai, trigger, history) => {
        const gen = this.publishBoardAiReplyGenerator
        if (!gen) return null
        return gen(ai, trigger, history)
      }
    })
    // AI 社交：好友面板「我的 AI」+ AI 私聊会话。不依赖 LAN 直连（同账号 AI 在本机），
    // 与社交模块同生命周期装配；注册表与 ai.ts 同源（abyssac_data/ai-registry.json）。
    this.aiSocial = new AiSocialService({
      root: this.root,
      registryPath: join(this.root, 'ai-registry.json'),
      getIdentity: () => {
        const u = userStore.getCurrentUser()
        return u ? { uid: u.UID, 用户名: u.用户名 } : null
      },
      emit: (event) => {
        const win = this.mainWindowGetter?.()
        if (win && !win.isDestroyed()) {
          win.webContents.send('ai-social:event', event)
        }
      },
      aiReply: async (peer, trigger, history) => {
        const gen = this.aiSocialReplyGenerator
        if (!gen) return null
        return gen(peer, trigger, history)
      }
    })
    // L1.5 中继异步传输：主系统中继器（大云盘语义）。
    // master 持有中继存储端（{root}/relay/：条目清单 entries.json + 文件实体 files/{itemId}/）；
    // satellite/任意角色只做上传发起端与取件端。上传落主系统，接收端确认后从主系统下载回来，
    // 上传/下载两段独立带进度；下载位置为接收端自定义目录（AppConfig.relay 配置，未配置回退默认）。
    this.relay = new RelayService({
      root: this.root,
      getIdentity: () => {
        const u = userStore.getCurrentUser()
        return u ? { uid: u.UID, 用户名: u.用户名 } : null
      },
      getRole: () => this.config.getRole(),
      sendLan: (uid, type, payload) => this.sendLan(uid, type, payload),
      sendLanFile: (uid, filePath, options) => this.sendLanFile(uid, filePath, options),
      sendLanDirectory: (uid, dirPath, options) => this.sendLanDirectory(uid, dirPath, options),
      listRoster: () => this.lan?.listRoster() ?? [],
      // 中继下载位置：接 AppConfig.relay.downloadDir（用户自定义）；
      // 未配置/留空回退默认独立目录 {root}/relay/downloads（单一事实源 resolveRelayDownloadDir）
      getDownloadDir: () => resolveRelayDownloadDir(getAppConfig?.().relay?.downloadDir, this.root),
      // 无人确认保留天数：接 AppConfig.relay.retentionDays，未配置回退默认 7 天
      getRetentionDays: () => getAppConfig?.().relay?.retentionDays ?? RELAY_DEFAULT_RETENTION_DAYS,
      emit: (event) => {
        const win = this.mainWindowGetter?.()
        if (win && !win.isDestroyed()) {
          win.webContents.send('relay:event', event)
        }
      }
    })
    // 重建收件链：把中继收件器挂进流收端链（此时可能已有外部 onStream 观察者，保持透传）
    this.lanOnStream = this.wireLanStream(this.lanOnStream)
    return result
  }

  /** 停机：上报离线 + 关闭监听与全部连接（onBeforeQuit 调用） */
  async stopLan(): Promise<void> {
    this.lanFileSink?.reset()
    this.lanFileSink = null
    this.relay?.stop()
    this.relay = null
    this.lanOnStream = null
    if (!this.lan) return
    await this.lan.stop()
    this.lan = null
    this.masterLan = null
    // 清理好友服务与聊天室服务：LAN 关闭后不可再用
    this.friends = null
    this.chatRooms = null
    this.publishBoard = null
    this.aiSocial = null
  }

  getLanStatus(): { running: boolean; port: number; pendingCount: number; peers: LanPeer[]; roster: LanPeer[] } {
    const lan = this.lan
    return {
      running: lan?.isRunning() ?? false,
      port: lan?.getPort() ?? LAN_DEFAULT_PORT,
      pendingCount: lan?.getPendingCount() ?? 0,
      peers: lan?.listPeers() ?? [],
      roster: lan?.listRoster() ?? []
    }
  }

  /** 业务层接线：注册局域网消息/对端在线状态/二进制流回调（好友/聊天室/发布板模块在启动时调用） */
  registerLanCallbacks(cbs: {
    onMessage?: (env: LanEnvelope) => void
    onPeerStatus?: (ev: import('./lan/lan-types').LanPeerStatusEvent) => void
    onStream?: import('./lan/lan-stream').LanStreamCallbacks
  }): void {
    this.lanOnMessage = cbs.onMessage ?? null
    this.lanOnPeerStatus = cbs.onPeerStatus ?? null
    this.lanOnStream = this.wireLanStream(cbs.onStream ?? null)
  }

  /**
   * 启用文件收件端（默认安全的官方落盘实现）：把 incoming 收件链桥接到流收端。
   * - 权限判定 allowPeer：仅放行的对端 uid 可落盘；未调用本方法或未放行 → 对端字节完全不落盘
   * - 路径校验/幂等去重/威胁内容防线由收件器内置（{root}/incoming/{peerUid}/ 之外不写任何字节）
   * - 外部观察者回调（registerLanCallbacks.onStream）保持透传，二者同时消费（观察者模式）
   */
  enableLanFileSink(allowPeer?: (peerUid: number) => boolean): void {
    if (!this.lanFileSink) {
      this.lanFileSink = new LanFileSink({ root: this.root, allowPeer })
      this.lanOnStream = this.wireLanStream(this.lanOnStream)
      return
    }
    this.lanFileSink.setAllowPeer(allowPeer ?? null)
  }

  /** 组装流收端链：实时收件器（incoming 落盘）+ 同步实体收件器（sync_staging 落盘）+ 备份包收件器（backup_dl 落盘）+ 中继收件器（relay 落盘）+ 外部观察者（只读消费）。
   * 链式消费语义：每条流按 name 路由到唯一写盘者（sync: 前缀 → SyncStreamSink；backup: 前缀 → BackupStreamSink；
   * relay 标记 → 中继收件器；其余 → LanFileSink），观察者只读透传。 */
  private wireLanStream(
    outer: import('./lan/lan-stream').LanStreamCallbacks | null
  ): import('./lan/lan-stream').LanStreamCallbacks {
    const sink = this.lanFileSink
    const syncSink = this.syncStreamSink
    const backupSink = this.backupStreamSink
    const relayCbs = this.relay?.getStreamCallbacks() ?? null
    return {
      onBegin: (peerUid, streamId, meta) => {
        // relay 流：实时收件器整流跳过（见 lan-file-sink onBegin meta.relay），中继收件器接管落盘；
        // sync: 流：实时收件器整流跳过（非 sync: 前缀不消费），SyncStreamSink 接管落盘；
        // backup: 流：实时收件器整流跳过（非 backup: 前缀不消费），BackupStreamSink 按 transferId 落盘
        syncSink?.onBegin(peerUid, streamId, meta)
        backupSink?.onBegin(peerUid, streamId, meta)
        sink?.onBegin(peerUid, streamId, meta)
        relayCbs?.onBegin?.(peerUid, streamId, meta)
        outer?.onBegin?.(peerUid, streamId, meta)
      },
      onData: (peerUid, streamId, offset, data) => {
        // 每条流只有一个收件器实际写盘（sync/backup/relay 流的实时收件器 skipped，普通流的 sync/backup/relay 收件器整流忽略）
        syncSink?.onData(peerUid, streamId, offset, data)
        backupSink?.onData(peerUid, streamId, offset, data)
        sink?.onData(peerUid, streamId, offset, data)
        relayCbs?.onData?.(peerUid, streamId, offset, data)
        outer?.onData?.(peerUid, streamId, offset, data)
      },
      onEnd: (peerUid, streamId, meta, error) => {
        syncSink?.onEnd(peerUid, streamId, meta, error)
        backupSink?.onEnd(peerUid, streamId, meta, error)
        sink?.onEnd(peerUid, streamId, meta, error)
        relayCbs?.onEnd?.(peerUid, streamId, meta, error)
        outer?.onEnd?.(peerUid, streamId, meta, error)
      },
      onAbort: (peerUid, streamId, reason) => {
        syncSink?.onAbort(peerUid, streamId, reason)
        backupSink?.onAbort(peerUid, streamId, reason)
        sink?.onAbort(peerUid, streamId, reason)
        relayCbs?.onAbort?.(peerUid, streamId, reason)
        outer?.onAbort?.(peerUid, streamId, reason)
      },
      onProgress: outer?.onProgress
    }
  }

  /** AI 代理配置存储（chat_room_manage 工具据此开关聊天室 AI 自动回复） */
  getAiAgentConfig(): AiAgentConfigStore {
    return this.aiAgentConfig
  }

  /** 好友系统门面（LAN 已启动且有业务装配后可用；未启动返回 null） */
  getFriends(): FriendService | null {
    return this.friends
  }

  /** 聊天室门面（LAN 已启动且有业务装配后可用；未启动返回 null） */
  getChatRooms(): ChatRoomService | null {
    return this.chatRooms
  }

  /** 发布板门面（LAN 已启动且有业务装配后可用；未启动返回 null） */
  getPublishBoard(): PublishBoardService | null {
    return this.publishBoard
  }

  /** AI 社交门面（好友面板「我的 AI」+ AI 私聊会话；LAN 装配后可用） */
  getAiSocial(): AiSocialService | null {
    return this.aiSocial
  }

  /** 中继异步传输门面（L1.5 大云盘；LAN 启动且业务装配后可用，未启动返回 null） */
  getRelay(): RelayService | null {
    return this.relay
  }

  /** 通过局域网直连发送业务信封（好友/聊天室/发布板模块统一入口） */
  sendLan(uid: number, type: string, payload: unknown): LanSendResult {
    if (!this.lan) return { ok: false, mode: 'outbox', error: '局域网未启动' }
    return this.lan.sendTo(uid, type, payload)
  }

  /** 通过局域网直连发送二进制流（任意文件类型；块级 sha256 + 整体校验，多线路并发安全） */
  sendLanStream(uid: number, spec: import('./lan/lan-stream').SendStreamSpec, options?: { windowSize?: number }): Promise<import('./lan/lan-stream').SendStreamResult> {
    if (!this.lan) return Promise.resolve({ ok: false, error: '局域网未启动', ackedBytes: 0 })
    return this.lan.sendStream(uid, spec, options)
  }

  /** 便捷：局域网发送内存 Buffer（自动切块 + 整体哈希；relay/transferId 透传给收端做业务路由） */
  sendLanBytes(uid: number, name: string, data: Buffer, options?: { chunkSize?: number; windowSize?: number; relay?: LanStreamRelayTag; transferId?: string }): Promise<import('./lan/lan-stream').SendStreamResult> {
    if (!this.lan) return Promise.resolve({ ok: false, error: '局域网未启动', ackedBytes: 0 })
    return this.lan.sendBytes(uid, name, data, options)
  }

  /** 便捷：局域网发送本地文件（流式随机读盘，不整文件载入内存；relay 标记使收端走中继落盘语义） */
  sendLanFile(uid: number, filePath: string, options?: { name?: string; chunkSize?: number; windowSize?: number; relPath?: string; kind?: 'file' | 'dir'; relay?: LanStreamRelayTag; transferId?: string; totalSha256?: string }): Promise<import('./lan/lan-stream').SendStreamResult> {
    if (!this.lan) return Promise.resolve({ ok: false, error: '局域网未启动', ackedBytes: 0 })
    return this.lan.sendFile(uid, filePath, options)
  }

  /** 便捷：局域网发送整个目录（递归保结构，目录项流 + 文件流并发；聚合进度回调；relay 标记使收端走中继落盘语义） */
  sendLanDirectory(uid: number, dirPath: string, options?: {
    chunkSize?: number
    windowSize?: number
    concurrency?: number
    ignore?: (relPath: string) => boolean
    onProgress?: (p: import('./lan/lan-stream').LanDirectoryProgress) => void
    relay?: LanStreamRelayTag
    transferId?: string
  }): Promise<import('./lan/lan-stream').LanDirectoryResult> {
    if (!this.lan) return Promise.resolve({ ok: false, error: '局域网未启动', ackedBytes: 0, files: 0, dirs: 0 })
    return this.lan.sendDirectory(uid, dirPath, options)
  }

  /** master 模式构建本地名册：users.json 全体 + 分系统账本地址（roster 组装同源） */
  private buildLocalRoster(userStore: UserStore): LanPeer[] {
    if (!this.registry) return []
    const satellites = this.registry.listSatellites()
    const uidToSat = new Map(satellites.map((s) => [s.uid, s]))
    const now = Date.now()
    return userStore
      .listUsers()
      .map((u): LanPeer => {
        const sat = uidToSat.get(u.UID)
        if (!sat) {
          return {
            uid: u.UID,
            用户名: u.用户名,
            role: 'master',
            lanIp: this.masterLan?.lanIp ?? null,
            lanPort: this.masterLan?.lanPort ?? LAN_DEFAULT_PORT,
            online: this.masterLan != null,
            lastSeen: this.masterLan ? now : null
          }
        }
        return {
          uid: u.UID,
          用户名: u.用户名,
          role: 'satellite',
          lanIp: sat.lanIp ?? null,
          lanPort: sat.lanPort ?? LAN_DEFAULT_PORT,
          online: sat.status === 'active' && sat.lastSeen != null && now - sat.lastSeen < 90_000,
          lastSeen: sat.lastSeen ?? null
        }
      })
  }

  /** 备份收端门面（satellite 模式 BackupStreamSink 装配后可用；大备份 LAN 分块面落盘后按 transferId 取 zip 路径） */
  getBackupReceiver(): { awaitZipReady(transferId: string): Promise<string> } | null {
    return this.backupStreamSink ? { awaitZipReady: (transferId) => this.backupStreamSink!.awaitZipReady(transferId) } : null
  }

  /** 同步状态（管理窗口/设置页展示用） */
  getSyncStatus(): { running: boolean; ackedSeq: number; pendingCount: number } {
    return {
      running: this.syncEngine !== null,
      ackedSeq: this.syncEngine?.getAckedSeq() ?? 0,
      pendingCount: this.syncEngine?.getPendingCount() ?? 0
    }
  }

  registerIpc(ipc: typeof ipcMainType, deps: { getUserStore: () => UserStore | null; getMainWindow: () => BrowserWindow | null }): void {
    // 注入主窗口获取器：好友/聊天室/发布板事件推送目标（拆分前同语义）
    this.mainWindowGetter = deps.getMainWindow
    safeHandle(
      ipc, 'multi:getStatus',
      () => this.getStatus(),
      { role: 'standalone', master: null }
    )

    // ===== 域 IPC 注册：按域拆至 ipc/ 子模块（行为与拆分前逐字等价） =====
    const ctx: MultiInstanceIpcCtx = {
      root: this.root,
      // 惰性装配：注册成为主系统（auth:register createMaster）后，账号管理局/备份中心
      // 每次 IPC 调用经 getter 补齐 registry/satelliteStore，热升级无需重启。
      getRegistry: () => {
        this.ensureMasterAssets()
        return this.registry
      },
      getSatelliteStore: () => {
        this.ensureMasterAssets()
        return this.satelliteStore
      },
      getConfig: () => this.config,
      getTokenCache: () => this.tokenCache,
      getFriends: () => this.friends,
      getChatRooms: () => this.chatRooms,
      getPublishBoard: () => this.publishBoard,
      getAiSocial: () => this.aiSocial,
      getRelay: () => this.relay,
      getAiAgentConfig: () => this.aiAgentConfig,
      getUserStore: deps.getUserStore,
      getMainWindow: deps.getMainWindow,
      probeMaster: (baseUrl) => this.probeMaster(baseUrl),
      setPendingSatellite: (link) => this.setPendingSatellite(link),
      getJoinInfo: () => this.getJoinInfo(),
      rotateJoinCode: () => this.rotateJoinCode(),
      resetRole: () => this.resetRole(),
      stopSync: () => this.stopSync(),
      startSync: () => this.startSync(),
      getBackupReceiver: () => this.getBackupReceiver()
    }
    registerFriendIpc(ipc, ctx)
    registerAiSocialIpc(ipc, ctx)
    registerChatRoomIpc(ipc, ctx)
    registerPublishBoardIpc(ipc, ctx)
    registerRelayIpc(ipc, ctx)
    registerAccountIpc(ipc, ctx)
    registerBackupIpc(ipc, ctx)
  }
}

