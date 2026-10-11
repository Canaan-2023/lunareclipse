/**
 * 为什么存在：LanEnvelope（JSON 信封）只承载 UTF-8 文本，二进制文件必须 base64 转码
 * （体积 +33%、内存翻倍、无法分块校验）；且单信封一次 send 大载荷独占 ws 发送缓冲、
 * 阻塞同连接其它业务消息，无法并发、无法断点续传。
 * 作用：在既有 ws 连接之上新增「多路二进制流」子协议（二进制帧 magic 前缀辨识，与
 * JSON 信封共存，业务信封语义零改动）：
 * 1. 任意文件类型：data 帧 payload 为原始字节，不做文本假设（不受 base64/JSON 限制）；
 * 2. 分块校验：按 chunkSize 分块、逐块在途传递（整文件不驻留发送端内存），
 * 块级 sha256（每块独立校验）为完整性主防线；可选整体 sha256 终校验
 * 在收端按块增量更新（createHash.update，O(1) 内存），不限制文件大小；
 * 3. 多线路并发：同一连接上多条 stream（不同 streamId）交错发送（应用层多路复用，
 * 同 HTTP/2 思路——单 TCP 局域网带宽已够打满，无需拆多条 TCP）；
 * 单条 stream 内部为「滑动窗口 + 在途上限」pipelined 发送，读/发/确认流水化；
 * 4. 多核利用：块哈希交给 LanHashPool（worker_threads 池）并行计算，
 * 不阻塞主线程的事件循环与 socket 收发。
 * 协议帧（固定 28 字节头 + payload；data 帧 payload 后可选附 32B 块 sha256）：
 * [0:4) magic 'LMST'（与 JSON 信道的 '{' 首字节不冲突）
 * [4] version = 1
 * [5] type = 1 begin | 2 data | 3 ack | 4 nak | 5 end | 6 abort
 * [6] flags = bit0: data 帧尾附 32B sha256（data 帧必选）
 * [7] 保留
 * [8:12) streamId (uint32 BE)：一次文件传输的会话号（发送方分配，连接内唯一）
 * [12:16) seq (uint32 BE)：data 帧的块序号（0..chunkCount-1）
 * [16:24) offset (uint64 BE)：data 帧在文件中的字节偏移（收端按此落位，支持乱序/重传覆盖）
 * [24:28) length (uint32 BE)：payload（块数据）字节数
 *
 * begin 帧 payload = JSON: { name, size, chunkSize, chunkCount, totalSha256 }
 * totalSha256 为空串表示不启用整体终校验（发送方未预读全文件时）
 * ack 帧 payload = JSON: { upToSeq }（累计确认：<= upToSeq 的块全部收妥）
 * nak 帧 payload = JSON: { seqs: number[] }（块级校验失败或缺块，请求立即重传）
 * end 帧 payload = JSON: { ok }（收端全量收齐后的终校验结论，回给发送端）
 * abort 帧 payload = JSON: { reason }
 */

import type { WebSocket } from 'ws'
import { createHash } from 'crypto'
import { open, readdir, stat } from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { basename, join } from 'path'
import { LanHashPool } from './lan-hash-pool'

// ============================================================
// 帧常量与编解码
// ------------------------------------------------------------

export const LAN_STREAM_MAGIC = 0x4c4d5354 // 'LMST'
export const LAN_STREAM_VERSION = 1
export const LAN_STREAM_HEADER_LEN = 28
export const LAN_STREAM_CHUNK_HASH_LEN = 32 // sha256 二进制长度

export const LAN_STREAM_TYPE_BEGIN = 1
export const LAN_STREAM_TYPE_DATA = 2
export const LAN_STREAM_TYPE_ACK = 3
export const LAN_STREAM_TYPE_NAK = 4
export const LAN_STREAM_TYPE_END = 5
export const LAN_STREAM_TYPE_ABORT = 6

const LAN_STREAM_FLAG_CHUNK_HASH = 0b0000_0001

export const LAN_STREAM_DEFAULT_CHUNK_SIZE = 1024 * 1024 // 1MB
/** 单条 stream 最大在途块数（滑动窗口） */
export const LAN_STREAM_DEFAULT_WINDOW = 8
/** 单块发送后等待确认超时（ms）；超时触发重传 */
export const LAN_STREAM_RETRANSMIT_TIMEOUT_MS = 3_000
/** 单块最大重传次数；超出后 abort 整条流（避免坏块无限循环） */
export const LAN_STREAM_MAX_RETRIES = 3
/**
 * 单文件大小防线：不再设"业务上限"（512MB 限制已移除，传输任意大小文件），
 * 仅保留 Number.MAX_SAFE_INTEGER 作元数据防呆——超过 JS safe integer 的 size 无法可靠表达，
 * 直接拒绝 begin（防御性护栏，不是业务限制）。
 */
export const LAN_STREAM_MAX_FILE = Number.MAX_SAFE_INTEGER

export interface LanStreamBeginMeta {
  /** 业务文件名（收端落盘用；文件夹传输时为目录/文件相对路径的末段） */
  name: string
  size: number
  chunkSize: number
  chunkCount: number
  /** 整体 sha256（hex）；空串 = 收端跳过整体终校验 */
  totalSha256: string
  /** 文件夹传输：相对根目录的多级相对路径（含子目录层级）；缺省 = 单文件流，落 {uid}/{name} */
  relPath?: string
  /** 文件夹传输：目录项流（size=0，收端仅创建目录）；缺省 = 普通文件流 */
  kind?: 'file' | 'dir'
  /** 中继异步传输标记（携带 = 中继流，收端按中继语义落盘；缺省 = 普通实时流） */
  relay?: LanStreamRelayTag
  /** 业务传输关联号（邀请制直传的 transferId）：接收方据此关联卡片进度与完成；缺省 = 无关联 */
  transferId?: string
}

export interface LanStreamFrame {
  type: number
  flags: number
  streamId: number
  seq: number
  offset: bigint
  /** 块数据（data 帧）或控制载荷（JSON 字节） */
  payload: Buffer
  /** data 帧尾附的块 sha256（hex），无则 null */
  chunkHash: string | null
}

/** 是否二进制流帧（magic 前缀；JSON 信封首字符 '{' 不会误判） */
export function isLanStreamFrame(raw: Buffer): boolean {
  return raw.length >= 4 && raw.readUInt32BE(0) === LAN_STREAM_MAGIC
}

/**
 * 编码一帧；data 帧默认带块 hash（flags 默认开启），控制帧传 flags=0。
 * chunkHash：可选（hex 字符串或原始 Buffer）；不传时在主线程现算（控制帧无 hash 区，
 * 只有 data 帧会走到这里）；发送端传入 worker 池算好的 hash 可避免主线程重复计算。
 */
export function encodeLanStreamFrame(
  type: number,
  streamId: number,
  seq: number,
  offset: bigint,
  payload: Buffer,
  flags = LAN_STREAM_FLAG_CHUNK_HASH,
  chunkHash?: Buffer | string
): Buffer {
  const hasHash = (flags & LAN_STREAM_FLAG_CHUNK_HASH) !== 0
  const hashLen = hasHash ? LAN_STREAM_CHUNK_HASH_LEN : 0
  const out = Buffer.allocUnsafe(LAN_STREAM_HEADER_LEN + payload.length + hashLen)
  out.writeUInt32BE(LAN_STREAM_MAGIC, 0)
  out[4] = LAN_STREAM_VERSION
  out[5] = type
  out[6] = flags
  out[7] = 0
  out.writeUInt32BE(streamId, 8)
  out.writeUInt32BE(seq, 12)
  out.writeBigUInt64BE(BigInt(offset), 16)
  out.writeUInt32BE(payload.length, 24)
  payload.copy(out, LAN_STREAM_HEADER_LEN)
  if (hasHash) {
    const hashBuf = Buffer.isBuffer(chunkHash)
      ? chunkHash
      : createHash('sha256').update(payload).digest()
    hashBuf.copy(out, LAN_STREAM_HEADER_LEN + payload.length)
  }
  return out
}

/** 解析一帧；非法 magic / 版本 / 截断返回 null */
export function parseLanStreamFrame(raw: Buffer): LanStreamFrame | null {
  if (raw.length < LAN_STREAM_HEADER_LEN) return null
  if (raw.readUInt32BE(0) !== LAN_STREAM_MAGIC) return null
  if (raw[4] !== LAN_STREAM_VERSION) return null
  const type = raw[5]
  const flags = raw[6]
  const streamId = raw.readUInt32BE(8)
  const seq = raw.readUInt32BE(12)
  const offset = raw.readBigUInt64BE(16)
  const length = raw.readUInt32BE(24)
  const hasHash = (flags & LAN_STREAM_FLAG_CHUNK_HASH) !== 0
  if (LAN_STREAM_HEADER_LEN + length + (hasHash ? LAN_STREAM_CHUNK_HASH_LEN : 0) > raw.length) return null
  const payload = raw.subarray(LAN_STREAM_HEADER_LEN, LAN_STREAM_HEADER_LEN + length)
  let chunkHash: string | null = null
  if (hasHash) {
    const hashBuf = raw.subarray(
      LAN_STREAM_HEADER_LEN + length,
      LAN_STREAM_HEADER_LEN + length + LAN_STREAM_CHUNK_HASH_LEN
    )
    chunkHash = hashBuf.toString('hex')
  }
  return { type, flags, streamId, seq, offset, payload, chunkHash }
}

// ============================================================
// 发送端：单条 stream 的滑动窗口状态机
// ------------------------------------------------------------
// 一次 sendStream 对应一个 SendingStream：按 chunk 切分文件，窗口内块流水化在途
// （读取 → worker 池哈希 → 发送；读/发/确认不互相阻塞），每块带 sha256；
// 收端累计确认（ack upToSeq）后窗口推进；超时/被 nak 的块重传，重传耗尽 abort。

export interface SendStreamSpec {
  /** 业务文件名（收端落盘用） */
  name: string
  /** 总字节数（数据源实际大小，须与数据一致） */
  size: number
  chunkSize?: number
  /** 可选：整体 sha256（hex）。不传则由收端跳过整体终校验（块级校验兜底） */
  totalSha256?: string
  /** 文件夹传输：相对根目录的多级相对路径 */
  relPath?: string
  /** 文件夹传输：目录项流（size=0）标记 */
  kind?: 'file' | 'dir'
  /** 中继异步传输标记：携带则收端按中继语义落盘（relay 存储端/自定义下载位置），不走 incoming 实时收件 */
  relay?: LanStreamRelayTag
  /** 业务传输关联号（邀请制直传的 transferId）：透传进 begin meta，接收方据此关联卡片状态 */
  transferId?: string
  /** 拉取分块数据（offset, length）→ Buffer；可流式/内存/磁盘任意来源 */
  readChunk: (offset: number, length: number) => Buffer | Promise<Buffer>
  onProgress?: (sentBytes: number, totalBytes: number) => void
}

/**
 * 中继流标记（向后兼容：旧对端无此字段时按普通实时流处理）。
 * 为什么存在：中继异步传输与实时文件传输共用同一条 L0 流通道（块级 sha256 + 进度回调），
 * 仅靠 meta.name 前缀区分会被收端文件名净化剥掉（冒号/非法字符会被替换），必须走结构字段。
 * 作用：收端在 onBegin 读到 relay 标记后把流交中继收件器（RelayService），
 * 上传流（phase='upload'）落主系统中继存储 {root}/relay/files/{itemId}/，
 * 下载流（phase='download'）落接收端自定义下载位置 {downloadDir}/{targetName}（含原结构）。
 */
export interface LanStreamRelayTag {
  /** 中继条目 ID（发送端生成 uuid；收端按此隔离目录/索引状态） */
  itemId: string
  /** upload=发送端→主系统中继存储；download=主系统→接收端自定义下载位置 */
  phase: 'upload' | 'download'
  /** 顶层落盘名：文件夹=原目录名（收端重建顶层目录），单文件=原文件名 */
  targetName: string
  /** 单文件/文件夹语义（收端决定单文件直落 or 目录保结构） */
  kind: 'file' | 'dir'
}

export interface SendStreamResult {
  ok: boolean
  error?: string
  /** 已确认送达的字节数 */
  ackedBytes: number
}

/** 文件夹传输：遍历目录得到的一个条目（文件或目录） */
export interface LanDirectoryEntry {
  /** 相对根目录的多级路径（`/` 分隔，收端逐段净化重建） */
  relPath: string
  kind: 'file' | 'dir'
  /** 文件绝对路径（kind=file 时有效） */
  filePath?: string
  /** 文件总字节数（kind=dir 时为 0） */
  size: number
}

/** 文件夹传输：聚合进度（按完成顺序累计，doneBytes 为已确认送达的字节） */
export interface LanDirectoryProgress {
  doneFiles: number
  totalFiles: number
  doneBytes: number
  totalBytes: number
  /** 刚完成的条目相对路径 */
  relPath: string
}

export interface LanDirectoryResult extends SendStreamResult {
  /** 成功/尝试的文件条目数 */
  files: number
  /** 目录条目数（含空目录） */
  dirs: number
}

interface InflightBlock {
  seq: number
  data: Buffer
  hash: string
  /** 剩余重传次数 */
  retriesLeft: number
  timer: ReturnType<typeof setTimeout> | null
}

/** 流管理器回调（收端视角） */
export interface LanStreamCallbacks {
  /** 收到 begin（元数据校验通过）：上层可据此分配落盘缓冲/流式文件句柄（size 即文件总长） */
  onBegin?: (peerUid: number, streamId: number, meta: LanStreamBeginMeta) => void
  /** 收到流数据块（已通过块级 sha256 校验；上层可按 offset 落盘/处理） */
  onData: (peerUid: number, streamId: number, offset: number, data: Buffer) => void
  /** 整条流全部块收齐且整体校验（若启用）通过；error 非空表示收端校验失败 */
  onEnd: (peerUid: number, streamId: number, meta: { name: string; size: number }, error?: string) => void
  /** 对端中止 / 连接关闭导致流失败 */
  onAbort: (peerUid: number, streamId: number, reason: string) => void
  /** 收端进度（已收字节/总字节） */
  onProgress?: (peerUid: number, streamId: number, receivedBytes: number, totalBytes: number) => void
}

class SendingStream {
  public readonly streamId: number
  public readonly name: string
  public readonly size: number
  public readonly chunkSize: number
  public readonly chunkCount: number

  private readonly readChunk: SendStreamSpec['readChunk']
  private readonly pool: LanHashPool
  private readonly uid: number
  private readonly sendFrame: (frame: Buffer) => boolean
  private readonly onProgressSpec?: SendStreamSpec['onProgress']
  private readonly windowSize: number

  private windowStart = 0
  private readonly inflight = new Map<number, InflightBlock>()
  /** 已发起读取（await readChunk）但尚未入在途的块：防止异步读取把窗口撑爆 */
  private pendingReads = 0
  private nextReadSeq = 0
  private settled = false
  private totalAckedBytes = 0
  private readonly totalSha256: string
  private readonly relPath?: string
  private readonly kind?: 'file' | 'dir'
  private readonly relay?: LanStreamRelayTag
  private readonly transferId?: string
  private resolveResult!: (r: SendStreamResult) => void

  constructor(params: {
    streamId: number
    spec: SendStreamSpec
    pool: LanHashPool
    uid: number
    sendFrame: (frame: Buffer) => boolean
    windowSize?: number
  }) {
    this.streamId = params.streamId
    this.name = params.spec.name
    this.size = params.spec.size
    this.chunkSize = params.spec.chunkSize || LAN_STREAM_DEFAULT_CHUNK_SIZE
    this.chunkCount = this.size === 0 ? 0 : Math.max(1, Math.ceil(this.size / this.chunkSize))
    this.readChunk = params.spec.readChunk
    this.pool = params.pool
    this.uid = params.uid
    this.sendFrame = params.sendFrame
    this.windowSize = Math.max(1, params.windowSize || LAN_STREAM_DEFAULT_WINDOW)
    this.onProgressSpec = params.spec.onProgress
    this.totalSha256 = params.spec.totalSha256 ?? ''
    this.relPath = params.spec.relPath
    this.kind = params.spec.kind
    this.relay = params.spec.relay
    this.transferId = params.spec.transferId
  }

  /** 发起传输；调用方 await 得到最终投递结果 */
  start(): Promise<SendStreamResult> {
    return new Promise((resolve) => {
      this.resolveResult = resolve
      const meta: LanStreamBeginMeta = {
        name: this.name,
        size: this.size,
        chunkSize: this.chunkSize,
        chunkCount: this.chunkCount,
        totalSha256: this.totalSha256,
        ...(this.relPath !== undefined ? { relPath: this.relPath } : {}),
        ...(this.kind !== undefined ? { kind: this.kind } : {}),
        ...(this.relay !== undefined ? { relay: this.relay } : {}),
        ...(this.transferId !== undefined ? { transferId: this.transferId } : {})
      }
      const beginPayload = Buffer.from(JSON.stringify(meta))
      if (!this.sendFrame(encodeLanStreamFrame(LAN_STREAM_TYPE_BEGIN, this.streamId, 0, 0n, beginPayload, 0))) {
        this.settle(false, '连接不可用（begin 发送失败）')
        return
      }
      if (this.chunkCount === 0) {
        // 空文件：无需数据帧，直接发 end 结算
        if (this.sendFrame(encodeLanStreamFrame(LAN_STREAM_TYPE_END, this.streamId, 0, 0n, Buffer.alloc(0), 0))) {
          this.settle(true)
        } else {
          this.settle(false, '连接不可用（end 发送失败）')
        }
        return
      }
      this.pump()
    })
  }

  /** 推进窗口：窗口未满则继续读块入在途（读取异步，读完后进入在途并发出） */
  private pump(): void {
    while (!this.settled && this.inflight.size + this.pendingReads < this.windowSize && this.nextReadSeq < this.chunkCount) {
      const seq = this.nextReadSeq
      this.nextReadSeq += 1
      this.pendingReads += 1
      void this.readAndSend(seq)
    }
  }

  private async readAndSend(seq: number): Promise<void> {
    try {
      const offset = seq * this.chunkSize
      const len = Math.min(this.chunkSize, this.size - offset)
      const data = await this.readChunk(offset, len)
      this.pendingReads -= 1
      if (this.settled || this.finalizing) return
      if (seq < this.windowStart) {
        // 读取期间已被累计确认：丢弃过期数据
        this.pump()
        return
      }
      const hash = await this.pool.hash(data)
      if (this.settled || this.finalizing || seq < this.windowStart) {
        this.pump()
        return
      }
      this.enterInflight(seq, data, hash)
      this.pump()
    } catch (err) {
      this.pendingReads -= 1
      this.settle(false, `读取/哈希分块失败（seq=${seq}）: ${(err as Error).message}`)
    }
  }

  private enterInflight(seq: number, data: Buffer, hash: string): void {
    if (this.inflight.has(seq)) return // 理论上不会（seq 唯一），防御
    const block: InflightBlock = { seq, data, hash, retriesLeft: LAN_STREAM_MAX_RETRIES, timer: null }
    this.inflight.set(seq, block)
    this.startRetransmitTimer(block)
    const frame = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, this.streamId, seq, BigInt(seq * this.chunkSize), data, LAN_STREAM_FLAG_CHUNK_HASH, Buffer.from(hash, 'hex'))
    if (!this.sendFrame(frame)) {
      this.settle(false, '连接不可用（data 发送失败）')
    }
  }

  private startRetransmitTimer(block: InflightBlock): void {
    if (block.timer) clearTimeout(block.timer)
    block.timer = setTimeout(() => {
      block.timer = null
      if (this.settled || this.finalizing || !this.inflight.has(block.seq)) return
      if (block.retriesLeft <= 0) {
        this.settle(false, `分块 ${block.seq} 确认超时且重传耗尽，流中止`)
        return
      }
      block.retriesLeft -= 1
      const frame = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, this.streamId, block.seq, BigInt(block.seq * this.chunkSize), block.data, LAN_STREAM_FLAG_CHUNK_HASH, Buffer.from(block.hash, 'hex'))
      if (!this.sendFrame(frame)) {
        this.settle(false, '连接不可用（重传发送失败）')
      }
      this.startRetransmitTimer(block)
    }, LAN_STREAM_RETRANSMIT_TIMEOUT_MS)
  }

  /** 收到累计确认：upToSeq（含）之前的块全部收妥 */
  onAck(upToSeq: number): void {
    if (this.settled || this.finalizing) return
    if (upToSeq < this.windowStart) return
    for (let s = this.windowStart; s <= upToSeq; s += 1) {
      const block = this.inflight.get(s)
      if (block) {
        if (block.timer) clearTimeout(block.timer)
        this.inflight.delete(s)
        this.totalAckedBytes += block.data.length
      }
    }
    this.windowStart = upToSeq + 1
    this.onProgressSpec?.(this.totalAckedBytes, this.size)
    this.pump()
    this.checkCompletion()
  }

  /** 收到 nak：立即重传指定块（不等超时） */
  onNak(seqs: number[]): void {
    if (this.settled || this.finalizing) return
    for (const seq of seqs) {
      const block = this.inflight.get(seq)
      if (!block) continue
      if (block.timer) clearTimeout(block.timer)
      if (block.retriesLeft <= 0) {
        this.settle(false, `分块 ${seq} 校验失败且重传耗尽，流中止`)
        return
      }
      block.retriesLeft -= 1
      const frame = encodeLanStreamFrame(LAN_STREAM_TYPE_DATA, this.streamId, block.seq, BigInt(block.seq * this.chunkSize), block.data, LAN_STREAM_FLAG_CHUNK_HASH, Buffer.from(block.hash, 'hex'))
      if (!this.sendFrame(frame)) {
        this.settle(false, '连接不可用（nak 重传发送失败）')
        return
      }
      this.startRetransmitTimer(block)
    }
  }

  /** 收端回执 end：ok=false 表示收端整体校验失败；ok=true 为成功确认，立即结算 */
  onReceiverEnd(ok: boolean, error: string): void {
    if (this.settled || this.finalizing) return
    if (!ok) {
      this.settle(false, error)
    } else {
      // 对端已确认：立即结算成功（不等待兜底定时器）
      this.settle(true)
    }
  }

  /** 对端发来 abort / 连接关闭 */
  abort(reason: string): void {
    if (this.settled || this.finalizing) return
    this.settle(false, reason)
  }

  private finalizing = false

  /** 全部块已确认：发 end 帧通知收端传输完成；等待收端回执或兜底结算 */
  private checkCompletion(): void {
    if (this.settled || this.finalizing) return
    if (this.windowStart >= this.chunkCount) {
      this.finalizing = true
      if (!this.sendFrame(encodeLanStreamFrame(LAN_STREAM_TYPE_END, this.streamId, 0, 0n, Buffer.alloc(0), 0))) {
        this.settle(false, '连接不可用（end 发送失败）')
        return
      }
      // 兜底：收端整体校验慢于网络传输（大文件 / 高核争用）时不应无限等待；
      // 数据面（块级校验）已全部确认成功，网络送达性已保证，兜底按成功结算。
      this.finishTimer = setTimeout(() => {
        this.settle(true)
      }, LAN_STREAM_RETRANSMIT_TIMEOUT_MS * 2)
    }
  }

  private finishTimer: ReturnType<typeof setTimeout> | null = null

  private settle(ok: boolean, error?: string): void {
    if (this.settled) return
    this.settled = true
    if (this.finishTimer) clearTimeout(this.finishTimer)
    for (const block of this.inflight.values()) {
      if (block.timer) clearTimeout(block.timer)
    }
    this.inflight.clear()
    this.resolveResult({ ok, error, ackedBytes: this.totalAckedBytes })
  }
}

// ============================================================
// 流管理器：连接层分发 + 收发状态机容器
// ------------------------------------------------------------

interface ReceivingStream {
  streamId: number
  name: string
  size: number
  chunkSize: number
  chunkCount: number
  totalSha256: string
  /** 已收且块级校验通过的 seq 集合 */
  received: Set<number>
  /** 期待的下一连续 seq（累计确认语义） */
  expectSeq: number
  /** 整体 sha256 增量累积器（totalSha256 非空时启用，O(1) 内存；大文件不限大小由此而来） */
  hash?: ReturnType<typeof createHash>
  receivedBytes: number
  ended: boolean
  /** 乱序到达的异步校验通过块：等 expectSeq 连续后按序吐给 onData（保证上层观察者序内交付） */
  ordered: Map<number, { offset: number; data: Buffer }>
}

export class LanStreamManager {
  private readonly pool: LanHashPool
  private readonly callbacks: LanStreamCallbacks
  private readonly sending = new Map<number, SendingStream>()
  private readonly receiving = new Map<number, ReceivingStream>()
  private nextStreamId = 1
  private readonly socketForUid = new Map<number, WebSocket>()

  constructor(callbacks: LanStreamCallbacks, pool?: LanHashPool) {
    this.callbacks = callbacks
    this.pool = pool ?? new LanHashPool()
  }

  /** 注册连接：该 uid 的二进制帧由本管理器经此 socket 收发 */
  attachSocket(uid: number, socket: WebSocket): void {
    const prev = this.socketForUid.get(uid)
    if (prev && prev !== socket) {
      this.abortAllForUid(uid, '连接被新连接顶替')
    }
    this.socketForUid.set(uid, socket)
  }

  /** 连接关闭：中止该 uid 的全部活跃流 */
  detachSocket(uid: number): void {
    if (this.socketForUid.delete(uid)) {
      this.abortAllForUid(uid, '对端连接已关闭')
    }
  }

  /** 收到一帧：按类型分发到收发状态机 */
  handleFrame(uid: number, frame: LanStreamFrame): void {
    switch (frame.type) {
      case LAN_STREAM_TYPE_BEGIN:
        this.onBegin(uid, frame)
        break
      case LAN_STREAM_TYPE_DATA:
        this.onDataFrame(uid, frame)
        break
      case LAN_STREAM_TYPE_ACK:
        this.onAck(uid, frame)
        break
      case LAN_STREAM_TYPE_NAK:
        this.onNak(uid, frame)
        break
      case LAN_STREAM_TYPE_END:
        this.onEnd(uid, frame)
        break
      case LAN_STREAM_TYPE_ABORT:
        this.onAbortFrame(uid, frame)
        break
      default:
        break // 未知类型忽略（向前兼容）
    }
  }

  /** 上层调用：发送一段数据流到对端 uid（需已连接） */
  sendStream(uid: number, spec: SendStreamSpec, options?: { windowSize?: number }): Promise<SendStreamResult> {
    if (!this.socketForUid.has(uid)) {
      return Promise.resolve({ ok: false, error: '对端不在线：无活跃连接，无法发送流', ackedBytes: 0 })
    }
    const streamId = this.nextStreamId
    this.nextStreamId += 1
    const sendFrame = (frame: Buffer): boolean => {
      const socket = this.socketForUid.get(uid)
      if (!socket || socket.readyState !== 1 /* WebSocket.OPEN */) return false
      try {
        socket.send(frame, { binary: true })
        return true
      } catch {
        return false
      }
    }
    const st = new SendingStream({
      streamId,
      spec,
      pool: this.pool,
      uid,
      sendFrame,
      windowSize: options?.windowSize
    })
    this.sending.set(streamId, st)
    const result = st.start()
    void result.then(() => {
      this.sending.delete(streamId)
    })
    return result
  }

  /** 便捷：发送内存 Buffer（自动切块；整体哈希走 worker 池，不阻塞主线程） */
  async sendBytes(
    uid: number,
    name: string,
    data: Buffer,
    options?: { chunkSize?: number; windowSize?: number; relPath?: string; kind?: 'file' | 'dir'; relay?: LanStreamRelayTag; transferId?: string }
  ): Promise<SendStreamResult> {
    // 整体 sha256 交给哈希池并行计算（与块哈希同一 worker 池，多核利用；大载荷不卡事件循环）
    const totalSha256 = await this.pool.hash(data)
    return this.sendStream(
      uid,
      {
        name,
        size: data.length,
        chunkSize: options?.chunkSize,
        totalSha256,
        relPath: options?.relPath,
        kind: options?.kind,
        relay: options?.relay,
        transferId: options?.transferId,
        readChunk: (offset, length) => data.subarray(offset, offset + length)
      },
      { windowSize: options?.windowSize }
    )
  }

  /** 便捷：发送本地文件（流式按 offset 随机读盘，不整文件载入内存） */
  async sendFile(
    uid: number,
    filePath: string,
    options?: { name?: string; chunkSize?: number; windowSize?: number; relPath?: string; kind?: 'file' | 'dir'; relay?: LanStreamRelayTag; transferId?: string; totalSha256?: string }
  ): Promise<SendStreamResult> {
    let chunker: { readChunk: SendStreamSpec['readChunk']; size: number; close: () => Promise<void> } | null = null
    try {
      chunker = await createFileChunker(filePath)
      return await this.sendStream(
        uid,
        {
          name: options?.name ?? basename(filePath),
          size: chunker.size,
          chunkSize: options?.chunkSize,
          totalSha256: options?.totalSha256,
          relPath: options?.relPath,
          kind: options?.kind,
          relay: options?.relay,
          transferId: options?.transferId,
          readChunk: chunker.readChunk
        },
        { windowSize: options?.windowSize }
      )
    } catch (err) {
      return { ok: false, error: `打开文件失败: ${(err as Error).message}`, ackedBytes: 0 }
    } finally {
      if (chunker) await chunker.close()
    }
  }

  /** 发送整个目录（递归，结构保持不变：空目录/子目录层级/文件名原样重建） */
  async sendDirectory(
    uid: number,
    dirPath: string,
    options?: {
      chunkSize?: number
      windowSize?: number
      /** 同时传输的最大文件流数（多线路并发；默认 4） */
      concurrency?: number
      /** 遍历时忽略的条目（返回 true 跳过）；入参为相对路径 */
      ignore?: (relPath: string) => boolean
      onProgress?: (p: LanDirectoryProgress) => void
      /** 中继异步传输标记：目录内全部流统一携带（收端按中继语义落盘） */
      relay?: LanStreamRelayTag
      /** 业务传输关联号（邀请制直传的 transferId）：目录内全部流统一携带，接收方据此关联卡片状态 */
      transferId?: string
    }
  ): Promise<LanDirectoryResult> {
    let st: Awaited<ReturnType<typeof stat>> | null = null
    try {
      st = await stat(dirPath)
    } catch {
      st = null
    }
    if (!st || !st.isDirectory()) {
      return { ok: false, error: `目录不存在或不可读: ${dirPath}`, ackedBytes: 0, files: 0, dirs: 0 }
    }
    const entries = await walkDirectorySafe(dirPath, options?.ignore)
    if (!entries) {
      return { ok: false, error: `遍历目录失败: ${dirPath}`, ackedBytes: 0, files: 0, dirs: 0 }
    }
    const dirs = entries.filter((e) => e.kind === 'dir')
    const files = entries.filter((e) => e.kind === 'file')
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0)

    // 1) 先发目录项流（size=0，收端仅 mkdir）——结构最先建立，空目录也能表达
    for (const d of dirs) {
      const res = await this.sendStream(
        uid,
        {
          name: basename(d.relPath),
          size: 0,
          relPath: d.relPath,
          kind: 'dir',
          relay: options?.relay,
          transferId: options?.transferId,
          readChunk: () => Buffer.alloc(0)
        },
        { windowSize: options?.windowSize }
      )
      if (!res.ok) {
        return { ok: false, error: `目录项发送失败 ${d.relPath}: ${res.error ?? '未知'}`, ackedBytes: res.ackedBytes, files: 0, dirs: dirs.length }
      }
    }

    // 2) 文件项多流并发（concurrency 控制在途流数；聚合进度按完成顺序累计）
    const concurrency = Math.max(1, Math.min(options?.concurrency ?? 4, 16))
    let ackedBytes = 0
    let doneFiles = 0
    const failures: string[] = []
    const pumpFiles = async (queue: typeof files, start: number, step: number): Promise<void> => {
      for (let i = start; i < queue.length; i += step) {
        const f = queue[i]
        let res: SendStreamResult
        if (f.filePath) {
          res = await this.sendFile(uid, f.filePath, {
            name: basename(f.relPath),
            relPath: f.relPath,
            kind: 'file',
            chunkSize: options?.chunkSize,
            windowSize: options?.windowSize,
            relay: options?.relay,
            transferId: options?.transferId
          })
        } else {
          res = { ok: false, error: '条目缺少读取路径', ackedBytes: 0 }
        }
        if (res.ok) {
          ackedBytes += res.ackedBytes
        } else {
          failures.push(`${f.relPath}: ${res.error ?? '未知错误'}`)
        }
        doneFiles += 1
        options?.onProgress?.({
          doneFiles,
          totalFiles: files.length,
          doneBytes: ackedBytes,
          totalBytes,
          relPath: f.relPath
        })
      }
    }
    await Promise.all(Array.from({ length: concurrency }, (_, i) => pumpFiles(files, i, concurrency)))

    return { ok: failures.length === 0, error: failures.length ? `以下文件发送失败：${failures.join('；')}` : undefined, ackedBytes, files: files.length, dirs: dirs.length }
  }

  /** 测试辅助：当前活跃发送流数 */
  getActiveSendingCount(): number {
    return this.sending.size
  }

  /** 测试辅助：当前活跃接收流数 */
  getActiveReceivingCount(): number {
    return this.receiving.size
  }

  getHashPoolSize(): number {
    return this.pool.getSize()
  }

  /** 销毁：终止 worker 池与全部流 */
  destroy(): void {
    for (const uid of [...this.socketForUid.keys()]) {
      this.abortAllForUid(uid, '传输层销毁')
    }
    this.pool.destroy()
  }

  // -------- 接收侧 --------

  private onBegin(uid: number, frame: LanStreamFrame): void {
    if (this.receiving.has(frame.streamId)) {
      // 重复 begin（重连后对端重发）：中止旧的再重建
      const old = this.receiving.get(frame.streamId)
      if (old && !old.ended) {
        this.callbacks.onAbort(uid, frame.streamId, 'begin 覆盖（对端重启传输）')
      }
      this.receiving.delete(frame.streamId)
    }
    let meta: LanStreamBeginMeta
    try {
      meta = JSON.parse(frame.payload.toString('utf8')) as LanStreamBeginMeta
    } catch {
      this.reply(uid, LAN_STREAM_TYPE_ABORT, frame.streamId, Buffer.from(JSON.stringify({ reason: 'begin 元数据非法' })))
      return
    }
    const chunkSize = meta.chunkSize && meta.chunkSize > 0 ? meta.chunkSize : LAN_STREAM_DEFAULT_CHUNK_SIZE
    const expectCount = meta.size === 0 ? 0 : Math.ceil(meta.size / chunkSize)
    if (
      !Number.isFinite(meta.size) || meta.size < 0 || meta.size > LAN_STREAM_MAX_FILE ||
      !Number.isFinite(meta.chunkCount) || meta.chunkCount !== expectCount || !meta.name
    ) {
      this.reply(uid, LAN_STREAM_TYPE_ABORT, frame.streamId, Buffer.from(JSON.stringify({ reason: 'begin 元数据非法' })))
      return
    }
    this.receiving.set(frame.streamId, {
      streamId: frame.streamId,
      name: meta.name,
      size: meta.size,
      chunkSize,
      chunkCount: meta.chunkCount,
      totalSha256: meta.totalSha256 ?? '',
      received: new Set(),
      expectSeq: 0,
      // 整体终校验增量累积（不整文件驻留内存；totalSha256 为空 = 仅块级校验兜底）
      hash: meta.totalSha256 ? createHash('sha256') : undefined,
      ordered: new Map(),
      receivedBytes: 0,
      ended: false
    })
    this.callbacks.onBegin?.(uid, frame.streamId, {
      name: meta.name,
      size: meta.size,
      chunkSize,
      chunkCount: meta.chunkCount,
      totalSha256: meta.totalSha256 ?? '',
      ...(meta.relPath !== undefined ? { relPath: meta.relPath } : {}),
      ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
      // 透传业务标记：lan-file-sink 的 meta.relay（中继落盘语义）与 meta.transferId
      // （buildTarget 目录隔离）都在消费这两个字段，此前回调只透传了 relPath/kind——
      // 属上游缺漏修复：sendFile/sendBytes 已下发 spec.relay/transferId，收端必须拿到。
      ...(meta.relay !== undefined ? { relay: meta.relay } : {}),
      ...(meta.transferId !== undefined ? { transferId: meta.transferId } : {})
    })
    if (meta.chunkCount === 0) {
      this.completeStream(uid, frame.streamId)
    }
  }

  private onDataFrame(uid: number, frame: LanStreamFrame): void {
    const stream = this.receiving.get(frame.streamId)
    if (!stream || stream.ended) {
      this.reply(uid, LAN_STREAM_TYPE_ABORT, frame.streamId, Buffer.from(JSON.stringify({ reason: '未知或已结束的流' })))
      return
    }
    const seq = frame.seq
    if (seq >= stream.chunkCount || Number(frame.offset) + frame.payload.length > stream.size) {
      this.reply(uid, LAN_STREAM_TYPE_NAK, frame.streamId, Buffer.from(JSON.stringify({ seqs: [seq] })))
      return
    }
    if (stream.received.has(seq)) {
      // 重复块（重传幂等）：直接回累计确认
      this.maybeAck(uid, stream)
      return
    }
    if (!frame.chunkHash) {
      this.reply(uid, LAN_STREAM_TYPE_NAK, frame.streamId, Buffer.from(JSON.stringify({ seqs: [seq] })))
      return
    }
    // 块级 sha256 校验（worker 池并行；多个块校验结果乱序安全：按 offset 落位 + Set 去重）
    void this.pool
      .hash(frame.payload)
      .then((computed) => {
        if (stream.ended) return
        if (computed !== frame.chunkHash) {
          this.reply(uid, LAN_STREAM_TYPE_NAK, frame.streamId, Buffer.from(JSON.stringify({ seqs: [seq] })))
          return
        }
        this.acceptBlock(uid, stream, seq, Number(frame.offset), frame.payload)
      })
      .catch(() => {
        this.reply(uid, LAN_STREAM_TYPE_NAK, frame.streamId, Buffer.from(JSON.stringify({ seqs: [seq] })))
      })
  }

  private acceptBlock(uid: number, stream: ReceivingStream, seq: number, offset: number, data: Buffer): void {
    if (stream.ended || stream.received.has(seq)) {
      this.maybeAck(uid, stream)
      return
    }
    stream.received.add(seq)
    stream.receivedBytes += data.length
    // 异步哈希校验完成顺序 ≠ 块序号顺序：先暂存，按 expectSeq 连续时再序内吐给上层观察者
    // （onData 接收方（如 LanFileSink 按 offset 顺序写盘）依赖序内交付）
    stream.ordered.set(seq, { offset, data })
    while (stream.ordered.has(stream.expectSeq)) {
      const next = stream.ordered.get(stream.expectSeq)!
      stream.ordered.delete(stream.expectSeq)
      // 整体 sha256 增量累积必须按文件 offset 顺序（与 onData 同序，序内循环保证）
      stream.hash?.update(next.data)
      this.callbacks.onData(uid, stream.streamId, next.offset, next.data)
      this.callbacks.onProgress?.(uid, stream.streamId, stream.receivedBytes, stream.size)
      stream.expectSeq += 1
    }
    this.maybeAck(uid, stream)
    if (stream.expectSeq >= stream.chunkCount) {
      this.completeStream(uid, stream.streamId)
    }
  }

  private maybeAck(uid: number, stream: ReceivingStream): void {
    const upTo = stream.expectSeq - 1
    if (upTo >= 0) {
      this.reply(uid, LAN_STREAM_TYPE_ACK, stream.streamId, Buffer.from(JSON.stringify({ upToSeq: upTo })))
    }
  }

  /** 全部块收齐：整体 sha256 终校验（若启用）→ onEnd → 回 end(ok) 给发送端 */
  private completeStream(uid: number, streamId: number): void {
    const stream = this.receiving.get(streamId)
    if (!stream || stream.ended) return
    stream.ended = true
    this.receiving.delete(streamId)
    let error: string | undefined
    if (stream.totalSha256 && stream.hash) {
      const computed = stream.hash.digest('hex')
      if (computed !== stream.totalSha256) {
        error = `整体校验失败（期望 ${stream.totalSha256.slice(0, 12)}…，实际 ${computed.slice(0, 12)}…）`
      }
    } else if (stream.size === 0) {
      // 空文件且未启用整体校验：无内容可校验
    }
    this.callbacks.onEnd(uid, streamId, { name: stream.name, size: stream.size }, error)
    this.reply(uid, LAN_STREAM_TYPE_END, streamId, Buffer.from(JSON.stringify({ ok: !error })))
  }

  private onAck(uid: number, frame: LanStreamFrame): void {
    const st = this.sending.get(frame.streamId)
    if (!st) return
    let payload: { upToSeq?: number }
    try {
      payload = JSON.parse(frame.payload.toString('utf8')) as { upToSeq?: number }
    } catch {
      return
    }
    st.onAck(payload.upToSeq ?? -1)
  }

  private onNak(uid: number, frame: LanStreamFrame): void {
    const st = this.sending.get(frame.streamId)
    if (!st) return
    try {
      const p = JSON.parse(frame.payload.toString('utf8')) as { seqs?: number[] }
      if (Array.isArray(p.seqs)) st.onNak(p.seqs)
    } catch {
      // 非法 nak 忽略
    }
  }

  /** end 帧语义（双向）：
   * - 收端收到发送端的 END（空 payload）= 发送端宣告全部块已确认送达；
   * - 发送端收到收端的 END{ok} = 收端整体校验结论回执。
   */
  private onEnd(uid: number, frame: LanStreamFrame): void {
    const st = this.sending.get(frame.streamId)
    if (st) {
      let ok = true
      try {
        ok = (JSON.parse(frame.payload.toString('utf8')) as { ok?: boolean }).ok !== false
      } catch {
        ok = true // 空 payload（发送端自定义 END）视为成功回执
      }
      st.onReceiverEnd(ok, ok ? '' : '收端整体校验失败')
      return
    }
    // 收端视角：发送端宣告完成 → 检查本端是否已收全（防御：发送端只在全 ack 后发 END，
    // 正常应已 completeStream；若出现缺口说明协议状态错乱，且发送端已释放全部块数据
    // 无法重补，明确失败比挂起等待更安全）
    const stream = this.receiving.get(frame.streamId)
    if (stream && !stream.ended) {
      let missing = 0
      for (let s = 0; s < stream.chunkCount; s += 1) {
        if (!stream.received.has(s)) missing += 1
      }
      if (missing > 0) {
        this.receiving.delete(frame.streamId)
        const reason = `收端数据不完整（缺 ${missing} 块，发送端已宣告结束，无法恢复）`
        this.callbacks.onAbort(uid, frame.streamId, reason)
        this.reply(uid, LAN_STREAM_TYPE_ABORT, frame.streamId, Buffer.from(JSON.stringify({ reason })))
      } else {
        this.completeStream(uid, frame.streamId)
      }
    }
  }

  private onAbortFrame(uid: number, frame: LanStreamFrame): void {
    let reason = '对端中止传输'
    try {
      reason = (JSON.parse(frame.payload.toString('utf8')) as { reason?: string }).reason ?? reason
    } catch {
      // 默认原因
    }
    const st = this.sending.get(frame.streamId)
    if (st) {
      st.abort(reason)
      this.sending.delete(frame.streamId)
    }
    if (this.receiving.has(frame.streamId)) {
      this.receiving.delete(frame.streamId)
      this.callbacks.onAbort(uid, frame.streamId, reason)
    }
  }

  private abortAllForUid(uid: number, reason: string): void {
    for (const [sid, st] of [...this.sending]) {
      st.abort(reason)
      this.sending.delete(sid)
    }
    for (const [sid, stream] of [...this.receiving]) {
      if (!stream.ended) {
        this.receiving.delete(sid)
        this.callbacks.onAbort(uid, sid, reason)
      }
    }
  }

  private reply(uid: number, type: number, streamId: number, payload: Buffer): void {
    const socket = this.socketForUid.get(uid)
    if (!socket || socket.readyState !== 1) return
    try {
      socket.send(encodeLanStreamFrame(type, streamId, 0, 0n, payload, 0), { binary: true })
    } catch {
      // 对端已关闭：静默丢弃（发送侧超时重传 / abort 兜底）
    }
  }
}

/** 流式文件读取分块器：对文件句柄顺序随机读，内存友好（整文件不驻留内存，不限制文件大小） */
export async function createFileChunker(filePath: string): Promise<{ readChunk: SendStreamSpec['readChunk']; size: number; close: () => Promise<void> }> {
  const fh: FileHandle = await open(filePath, 'r')
  const stat = await fh.stat()
  const close = async (): Promise<void> => {
    try {
      await fh.close()
    } catch {
      // 已关闭忽略
    }
  }
  const readChunk = async (offset: number, length: number): Promise<Buffer> => {
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    if (bytesRead !== length) {
      // 文件在读取期间被截断
      await close()
      throw new Error(`文件读取不完整（offset=${offset}，期望 ${length} 实得 ${bytesRead}）`)
    }
    return buf
  }
  return { readChunk, size: stat.size, close }
}

/** 便捷工具：同步整体哈希（测试/小载荷用） */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * 递归遍历目录（文件 + 目录 + 空目录），返回按 relPath 排序的条目。
 * 安全：跳过符号链接（防循环/越出根目录）；带 maxEntries 上限防止失控目录引爆内存。
 * 失败（根不可读/超量）返回 null，由调用方决定整体失败。
 */
export async function walkDirectorySafe(
  root: string,
  ignore?: (relPath: string) => boolean,
  maxEntries = 100_000
): Promise<LanDirectoryEntry[] | null> {
  const entries: LanDirectoryEntry[] = []
  const walk = async (dir: string, relDir: string): Promise<boolean> => {
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return false
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of dirents) {
      // 符号链接一律跳过：防止循环引用与跟随出根目录
      if (d.isSymbolicLink()) continue
      const relPath = relDir ? `${relDir}/${d.name}` : d.name
      if (ignore?.(relPath)) continue
      if (entries.length >= maxEntries) return false
      if (d.isDirectory()) {
        entries.push({ relPath, kind: 'dir', size: 0 })
        if (!(await walk(join(dir, d.name), relPath))) return false
      } else if (d.isFile()) {
        const filePath = join(dir, d.name)
        let size = 0
        try {
          size = (await stat(filePath)).size
        } catch {
          size = 0 // 读取失败仍发送，发送端会以流错误暴露
        }
        entries.push({ relPath, kind: 'file', filePath, size })
      }
      // 其它类型（fifo/socket/设备文件）跳过
    }
    return true
  }
  const ok = await walk(root, '')
  return ok ? entries : null
}