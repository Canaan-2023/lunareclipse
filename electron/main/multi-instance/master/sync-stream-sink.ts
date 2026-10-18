/**
 * 为什么存在：同步分块面（sync staging）收端。LAN 流通道（lan-stream）交付"已通过块级 sha256
 * + 整体 sha256 的原始字节"，但把字节落成 sync_staging 暂存文件是业务侧责任——必须与通用
 * 文件收件链（lan-file-sink 的 incoming/）隔离：staging 只承接同步实体（分系统 oplog 大条目
 * 的前置字节），由 applyPush 按 size/hash 校验后消费；若落入 incoming/ 会被好友收件语义接管，
 * 语义错位且无法按 instanceId 隔离。
 * 作用：接收流名形如 'sync:{instanceId}:{key}' 的同步实体流（name 由卫星侧 sendLanFile 写入），
 * 按对端 uid 校验权限后流式落 {root}/sync_staging/U{uid}/{instanceId}/{key 多级路径}：
 * 先写 .part，整流收齐（onEnd 无 error = 流层整体 sha256 已通过）后 rename 覆盖正式文件。
 * 默认安全：allowPeer 未放开（默认拒绝）时对端字节完全不落盘。
 */

import { createWriteStream, mkdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname } from 'path'
import type { WriteStream } from 'fs'
import { SatelliteStore } from './satellite-store'
import type { LanStreamBeginMeta } from '../lan/lan-stream'

/** 流名前缀（卫星 endSync 实体发送端与收端解析共用；key 不含 ':'（isValidKey 禁冒号），可放心按冒号切分） */
export const SYNC_STREAM_PREFIX = 'sync:'

/** instanceId 白名单（注册签发的 satellite-XXXXXX 形态；收端不得信任任意字符串拼路径） */
const INSTANCE_ID_PATTERN = /^satellite-[A-F0-9]{6}$/

/** 单条流的落盘状态 */
interface SinkEntry {
  /** 正式文件目标路径（不含 .part） */
  target: string
  w: WriteStream
  /** 已流式写入字节数（与协议 onData offset 对齐校验用） */
  size: number
  /** 幂等命中（同对端同 instanceId 同 key 的正式文件路径已被本条流 expect，重发覆盖）→ 落盘后 rename 覆盖 */
  skipped: boolean
}

export interface SyncStreamSinkOptions {
  /** 数据根目录（暂存统一落 {root}/sync_staging/U{uid}/{instanceId}/，不向该目录之外写任何字节） */
  root: string
  /** 权限判定：仅当对端 uid 被显式放行（已注册卫星）才收件落盘；默认拒绝（调用方按注册账本放开） */
  allowPeer?: (peerUid: number) => boolean
}

export class SyncStreamSink {
  private readonly entries = new Map<number, SinkEntry>()
  private allow: (peerUid: number) => boolean

  constructor(private readonly opts: SyncStreamSinkOptions) {
    // 暂存根目录不预建（按 U{uid} 分账惰性 mkdir），仅保留权限判定
    this.allow = opts.allowPeer ?? (() => false)
  }

  /** 更新权限判定（注册账本变化后调用；传 null 恢复默认拒绝） */
  setAllowPeer(allow: ((peerUid: number) => boolean) | null): void {
    this.allow = allow ?? (() => false)
  }

  /** 对端离线/服务停止：丢弃本端所有未收齐的 .part（不产生半成品） */
  reset(): void {
    for (const [sid, e] of this.entries) {
      this.abortEntry(sid, e)
    }
    this.entries.clear()
  }

  // ===== 桥接到 LanStreamCallbacks（与 lan-file-sink 同链并存，只消费 sync: 前缀流） =====

  onBegin(peerUid: number, streamId: number, meta: LanStreamBeginMeta): void {
    if (this.entries.has(streamId)) return // 同流重复 begin（协议内不应出现）忽略

    // 1. 流名识别：非 'sync:' 前缀的流不是同步实体（好友/中继/聊天室流），整流跳过
    if (!meta.name.startsWith(SYNC_STREAM_PREFIX)) {
      this.entries.set(streamId, { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true })
      return
    }
    // 2. 权限判定：对端未被放行 → 整流丢弃（此后 onData/onEnd 不再落盘）
    if (!this.allow(peerUid)) {
      console.warn(`[sync-sink] 拒绝同步实体：对端 uid=${peerUid} 未注册（streamId=${streamId}）`)
      this.entries.set(streamId, { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true })
      return
    }
    // 3. 解析 sync:{instanceId}:{key}；key 本身不含 ':'，因此最后一个冒号之后都是 key
    const parsed = this.parseStreamName(meta.name)
    if (!parsed) {
      console.warn(`[sync-sink] 拒绝同步实体：流名非法（streamId=${streamId}，name=${meta.name.slice(0, 80)}）`)
      this.entries.set(streamId, { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true })
      return
    }
    // 4. 账号隔离：key 的账号作用域必须等于对端 uid（防卫星 A 借流名写卫星 B 的暂存/镜像）
    const scope = SatelliteStore.scopeFromKey(parsed.key)
    if (!scope || scope.uid !== peerUid) {
      console.warn(`[sync-sink] 拒绝同步实体：key 作用域与对端 uid 不符（streamId=${streamId}，uid=${peerUid}，key=${parsed.key}）`)
      this.entries.set(streamId, { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true })
      return
    }
    // 5. 落盘路径与 applyPush 读取路径同源（stagingPathFor 单例推导）
    const target = SatelliteStore.stagingPathFor(this.opts.root, peerUid, parsed.instanceId, parsed.key)
    mkdirSync(dirname(target), { recursive: true })
    const w = createWriteStream(`${target}.part`)
    // 吞掉写盘 IO 错误：destroy/磁盘满等情况由 abort/清理路径兜底，绝不让 error 变 uncaughtException 炸进程
    w.on('error', () => {})
    this.entries.set(streamId, { target, w, size: 0, skipped: false })
  }

  onData(_peerUid: number, streamId: number, offset: number, data: Buffer): void {
    const e = this.entries.get(streamId)
    if (!e || e.skipped) return
    if (offset !== e.size) {
      // 协议保证序内交付；出现缺口说明收端状态异常，中止本流防半截文件（块级校验失败早已在流层拦截）
      this.entries.delete(streamId)
      this.abortEntry(streamId, e)
      return
    }
    e.size += data.length
    e.w.write(data)
  }

  onEnd(peerUid: number, streamId: number, meta: { name: string; size: number }, error?: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return // 非同步流/权限拒绝/流名非法/作用域不符：无正式文件产出，静默收敛
    e.w.end(() => {
      if (error) {
        // 流层整体 sha256 终校验失败：删除 .part，绝不产出损坏暂存
        this.removePart(streamId, e)
        return
      }
      void peerUid
      void meta
      this.finalize(streamId, e)
    })
  }

  onAbort(peerUid: number, streamId: number, reason: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return
    this.abortEntry(streamId, e)
    void peerUid
    void reason
  }

  // ===== 内部 =====

  /** 解析 sync:{instanceId}:{key}；返回 null = 非法（整流拒绝，不产生任何文件） */
  private parseStreamName(name: string): { instanceId: string; key: string } | null {
    const rest = name.slice(SYNC_STREAM_PREFIX.length)
    const sep = rest.lastIndexOf(':')
    if (sep <= 0) return null
    const instanceId = rest.slice(0, sep)
    const key = rest.slice(sep + 1)
    // instanceId 直接拼入暂存路径，必须过白名单（防 '..'/'/' 路径穿越）；key 过同步白名单（防非法 key 落盘）
    if (!INSTANCE_ID_PATTERN.test(instanceId)) return null
    if (!SatelliteStore.isValidKey(key)) return null
    return { instanceId, key }
  }

  /** 整流收齐（流层整体 sha256 已过）后落位：覆盖式 rename（重推同一 key 实体时幂等覆盖旧暂存） */
  private finalize(streamId: number, e: SinkEntry): void {
    const part = `${e.target}.part`
    try {
      // Windows 上 rename 覆盖已存在目标可能 EEXIST：先清旧暂存再 rename（applyPush 只消费
      // 完整 .part rename 后的正式文件，窗口期无并发读——push 元数据在实体流 onEnd 之后才发生）
      rmSync(e.target, { force: true })
      renameSync(part, e.target)
      console.log(`[sync-sink] 同步实体就位：${basename(e.target)}（${e.size} 字节）`)
    } catch (err) {
      console.error(`[sync-sink] 暂存落位失败（streamId=${streamId}）:`, (err as Error).message)
      rmSync(part, { force: true })
    }
  }

  private abortEntry(streamId: number, e: SinkEntry): void {
    // skipped 条目（非同步流/权限拒绝/非法流名/作用域不符）无写句柄与 .part：直接跳过
    if (!e.w) return
    const part = `${e.target}.part`
    try {
      e.w.destroy()
    } catch {
      // 忽略
    }
    // fd 释放（close 事件）后再删 .part：Windows 上持有句柄时直接 rmSync 会失败或与异步 open 竞态
    e.w.once('close', () => {
      try {
        rmSync(part, { force: true })
      } catch {
        // 忽略
      }
    })
    // destroy 前若 open 尚未完成，'close' 可能不触发 → 定时兜底清理（防半截文件残留）
    setTimeout(() => {
      try {
        rmSync(part, { force: true })
      } catch {
        // 忽略
      }
    }, 1000).unref()
    void streamId
  }

  private removePart(streamId: number, e: SinkEntry): void {
    try {
      rmSync(`${e.target}.part`, { force: true })
    } catch (err) {
      console.warn(`[sync-sink] 清理 .part 失败（streamId=${streamId}）:`, (err as Error).message)
    }
  }
}