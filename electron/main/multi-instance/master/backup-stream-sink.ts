/**
 * 为什么存在：备份下载分块面（backup_dl）收端。备份 zip 在主系统侧打包后一律经
 * lan-stream 分块面推送到分系统本机——不再按体积分级、不保留 HTTP 整包路径（body
 * 体积限制 + 无进度停滞判定 + 固定超时全是"限制"残留）。LAN 流通道交付"已通过块级
 * sha256 + 整体 sha256 的原始字节"，但把字节落成本地 zip 文件是业务侧责任——必须与
 * 通用收件链（lan-file-sink 的 incoming/）隔离：backup_dl 只承接主系统推送的备份包，
 * 按 transferId 隔离落盘（transferId 含随机段，无对端 uid 歧义；备份流方向固定为
 * master → satellite，收端不依赖对端 uid 做归属键）。
 * 作用：接收流名形如 'backup:{date}'（master 侧 sendBytes 写入）且必带 transferId 的
 * 备份流，先写 {root}/backup_dl/{transferId}.zip.part，整流收齐（onEnd 无 error =
 * 流层整体 sha256 已通过）后原子 rename 为正式文件，并 resolve 该 transferId 的就绪
 * 等待者（downloadBackupZip 的 awaitZipReady 消费）；任一步失败
 * （abort/终校验失败/缺 transferId）绝不产出正式文件并向等待者报错。
 */

import { createWriteStream, mkdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { WriteStream } from 'fs'
import type { LanStreamBeginMeta } from '../lan/lan-stream'

/** 流名前缀（master 侧推流与收端解析共用；流名其余部分是备份日期，收端仅凭 transferId 定位） */
export const BACKUP_STREAM_PREFIX = 'backup:'

/**
 * transferId 白名单：backup-{uid}-{date}-{ms}-{hex}。只允许字母数字与 '-'，
 * 直接拼入落盘文件名的段必须过白名单（防 '..' / '/' 路径穿越）。
 */
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9-]+$/

/** 单条流的落盘状态 */
interface SinkEntry {
  /** 业务传输关联号（awaitZipReady 的键；文件名的隔离段） */
  transferId: string
  /** 正式 zip 目标路径（不含 .part） */
  target: string
  w: WriteStream
  /** 已流式写入字节数（与协议 onData offset 对齐校验用） */
  size: number
  /** 非备份流/缺 transferId/非法 transferId → 整流丢弃，不产生正式文件 */
  skipped: boolean
}

export interface BackupStreamSinkOptions {
  /** 数据根目录（备份统一落 {root}/backup_dl/，不向该目录之外写任何字节） */
  root: string
}

export class BackupStreamSink {
  private readonly entries = new Map<number, SinkEntry>()
  /** 已完成 transferId → 正式 zip 绝对路径（awaitZipReady 幂等命中；同会话重复下载直接返回） */
  private readonly ready = new Map<string, string>()
  /** 等待者（awaitZipReady 先行注册，onEnd/onAbort 时按 transferId 决定 resolve/reject） */
  private readonly waiters = new Map<string, Array<{ resolve: (path: string) => void; reject: (err: Error) => void }>>()

  constructor(private readonly opts: BackupStreamSinkOptions) {}

  /** 对端离线/服务停止：丢弃本端所有未收齐的 .part（不产生半成品） */
  reset(): void {
    for (const [, e] of this.entries) {
      this.abortEntry(e)
    }
    this.entries.clear()
  }

  // ===== 就绪契约（downloadBackupZip LAN 分支调用） =====

  /** 等待某 transferId 的 zip 就绪；已收齐立即返回落盘绝对路径，失败（中止/终校验不过）reject。
   * 为什么不做总超时：备份传输可靠性由 LAN 层块级停滞判定承担（见 lan-stream），
   * 主系统推流成功必然先于本请求的 HTTP 响应完成，此处要么已就绪要么即将就绪，
   * 没有"永远等不到"的合法路径——错误路径全部由 fail() 显式 reject。 */
  awaitZipReady(transferId: string): Promise<string> {
    const done = this.ready.get(transferId)
    if (done) return Promise.resolve(done)
    const entry = this.waiters.get(transferId) ?? []
    return new Promise<string>((resolve, reject) => {
      entry.push({ resolve, reject })
      this.waiters.set(transferId, entry)
    })
  }

  // ===== 桥接到 LanStreamCallbacks（与 lan-file-sink / sync-stream-sink 同链并存，只消费 backup: 前缀流） =====

  onBegin(_peerUid: number, streamId: number, meta: LanStreamBeginMeta): void {
    if (this.entries.has(streamId)) return // 同流重复 begin（协议内不应出现）忽略

    // 1. 流名识别：非 'backup:' 前缀的流不是备份业务（同步/好友/中继/聊天室流），整流跳过
    if (!meta.name.startsWith(BACKUP_STREAM_PREFIX)) {
      this.entries.set(streamId, { transferId: '', target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true })
      return
    }
    // 2. transferId 白名单：缺失或非法 → 整流丢弃（备份下载必须有业务关联号，避免匿名字节落盘）
    if (!meta.transferId || !TRANSFER_ID_PATTERN.test(meta.transferId)) {
      console.warn(`[backup-sink] 拒绝备份流：transferId 缺失或非法（streamId=${streamId}，name=${meta.name.slice(0, 80)}）`)
      this.entries.set(streamId, { transferId: '', target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true })
      return
    }
    // 3. 落盘路径：backup_dl 根下按 transferId 单文件（zip 是打包产物，不存在多级结构）
    const target = join(this.opts.root, 'backup_dl', `${meta.transferId}.zip`)
    mkdirSync(dirname(target), { recursive: true })
    const w = createWriteStream(`${target}.part`)
    // 吞掉写盘 IO 错误：destroy/磁盘满等情况由 abort/清理路径兜底，绝不让 error 变 uncaughtException 炸进程
    w.on('error', () => {})
    this.entries.set(streamId, { transferId: meta.transferId, target, w, size: 0, skipped: false })
  }

  onData(_peerUid: number, streamId: number, offset: number, data: Buffer): void {
    const e = this.entries.get(streamId)
    if (!e || e.skipped) return
    if (offset !== e.size) {
      // 协议保证序内交付；出现缺口说明收端状态异常，中止本流防半截文件（块级校验失败早已在流层拦截）
      this.entries.delete(streamId)
      this.abortEntry(e)
      return
    }
    e.size += data.length
    e.w.write(data)
  }

  onEnd(_peerUid: number, streamId: number, _meta: { name: string; size: number }, error?: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return // 非备份流/缺 transferId：无正式文件产出，静默收敛
    e.w.end(() => {
      if (error) {
        // 流层整体 sha256 终校验失败：删除 .part，绝不产出损坏 zip，并向等待者报错
        this.removePart(e)
        this.fail(e.transferId, new Error(`备份流终校验失败：${error}`))
        return
      }
      this.finalize(e)
    })
  }

  onAbort(_peerUid: number, streamId: number, reason: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return
    this.abortEntry(e)
    this.fail(e.transferId, new Error(`备份流中止：${reason}`))
  }

  // ===== 内部 =====

  /** 整流收齐（流层整体 sha256 已过）后落位：覆盖式 rename，成功则唤醒该 transferId 的等待者 */
  private finalize(e: SinkEntry): void {
    const part = `${e.target}.part`
    try {
      // Windows 上 rename 覆盖已存在目标可能 EEXIST：先清旧文件再 rename（transferId 含随机段，
      // 同会话内几乎不可能重名；写法与 sync/sink 一致求稳妥）
      rmSync(e.target, { force: true })
      renameSync(part, e.target)
      console.log(`[backup-sink] 备份就位：${basename(e.target)}（${e.size} 字节）`)
      const ws = this.waiters.get(e.transferId)
      this.waiters.delete(e.transferId)
      this.ready.set(e.transferId, e.target)
      ws?.forEach((w) => w.resolve(e.target))
    } catch (err) {
      console.error(`[backup-sink] 备份落位失败（transferId=${e.transferId}）:`, (err as Error).message)
      rmSync(part, { force: true })
      this.fail(e.transferId, new Error(`备份落位失败：${(err as Error).message}`))
    }
  }

  /** 显式失败（abort/校验不过/落位失败）：唤醒该 transferId 的全部等待者并报错 */
  private fail(transferId: string, err: Error): void {
    const ws = this.waiters.get(transferId)
    if (!ws) return
    this.waiters.delete(transferId)
    ws.forEach((w) => w.reject(err))
  }

  private abortEntry(e: SinkEntry): void {
    // skipped 条目（非备份流/缺 transferId）无写句柄与 .part：直接跳过
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
  }

  private removePart(e: SinkEntry): void {
    try {
      rmSync(`${e.target}.part`, { force: true })
    } catch (err) {
      console.warn(`[backup-sink] 清理 .part 失败（transferId=${e.transferId}）:`, (err as Error).message)
    }
  }
}