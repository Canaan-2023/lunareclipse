/**
 * 流会话状态机：把 server.ts 对话流编排中靠闭包拼凑的“谁拥有当前流”
 * 收敛为显式相位机（idle/streaming/grace），统一排队、接管与超时语义，
 * 并保留迁移历史供排查，防止多流并发时的归属错乱问题。
 */
import { WebSocket } from 'ws'
import type { SubAgentEvent } from '../sub-agent'

/**
 * 流会话状态机

 * 背景：server.ts 的对话流编排原先靠五个闭包单例协作——streamChain（串行队列）、
 * streamOwnerWs（流归属连接）、activeStreamInfo（运行中快照）、currentSubAgentForwarder
 * （子代理事件转发器）、takeoverTimer（接管宽限计时器）。它们拼出一个"谁拥有当前流"
 * 的状态机，但没有任何一处能回答"现在处于什么相位"——本周五个 bug 全部长在这片暗区。

 * 本类把它们收拢为一个显式状态机：

 * idle ──enqueue(排队)──▶ streaming ──ownerClosed──▶ grace ──超时无接管──▶ idle
 * ▲ │ │
 * └─┤takeover(宽限内救回)────┘
 * └─takeover(运行中改道)：streaming → streaming

 * - phase 只描述"当前流"，排队深度用 queueDepth 独立记录（enqueue 可发生在任何相位）
 * - 重试是 streaming 相位内的递归 runStream（re-begin 同 messageId），不构成相位迁移
 * - runHeadlessChat 不推 WS，不 begin()，只占队列

 * 迁移历史保留最近 24 条（ring），供排查"流到底死在哪一步"——原来这只能靠读闭包代码推理。
 */

export type StreamPhase = 'idle' | 'streaming' | 'grace'

export interface ActiveStreamSnapshot {
  sessionId: string | undefined
  messageId: string
  startedAt: number
  output: string
  reasoning: string
  textRowId?: number
  reasoningRowId?: number
  turnId?: string
}

export interface PhaseRecord {
  at: number
  from: StreamPhase
  to: StreamPhase
  why: string
}

const HISTORY_LIMIT = 24
/** WebSocket 发送缓冲区上限：超过此值跳过本次发送，防止慢客户端导致内存无界增长 */
const MAX_BUFFERED_AMOUNT = 1024 * 1024

export class StreamSession {
  private phase: StreamPhase = 'idle'
  private queueDepth = 0
  private chain: Promise<void> = Promise.resolve()
  private owner: WebSocket | null = null
  private snapshot: ActiveStreamSnapshot | null = null
  private forwarder: ((evt: SubAgentEvent) => void) | null = null
  private graceTimer: NodeJS.Timeout | null = null
  private readonly history: PhaseRecord[] = []

  getPhase(): StreamPhase {
    return this.phase
  }

  getQueueDepth(): number {
    return this.queueDepth
  }

  getHistory(): readonly PhaseRecord[] {
    return this.history
  }

  private go(to: StreamPhase, why: string): void {
    if (this.phase === to) return
    this.history.push({ at: Date.now(), from: this.phase, to, why })
    if (this.history.length > HISTORY_LIMIT) this.history.shift()
    this.phase = to
  }

  /**
   * 串行队列：所有流式请求（WS 对话 / 持续激活续接 / runHeadlessChat）统一排队，
   * 同一时刻只有一个 stream（LLMClient 单实例串行设计的配套约束）。

   * 内部链吞掉异常保持永不断裂；调用方通过返回值感知异常。
    * 修复：原 runHeadlessChat 路径只 await streamChain.then(...) 未回写链条，
   * 并发 headless 调用会同时挂到同一尾节点、彼此不排队（与串行设计矛盾）；
   * 本实现统一回写 tail，队列语义对所有调用方一致。
   */
  enqueue(task: () => Promise<void>): Promise<void> {
    this.queueDepth++
    const run = this.chain.then(async () => {
      this.queueDepth--
      await task()
    })
    // chain 回写含当前 task 的 promise（吞掉异常保持永不断裂）；调用方通过返回值感知异常
    this.chain = run.catch(() => {})
    return run
  }

  /** runStream 开始：记录归属连接与运行快照（/api/streams/active 与 takeover 重放的数据源） */
  begin(owner: WebSocket, sessionId: string | undefined, messageId: string): ActiveStreamSnapshot {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    this.owner = owner
    this.snapshot = { sessionId, messageId, startedAt: Date.now(), output: '', reasoning: '' }
    this.go('streaming', `begin ${messageId}`)
    return this.snapshot
  }

  isOwner(ws: WebSocket): boolean {
    return this.owner === ws
  }

  ownerOr(fallback: WebSocket): WebSocket {
    return this.owner ?? fallback
  }

  isOpen(fallback: WebSocket): boolean {
    return this.ownerOr(fallback).readyState === WebSocket.OPEN
  }

  /** 推送到当前归属连接（内建 open 检查）；未连接返回 false，调用方无需再包 if */
  push(fallback: WebSocket, data: string): boolean {
    const target = this.ownerOr(fallback)
    if (target.readyState !== WebSocket.OPEN) return false
    if (target.bufferedAmount > MAX_BUFFERED_AMOUNT) return false
    target.send(data)
    return true
  }

  appendOutput(messageId: string, text: string): void {
    if (this.snapshot?.messageId === messageId) this.snapshot.output += text
  }

  appendReasoning(messageId: string, text: string): void {
    if (this.snapshot?.messageId === messageId) this.snapshot.reasoning += text
  }

  current(): ActiveStreamSnapshot | null {
    return this.snapshot
  }

  clearSnapshot(messageId: string): void {
    if (this.snapshot?.messageId === messageId) {
      this.snapshot = null
      // grace 相位下快照可被正常收尾清除，但相位由宽限计时器负责收场
      if (this.phase !== 'grace') this.go('idle', `clearSnapshot ${messageId}`)
    }
  }

  /** runStream 结束：清归属（若仍是本连接——防御并发抢占）+ 快照（若仍是本消息） */
  finish(ws: WebSocket, messageId: string): void {
    if (this.owner === ws) this.owner = null
    this.clearSnapshot(messageId)
  }

  setForwarder(fn: ((evt: SubAgentEvent) => void) | null): void {
    this.forwarder = fn
  }

  forward(evt: SubAgentEvent): void {
    this.forwarder?.(evt)
  }

  /**
   * 新连接接管运行中流（前端重载/断线重连后凭 /api/streams/active 发起）：
   * 推送目标改道 + 撤宽限计时。messageId 匹配返回快照供重放，否则 null。
   */
  takeover(ws: WebSocket, messageId: string): ActiveStreamSnapshot | null {
    if (!this.snapshot || this.snapshot.messageId !== messageId) return null
    this.owner = ws
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    this.go('streaming', `takeover ${messageId}`)
    return this.snapshot
  }

  /**
   * 归属连接关闭：不立即 abort，进入宽限等待新连接 takeover（重载/断线重连场景）。
   * 宽限内被 takeover 救回则流继续；超时仍无主则清快照并回调 onOrphan（abort 兜底）。
   */
  ownerClosed(onOrphan: () => void, graceMs = 5000): void {
    if (this.phase === 'grace') return
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    this.owner = null
    this.go('grace', 'ownerClosed')
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (!this.owner) {
        this.snapshot = null
        this.go('idle', 'graceExpired')
        onOrphan()
      }
    }, graceMs)
  }

  /** 服务器关闭兜底：清宽限计时器（不触发 onOrphan——进程都要退了） */
  dispose(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }
}
