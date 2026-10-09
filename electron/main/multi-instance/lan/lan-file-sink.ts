/**
 * 为什么存在：LMST 流通道交付的是"已通过块级 sha256 校验的原始字节"，但把字节落成磁盘文件
 * 属于业务侧责任——必须把现有业务信封通道的安全语义（权限判定、路径校验、幂等去重、威胁内容防线）
 * 原样迁移到文件收端，否则"任意对端可向任意路径写任意字节"将成为新的攻击面。
 * 作用：按对端 uid 收件到 {root}/incoming/{peerUid}/：先以 {streamId}-{safeName}.part 流式落盘，
 * 整流收齐且可选威胁扫描通过后原子 rename 为正式文件；任一防线不过则整载荷丢弃（不产生正式文件）。
 * 默认安全：allowPeer 未放开（默认拒绝）时对端字节完全不落盘。
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { WriteStream } from 'fs'
import type { LanStreamBeginMeta } from './lan-stream'
import { SYNC_STREAM_PREFIX } from '../master/sync-stream-sink'
import { BACKUP_STREAM_PREFIX } from '../master/backup-stream-sink'

/** 参与整文件威胁扫描的最大字节数：超过阈值的文件跳过内容扫描（仅保留"绝不执行/解压/加载"防线） */
const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024

/** 多级相对路径最大段数（防超深路径递归/超长路径越界） */
const MAX_RELPATH_SEGMENTS = 64

export interface LanFileSinkOptions {
  /** 数据根目录（收件统一落 {root}/incoming/{peerUid}/，不向该目录之外写任何字节） */
  root: string
  /** 权限判定：仅当对端 uid 被显式放行才收件落盘；默认拒绝（调用方按业务关系放开，如好友/群成员） */
  allowPeer?: (peerUid: number) => boolean
  /**
   * 威胁内容防线（可选）：整流收齐后对字节做扫描，返回命中描述或 null。
   * 与 skill 市场的"收端防线"同语义：先整体校验再落位，命中即删 .part、不产出正式文件。
   * 仅对 ≤ maxScanBytes 的文件调用；超限文件不扫描（由"内容不执行"防线兜底，不替代 AV）。
   */
  scanContent?: (raw: Buffer) => string | null
  /** 参与内容扫描的最大字节数（默认 8MB） */
  maxScanBytes?: number
}

/** 单条流的落盘状态 */
interface SinkEntry {
  /** 落盘目标：正式文件名（不含 .part） */
  target: string
  w: WriteStream
  /** 已流式写入字节数（与协议 onData offset 对齐校验用） */
  size: number
  /** 幂等命中（同对端同 streamId 已收过）→ 后续数据直接丢弃 */
  skipped: boolean
  /** 目录项流（kind='dir'）：size=0，onBegin 时已 mkdir，无 .part/rename 语义 */
  isDir: boolean
}

export class LanFileSink {
  private readonly entries = new Map<number, SinkEntry>()
  private readonly incomingDir: string
  private allow: (peerUid: number) => boolean
  private readonly scanContent?: (raw: Buffer) => string | null
  private readonly maxScanBytes: number

  constructor(private readonly opts: LanFileSinkOptions) {
    this.incomingDir = join(opts.root, 'incoming')
    mkdirSync(this.incomingDir, { recursive: true })
    this.allow = opts.allowPeer ?? (() => false)
    this.scanContent = opts.scanContent
    this.maxScanBytes = opts.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES
  }

  /** 更新权限判定（好友关系等变化后调用；传 null 恢复默认拒绝） */
  setAllowPeer(allow: ((peerUid: number) => boolean) | null): void {
    this.allow = allow ?? (() => false)
  }

  /** 对端离线/服务停止：丢弃本端所有未收齐的 .part（不产生半成品） */
  reset(peerUid?: number): void {
    if (peerUid == null) {
      for (const [sid, e] of this.entries) {
        this.abortEntry(sid, e)
      }
      this.entries.clear()
      return
    }
    const e = this.entries.get(peerUid)
    if (e) {
      this.abortEntry(peerUid, e)
      this.entries.delete(peerUid)
    }
  }

  // ===== 桥接到 LanStreamCallbacks（由上层组装成链，可同时透传外部观察者） =====

  onBegin(peerUid: number, streamId: number, meta: LanStreamBeginMeta): void {
    if (this.entries.has(streamId)) return // 同流重复 begin（协议内不应出现）忽略

    // 0. 中继异步传输流：不进 incoming 实时收件链（由中继收件器按 relay 语义落盘），整流跳过
    if (meta.relay) {
      this.entries.set(streamId, {
        target: '',
        w: void 0 as unknown as WriteStream,
        size: 0,
        skipped: true,
        isDir: false
      })
      return
    }

    // 0.5 同步实体流（sync: 前缀）：不进 incoming 实时收件链（由 SyncStreamSink 按 instanceId 语义
    // 落 sync_staging，见 multi-instance/master/sync-stream-sink.ts），整流跳过防双写
    if (meta.name.startsWith(SYNC_STREAM_PREFIX)) {
      this.entries.set(streamId, {
        target: '',
        w: void 0 as unknown as WriteStream,
        size: 0,
        skipped: true,
        isDir: false
      })
      return
    }

    // 0.6 备份包流（backup: 前缀）：不进 incoming 收件链（由 BackupStreamSink 按 transferId 语义
    // 落 backup_dl/，见 multi-instance/master/backup-stream-sink.ts），整流跳过防双写
    if (meta.name.startsWith(BACKUP_STREAM_PREFIX)) {
      this.entries.set(streamId, {
        target: '',
        w: void 0 as unknown as WriteStream,
        size: 0,
        skipped: true,
        isDir: false
      })
      return
    }

    // 1. 权限判定：对端未被放行 → 整流丢弃（此后 onData/onEnd 不再落盘）
    if (!this.allow(peerUid)) {
      console.warn(`[lan-file] 拒绝收件：对端 uid=${peerUid} 未获收件权限（streamId=${streamId}）`)
      this.entries.set(streamId, {
        target: '',
        w: void 0 as unknown as WriteStream,
        size: 0,
        skipped: true,
        isDir: false
      })
      return
    }

    const peerDir = join(this.incomingDir, String(peerUid))
    // 2. 路径校验：单文件流仅允许单层安全名；文件夹流按多级相对路径逐段净化后重建
    const target = this.buildTarget(peerDir, streamId, meta)
    if (target === '') {
      console.warn(`[lan-file] 拒绝收件：非法相对路径（streamId=${streamId}，kind=${meta.kind ?? 'file'}, relPath=${meta.relPath ?? '-'}）`)
      this.entries.set(streamId, {
        target: '',
        w: void 0 as unknown as WriteStream,
        size: 0,
        skipped: true,
        isDir: false
      })
      return
    }

    // 目录项流：size=0，目标目录已（递归）创建，无正式文件可 rename
    if (meta.kind === 'dir') {
      if (existsSync(target)) {
        // 幂等：目录已存在 → 跳过（重发/重复广播场景）
        this.entries.set(streamId, { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true, isDir: true })
        return
      }
      mkdirSync(target, { recursive: true })
      this.entries.set(streamId, { target, w: void 0 as unknown as WriteStream, size: 0, skipped: false, isDir: true })
      return
    }

    // 3. 幂等：同对端同 streamId 的正式文件已存在（重放/重复广播）→ 跳过本次接收，不重复落盘
    if (existsSync(target)) {
      this.entries.set(streamId, { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true, isDir: false })
      return
    }

    mkdirSync(dirname(target), { recursive: true })
    const w = createWriteStream(`${target}.part`)
    // 吞掉写盘 IO 错误：destroy/磁盘满等情况由 abort/清理路径兜底，绝不让 error 变 uncaughtException 炸进程
    w.on('error', () => {})
    this.entries.set(streamId, { target, w, size: 0, skipped: false, isDir: false })
  }

  onData(peerUid: number, streamId: number, offset: number, data: Buffer): void {
    const e = this.entries.get(streamId)
    if (!e || e.skipped) return
    if (e.isDir) {
      // 目录项流不应携带数据（防御协议异常：size=0 却有 data 帧）——丢弃本流
      this.entries.delete(streamId)
      return
    }
    if (offset !== e.size) {
      // 协议保证序内交付；出现缺口说明收端状态异常，中止本流防半截文件（块级校验失败早已在流层拦截）
      this.entries.delete(streamId)
      this.abortEntry(streamId, e)
      return
    }
    e.size += data.length
    e.w.write(data)
    void peerUid
  }

  onEnd(peerUid: number, streamId: number, meta: { name: string; size: number }, error?: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return // 权限拒绝/幂等命中：无正式文件产出，静默收敛
    if (e.isDir) return // 目录项流：目录已创建完成，无落位动作
    e.w.end(() => {
      if (error) {
        // 协议层整体校验失败：删除 .part，绝不产出损坏文件
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

  /**
   * 计算落盘目标路径；返回 '' 表示非法（整流拒绝，不产生任何文件）。
   * 携带 transferId（邀请制直传）时收进 invites/{transferId}/ 独立暂存区：
   * 单文件流：incoming/{peerUid}/invites/{transferId}/{safeName}
   * 文件夹流：incoming/{peerUid}/invites/{transferId}/tree/{净化后的多级相对路径}
   * 邀请制接收方在 file-done 后把整个暂存区原子挪到下载文件夹，转移期内不与其他直连流互相污染。
   * 未携带 transferId（老语义：实时直连流）：
   * 单文件流：incoming/{peerUid}/{streamId}-{safeName}（前缀 streamId 防同对端同名覆盖搅局）
   * 文件夹流：incoming/{peerUid}/tree/{净化后的多级相对路径}（结构原样重建）
   */
  private buildTarget(peerDir: string, streamId: number, meta: LanStreamBeginMeta): string {
    const base = meta.transferId ? join(peerDir, 'invites', this.sanitizeName(meta.transferId)) : peerDir
    if (!meta.relPath) {
      // 单文件流：仅允许单层安全名（老路径语义不变）
      const safeName = this.sanitizeName(meta.name)
      return meta.transferId ? join(base, safeName) : join(base, `${streamId}-${safeName}`)
    }
    const segs = this.sanitizeRelPath(meta.relPath)
    if (!segs) return ''
    return join(base, 'tree', ...segs)
  }

  /**
   * 多级相对路径安全化：统一 / 分隔，逐段过白名单（禁 ..、.、绝对路径、盘符、控制符、
   * Windows 非法字符），限制段数上限。任一非法返回 null（整流拒绝）。
   * 幂等/深度防线：path.join 到固定 root 内，段净化后再拼接，杜绝 .. 越出 tree/。
   */
  private sanitizeRelPath(relPath: string): string[] | null {
    // 只接受纯相对路径：禁绝对路径（/ 开头、盘符开头）、禁 \ 变体
    if (!relPath || relPath.includes('\0')) return null
    if (relPath.startsWith('/') || relPath.startsWith('\\')) return null
    const rawSegs = relPath.split(/[/\\]+/).filter((s) => s.length > 0)
    if (rawSegs.length === 0 || rawSegs.length > MAX_RELPATH_SEGMENTS) return null
    const segs: string[] = []
    for (const seg of rawSegs) {
      if (seg === '.' || seg === '..') return null // 路径穿越：整流拒绝
      // 盘符（C:）与超窗净化：逐段 sanitizeName，结果不得与输入偏离（含 : / 等即视为非法）
      const clean = this.sanitizeName(seg)
      if (clean !== seg) return null
      segs.push(clean)
    }
    return segs
  }

  /** 整流校验通过后落位：可选威胁扫描 → 通过则原子 rename，命中则删除 .part */
  private finalize(streamId: number, e: SinkEntry): void {
    const part = `${e.target}.part`
    try {
      if (this.scanContent) {
        const size = e.size
        if (size <= this.maxScanBytes) {
          // 先整体校验再落位（与 skill 市场收端同语义），避免"命中威胁还产出正式文件"
          const hit = this.scanContent(readFileSync(part))
          if (hit) {
            console.warn(`[lan-file] 威胁内容防线命中（streamId=${streamId}，${hit}）：整载荷丢弃`)
            rmSync(part, { force: true })
            return
          }
        }
      }
      renameSync(part, e.target)
      // 隐私：只输出文件名，不输出接收落位的完整路径
      console.log(`[lan-file] 收件完成：${basename(e.target)}（${e.size} 字节）`)
    } catch (err) {
      console.error(`[lan-file] 收件落位失败（streamId=${streamId}）:`, (err as Error).message)
      rmSync(part, { force: true })
    }
  }

  private abortEntry(streamId: number, e: SinkEntry): void {
    if (e.isDir) return // 目录项流没有写句柄/.part，无需清理
    // skipped 条目（拒绝收件/幂等命中/中继流）无写句柄与 .part：直接跳过，避免对 undefined 调 destroy/once 崩溃
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
      console.warn(`[lan-file] 清理 .part 失败（streamId=${streamId}）:`, (err as Error).message)
    }
  }

  /** 文件名安全化：去路径成分（只留 basename）、剔除控制字符与 Windows 非法字符、防 . 与 .. */
  private sanitizeName(name: string): string {
    const base = basename(name) // win32 同时处理 / 与 \（路径穿越素材在此被剥掉）
    // eslint-disable-next-line no-control-regex -- 刻意剔除控制字符与 Windows 非法字符（路径整流防线）
    const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120)
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'unnamed'
  }
}