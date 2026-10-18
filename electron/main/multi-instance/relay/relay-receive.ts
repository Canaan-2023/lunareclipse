/**
 * @category 多实例
 * @summary 中继接收端：提醒 → 确认取件 → 下载收齐回报（含本机直通复制）
 *
 * 为什么独立成文件：接收端是「取件方」的一类行为（提醒处理 + 同意制登记 + 条目级收齐统计），
 * 与 hub 侧的条目状态机推进是两件事；原先同处一个类，同意制守卫的读写点散落在 1093 行里。
 *
 * ADR-09 拆分自 relay-service.ts（纯搬移不改行为）：函数收 `host` 句柄，
 * 状态与共享能力经该句柄读写（宿主 facade 以闭包提供，**不放宽类成员可见性**）。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { walkDirectorySafe } from '../lan/lan-stream'
import type { LanEnvelope } from '../lan/lan-types'
import type { RelayEntry } from './relay-types'
import type { RelayHost, RelayNotifyPayloadLike } from './relay-host'

/** 进行中的下载条目统计（receiver 侧：条目所有流收齐后才算取件完成） */
export interface PendingDownload {
  /** 未结束的流数（onBegin +1，onEnd/onAbort -1） */
  count: number
  /** 是否出现过失败流（abort 或 end error） */
  failed: boolean
  error?: string
}

  // ===== 接收端侧：提醒 → 确认 → 下载完成 =====

  /** receiver：收到文件就绪提醒（社交链路直达；离线由 outbox 补投） */
export function handleNotify(host: RelayHost, env: LanEnvelope): void {
    const p = env.payload as RelayNotifyPayloadLike | undefined
    if (!p?.itemId) return
    const identity = host.deps.getIdentity()
    if (!identity) return
    if (p.receiverUid !== identity.uid && p.senderUid !== identity.uid) return // 只处理发给本机的提醒
    host.handleNotifyLocal(p)
  }

  /** 本地投递提醒（本机接收端由 notifyReceiver / revokeLocal 直连调用；payload 已通过身份过滤） */
export function handleNotifyLocal(host: RelayHost, p: RelayNotifyPayloadLike): void {
    const identity = host.deps.getIdentity()
    if (!identity) return
    if (p.revoked) {
      host.confirmedDownloads.delete(p.itemId) // 条目已撤回：撤销同意登记，后续 download 流一律拒收
      host.emit({ type: 'revoked', itemId: p.itemId })
      return
    }
    const now = Date.now()
    host.emit({
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
        expiresAt: p.expiresAt ?? now + host.retentionDays() * 24 * 60 * 60 * 1000
      }
    })
  }

  /** receiver：确认取件 → 通知中继端回发下载流（下载与上传分离；落自定义下载位置） */
export function confirm(host: RelayHost, itemId: string): { ok: boolean; error?: string } {
    const identity = host.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = host.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端且本机即取件方：不经 LAN 回环（无自己的 socket），本地直接校验并复制
    if (hub.uid === identity.uid) {
      const res = confirmLocal(host, itemId)
      if (res.ok) host.confirmedDownloads.add(itemId) // 本地复制同样按同意制登记（guard 与远端一致）
      return res
    }
    const res = host.deps.sendLan(hub.uid, 'relay.confirm', { itemId })
    if (!res.ok && res.mode !== 'outbox') return { ok: false, error: res.error ?? '确认发送失败' }
    host.confirmedDownloads.add(itemId) // 同意登记先行：确认发出即视为本机同意接收，download 流据此放行
    return { ok: true }
  }

  /** hub 且本机即取件方：本地校验取件权 → 把中继文件复制到自定义下载位置（与 streamBack 落盘同构） */
export function confirmLocal(host: RelayHost, itemId: string): { ok: boolean; error?: string } {
    if (!host.store) return { ok: false, error: '本机不是中继存储端' }
    const entry = host.store.get(itemId)
    const identity = host.deps.getIdentity()
    if (!entry) {
      host.emit({ type: 'error', itemId, error: '条目不存在（可能已被撤回或过期清理）' })
      return { ok: false, error: '条目不存在（可能已被撤回或过期清理）' }
    }
    if (!identity || entry.receiverUid !== identity.uid) {
      return { ok: false, error: '只有接收方本人能确认取件' }
    }
    if (entry.status === 'downloaded' || entry.status === 'expired') return { ok: false, error: '条目已下载或已过期' }
    if (host.downloads.has(itemId)) return { ok: true } // 已在取件中：重复确认去重，不重开复制
    const root = host.store.filesRoot(entry.itemId)
    if (!root || !existsSync(root)) {
      host.emit({ type: 'error', itemId: entry.itemId, error: '中继文件实体缺失（可能已被清理），请发送方重新上传' })
      return { ok: false, error: '中继文件实体缺失（可能已被清理），请发送方重新上传' }
    }
    const promise = copyLocal(host, entry, root)
    host.downloads.set(itemId, promise)
    void promise.finally(() => host.downloads.delete(itemId))
    return { ok: true }
  }

  /**
   * 本机取件复制：把中继存储条目复制到自定义下载位置。
   * 为什么存在：本机既是中继端又是取件方时没有自己的 LAN socket，回发下载流无法送达，
   * 于是退化为本地复制——文件直接复制，目录结构保真（复用 walkDirectorySafe 安全遍历），
   * 进度按文件累计推事件，完成后走 completeDownload 本机分支置终态。
   */
export async function copyLocal(host: RelayHost, entry: RelayEntry, root: string): Promise<void> {
    const dlRoot = host.deps.getDownloadDir()
    try {
      mkdirSync(dlRoot, { recursive: true })
    } catch (err) {
      host.emit({ type: 'error', itemId: entry.itemId, error: `创建下载目录失败：${(err as Error).message}` })
      return
    }
    const targetRoot = join(dlRoot, host.sanitizeName(entry.name))
    try {
      if (entry.kind === 'file') {
        const src = join(root, entry.name)
        if (!existsSync(src)) throw new Error('中继文件实体缺失')
        copyFileSync(src, targetRoot)
        const size = statSync(src).size
        host.emit({ type: 'progress', itemId: entry.itemId, phase: 'download', sentBytes: size, totalBytes: size })
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
          host.emit({
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
      host.emit({ type: 'error', itemId: entry.itemId, error: `本机取件失败：${(err as Error).message}` })
      return
    }
    // 本地复制完成即视为取件完毕：回报动作在本机直接完成（hub 即本机）
    host.completeDownload(entry.itemId, true)
  }

  /** receiver：条目下载流全部收齐 → 向中继端回报取件结果（hub 是本机时本地直接置终态） */
export function completeDownload(host: RelayHost, itemId: string, ok: boolean, error?: string): void {
    if (ok) host.confirmedDownloads.delete(itemId) // 下载完成即消费同意；失败保留登记以支持重试
    host.emit({ type: 'done', itemId, ok, error })
    const hub = host.findHub()
    const identity = host.deps.getIdentity()
    if (!hub || !identity) return
    // 本机即中继存储端且本机即取件方：download-done 不经 LAN 回环（无自己的 socket），本地直接收尾
    if (hub.uid === identity.uid) {
      host.applyDownloadDone(itemId, ok, identity.uid)
      return
    }
    host.deps.sendLan(hub.uid, 'relay.download-done', { itemId, ok, error })
  }
