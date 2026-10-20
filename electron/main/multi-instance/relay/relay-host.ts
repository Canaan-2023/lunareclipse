/**
 * @category 多实例
 * @summary 中继四模块的共享契约：宿主句柄 RelayHost + 信封载荷形状
 *
 * 为什么独立成文件：ADR-09 把 RelayService 的四类角色逻辑外移后，四个模块需要一个**共同的宿主句柄**
 * 与**共同的载荷形状**契约；放在本文件（纯类型、无运行时 import）可避免模块 ↔ 宿主之间的运行时环。
 *
 * ADR-09 拆分自 relay-service.ts（纯搬移不改行为）：函数收 `host` 句柄，
 * 状态与共享能力经该句柄读写（宿主 facade 以闭包提供，**不放宽类成员可见性**）。
 */
import type { RelayStore } from './relay-store'
import type { RelayEntry, RelayEvent } from './relay-types'
import type { RelayServiceDeps } from './relay-service'

/** payload 形状（与 relay-types 对齐；endpoint 载荷经信封 JSON 序列化，端侧自行校验字段） */
export interface RelayUploadBeginPayloadLike {
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

export interface RelayNotifyPayloadLike {
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

/**
 * 四模块的宿主句柄：只暴露模块真正需要读写的成员（状态切片 + 跨模块能力）。
 * 宿主以**闭包**实现（见 relay-service.ts 的 buildHost），故 RelayService 的内部成员
 * 不必放宽为 public —— 句柄取值等价于直接 `this.x`。
 */
export interface RelayHost {
  deps: RelayServiceDeps
  /** 中继条目表（真 owner 为 relay-store.ts；非 master 为 null） */
  store: RelayStore | null
  /** 下载回发去重：itemId → 进行中的 Promise */
  downloads: Map<string, Promise<void>>
  /** 本机已确认取件的条目（同意制守卫） */
  confirmedDownloads: Set<string>
  retentionDays(): number
  findHub(): { uid: number; online: boolean } | null
  peerName(uid: number): string | null
  sanitizeName(name: string): string
  toEntry(p: RelayUploadBeginPayloadLike & { createdAt: number; status: RelayEntry['status'] }): RelayEntry
  emit(event: RelayEvent): void
  emitEntry(itemId: string): void
  registerEntry(p: RelayUploadBeginPayloadLike): void
  completeUpload(itemId: string): void
  revokeLocal(senderUid: number, itemId: string): void
  handleNotifyLocal(p: RelayNotifyPayloadLike): void
  applyDownloadDone(itemId: string, ok: boolean, fromUid: number): void
  completeDownload(itemId: string, ok: boolean, error?: string): void
}
