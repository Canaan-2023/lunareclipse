/**
 * 为什么存在：多开实例互为对等节点，任何角色都可能被连接，须常驻监听端口并管理各对端 socket 与心跳保活。
 * 作用：启动 WebSocketServer 监听（端口被占用时自增重试），登记 hello、转发信封、心跳/超时清理并回调断线。
 */

import { WebSocket, WebSocketServer } from 'ws'
import { randomUUID } from 'crypto'
import type { LanEnvelope, LanHello } from './lan-types'
import { LAN_DEFAULT_PORT, LAN_MAX_PAYLOAD } from './lan-types'
import { isLanStreamFrame } from './lan-stream'

/**
 * 局域网直连服务端（每个参与直连的终端都监听一个固定端口）：
 * - 绑定 0.0.0.0 供对端直连（62003 起，被占自动回退 +1）
 * - 连接建立后任一方向先发 hello 交换身份，双方都收到对方 hello 才算握手完成
 * - 心跳 ping 20s：连续超时（40s 无 pong）判定对端离线并清理连接
 * - 同一 uid 只保留最近一条活跃连接（后连入者顶掉旧连接，避免双向重复建连）
 */
export interface LanServerCallbacks {
  /** 收到对端 hello（身份交换完成）：peer 为对端声明，socket 已可复用 */
  onHello: (peer: LanHello, socket: WebSocket) => void
  /** 收到业务信封（非 hello 类型） */
  onEnvelope: (env: LanEnvelope) => void
  /** 对端连接关闭（主动断或心跳超时）：uid 已从连接表移除 */
  onPeerClose: (uid: number) => void
  /**
   * 收到二进制流帧（magic='LMST'）：由上层 LanStreamManager 解析分发。
   * 与 JSON 信封共存于同一条 ws 连接，按帧首 4 字节 magic 分流互不干扰。
   */
  onStreamFrame?: (uid: number, raw: Buffer) => void
  /** 连接登记完成（入站握手/出站注册统一的登记点）：流管理器据此桥接收发 */
  onSocketAttached?: (uid: number, socket: WebSocket) => void
}

export class LanServer {
  private wss: WebSocketServer | null = null
  private readonly sockets = new Map<number, WebSocket>()
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private timeoutTimer: ReturnType<typeof setInterval> | null = null
  private listenPort = LAN_DEFAULT_PORT

  constructor(
    private readonly helloFactory: () => LanHello | null,
    private readonly callbacks: LanServerCallbacks
  ) {}

  /** 启动监听：从默认端口尝试，被占则 +1 回退；返回实际监听端口 */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      let attempt = 0
      const tryBind = (): void => {
        const port = LAN_DEFAULT_PORT + attempt
        const wss = new WebSocketServer({ host: '0.0.0.0', port, maxPayload: LAN_MAX_PAYLOAD })
        wss.on('listening', () => {
          this.wss = wss
          this.listenPort = port
          this.wire(wss)
          this.startHeartbeat()
          resolve(port)
        })
        wss.on('error', (err: NodeJS.ErrnoException) => {
          try {
            wss.close()
          } catch {
            // 忽略关闭异常
          }
          if (err.code === 'EADDRINUSE' && attempt < 20) {
            attempt += 1
            tryBind()
            return
          }
          reject(err)
        })
      }
      tryBind()
    })
  }

  getPort(): number {
    return this.listenPort
  }

  /** 向指定 uid 直连发送信封；无活跃连接返回 false（调用方决定入 outbox） */
  sendTo(uid: number, env: LanEnvelope): boolean {
    const socket = this.sockets.get(uid)
    if (!socket || socket.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(env))
    return true
  }

  /**
   * 注册一条出站连接（lan-client open 完成后由调用方登记为可发送通道）；pending 为握手期间缓冲的业务消息，接管后回放。
   * 返回是否被采纳：双向同时建连时若本连接落败（对端保留了既有连接），pending 经存活连接转发，避免消息丢失。
   */
  registerOutbound(uid: number, socket: WebSocket, pending: LanEnvelope[] = []): boolean {
    const initiator = this.helloFactory()?.uid
    if (initiator == null) {
      try {
        socket.terminate()
      } catch {
        // 忽略
      }
      return false
    }
    if (!this.attach(socket, uid, initiator)) return false
    for (const env of pending) {
      this.callbacks.onEnvelope(env)
    }
    return true
  }

  hasPeer(uid: number): boolean {
    return this.sockets.has(uid)
  }

  getSocket(uid: number): WebSocket | null {
    return this.sockets.get(uid) ?? null
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer)
      this.timeoutTimer = null
    }
    for (const ws of this.sockets.values()) {
      try {
        ws.terminate()
      } catch {
        // 已关闭的连接忽略
      }
    }
    this.sockets.clear()
    this.wss?.close()
    this.wss = null
  }

  private wire(wss: WebSocketServer): void {
    wss.on('connection', (socket) => {
      // 入站连接：等待对端先发 hello；迟到（>8s）则关闭防僵尸连接
      // （closure 监听统一由 attach 挂载，这里只处理握手期）
      const helloTimer = setTimeout(() => {
        try {
          socket.close(4001, 'hello timeout')
        } catch {
          // 忽略关闭异常
        }
      }, 8000)
      socket.on('message', (raw) => {
        try {
          const env = JSON.parse(raw.toString()) as LanEnvelope
          if (env.type !== 'hello') return // 未握手前只接受 hello
          clearTimeout(helloTimer)
          const peer = env.payload as LanHello
          // 回发本机 hello 完成双向握手（出站侧等待对端 hello 才 resolve）
          const mine = this.helloFactory()
          if (mine) {
            socket.send(
              JSON.stringify({
                id: randomUUID(),
                type: 'hello',
                from: mine.uid,
                to: peer.uid,
                ts: Date.now(),
                payload: mine
              } satisfies LanEnvelope)
            )
          }
          // 关键顺序：先 attach（挂统一消息/关闭监听、移除握手监听）再回调上层；
          // 入站连接必由对端出站发起，initiator 即对端 uid（与出站侧比较规则同源，双向同时建连时收敛一致）。
          if (!this.attach(socket, peer.uid, peer.uid)) return
          this.callbacks.onHello(peer, socket)
        } catch {
          // 非 JSON 消息忽略
        }
      })
    })
  }

  /**
   * 以 uid 键控登记连接（挂统一消息/关闭监听）。initiator 为本连接的发起方 uid：
   * - 出站连接的发起方是本机；入站连接的发起方是对端（hello.from）
   * - 双向同时建连时两端各自独立比较，规则「发起方 uid 小者保留、相等先到先得」收敛出同一条连接，
   * 杜绝「A 保留 A→B、B 保留 B→A、各自的另一端已被顶掉」导致双向断连
   */
  private attach(socket: WebSocket, uid: number, initiator: number): boolean {
    const old = this.sockets.get(uid)
    if (old && old !== socket) {
      const oldInitiator = (old as WebSocket & { lanInitiator?: number }).lanInitiator
      // 新连接发起方 uid 不小于旧连接时落败：关闭新连接、保留旧连接（对端大概率保留的正是旧连接）
      if (initiator >= (oldInitiator ?? Number.MAX_SAFE_INTEGER)) {
        try {
          socket.terminate()
        } catch {
          // 忽略
        }
        return false
      }
      try {
        old.terminate()
      } catch {
        // 忽略
      }
    }
    this.sockets.set(uid, socket)
    ;(socket as WebSocket & { lanUid?: number }).lanUid = uid
    ;(socket as WebSocket & { lanInitiator?: number }).lanInitiator = initiator
    // 心跳基线：登记时打一次时间戳，此后由 pong 事件刷新。
    // 修复：此前只在「发送 ping 时」赋时间戳且无人监听 pong，超时判定恒为假，
    // 对端静默消失（休眠/断网无 FIN）时连接永不清理、在线状态长期失真。
    ;(socket as WebSocket & { lanLastPong?: number }).lanLastPong = Date.now()
    socket.on('pong', () => {
      ;(socket as WebSocket & { lanLastPong?: number }).lanLastPong = Date.now()
    })
    // 接管连接：移除握手中的临时监听（lan-client 的握手监听器/入站 hello 监听器），
    // 防止其将后续消息重复缓冲或吞掉；此后业务消息统一走下面这个监听器。
    socket.removeAllListeners('message')
    socket.on('message', (raw) => {
      const buf = raw as Buffer
      if (this.callbacks.onStreamFrame && isLanStreamFrame(buf)) {
        // 二进制流帧：直通流管理器（信封通道完全不受影响）
        this.callbacks.onStreamFrame(uid, buf)
        return
      }
      try {
        const env = JSON.parse(buf.toString()) as LanEnvelope
        if (env.type === 'hello') return // 已登记连接不再重复握手
        this.callbacks.onEnvelope(env)
      } catch {
        // 非法消息忽略（协议外数据）
      }
    })
    // 出站连接（registerOutbound 路径）在 wire() 里没有挂过这些监听，
    // 必须在此统一补挂：否则对端下线后死 socket 残留，在线状态永远失真。
    socket.on('close', () => {
      this.detach(socket)
    })
    socket.on('error', () => {
      try {
        socket.terminate()
      } catch {
        // 忽略
      }
    })
    // 流管理器桥接：登记完成（入站/出站统一路径）后通知上层挂接收发
    this.callbacks.onSocketAttached?.(uid, socket)
    return true
  }

  private detach(socket: WebSocket): void {
    const uid = (socket as WebSocket & { lanUid?: number }).lanUid
    if (uid == null) return
    if (this.sockets.get(uid) === socket) {
      this.sockets.delete(uid)
      this.callbacks.onPeerClose(uid)
    }
  }

  private startHeartbeat(): void {
    // 每 20s 对所有连接 ping；40s 未收到 pong 视为超时断开（时间戳由 attach 的 pong 监听刷新）
    this.heartbeatTimer = setInterval(() => {
      for (const [, socket] of this.sockets) {
        if (socket.readyState !== WebSocket.OPEN) continue
        socket.ping()
      }
    }, 20_000)
    this.timeoutTimer = setInterval(() => {
      const now = Date.now()
      for (const [, socket] of [...this.sockets]) {
        const last = (socket as WebSocket & { lanLastPong?: number }).lanLastPong
        if (last == null || socket.readyState !== WebSocket.OPEN) continue
        if (now - last > 40_000) {
          try {
            socket.terminate()
          } catch {
            // 忽略
          }
        }
      }
    }, 10_000)
  }
}