/**
 * 为什么存在：上层业务（好友/群聊/发布板）都依赖"发现-直连-投递"原语，需要集中一处装配服务器/客户端/对端表/离线信箱。
 * 作用：LAN 统一门面：启动/停止整套局域网底座，按 toUid 投递信封（直连或离线 outbox），上报对端与花名册状态。
 */

import { WebSocket } from 'ws'
import { randomUUID } from 'crypto'
import type { LanEnvelope, LanHello, LanPeer, LanPeerStatusEvent } from './lan-types'
import { LAN_DEFAULT_PORT } from './lan-types'
import { LanServer } from './lan-server'
import { openLanConnection } from './lan-client'
import { LanPeerStore } from './peer-store'
import { LanOutbox } from './outbox'
import { LanStreamManager, parseLanStreamFrame } from './lan-stream'
import type { LanStreamCallbacks, SendStreamResult, SendStreamSpec } from './lan-stream'

/**
 * 在线心跳周期（60s）：主系统 roster 以 lastSeen 距今 <90s 判定在线；ws 层的 20s ping
 * 只保连接存活、不刷新 lastSeen，所以需要应用层心跳把 lastSeen 保持在判定窗口内。
 * 60s = 判定窗口的 2/3，留出上报延迟与单次失败的余量；若调整此值，须同步理解 90s 判定窗口。
 */
const LAN_HEARTBEAT_INTERVAL_MS = 60_000

/**
 * 局域网通信层门面（L0 底座）：
 * - 启动：绑定直连端口 → 上报在线（satellite 经主系统 /lan/online，master 本机即数据源）→ 拉 roster 刷 peers → 回连在线对端
 * - 发送：直连已存在 → 直接发；有地址无连接 → 出站握手后发；失败 → 入 outbox 落盘
 * - 接收：对端 hello 到达 → 记 online + lastSeen → 补投 outbox → onPeerStatus 通知上层
 * - 停机：上报离线 + 关闭连接与监听
 * 业务语义（好友/群/新闻）不在此层：信封原样转发给 onMessage。
 */
export interface LanServiceDeps {
  /** 数据根目录（federation/ 挂其下） */
  root: string
  /** 当前角色：standalone 不启动 LAN */
  role: 'master' | 'satellite'
  /** 当前登录用户的（UID, 用户名）；未登录返回 null（LAN 不发送） */
  getIdentity: () => { uid: number; 用户名: string } | null
  /** 本机局域网可达 IPv4（无则 LAN 不发、不上报地址） */
  pickLanIp: () => string | null
  /** master 模式：本地构造全员名册（registry 卫星 + users，含各自地址与在线态） */
  getLocalRoster?: () => LanPeer[]
  /** satellite 模式：向主系统上报在线/离线（lanIp/lanPort/online） */
  reportLanStatus?: (info: { lanIp: string | null; lanPort: number; online: boolean }) => Promise<{ ok: boolean; error?: string }>
  /** satellite 模式：从主系统拉全员名册（含地址） */
  fetchRoster?: () => Promise<LanPeer[]>
  /** server 绑定端口后回调（master 模式据此写入本机地址，再拉 roster） */
  onLanStarted?: (port: number) => void
  /** 业务信封回调（收到对端发来的非 hello 消息） */
  onMessage?: (env: LanEnvelope) => void
  /** 对端在线状态变化（好友列表/群成员徽标用） */
  onPeerStatus?: (ev: LanPeerStatusEvent) => void
  /**
   * 二进制流接收回调（任意文件类型的传输通道，与信封通道互补）：
   * onData 按 offset 提供已通过块级 sha256 校验的原始字节，业务层负责落盘/路径校验；
   * onEnd 携带整体校验结论（error 非空 = 校验失败）；onAbort 表示流中途失败。
   */
  onStream?: LanStreamCallbacks
}

export interface LanSendResult {
  ok: boolean
  /** 直连送达 | 入 outbox 待补投 | 发送源不可用 */
  mode: 'direct' | 'outbox' | 'no-identity'
  error?: string
}

export class LanService {
  private readonly server: LanServer
  private readonly peers: LanPeerStore
  private readonly outbox: LanOutbox
  /** 二进制流管理器：同一 ws 连接上承载 LMST 流帧（与 JSON 信封按 magic 分流共存） */
  private readonly streams: LanStreamManager
  private started = false
  private stopped = false
  /** 正在尝试出站连接的对端 uid（防对同一 uid 并发建多个连接） */
  private readonly connecting = new Set<number>()
  /** 分系统在线心跳定时器：主系统 roster 以 lastSeen 距今 <90s 判在线，仅启动/停机各上报一次会 90s 后失真 */
  private lanHeartbeat: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: LanServiceDeps) {
    this.peers = new LanPeerStore(deps.root)
    this.outbox = new LanOutbox(deps.root)
    this.streams = new LanStreamManager(
      {
        onBegin: (peerUid, streamId, meta) => this.deps.onStream?.onBegin?.(peerUid, streamId, meta),
        onData: (peerUid, streamId, offset, data) => this.deps.onStream?.onData(peerUid, streamId, offset, data),
        onEnd: (peerUid, streamId, meta, error) => this.deps.onStream?.onEnd(peerUid, streamId, meta, error),
        onAbort: (peerUid, streamId, reason) => this.deps.onStream?.onAbort(peerUid, streamId, reason),
        onProgress: this.deps.onStream?.onProgress
      }
    )
    this.server = new LanServer(
      () => this.makeHello(),
      {
        onHello: (peer, socket) => this.handlePeerHello(peer, socket),
        onEnvelope: (env) => this.deps.onMessage?.(env),
        onPeerClose: (uid) => this.handlePeerClose(uid),
        // 二进制帧直通流管理器；握手期（wire 的 hello 监听）天然按 JSON 处理，流帧在握手后才会出现
        onStreamFrame: (uid, raw) => {
          const frame = parseLanStreamFrame(raw)
          if (frame) this.streams.handleFrame(uid, frame)
        },
        // 连接登记（入站/出站统一路径）后桥接：该 uid 的流帧经此 socket 收发
        onSocketAttached: (uid, socket) => this.streams.attachSocket(uid, socket)
      }
    )
  }

  /** 启动 LAN：绑定端口 → 上报在线 → 拉 roster → 回连在线对端 */
  async start(): Promise<{ ok: boolean; port?: number; error?: string }> {
    if (this.started) return { ok: true, port: this.server.getPort() }
    try {
      const port = await this.server.start()
      this.started = true
      this.stopped = false
      const hello = this.makeHello()

      // 0. 绑定完成后回调（master 模式写入本机地址供 roster 组装）
      this.deps.onLanStarted?.(port)

      // 1. 上报在线（master 本机无上报端点：直接以本机身份参与名册）
      if (this.deps.role === 'satellite' && this.deps.reportLanStatus) {
        try {
          await this.deps.reportLanStatus({ lanIp: hello?.lanIp ?? null, lanPort: port, online: true })
        } catch (err) {
          console.warn('[lan] 上报在线失败（后续心跳补偿）:', (err as Error).message)
        }
        // 主系统 roster 以 lastSeen 距今 <90s 判定在线：仅启动上报一次会在 90s 后把仍存活的
        // 分系统误标为离线（ws 20s ping 只保连接、不刷 lastSeen）。心跳维持 lastSeen 新鲜；
        // 心跳失败静默（下一次心跳续上），stop() 清理定时器。
        this.lanHeartbeat = setInterval(() => {
          const h = this.makeHello()
          void this.deps.reportLanStatus?.({ lanIp: h?.lanIp ?? null, lanPort: port, online: true }).catch(() => {})
        }, LAN_HEARTBEAT_INTERVAL_MS)
      }

      // 2. 拉 roster 刷 peers 与缓存
      try {
        const roster = this.deps.role === 'master' ? this.deps.getLocalRoster?.() : await this.deps.fetchRoster?.()
        if (roster && roster.length > 0) {
          this.peers.saveRosterCache(roster)
          this.peers.applyRoster(roster)
        }
      } catch (err) {
        console.warn('[lan] 拉取名册失败（保留历史 peers）:', (err as Error).message)
      }

      // 3. 回连在线且已知地址的对端（失败静默，稍后可按需重连）
      const targets = this.peers.listPeers().filter((p) => p.online && p.lanIp && p.uid !== hello?.uid)
      for (const peer of targets.slice(0, 32)) {
        void this.ensureConnected(peer)
      }

      console.log(`[lan] 局域网直连服务已启动：端口 ${port}，已登记 ${targets.length} 个在线对端`)
      return { ok: true, port }
    } catch (err) {
      this.started = false
      return { ok: false, error: (err as Error).message }
    }
  }

  /** 停机：上报离线 + 关闭监听与全部连接 */
  async stop(): Promise<void> {
    if (!this.started) {
      this.stopped = true
      return
    }
    this.stopped = true
    if (this.lanHeartbeat) {
      clearInterval(this.lanHeartbeat)
      this.lanHeartbeat = null
    }
    if (this.deps.role === 'satellite' && this.deps.reportLanStatus) {
      try {
        await this.deps.reportLanStatus({ lanIp: null, lanPort: this.server.getPort(), online: false })
      } catch {
        // 主系统不可达时忽略（对端按心跳超时判定离线）
      }
    }
    this.server.stop()
    // 终止流管理器：中止全部活跃流并回收哈希 worker 池（防句柄泄漏）
    this.streams.destroy()
    this.started = false
  }

  getPort(): number {
    return this.server.getPort()
  }

  isRunning(): boolean {
    return this.started && !this.stopped
  }

  /** 全员名册（roster-cache 刷新后即最新；send/UI 用） */
  listRoster(): LanPeer[] {
    return this.peers.loadRosterCache()?.items ?? this.peers.listPeers()
  }

  /** 直连对端表（含 lastSeen/online） */
  listPeers(): LanPeer[] {
    return this.peers.listPeers()
  }

  getPeer(uid: number): LanPeer | null {
    return this.peers.getPeer(uid)
  }

  /** 待补投消息数（管理窗口展示用） */
  getPendingCount(): number {
    return this.outbox.countPending()
  }

  /**
   * 发送业务信封到指定 uid：
   * 直连可达 → 立即送达；不可达但已知地址 → 出站握手再发；仍失败 → 入 outbox 补投。
   */
  sendTo(uid: number, type: string, payload: unknown): LanSendResult {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, mode: 'no-identity', error: '未登录，无法发送' }
    // LAN 未启动（本方刚启动/离线恢复窗口）：不丢消息——立即入 outbox，等启动后对端上线补投
    if (!this.isRunning()) {
      this.outbox.enqueue(identity.uid, uid, payload, type, Date.now())
      return { ok: true, mode: 'outbox', error: '局域网未启动，消息已入补投队列，启动后将自动补投' }
    }
    const env: LanEnvelope = { id: randomUUID(), type, from: identity.uid, to: uid, ts: Date.now(), payload }

    if (this.server.sendTo(uid, env)) {
      return { ok: true, mode: 'direct' }
    }
    const peer = this.peers.getPeer(uid)
    if (peer?.lanIp) {
      // 有地址：异步补一次出站直连，成功后立即投递；失败则落 outbox
      void this.ensureConnectedAndSend(peer, env)
      return { ok: true, mode: 'outbox', error: '对端不在线，已排队（直连尝试中）' }
    }
    this.outbox.enqueue(identity.uid, uid, payload, type, env.ts)
    return { ok: true, mode: 'outbox', error: '对端地址未知，已入补投队列' }
  }

  /**
   * 发送二进制流到指定 uid（不受文件类型限制：data 帧为原始字节，块级 sha256 + 整体校验）。
   * 与 sendTo 的信封通道互补：文本/结构化载荷走信封，大文件/二进制走流。
   * 流帧与信封帧在同一条 ws 连接上按 magic 分流，互不阻塞。
   * 需要多线路并发时并发调用多次（不同 streamId 交错发送），或用 windowSize 调滑窗深度。
   */
  sendStream(uid: number, spec: SendStreamSpec, options?: { windowSize?: number }): Promise<SendStreamResult> {
    return this.streams.sendStream(uid, spec, options)
  }

  /** 便捷：发送内存 Buffer（自动切块 + 整体哈希） */
  sendBytes(uid: number, name: string, data: Buffer, options?: { chunkSize?: number; windowSize?: number }): Promise<SendStreamResult> {
    return this.streams.sendBytes(uid, name, data, options)
  }

  /** 便捷：发送本地文件（流式随机读盘，不整文件载入内存） */
  sendFile(uid: number, filePath: string, options?: { name?: string; chunkSize?: number; windowSize?: number; relPath?: string; kind?: 'file' | 'dir'; transferId?: string; totalSha256?: string }): Promise<SendStreamResult> {
    return this.streams.sendFile(uid, filePath, options)
  }

  /** 便捷：发送整个目录（递归保结构；目录项流 + 文件流多线路并发；聚合进度回调） */
  sendDirectory(
    uid: number,
    dirPath: string,
    options?: {
      chunkSize?: number
      windowSize?: number
      concurrency?: number
      ignore?: (relPath: string) => boolean
      onProgress?: (p: import('./lan-stream').LanDirectoryProgress) => void
      transferId?: string
    }
  ): Promise<import('./lan-stream').LanDirectoryResult> {
    return this.streams.sendDirectory(uid, dirPath, options)
  }

  /** 诊断/测试：流管理器实例（活跃流数、哈希池大小） */
  getStreamManager(): LanStreamManager {
    return this.streams
  }

  /** 尝试直连并立即投递；失败落 outbox（与 ensureConnected 复用连接防重）
   * 补投重入队时保留原信封 ts（发送时刻），不重新生成时间戳 */
  private async ensureConnectedAndSend(peer: LanPeer, env: LanEnvelope): Promise<void> {
    const socket = await this.ensureConnected(peer)
    if (socket) {
      if (!this.server.sendTo(peer.uid, env)) {
        this.outbox.enqueue(env.from, peer.uid, env.payload, env.type, env.ts)
      }
    } else {
      this.outbox.enqueue(env.from, peer.uid, env.payload, env.type, env.ts)
    }
  }

  /** 确保与对端存在活跃出站连接；已连接返回 null（无需再连）；连接失败返回 null 并置在线状态为离线 */
  private async ensureConnected(peer: LanPeer): Promise<WebSocket | null> {
    if (!peer.lanIp) return null
    if (this.server.hasPeer(peer.uid)) return this.server.getSocket(peer.uid)
    if (this.connecting.has(peer.uid)) return null
    this.connecting.add(peer.uid)
    try {
      const hello = this.makeHello()
      if (!hello) return null
      const { socket, peer: remoteHello, pending } = await openLanConnection(hello, peer.lanIp, peer.lanPort || LAN_DEFAULT_PORT)
      if (!this.server.registerOutbound(remoteHello.uid, socket, pending)) {
        // 本出站连接在双向同时建连中落败：对端保留的是既有连接（本机该 uid 已有存活连接），直接复用它
        return this.server.getSocket(remoteHello.uid) ?? null
      }
      // 出站握手完成：登记对端在线并补投
      this.handlePeerHello(remoteHello, socket)
      return socket
    } catch (err) {
      // 直连失败：标记离线（保留地址供下次重连），不重试（上层按需再次调用）
      this.peers.updatePeer({ ...peer, online: false, lastSeen: peer.lastSeen })
      this.deps.onPeerStatus?.({ peer: { ...peer, online: false }, online: false })
      void err
      return null
    } finally {
      this.connecting.delete(peer.uid)
    }
  }

  /**
   * 收到对端 hello（入站或出站握手完成）：
   * 登记在线态 → 更新地址 → 补投 outbox → 通知上层。
   */
  private handlePeerHello(peer: LanHello, socket: WebSocket): void {
    const prev = this.peers.getPeer(peer.uid)
    const merged: LanPeer = {
      uid: peer.uid,
      用户名: peer.用户名,
      role: peer.role,
      lanIp: peer.lanIp ?? prev?.lanIp ?? null,
      lanPort: peer.lanPort || prev?.lanPort || LAN_DEFAULT_PORT,
      online: true,
      lastSeen: Date.now()
    }
    this.peers.updatePeer(merged)
    const delivered = this.outbox.flushTo(peer.uid, (env) => this.server.sendTo(peer.uid, env))
    if (delivered > 0) {
      console.log(`[lan] 对端在线，补投 ${delivered} 条消息 → uid=${peer.uid}`)
    }
    this.deps.onPeerStatus?.({ peer: merged, online: true })
    void socket
  }

  /** 对端连接关闭：置离线并通知上层（地址保留供重连） */
  private handlePeerClose(uid: number): void {
    this.streams.detachSocket(uid)
    const peer = this.peers.getPeer(uid)
    if (!peer) return
    this.peers.updatePeer({ ...peer, online: false })
    this.deps.onPeerStatus?.({ peer: { ...peer, online: false }, online: false })
  }

  /** 本机 hello 身份声明（未登录返回 null） */
  private makeHello(): LanHello | null {
    const identity = this.deps.getIdentity()
    if (!identity) return null
    return {
      uid: identity.uid,
      用户名: identity.用户名,
      role: this.deps.role,
      lanIp: this.deps.pickLanIp(),
      lanPort: this.started ? this.server.getPort() : LAN_DEFAULT_PORT
    }
  }
}