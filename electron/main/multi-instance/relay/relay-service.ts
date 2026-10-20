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

import { mkdirSync } from 'fs'
import { basename, join } from 'path'
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
import { RelayStore } from './relay-store'
import type { RelayEntry, RelayEvent, RelayListItem } from './relay-types'
import { RelaySink } from './relay-sink'
import type { RelaySinkTarget } from './relay-sink'
import {
  beginUpload,
  revoke,
  uploadDirectory,
  uploadFile
} from './relay-upload'
import {
  applyDownloadDone,
  completeUpload,
  handleConfirm,
  handleDownloadDone,
  handleRevoke,
  handleUploadBegin,
  handleUploadDone,
  registerEntry,
  revokeLocal
} from './relay-hub'
import {
  completeDownload,
  confirm,
  handleNotify,
  handleNotifyLocal
} from './relay-receive'
import type { PendingDownload } from './relay-receive'
import type { RelayHost, RelayUploadBeginPayloadLike } from './relay-host'

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

/** 收件流与其中继条目的绑定（wrapper 用 streamId 追踪，onEnd/onAbort 时据此收敛条目下载判定） */
interface StreamRelayInfo {
  itemId: string
  phase: 'upload' | 'download'
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
  /** 四模块宿主句柄（闭包引用本实例私有成员，见 buildHost） */
  private readonly host: RelayHost

  constructor(private readonly deps: RelayServiceDeps) {
    this.isHub = deps.getRole() === 'master'
    // 只有 master 持有中继存储端；发送端/接收端视角不建 store（真值在主系统；端侧副本经事件同步， 接入）
    this.store = this.isHub ? new RelayStore(deps.root) : null
    this.sink = new RelaySink({
      resolve: (peerUid, meta) => this.resolveTarget(peerUid, meta)
    })
    this.host = this.buildHost()
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
    this.host.completeDownload(itemId, !p.failed, p.error)
  }
  // ===== 信封入口（LAN onMessage 转发：relay.* 前缀） =====

  handleLanEnvelope(env: LanEnvelope): void {
    switch (env.type) {
      case 'relay.upload-begin':
        handleUploadBegin(this.host, env)
        break
      case 'relay.upload-done':
        handleUploadDone(this.host, env)
        break
      case 'relay.notify':
        handleNotify(this.host, env)
        break
      case 'relay.confirm':
        handleConfirm(this.host, env)
        break
      case 'relay.download-done':
        handleDownloadDone(this.host, env)
        break
      case 'relay.revoke':
        handleRevoke(this.host, env)
        break
      default:
        break
    }
  }

  // ===== 四模块委托（ADR-09）：实现已外移 ./relay-{sink,upload,hub,receive}，宿主只保留编排与协议锚点 =====

  /** sender：发起上传登记（实现见 relay-upload.ts） */
  beginUpload(input: {
    receiverUid: number
    kind: 'file' | 'dir'
    name: string
    totalBytes: number
    files: number
    dirs: number
  }): { ok: boolean; itemId?: string; error?: string } {
    return beginUpload(this.host, input)
  }

  /** sender：单文件上传（实现见 relay-upload.ts） */
  async uploadFile(
    filePath: string,
    opts: { itemId: string; name: string; onProgress?: (sentBytes: number, totalBytes: number) => void }
  ): Promise<{ ok: boolean; error?: string }> {
    return uploadFile(this.host, filePath, opts)
  }

  /** sender：文件夹上传（实现见 relay-upload.ts） */
  async uploadDirectory(
    dirPath: string,
    opts: { itemId: string; name: string; onProgress?: (p: LanDirectoryProgress) => void }
  ): Promise<{ ok: boolean; error?: string }> {
    return uploadDirectory(this.host, dirPath, opts)
  }

  /** sender：撤回未取件的上传（实现见 relay-upload.ts → hub 的 revokeLocal） */
  revoke(itemId: string): { ok: boolean; error?: string } {
    return revoke(this.host, itemId)
  }

  /** receiver：确认取件（实现见 relay-receive.ts） */
  confirm(itemId: string): { ok: boolean; error?: string } {
    return confirm(this.host, itemId)
  }

  /**
   * 四模块宿主句柄：以闭包引用本实例成员（读时取当前值，与直接 `this.x` 等价）。
   * 为什么用闭包而不直接把 this 传出去：直接传 this 要求 17 个内部成员放宽为 public
   * （TS 私有成员不满足接口），闭包方案既保持封装、又让模块只依赖它真正需要的成员。
   */
  private buildHost(): RelayHost {
    // ⚠️ 对象字面量里的 getter 中 `this` 指向字面量自身（写 this.store 会自引用/递归），
    // 故用「读函数」闭包捕获类实例（避免 no-this-alias 的别名写法，同时保持读时取当前值）。
    const readStore = (): RelayStore | null => this.store
    const readDownloads = (): Map<string, Promise<void>> => this.downloads
    const readConfirmedDownloads = (): Set<string> => this.confirmedDownloads
    return {
      deps: this.deps,
      get store() {
        return readStore()
      },
      get downloads() {
        return readDownloads()
      },
      get confirmedDownloads() {
        return readConfirmedDownloads()
      },
      retentionDays: () => this.retentionDays(),
      findHub: () => this.findHub(),
      peerName: (uid) => this.peerName(uid),
      sanitizeName: (name) => this.sanitizeName(name),
      toEntry: (p) => this.toEntry(p),
      emit: (event) => this.emit(event),
      emitEntry: (itemId) => this.emitEntry(itemId),
      registerEntry: (p) => registerEntry(this.host, p),
      completeUpload: (itemId) => completeUpload(this.host, itemId),
      revokeLocal: (senderUid, itemId) => revokeLocal(this.host, senderUid, itemId),
      handleNotifyLocal: (p) => handleNotifyLocal(this.host, p),
      applyDownloadDone: (itemId, ok, fromUid) => applyDownloadDone(this.host, itemId, ok, fromUid),
      completeDownload: (itemId, ok, error) => completeDownload(this.host, itemId, ok, error)
    }
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