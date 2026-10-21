/**
 * @category 多实例
 * @summary 中继 hub 侧：上传登记 / 收齐校验 / 通知接收端 / 回发下载流 / 撤回 / 取件完成记账
 *
 * 为什么独立成文件：hub 侧是中继端独有的一类行为（条目状态机推进 + 回发下载流），
 * 只有 master 角色执行；原先与发送端/接收端逻辑同处一个类，新增 hub 行为要在 1093 行里定位。
 *
 * ADR-09 拆分自 relay-service.ts（纯搬移不改行为）：函数收 `host` 句柄，
 * 状态与共享能力经该句柄读写（宿主 facade 以闭包提供，**不放宽类成员可见性**）。
 */
import { existsSync } from 'fs'
import { join } from 'path'
import type { LanEnvelope } from '../lan/lan-types'
import type { RelayEntry } from './relay-types'
import type { RelayHost, RelayNotifyPayloadLike, RelayUploadBeginPayloadLike } from './relay-host'

  // ===== 主系统（hub）侧：上传登记 / 完成校验 / 通知 =====

  /** 登记上传条目（LAN 信封与本机直通共用；发送方身份已由调用方校验） */
export function registerEntry(host: RelayHost, p: RelayUploadBeginPayloadLike): void {
    if (!host.store) return
    const now = Date.now()
    host.store.upsert({
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
      expiresAt: now + host.retentionDays() * 24 * 60 * 60 * 1000,
      storagePath: join('relay', 'files', p.itemId)
    })
    host.emitEntry(p.itemId)
  }

export function handleUploadBegin(host: RelayHost, env: LanEnvelope): void {
    const p = env.payload as RelayUploadBeginPayloadLike | undefined
    if (!p?.itemId || env.from !== p.senderUid) {
      console.warn('[relay] upload-begin 载荷非法或发送方不符，拒绝登记')
      return
    }
    host.registerEntry(p)
  }

  /** 上传收尾：字节校验 → uploaded → 通知接收端（本机接收端直接 emit，不走 LAN 回环） */
export function completeUpload(host: RelayHost, itemId: string): void {
    if (!host.store) return
    const entry = host.store.get(itemId)
    if (!entry || entry.status !== 'uploading') return
    // 收齐校验：文件实体目录存在且字节数达标（块级校验由流层保证；这里核对条目承诺总量）
    const root = host.store.filesRoot(entry.itemId)
    const gotBytes = root && existsSync(root) ? host.store.sizeOfFiles(entry.itemId) : 0
    if (gotBytes < entry.totalBytes) {
      console.warn(`[relay] 上传收齐校验未通过（itemId=${entry.itemId}，期望 ${entry.totalBytes} 实收 ${gotBytes}）`)
      host.emit({ type: 'error', itemId: entry.itemId, error: '上传内容不完整（字节数不符），请重试或撤回' })
      return
    }
    if (!host.store.transition(entry.itemId, 'uploaded')) return
    host.emitEntry(entry.itemId)
    // 通知接收端（对端离线走 outbox 补投；文件已在中继端，取件不依赖同时在线）
    notifyReceiver(host, entry)
  }

export function handleUploadDone(host: RelayHost, env: LanEnvelope): void {
    const p = env.payload as { itemId?: string } | undefined
    if (!p?.itemId) return
    host.completeUpload(p.itemId)
  }

  /** 通知接收端条目就绪；接收端是本机时直接 emit（LAN 无自己的 socket，回环会进 outbox） */
export function notifyReceiver(host: RelayHost, entry: RelayEntry): void {
    const identity = host.deps.getIdentity()
    const payload = notifyPayload(host, entry, false)
    if (identity && entry.receiverUid === identity.uid) {
      host.handleNotifyLocal(payload)
      return
    }
    host.deps.sendLan(entry.receiverUid, 'relay.notify', payload)
  }

  /** 构造 notify 信封载荷（普通提醒与撤销提醒共用；本机直通与 LAN 投递同一份数据，避免两处漂移） */
export function notifyPayload(host: RelayHost, entry: RelayEntry, revoked: boolean): RelayNotifyPayloadLike {
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

  /** hub：收到确认 → 校验取件权 → 回发下载流（条目级串行，多端重复 confirm 只回发一次） */
export function handleConfirm(host: RelayHost, env: LanEnvelope): void {
    if (!host.store) return
    const p = env.payload as { itemId?: string } | undefined
    if (!p?.itemId) return
    const itemId = p.itemId // 提为局部 const，闭包内保持类型收窄
    const entry = host.store.get(itemId)
    if (!entry) {
      host.emit({ type: 'error', itemId, error: '条目不存在（可能已被撤回或过期清理）' })
      return
    }
    // 取件权限收敛：只有条目接收方本人能确认取件（不同机器互不干扰由此保证）
    if (entry.receiverUid !== env.from) {
      console.warn(`[relay] 取件权限拒绝：uid=${env.from} 尝试取件 itemId=${itemId}（接收方=${entry.receiverUid}）`)
      return
    }
    if (entry.status === 'downloaded' || entry.status === 'expired') return
    if (host.downloads.has(itemId)) return
    const root = host.store.filesRoot(entry.itemId)
    if (!root || !existsSync(root)) {
      host.emit({ type: 'error', itemId: entry.itemId, error: '中继文件实体缺失（可能已被清理），请发送方重新上传' })
      return
    }
    const promise = streamBack(host, entry, root)
    host.downloads.set(itemId, promise)
    void promise.finally(() => host.downloads.delete(itemId))
  }

  /** hub：把中继存储的条目内容流式回发给取件端（下载是独立的一段，带进度） */
export async function streamBack(host: RelayHost, entry: RelayEntry, root: string): Promise<void> {
    const targetPath = join(root, entry.name)
    const relayTag = { itemId: entry.itemId, phase: 'download' as const, targetName: entry.name, kind: entry.kind }
    if (entry.kind === 'file') {
      const res = await host.deps.sendLanFile(entry.receiverUid, targetPath, {
        relay: { ...relayTag, kind: 'file' },
        onProgress: (sent, total) =>
          host.emit({ type: 'progress', itemId: entry.itemId, phase: 'download', sentBytes: sent, totalBytes: total })
      })
      if (!res.ok) host.emit({ type: 'error', itemId: entry.itemId, error: `回发下载流失败：${res.error ?? '未知'}` })
      return
    }
    const res = await host.deps.sendLanDirectory(entry.receiverUid, targetPath, {
      relay: { ...relayTag, kind: 'dir' },
      onProgress: (p) =>
        host.emit({
          type: 'progress',
          itemId: entry.itemId,
          phase: 'download',
          sentBytes: p.doneBytes,
          totalBytes: p.totalBytes,
          doneFiles: p.doneFiles,
          totalFiles: p.totalFiles
        })
    })
    if (!res.ok) host.emit({ type: 'error', itemId: entry.itemId, error: `回发下载流失败：${res.error ?? '未知'}` })
  }

  /** hub：处理取件完成回报 → 条目置终态 downloaded（元数据保留，文件实体按保留策略在后续清理中回收） */
export function applyDownloadDone(host: RelayHost, itemId: string, ok: boolean, fromUid: number): void {
    if (!host.store) return
    if (!ok) return
    const entry = host.store.get(itemId)
    if (!entry || entry.status === 'downloaded' || entry.status === 'expired') return
    if (entry.receiverUid !== fromUid) return // 只有接收方本人能回报取件完成
    host.store.transition(itemId, 'downloaded', { downloadedAt: Date.now() })
    host.emitEntry(itemId)
  }

  /** hub：信封入口——取件完成回报（远端 receiver 经 LAN 送达） */
export function handleDownloadDone(host: RelayHost, env: LanEnvelope): void {
    const p = env.payload as { itemId?: string; ok?: boolean } | undefined
    if (!p?.itemId) return
    host.applyDownloadDone(p.itemId, p.ok !== false, env.from)
  }

  // ===== 撤回 / 列表 / 过期清理 =====

  /** hub：执行撤回（远端 sender 经 LAN 信封与本机 sender 本地直通共用；接收端在本机时直接 emit 撤销提醒） */
export function revokeLocal(host: RelayHost, senderUid: number, itemId: string): void {
    if (!host.store) return
    const entry = host.store.get(itemId)
    if (!entry) return
    if (entry.senderUid !== senderUid) return // 只有发送方本人能撤回
    if (entry.status === 'downloaded') {
      host.emit({ type: 'error', itemId: entry.itemId, error: '对方已下载完成，无法撤回' })
      return
    }
    host.store.remove(itemId, true)
    host.emit({ type: 'revoked', itemId: entry.itemId })
    // 已通知过接收端 → 补发撤销提醒（receiver 侧清除提醒；接收端在本机时直接 emit，不走 LAN 回环）
    if (entry.status === 'notified') {
      const payload = notifyPayload(host, entry, true)
      const identity = host.deps.getIdentity()
      if (identity && entry.receiverUid === identity.uid) host.handleNotifyLocal(payload)
      else host.deps.sendLan(entry.receiverUid, 'relay.notify', payload)
    }
  }

  /** hub：信封入口——远端发送方的撤回请求 */
export function handleRevoke(host: RelayHost, env: LanEnvelope): void {
    const p = env.payload as { itemId?: string } | undefined
    if (!p?.itemId) return
    host.revokeLocal(env.from, p.itemId)
  }
