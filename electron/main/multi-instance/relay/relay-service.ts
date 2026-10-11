/**
 * 中继异步传输服务层（主系统中继器 = 大云盘语义）。
 * 为什么存在：实时 LAN 传输要求收发两端同时在线；当对端离线、或要"上传到主系统暂存、
 * 对端确认后再取件"时，需要一条独立于实时直连的异步通道。主系统（master）充当唯一中继存储端，
 * 发送端上传、接收端确认后从主系统下载——上传与下载是两件事，各自带进度、互不绑定在线时刻。
 * 作用：
 * - RelaySink：把带 relay 标记的二进制流落盘到目标（upload → {root}/relay/files/{itemId}/；
 * download → 接收端自定义下载位置 {downloadDir}/{targetName}/），整流安全与 incoming 同规则；
 * - 信封编排：上传登记/完成校验/通知/确认取件/下载完成/撤回/过期清理，状态机
 * uploading → uploaded → notified → downloaded / expired（store.transition 强制合法迁移）；
 * - 多机并发取件互不干扰：条目按 itemId 收敛到独立目录，下载回发以条目为整体串行化，
 * 取件权限按 receiverUid 收敛（见 handleConfirm），不同机器只触达自己的条目。
 * 默认安全：只有 master 持有中继存储；非 master 收 upload 流整流不落盘。下载目标默认
 * {root}/relay/downloads（ 接入用户自定义配置后改由配置提供），独立于 incoming 与账号数据。
 */

import { randomUUID } from 'crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, copyFileSync, statSync } from 'fs'
import { basename, dirname, join } from 'path'
import type { WriteStream } from 'fs'
import type { LanEnvelope } from '../lan/lan-types'
import type { LanSendResult } from '../lan/lan-service'
import type {
  LanDirectoryProgress,
  LanDirectoryResult,
  LanStreamBeginMeta,
  LanStreamCallbacks,
  LanStreamRelayTag,
  SendStreamResult
} from '../lan/lan-stream'
// 本机即中继端的取件复制需要遍历目录（结构保真，与流式回发等价；复用同一安全遍历防超深/失控目录）
import { walkDirectorySafe } from '../lan/lan-stream'
import { RelayStore } from './relay-store'
import type { RelayEntry, RelayEvent, RelayListItem } from './relay-types'

/** 无人确认默认保留期（天）：超过且未下载 → 主系统过期清理；发送方可随时撤回（ 起由 AppConfig.relay.retentionDays 覆盖） */
export const RELAY_DEFAULT_RETENTION_DAYS = 7

/**
 * 解析中继下载位置（AppConfig.relay.downloadDir 留空 → 默认 {root}/relay/downloads）。
 * 为什么独立成函数：装配层（getDownloadDir 依赖注入）与 AI 提示词段（relay 感知）都要算出
 * 同一份"实际下载位置"，若各处各自写 join 逻辑会随配置公式漂移；此函数是下载位置的单一事实源。
 */
export function resolveRelayDownloadDir(downloadDir: string | undefined, dataRoot: string): string {
  const custom = downloadDir?.trim()
  return custom || join(dataRoot, 'relay', 'downloads')
}

/** 多级相对路径最大段数（与 lan-file-sink 同规则：防超深路径递归/超长路径越界） */
const MAX_RELPATH_SEGMENTS = 64

export interface RelayServiceDeps {
  /** 数据根目录（master 侧中继存储挂 {root}/relay/ 下） */
  root: string
  /** 当前登录用户（未登录返回 null；上传/取件前校验） */
  getIdentity: () => { uid: number; 用户名: string } | null
  /** 本机角色：仅 master 持有中继存储端 */
  getRole: () => 'standalone' | 'master' | 'satellite'
  /** 经 L0 直连发送信封（上传登记/完成/通知/确认/下载完成/撤回；离线走 outbox 补投） */
  sendLan: (uid: number, type: string, payload: unknown) => LanSendResult
  /** 发送单个文件流（sender 上传 / master 回发下载流复用门面 sendLanFile） */
  sendLanFile: (
    uid: number,
    filePath: string,
    options: { name?: string; relay?: LanStreamRelayTag; onProgress?: (sentBytes: number, totalBytes: number) => void }
  ) => Promise<SendStreamResult>
  /** 发送整个目录流（结构保真；目录项流 + 文件流并发，全部带 relay 标记） */
  sendLanDirectory: (
    uid: number,
    dirPath: string,
    options: { relay?: LanStreamRelayTag; onProgress?: (p: LanDirectoryProgress) => void }
  ) => Promise<LanDirectoryResult>
  /** 全员名册（解析对端用户名 / 定位中继端 uid） */
  listRoster: () => Array<{ uid: number; 用户名: string; role: 'master' | 'satellite'; online: boolean }>
  /** 中继下载目标位置（接收端自定义下载位置； 起由装配层读 AppConfig.relay.downloadDir，未配置回退默认独立目录） */
  getDownloadDir: () => string
  /** 无人确认保留天数（ 起由装配层读 AppConfig.relay.retentionDays，未配置回退默认 7 天） */
  getRetentionDays: () => number
  /** 前端事件推送（webContents.send('relay:event', event)） */
  emit: (event: RelayEvent) => void
}

/** 中继收件器：把带 relay 标记的流落盘到 resolve 给出的目标；非中继流整流忽略（与实时链共存） */
interface RelaySinkTarget {
  rootDir: string
  /** 相对目标根的多级子路径（已逐段净化；空数组 = 根目录直落） */
  parts: string[]
  /** 目录项流（size=0，只 mkdir 不写 .part） */
  isDir: boolean
}

interface RelaySinkDeps {
  /** 解析流的落盘目标；返回 accept=false 整流忽略（无权/非中继/非法标记） */
  resolve: (peerUid: number, meta: LanStreamBeginMeta) => { accept: false } | { accept: true; target: RelaySinkTarget }
}

interface SinkEntry {
  target: string
  w: WriteStream
  size: number
  skipped: boolean
  isDir: boolean
}

const IGNORE_ENTRY: SinkEntry = { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true, isDir: false }

/** 流落盘器：幂等（正式目标已存在即跳过）、.part 临时写、abort 清理半成品——与 LanFileSink 同语义 */
class RelaySink {
  private readonly entries = new Map<number, SinkEntry>()

  constructor(private readonly deps: RelaySinkDeps) {}

  /** 对端离线/服务停止：丢弃未收齐的 .part（不产生半成品文件） */
  reset(): void {
    for (const [sid, e] of this.entries) {
      if (!e.skipped && !e.isDir) this.abortEntry(sid, e)
    }
    this.entries.clear()
  }

  onBegin(peerUid: number, streamId: number, meta: LanStreamBeginMeta): void {
    if (this.entries.has(streamId)) return
    if (!meta.relay) {
      // 非中继流：实时链的 LanFileSink 已接管，本收件器整流忽略
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    const resolved = this.deps.resolve(peerUid, meta)
    if (!resolved.accept) {
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    const { rootDir, parts, isDir } = resolved.target
    const target = join(rootDir, ...parts)
    // 路径防线：目标必须在传入的 rootDir 之内（parts 已逐段净化；这里再断言防 join 逃逸）
    if (!target.startsWith(rootDir + '\\') && !target.startsWith(rootDir + '/')) {
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    if (isDir) {
      if (existsSync(target)) {
        this.entries.set(streamId, IGNORE_ENTRY) // 幂等：目录已存在（重放场景）跳过
        return
      }
      mkdirSync(target, { recursive: true })
      this.entries.set(streamId, { target, w: void 0 as unknown as WriteStream, size: 0, skipped: false, isDir: true })
      return
    }
    // 幂等：正式目标已存在（重复下载/重放）→ 跳过，不覆盖已落盘的完整文件
    if (existsSync(target)) {
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    const w = createWriteStream(`${target}.part`)
    w.on('error', () => {}) // 吞掉写盘 IO 错误：由 abort/清理路径兜底，不炸主进程
    this.entries.set(streamId, { target, w, size: 0, skipped: false, isDir: false })
  }

  onData(peerUid: number, streamId: number, offset: number, data: Buffer): void {
    const e = this.entries.get(streamId)
    if (!e || e.skipped) return
    if (e.isDir) {
      this.entries.delete(streamId) // 目录项流不应携带数据：协议异常，丢弃本流
      return
    }
    if (offset !== e.size) {
      this.entries.delete(streamId)
      this.abortEntry(streamId, e) // 序内缺口说明状态异常：中止防半截文件
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
    if (e.skipped) return // 无权/幂等/非中继：无产出，静默收敛
    if (e.isDir) return // 目录项流：目录已建立
    e.w.end(() => {
      if (error) {
        this.removePart(streamId, e) // 协议层校验失败：删 .part，不产出损坏文件
        return
      }
      try {
        renameSync(`${e.target}.part`, e.target)
      } catch (err) {
        console.warn(`[relay] 中继落盘失败（streamId=${streamId}）:`, (err as Error).message)
        this.removePart(streamId, e)
      }
      void peerUid
      void meta
    })
  }

  onAbort(peerUid: number, streamId: number, reason: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return
    if (!e.isDir) this.abortEntry(streamId, e)
    void peerUid
    void reason
  }

  private abortEntry(streamId: number, e: SinkEntry): void {
    const part = `${e.target}.part`
    try {
      e.w.destroy()
    } catch {
      // 忽略
    }
    // fd 释放后再删 .part：Windows 上持有句柄直接 rmSync 会失败或与异步 open 竞态
    e.w.once('close', () => {
      try {
        rmSync(part, { force: true })
      } catch {
        // 忽略
      }
    })
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
    } catch {
      // 忽略
    }
    void streamId
  }
}

/** 收件流与其中继条目的绑定（wrapper 用 streamId 追踪，onEnd/onAbort 时据此收敛条目下载判定） */
interface StreamRelayInfo {
  itemId: string
  phase: 'upload' | 'download'
}

/** 进行中的下载条目统计（receiver 侧：条目所有流收齐后才算取件完成） */
interface PendingDownload {
  /** 未结束的流数（onBegin +1，onEnd/onAbort -1） */
  count: number
  /** 是否出现过失败流（abort 或 end error） */
  failed: boolean
  error?: string
}

export class RelayService {
  private readonly store: RelayStore | null
  private readonly sink: RelaySink
  private readonly isHub: boolean
  /** 下载回发去重：itemId → 进行中的 Promise（多端重复 confirm 只回发一次） */
  private readonly downloads = new Map<string, Promise<void>>()
  /** 本机收件流 → 中继标记（onBegin 记录，onEnd/onAbort 消费后清理） */
  private readonly streamRelays = new Map<number, StreamRelayInfo>()
  /** receiver 侧下载条目收齐统计 */
  private readonly pendingDownloads = new Map<string, PendingDownload>()
  /** 本机已确认取件的条目：download 流落盘守卫——只有先同意（confirm）才允许接收，防未确认条目被强推落盘 */
  private readonly confirmedDownloads = new Set<string>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: RelayServiceDeps) {
    this.isHub = deps.getRole() === 'master'
    // 只有 master 持有中继存储端；发送端/接收端视角不建 store（真值在主系统；端侧副本经事件同步， 接入）
    this.store = this.isHub ? new RelayStore(deps.root) : null
    this.sink = new RelaySink({
      resolve: (peerUid, meta) => this.resolveTarget(peerUid, meta)
    })
    // 过期清理：主系统定时兜底（未确认/超保留期条目不长期占用中继空间；已下载/已撤回为终态由发送侧语义处理）
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000)
    this.sweepTimer.unref()
  }

  /** 无人确认保留天数（装配层注入的配置值；未配置回退默认 7 天） */
  private retentionDays(): number {
    return this.deps.getRetentionDays() > 0 ? this.deps.getRetentionDays() : RELAY_DEFAULT_RETENTION_DAYS
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
    this.sink.reset()
    this.streamRelays.clear()
    this.pendingDownloads.clear()
    this.confirmedDownloads.clear()
  }

  // ===== 收件链桥（multi-instance 门面 wireLanStream 接线） =====

  /** 把中继收件器挂进流收端链（与 LanFileSink 并存：relay 流归这里，普通流整流忽略） */
  getStreamCallbacks(): LanStreamCallbacks {
    const sink = this.sink
    return {
      onBegin: (peerUid, streamId, meta) => {
        if (meta.relay) this.streamRelays.set(streamId, { itemId: meta.relay.itemId, phase: meta.relay.phase })
        if (meta.relay?.phase === 'download') {
          const p = this.pendingDownloads.get(meta.relay.itemId) ?? { count: 0, failed: false }
          p.count += 1
          this.pendingDownloads.set(meta.relay.itemId, p)
        }
        sink.onBegin(peerUid, streamId, meta)
      },
      onData: (peerUid, streamId, offset, data) => sink.onData(peerUid, streamId, offset, data),
      onEnd: (peerUid, streamId, meta, error) => {
        const r = this.streamRelays.get(streamId)
        this.streamRelays.delete(streamId)
        sink.onEnd(peerUid, streamId, meta, error)
        if (r?.phase === 'download') this.trackDownloadEnd(r.itemId, !!error, error)
      },
      onAbort: (peerUid, streamId, reason) => {
        const r = this.streamRelays.get(streamId)
        this.streamRelays.delete(streamId)
        sink.onAbort(peerUid, streamId, reason)
        if (r?.phase === 'download') this.trackDownloadEnd(r.itemId, true, reason)
      }
    }
  }

  /** receiver：条目全部下载流收齐 → 向中继端回报取件结果（下载完成 = 条目级语义，收件链收敛） */
  private trackDownloadEnd(itemId: string, failed: boolean, error?: string): void {
    const p = this.pendingDownloads.get(itemId)
    if (!p) return
    if (failed) {
      p.failed = true
      p.error = error
    }
    p.count -= 1
    if (p.count > 0) return
    this.pendingDownloads.delete(itemId)
    this.completeDownload(itemId, !p.failed, p.error)
  }

  // ===== 信封入口（LAN onMessage 转发：relay.* 前缀） =====

  handleLanEnvelope(env: LanEnvelope): void {
    switch (env.type) {
      case 'relay.upload-begin':
        this.handleUploadBegin(env)
        break
      case 'relay.upload-done':
        this.handleUploadDone(env)
        break
      case 'relay.notify':
        this.handleNotify(env)
        break
      case 'relay.confirm':
        this.handleConfirm(env)
        break
      case 'relay.download-done':
        this.handleDownloadDone(env)
        break
      case 'relay.revoke':
        this.handleRevoke(env)
        break
      default:
        break
    }
  }

  // ===== 发送端（任意角色）：上传登记 → 流式上传 → 完成回报 =====

  /** sender：发起上传登记（IPC 层选好文件后调用；随即调用 uploadFile/uploadDirectory 流式上传） */
  beginUpload(input: {
    receiverUid: number
    kind: 'file' | 'dir'
    name: string
    totalBytes: number
    files: number
    dirs: number
  }): { ok: boolean; itemId?: string; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = this.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端，中继上传暂不可用' }
    const itemId = randomUUID()
    const receiverName = this.peerName(input.receiverUid) ?? '未知'
    const expiresAt = Date.now() + this.retentionDays() * 24 * 60 * 60 * 1000
    const payload = {
      itemId,
      senderUid: identity.uid,
      senderName: identity.用户名,
      receiverUid: input.receiverUid,
      receiverName,
      kind: input.kind,
      name: input.name,
      totalBytes: input.totalBytes,
      files: input.files,
      dirs: input.dirs,
      expiresAt
    }
    // 本机即中继存储端：登记不再经 LAN 回环（LAN 无自己的 socket，sendTo 会进 outbox 永不送达）
    if (hub.uid === identity.uid) {
      this.registerEntry(payload)
      return { ok: true, itemId }
    }
    const res = this.deps.sendLan(hub.uid, 'relay.upload-begin', payload)
    if (!res.ok && res.mode !== 'outbox') {
      return { ok: false, error: res.error ?? '上传登记发送失败' }
    }
    // 本地（sender 视角）先登记 uploading 条目，便于 UI 即时反馈（真值以主系统为准）
    this.emit({ type: 'entry', entry: this.toEntry({ ...payload, createdAt: Date.now(), status: 'uploading' }) })
    return { ok: true, itemId }
  }

  /** sender：单文件上传到中继端（复用流式能力；relay 标记使收端落中继存储） */
  async uploadFile(
    filePath: string,
    opts: { itemId: string; name: string; onProgress?: (sentBytes: number, totalBytes: number) => void }
  ): Promise<{ ok: boolean; error?: string }> {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = this.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端：本地直接复制进中继目录（不经 LAN 流）
    if (hub.uid === identity.uid) {
      const itemId = opts.itemId
      const root = this.store?.ensureFiles(itemId)
      if (!root) return { ok: false, error: '本机不是中继存储端' }
      const target = join(root, this.sanitizeName(opts.name))
      try {
        mkdirSync(dirname(target), { recursive: true })
        const st = statSync(filePath, { throwIfNoEntry: false })
        if (!st?.isFile()) return { ok: false, error: '所选对象不是可读文件' }
        copyFileSync(filePath, target)
        opts.onProgress?.(st.size, st.size)
        this.emit({ type: 'progress', itemId, phase: 'upload', sentBytes: st.size, totalBytes: st.size })
      } catch (err) {
        this.emit({ type: 'error', itemId, error: `本地上传失败：${(err as Error).message}` })
        return { ok: false, error: (err as Error).message }
      }
      this.completeUpload(itemId)
      return { ok: true }
    }
    const res = await this.deps.sendLanFile(hub.uid, filePath, {
      name: opts.name,
      relay: { itemId: opts.itemId, phase: 'upload', targetName: opts.name, kind: 'file' },
      onProgress: (sent, total) => {
        opts.onProgress?.(sent, total)
        this.emit({ type: 'progress', itemId: opts.itemId, phase: 'upload', sentBytes: sent, totalBytes: total })
      }
    })
    if (!res.ok) {
      this.emit({ type: 'error', itemId: opts.itemId, error: res.error ?? '上传失败' })
      return { ok: false, error: res.error }
    }
    this.deps.sendLan(hub.uid, 'relay.upload-done', { itemId: opts.itemId, ackedBytes: res.ackedBytes })
    return { ok: true }
  }

  /** sender：文件夹上传（结构保真；目录项流 + 文件流并发，全部带 relay 标记与聚合进度） */
  async uploadDirectory(
    dirPath: string,
    opts: { itemId: string; name: string; onProgress?: (p: LanDirectoryProgress) => void }
  ): Promise<{ ok: boolean; error?: string }> {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = this.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端：递归复制进中继目录后收尾（保持结构；进度按文件累计）
    if (hub.uid === identity.uid) {
      const itemId = opts.itemId
      const root = this.store?.ensureFiles(itemId)
      if (!root) return { ok: false, error: '本机不是中继存储端' }
      const targetRoot = join(root, this.sanitizeName(opts.name))
      try {
        const entries = await walkDirectorySafe(dirPath)
        if (!entries) return { ok: false, error: '目录遍历失败（可能包含过多条目或不可读）' }
        const files = entries.filter((e) => e.kind === 'file')
        const totalBytes = files.reduce((acc, f) => acc + f.size, 0)
        const totalFiles = files.length
        const dirs = entries.filter((e) => e.kind === 'dir')
        mkdirSync(targetRoot, { recursive: true })
        let doneBytes = 0
        let doneFiles = 0
        for (const e of entries) {
          if (e.kind === 'dir') {
            mkdirSync(join(targetRoot, e.relPath), { recursive: true })
            continue
          }
          if (!e.filePath) continue // 文件条目必有 filePath；防御性跳过避免 undefined 进 copyFileSync
          const dest = join(targetRoot, e.relPath)
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(e.filePath, dest)
          doneBytes += e.size
          doneFiles += 1
          const p: LanDirectoryProgress = { doneBytes, totalBytes, doneFiles, totalFiles, relPath: e.relPath }
          opts.onProgress?.(p)
          this.emit({ type: 'progress', itemId, phase: 'upload', sentBytes: doneBytes, totalBytes, doneFiles, totalFiles })
        }
        void dirs // dirs 已并入目录创建
      } catch (err) {
        this.emit({ type: 'error', itemId, error: `本地上传失败：${(err as Error).message}` })
        return { ok: false, error: (err as Error).message }
      }
      this.completeUpload(itemId)
      return { ok: true }
    }
    const res = await this.deps.sendLanDirectory(hub.uid, dirPath, {
      relay: { itemId: opts.itemId, phase: 'upload', targetName: opts.name, kind: 'dir' },
      onProgress: (p) => {
        opts.onProgress?.(p)
        this.emit({
          type: 'progress',
          itemId: opts.itemId,
          phase: 'upload',
          sentBytes: p.doneBytes,
          totalBytes: p.totalBytes,
          doneFiles: p.doneFiles,
          totalFiles: p.totalFiles
        })
      }
    })
    if (!res.ok) {
      this.emit({ type: 'error', itemId: opts.itemId, error: res.error ?? '上传失败' })
      return { ok: false, error: res.error }
    }
    this.deps.sendLan(hub.uid, 'relay.upload-done', {
      itemId: opts.itemId,
      ackedBytes: res.ackedBytes,
      files: res.files,
      dirs: res.dirs
    })
    return { ok: true }
  }

  /** sender：撤回未取件的上传（中继端删除条目与文件实体；已下载则拒绝） */
  revoke(itemId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = this.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端：撤销本来就在本机执行（sendLan 会回环给自己进 outbox，走本地路径）
    if (hub.uid === identity.uid) {
      this.revokeLocal(identity.uid, itemId)
      return { ok: true }
    }
    const res = this.deps.sendLan(hub.uid, 'relay.revoke', { itemId })
    return res.ok || res.mode === 'outbox' ? { ok: true } : { ok: false, error: res.error ?? '撤回发送失败' }
  }

  // ===== 主系统（hub）侧：上传登记 / 完成校验 / 通知 =====

  /** 登记上传条目（LAN 信封与本机直通共用；发送方身份已由调用方校验） */
  private registerEntry(p: RelayUploadBeginPayloadLike): void {
    if (!this.store) return
    const now = Date.now()
    this.store.upsert({
      itemId: p.itemId,
      senderUid: p.senderUid,
      senderName: p.senderName ?? '未知',
      receiverUid: p.receiverUid,
      receiverName: p.receiverName ?? '未知',
      kind: p.kind,
      name: p.name,
      totalBytes: p.totalBytes ?? 0,
      files: p.files ?? 0,
      dirs: p.dirs ?? 0,
      createdAt: now,
      status: 'uploading',
      expiresAt: now + this.retentionDays() * 24 * 60 * 60 * 1000,
      storagePath: join('relay', 'files', p.itemId)
    })
    this.emitEntry(p.itemId)
  }

  private handleUploadBegin(env: LanEnvelope): void {
    const p = env.payload as RelayUploadBeginPayloadLike | undefined
    if (!p?.itemId || env.from !== p.senderUid) {
      console.warn('[relay] upload-begin 载荷非法或发送方不符，拒绝登记')
      return
    }
    this.registerEntry(p)
  }

  /** 上传收尾：字节校验 → uploaded → 通知接收端（本机接收端直接 emit，不走 LAN 回环） */
  private completeUpload(itemId: string): void {
    if (!this.store) return
    const entry = this.store.get(itemId)
    if (!entry || entry.status !== 'uploading') return
    // 收齐校验：文件实体目录存在且字节数达标（块级校验由流层保证；这里核对条目承诺总量）
    const root = this.store.filesRoot(entry.itemId)
    const gotBytes = root && existsSync(root) ? this.store.sizeOfFiles(entry.itemId) : 0
    if (gotBytes < entry.totalBytes) {
      console.warn(`[relay] 上传收齐校验未通过（itemId=${entry.itemId}，期望 ${entry.totalBytes} 实收 ${gotBytes}）`)
      this.emit({ type: 'error', itemId: entry.itemId, error: '上传内容不完整（字节数不符），请重试或撤回' })
      return
    }
    if (!this.store.transition(entry.itemId, 'uploaded')) return
    this.emitEntry(entry.itemId)
    // 通知接收端（对端离线走 outbox 补投；文件已在中继端，取件不依赖同时在线）
    this.notifyReceiver(entry)
  }

  private handleUploadDone(env: LanEnvelope): void {
    const p = env.payload as { itemId?: string } | undefined
    if (!p?.itemId) return
    this.completeUpload(p.itemId)
  }

  /** 通知接收端条目就绪；接收端是本机时直接 emit（LAN 无自己的 socket，回环会进 outbox） */
  private notifyReceiver(entry: RelayEntry): void {
    const identity = this.deps.getIdentity()
    const payload = this.notifyPayload(entry, false)
    if (identity && entry.receiverUid === identity.uid) {
      this.handleNotifyLocal(payload)
      return
    }
    this.deps.sendLan(entry.receiverUid, 'relay.notify', payload)
  }

  /** 构造 notify 信封载荷（普通提醒与撤销提醒共用；本机直通与 LAN 投递同一份数据，避免两处漂移） */
  private notifyPayload(entry: RelayEntry, revoked: boolean): RelayNotifyPayloadLike {
    return {
      itemId: entry.itemId,
      senderUid: entry.senderUid,
      senderName: entry.senderName,
      receiverUid: entry.receiverUid,
      kind: entry.kind,
      name: entry.name,
      totalBytes: revoked ? 0 : entry.totalBytes,
      files: revoked ? 0 : entry.files,
      dirs: revoked ? 0 : entry.dirs,
      expiresAt: revoked ? 0 : entry.expiresAt,
      ts: Date.now(),
      revoked
    }
  }

  // ===== 接收端侧：提醒 → 确认 → 下载完成 =====

  /** receiver：收到文件就绪提醒（社交链路直达；离线由 outbox 补投） */
  private handleNotify(env: LanEnvelope): void {
    const p = env.payload as RelayNotifyPayloadLike | undefined
    if (!p?.itemId) return
    const identity = this.deps.getIdentity()
    if (!identity) return
    if (p.receiverUid !== identity.uid && p.senderUid !== identity.uid) return // 只处理发给本机的提醒
    this.handleNotifyLocal(p)
  }

  /** 本地投递提醒（本机接收端由 notifyReceiver / revokeLocal 直连调用；payload 已通过身份过滤） */
  private handleNotifyLocal(p: RelayNotifyPayloadLike): void {
    const identity = this.deps.getIdentity()
    if (!identity) return
    if (p.revoked) {
      this.confirmedDownloads.delete(p.itemId) // 条目已撤回：撤销同意登记，后续 download 流一律拒收
      this.emit({ type: 'revoked', itemId: p.itemId })
      return
    }
    const now = Date.now()
    this.emit({
      type: 'notify',
      entry: {
        itemId: p.itemId,
        senderUid: p.senderUid,
        senderName: p.senderName,
        receiverUid: identity.uid,
        receiverName: identity.用户名,
        kind: p.kind,
        name: p.name,
        totalBytes: p.totalBytes,
        files: p.files,
        dirs: p.dirs,
        createdAt: p.ts ?? now,
        status: 'notified',
        expiresAt: p.expiresAt ?? now + this.retentionDays() * 24 * 60 * 60 * 1000
      }
    })
  }

  /** receiver：确认取件 → 通知中继端回发下载流（下载与上传分离；落自定义下载位置） */
  confirm(itemId: string): { ok: boolean; error?: string } {
    const identity = this.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = this.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端且本机即取件方：不经 LAN 回环（无自己的 socket），本地直接校验并复制
    if (hub.uid === identity.uid) {
      const res = this.confirmLocal(itemId)
      if (res.ok) this.confirmedDownloads.add(itemId) // 本地复制同样按同意制登记（guard 与远端一致）
      return res
    }
    const res = this.deps.sendLan(hub.uid, 'relay.confirm', { itemId })
    if (!res.ok && res.mode !== 'outbox') return { ok: false, error: res.error ?? '确认发送失败' }
    this.confirmedDownloads.add(itemId) // 同意登记先行：确认发出即视为本机同意接收，download 流据此放行
    return { ok: true }
  }

  /** hub 且本机即取件方：本地校验取件权 → 把中继文件复制到自定义下载位置（与 streamBack 落盘同构） */
  private confirmLocal(itemId: string): { ok: boolean; error?: string } {
    if (!this.store) return { ok: false, error: '本机不是中继存储端' }
    const entry = this.store.get(itemId)
    const identity = this.deps.getIdentity()
    if (!entry) {
      this.emit({ type: 'error', itemId, error: '条目不存在（可能已被撤回或过期清理）' })
      return { ok: false, error: '条目不存在（可能已被撤回或过期清理）' }
    }
    if (!identity || entry.receiverUid !== identity.uid) {
      return { ok: false, error: '只有接收方本人能确认取件' }
    }
    if (entry.status === 'downloaded' || entry.status === 'expired') return { ok: false, error: '条目已下载或已过期' }
    if (this.downloads.has(itemId)) return { ok: true } // 已在取件中：重复确认去重，不重开复制
    const root = this.store.filesRoot(entry.itemId)
    if (!root || !existsSync(root)) {
      this.emit({ type: 'error', itemId: entry.itemId, error: '中继文件实体缺失（可能已被清理），请发送方重新上传' })
      return { ok: false, error: '中继文件实体缺失（可能已被清理），请发送方重新上传' }
    }
    const promise = this.copyLocal(entry, root)
    this.downloads.set(itemId, promise)
    void promise.finally(() => this.downloads.delete(itemId))
    return { ok: true }
  }

  /**
   * 本机取件复制：把中继存储条目复制到自定义下载位置。
   * 为什么存在：本机既是中继端又是取件方时没有自己的 LAN socket，回发下载流无法送达，
   * 于是退化为本地复制——文件直接复制，目录结构保真（复用 walkDirectorySafe 安全遍历），
   * 进度按文件累计推事件，完成后走 completeDownload 本机分支置终态。
   */
  private async copyLocal(entry: RelayEntry, root: string): Promise<void> {
    const dlRoot = this.deps.getDownloadDir()
    try {
      mkdirSync(dlRoot, { recursive: true })
    } catch (err) {
      this.emit({ type: 'error', itemId: entry.itemId, error: `创建下载目录失败：${(err as Error).message}` })
      return
    }
    const targetRoot = join(dlRoot, this.sanitizeName(entry.name))
    try {
      if (entry.kind === 'file') {
        const src = join(root, entry.name)
        if (!existsSync(src)) throw new Error('中继文件实体缺失')
        copyFileSync(src, targetRoot)
        const size = statSync(src).size
        this.emit({ type: 'progress', itemId: entry.itemId, phase: 'download', sentBytes: size, totalBytes: size })
      } else {
        const entries = await walkDirectorySafe(root)
        if (!entries) throw new Error('目录遍历失败（可能包含过多条目或不可读）')
        const files = entries.filter((e) => e.kind === 'file')
        const totalBytes = files.reduce((acc, f) => acc + f.size, 0)
        const totalFiles = files.length
        mkdirSync(targetRoot, { recursive: true })
        let doneBytes = 0
        let doneFiles = 0
        for (const e of entries) {
          if (e.kind === 'dir') {
            mkdirSync(join(targetRoot, e.relPath), { recursive: true })
            continue
          }
          if (!e.filePath) continue
          const dest = join(targetRoot, e.relPath)
          mkdirSync(dirname(dest), { recursive: true })
          copyFileSync(e.filePath, dest)
          doneBytes += e.size
          doneFiles += 1
          this.emit({
            type: 'progress',
            itemId: entry.itemId,
            phase: 'download',
            sentBytes: doneBytes,
            totalBytes,
            doneFiles,
            totalFiles
          })
        }
      }
    } catch (err) {
      this.emit({ type: 'error', itemId: entry.itemId, error: `本机取件失败：${(err as Error).message}` })
      return
    }
    // 本地复制完成即视为取件完毕：回报动作在本机直接完成（hub 即本机）
    this.completeDownload(entry.itemId, true)
  }

  /** hub：收到确认 → 校验取件权 → 回发下载流（条目级串行，多端重复 confirm 只回发一次） */
  private handleConfirm(env: LanEnvelope): void {
    if (!this.store) return
    const p = env.payload as { itemId?: string } | undefined
    if (!p?.itemId) return
    const itemId = p.itemId // 提为局部 const，闭包内保持类型收窄
    const entry = this.store.get(itemId)
    if (!entry) {
      this.emit({ type: 'error', itemId, error: '条目不存在（可能已被撤回或过期清理）' })
      return
    }
    // 取件权限收敛：只有条目接收方本人能确认取件（不同机器互不干扰由此保证）
    if (entry.receiverUid !== env.from) {
      console.warn(`[relay] 取件权限拒绝：uid=${env.from} 尝试取件 itemId=${itemId}（接收方=${entry.receiverUid}）`)
      return
    }
    if (entry.status === 'downloaded' || entry.status === 'expired') return
    if (this.downloads.has(itemId)) return
    const root = this.store.filesRoot(entry.itemId)
    if (!root || !existsSync(root)) {
      this.emit({ type: 'error', itemId: entry.itemId, error: '中继文件实体缺失（可能已被清理），请发送方重新上传' })
      return
    }
    const promise = this.streamBack(entry, root)
    this.downloads.set(itemId, promise)
    void promise.finally(() => this.downloads.delete(itemId))
  }

  /** hub：把中继存储的条目内容流式回发给取件端（下载是独立的一段，带进度） */
  private async streamBack(entry: RelayEntry, root: string): Promise<void> {
    const targetPath = join(root, entry.name)
    const relayTag = { itemId: entry.itemId, phase: 'download' as const, targetName: entry.name, kind: entry.kind }
    if (entry.kind === 'file') {
      const res = await this.deps.sendLanFile(entry.receiverUid, targetPath, {
        relay: { ...relayTag, kind: 'file' },
        onProgress: (sent, total) =>
          this.emit({ type: 'progress', itemId: entry.itemId, phase: 'download', sentBytes: sent, totalBytes: total })
      })
      if (!res.ok) this.emit({ type: 'error', itemId: entry.itemId, error: `回发下载流失败：${res.error ?? '未知'}` })
      return
    }
    const res = await this.deps.sendLanDirectory(entry.receiverUid, targetPath, {
      relay: { ...relayTag, kind: 'dir' },
      onProgress: (p) =>
        this.emit({
          type: 'progress',
          itemId: entry.itemId,
          phase: 'download',
          sentBytes: p.doneBytes,
          totalBytes: p.totalBytes,
          doneFiles: p.doneFiles,
          totalFiles: p.totalFiles
        })
    })
    if (!res.ok) this.emit({ type: 'error', itemId: entry.itemId, error: `回发下载流失败：${res.error ?? '未知'}` })
  }

  /** receiver：条目下载流全部收齐 → 向中继端回报取件结果（hub 是本机时本地直接置终态） */
  private completeDownload(itemId: string, ok: boolean, error?: string): void {
    if (ok) this.confirmedDownloads.delete(itemId) // 下载完成即消费同意；失败保留登记以支持重试
    this.emit({ type: 'done', itemId, ok, error })
    const hub = this.findHub()
    const identity = this.deps.getIdentity()
    if (!hub || !identity) return
    // 本机即中继存储端且本机即取件方：download-done 不经 LAN 回环（无自己的 socket），本地直接收尾
    if (hub.uid === identity.uid) {
      this.applyDownloadDone(itemId, ok, identity.uid)
      return
    }
    this.deps.sendLan(hub.uid, 'relay.download-done', { itemId, ok, error })
  }

  /** hub：处理取件完成回报 → 条目置终态 downloaded（元数据保留，文件实体按保留策略在后续清理中回收） */
  private applyDownloadDone(itemId: string, ok: boolean, fromUid: number): void {
    if (!this.store) return
    if (!ok) return
    const entry = this.store.get(itemId)
    if (!entry || entry.status === 'downloaded' || entry.status === 'expired') return
    if (entry.receiverUid !== fromUid) return // 只有接收方本人能回报取件完成
    this.store.transition(itemId, 'downloaded', { downloadedAt: Date.now() })
    this.emitEntry(itemId)
  }

  /** hub：信封入口——取件完成回报（远端 receiver 经 LAN 送达） */
  private handleDownloadDone(env: LanEnvelope): void {
    const p = env.payload as { itemId?: string; ok?: boolean } | undefined
    if (!p?.itemId) return
    this.applyDownloadDone(p.itemId, p.ok !== false, env.from)
  }

  // ===== 撤回 / 列表 / 过期清理 =====

  /** hub：执行撤回（远端 sender 经 LAN 信封与本机 sender 本地直通共用；接收端在本机时直接 emit 撤销提醒） */
  private revokeLocal(senderUid: number, itemId: string): void {
    if (!this.store) return
    const entry = this.store.get(itemId)
    if (!entry) return
    if (entry.senderUid !== senderUid) return // 只有发送方本人能撤回
    if (entry.status === 'downloaded') {
      this.emit({ type: 'error', itemId: entry.itemId, error: '对方已下载完成，无法撤回' })
      return
    }
    this.store.remove(itemId, true)
    this.emit({ type: 'revoked', itemId: entry.itemId })
    // 已通知过接收端 → 补发撤销提醒（receiver 侧清除提醒；接收端在本机时直接 emit，不走 LAN 回环）
    if (entry.status === 'notified') {
      const payload = this.notifyPayload(entry, true)
      const identity = this.deps.getIdentity()
      if (identity && entry.receiverUid === identity.uid) this.handleNotifyLocal(payload)
      else this.deps.sendLan(entry.receiverUid, 'relay.notify', payload)
    }
  }

  /** hub：信封入口——远端发送方的撤回请求 */
  private handleRevoke(env: LanEnvelope): void {
    const p = env.payload as { itemId?: string } | undefined
    if (!p?.itemId) return
    this.revokeLocal(env.from, p.itemId)
  }

  /** 列表：中继端返回真值；非中继端本地无实体（端侧副本经事件同步， 接入） */
  list(): RelayListItem[] {
    const identity = this.deps.getIdentity()
    if (!identity || !this.store) return []
    return this.store
      .list()
      .filter((e) => e.senderUid === identity.uid || e.receiverUid === identity.uid)
      .map((e) => ({
        itemId: e.itemId,
        kind: e.kind,
        name: e.name,
        totalBytes: e.totalBytes,
        files: e.files,
        dirs: e.dirs,
        status: e.status,
        direction: e.senderUid === identity.uid ? 'send' : 'receive',
        peerUid: e.senderUid === identity.uid ? e.receiverUid : e.senderUid,
        peerName: e.senderUid === identity.uid ? e.receiverName : e.senderName,
        createdAt: e.createdAt,
        expiresAt: e.expiresAt,
        downloadedAt: e.downloadedAt
      }))
  }

  /** hub：过期清理（无人确认策略之一：保留期内可撤回/可补取，超期自动清除不长期占空间） */
  sweep(): number {
    if (!this.store) return 0
    return this.store.sweepExpired()
  }

  /** 中继运行信息（UI 面板与 AI 提示词共用：角色/下载位置/保留策略； 起下载位置与保留天数均来自 AppConfig.relay） */
  getInfo(): { isHub: boolean; downloadDir: string; retentionDays: number } {
    return {
      isHub: this.isHub,
      downloadDir: this.deps.getDownloadDir(),
      retentionDays: this.retentionDays()
    }
  }

  // ===== 内部 =====

  /** 前端事件统一出口（经装配层注入的 emit 推送到 renderer） */
  private emit(event: RelayEvent): void {
    this.deps.emit(event)
  }

  private emitEntry(itemId: string): void {
    const entry = this.store?.get(itemId)
    if (entry) this.emit({ type: 'entry', entry })
  }

  /** 本地合成 RelayEntry（sender/receiver 视角展示用；真值在主系统） */
  private toEntry(p: RelayUploadBeginPayloadLike & { createdAt: number; status: RelayEntry['status'] }): RelayEntry {
    return {
      itemId: p.itemId,
      senderUid: p.senderUid,
      senderName: p.senderName ?? '未知',
      receiverUid: p.receiverUid,
      receiverName: p.receiverName ?? '未知',
      kind: p.kind,
      name: p.name,
      totalBytes: p.totalBytes ?? 0,
      files: p.files ?? 0,
      dirs: p.dirs ?? 0,
      createdAt: p.createdAt,
      status: p.status,
      expiresAt: p.expiresAt ?? 0
    }
  }

  /** 定位中继端（主系统）：本机是 master → 本机；否则在名册中找在线的 master 节点 */
  private findHub(): { uid: number; online: boolean } | null {
    if (this.isHub) {
      const identity = this.deps.getIdentity()
      return identity ? { uid: identity.uid, online: true } : null
    }
    const master = this.deps.listRoster().find((p) => p.role === 'master' && p.online)
    return master ? { uid: master.uid, online: true } : null
  }

  /** 名册解析对端用户名 */
  private peerName(uid: number): string | null {
    return this.deps.listRoster().find((p) => p.uid === uid)?.用户名 ?? null
  }

  /** 中继流落盘目标解析（upload → 中继存储；download → 自定义下载位置；无权/非法整流拒绝） */
  private resolveTarget(
    peerUid: number,
    meta: LanStreamBeginMeta
  ): { accept: false } | { accept: true; target: RelaySinkTarget } {
    const relay = meta.relay
    if (!relay) return { accept: false }
    void peerUid
    if (relay.phase === 'upload') {
      // 上传流只被中继存储端接受；其他角色整流不落盘
      if (!this.store || !this.isHub) return { accept: false }
      const root = this.store.filesRoot(relay.itemId)
      if (!root) return { accept: false }
      mkdirSync(root, { recursive: true })
      return this.buildTarget(root, meta, relay)
    }
    // 下载流：接收端落到自定义下载位置——仅当本机已确认（同意制）才放行；未确认/伪造的 download 流整流拒绝
    if (!this.confirmedDownloads.has(relay.itemId)) {
      console.warn(`[relay] 下载流拒绝：itemId=${relay.itemId} 未经本机确认，防强推落盘`)
      return { accept: false }
    }
    const dlRoot = this.deps.getDownloadDir()
    try {
      mkdirSync(dlRoot, { recursive: true })
    } catch {
      return { accept: false }
    }
    return this.buildTarget(dlRoot, meta, relay)
  }

  /** 结合顶层 targetName 与多级 relPath 构造落盘目标（顶层始终一层 targetName，与回发端 layout 对齐） */
  private buildTarget(
    rootDir: string,
    meta: LanStreamBeginMeta,
    relay: LanStreamRelayTag
  ): { accept: true; target: RelaySinkTarget } | { accept: false } {
    const top = this.sanitizeName(relay.targetName)
    if (meta.kind === 'dir') {
      return { accept: true, target: { rootDir, parts: [top], isDir: true } }
    }
    if (!meta.relPath) {
      return { accept: true, target: { rootDir, parts: [top], isDir: false } }
    }
    const segs = this.sanitizeRelPath(meta.relPath)
    if (!segs) return { accept: false }
    return { accept: true, target: { rootDir, parts: [top, ...segs], isDir: false } }
  }

  /** 多级相对路径安全化（与 lan-file-sink.sanitizeRelPath 同规则；未来可抽公共模块） */
  private sanitizeRelPath(relPath: string): string[] | null {
    if (!relPath || relPath.includes('\0')) return null
    if (relPath.startsWith('/') || relPath.startsWith('\\')) return null
    const rawSegs = relPath.split(/[/\\]+/).filter((s) => s.length > 0)
    if (rawSegs.length === 0 || rawSegs.length > MAX_RELPATH_SEGMENTS) return null
    const segs: string[] = []
    for (const seg of rawSegs) {
      if (seg === '.' || seg === '..') return null
      const clean = this.sanitizeName(seg)
      if (clean !== seg) return null
      segs.push(clean)
    }
    return segs
  }

  /** 文件名安全化（与 lan-file-sink.sanitizeName 同规则） */
  private sanitizeName(name: string): string {
    const base = basename(name)
    // eslint-disable-next-line no-control-regex -- 剔除控制字符与 Windows 非法字符（路径整流防线）
    const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120)
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'unnamed'
  }
}

/** payload 形状（与 relay-types 对齐；endpoint 载荷经信封 JSON 序列化，端侧自行校验字段） */
interface RelayUploadBeginPayloadLike {
  itemId: string
  senderUid: number
  senderName?: string
  receiverUid: number
  receiverName?: string
  kind: 'file' | 'dir'
  name: string
  totalBytes?: number
  files?: number
  dirs?: number
  expiresAt?: number
}

interface RelayNotifyPayloadLike {
  itemId: string
  senderUid: number
  senderName: string
  /** 目标接收方 uid（提醒只投递本人；handleNotify 据此过滤） */
  receiverUid: number
  kind: 'file' | 'dir'
  name: string
  totalBytes: number
  files: number
  dirs: number
  expiresAt: number
  ts: number
  revoked?: boolean
}