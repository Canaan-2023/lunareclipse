/**
 * @category 多实例
 * @summary 中继发送端：上传登记 → 流式上传 → 完成回报 → 撤回
 *
 * 为什么独立成文件：发送端是「任意角色」的一类行为（本机即中继端时退化为本地复制），
 * 与 hub 侧登记/校验、receiver 侧取件无共享逻辑，原先却与二者同处一个类。
 *
 * ADR-09 拆分自 relay-service.ts（纯搬移不改行为）：函数收 `host` 句柄，
 * 状态与共享能力经该句柄读写（宿主 facade 以闭包提供，**不放宽类成员可见性**）。
 */
import { randomUUID } from 'crypto'
import { copyFileSync, mkdirSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { walkDirectorySafe } from '../lan/lan-stream'
import type { LanDirectoryProgress } from '../lan/lan-stream'
import type { RelayHost } from './relay-host'

  // ===== 发送端（任意角色）：上传登记 → 流式上传 → 完成回报 =====

  /** sender：发起上传登记（IPC 层选好文件后调用；随即调用 uploadFile/uploadDirectory 流式上传） */
export function beginUpload(host: RelayHost, input: {
    receiverUid: number
    kind: 'file' | 'dir'
    name: string
    totalBytes: number
    files: number
    dirs: number
  }): { ok: boolean; itemId?: string; error?: string } {
    const identity = host.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = host.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端，中继上传暂不可用' }
    const itemId = randomUUID()
    const receiverName = host.peerName(input.receiverUid) ?? '未知'
    const expiresAt = Date.now() + host.retentionDays() * 24 * 60 * 60 * 1000
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
      host.registerEntry(payload)
      return { ok: true, itemId }
    }
    const res = host.deps.sendLan(hub.uid, 'relay.upload-begin', payload)
    if (!res.ok && res.mode !== 'outbox') {
      return { ok: false, error: res.error ?? '上传登记发送失败' }
    }
    // 本地（sender 视角）先登记 uploading 条目，便于 UI 即时反馈（真值以主系统为准）
    host.emit({ type: 'entry', entry: host.toEntry({ ...payload, createdAt: Date.now(), status: 'uploading' }) })
    return { ok: true, itemId }
  }

  /** sender：单文件上传到中继端（复用流式能力；relay 标记使收端落中继存储） */
export async function uploadFile(host: RelayHost, 
    filePath: string,
    opts: { itemId: string; name: string; onProgress?: (sentBytes: number, totalBytes: number) => void }
  ): Promise<{ ok: boolean; error?: string }> {
    const identity = host.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = host.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端：本地直接复制进中继目录（不经 LAN 流）
    if (hub.uid === identity.uid) {
      const itemId = opts.itemId
      const root = host.store?.ensureFiles(itemId)
      if (!root) return { ok: false, error: '本机不是中继存储端' }
      const target = join(root, host.sanitizeName(opts.name))
      try {
        mkdirSync(dirname(target), { recursive: true })
        const st = statSync(filePath, { throwIfNoEntry: false })
        if (!st?.isFile()) return { ok: false, error: '所选对象不是可读文件' }
        copyFileSync(filePath, target)
        opts.onProgress?.(st.size, st.size)
        host.emit({ type: 'progress', itemId, phase: 'upload', sentBytes: st.size, totalBytes: st.size })
      } catch (err) {
        host.emit({ type: 'error', itemId, error: `本地上传失败：${(err as Error).message}` })
        return { ok: false, error: (err as Error).message }
      }
      host.completeUpload(itemId)
      return { ok: true }
    }
    const res = await host.deps.sendLanFile(hub.uid, filePath, {
      name: opts.name,
      relay: { itemId: opts.itemId, phase: 'upload', targetName: opts.name, kind: 'file' },
      onProgress: (sent, total) => {
        opts.onProgress?.(sent, total)
        host.emit({ type: 'progress', itemId: opts.itemId, phase: 'upload', sentBytes: sent, totalBytes: total })
      }
    })
    if (!res.ok) {
      host.emit({ type: 'error', itemId: opts.itemId, error: res.error ?? '上传失败' })
      return { ok: false, error: res.error }
    }
    host.deps.sendLan(hub.uid, 'relay.upload-done', { itemId: opts.itemId, ackedBytes: res.ackedBytes })
    return { ok: true }
  }

  /** sender：文件夹上传（结构保真；目录项流 + 文件流并发，全部带 relay 标记与聚合进度） */
export async function uploadDirectory(host: RelayHost, 
    dirPath: string,
    opts: { itemId: string; name: string; onProgress?: (p: LanDirectoryProgress) => void }
  ): Promise<{ ok: boolean; error?: string }> {
    const identity = host.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = host.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端：递归复制进中继目录后收尾（保持结构；进度按文件累计）
    if (hub.uid === identity.uid) {
      const itemId = opts.itemId
      const root = host.store?.ensureFiles(itemId)
      if (!root) return { ok: false, error: '本机不是中继存储端' }
      const targetRoot = join(root, host.sanitizeName(opts.name))
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
          host.emit({ type: 'progress', itemId, phase: 'upload', sentBytes: doneBytes, totalBytes, doneFiles, totalFiles })
        }
        void dirs // dirs 已并入目录创建
      } catch (err) {
        host.emit({ type: 'error', itemId, error: `本地上传失败：${(err as Error).message}` })
        return { ok: false, error: (err as Error).message }
      }
      host.completeUpload(itemId)
      return { ok: true }
    }
    const res = await host.deps.sendLanDirectory(hub.uid, dirPath, {
      relay: { itemId: opts.itemId, phase: 'upload', targetName: opts.name, kind: 'dir' },
      onProgress: (p) => {
        opts.onProgress?.(p)
        host.emit({
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
      host.emit({ type: 'error', itemId: opts.itemId, error: res.error ?? '上传失败' })
      return { ok: false, error: res.error }
    }
    host.deps.sendLan(hub.uid, 'relay.upload-done', {
      itemId: opts.itemId,
      ackedBytes: res.ackedBytes,
      files: res.files,
      dirs: res.dirs
    })
    return { ok: true }
  }

  /** sender：撤回未取件的上传（中继端删除条目与文件实体；已下载则拒绝） */
export function revoke(host: RelayHost, itemId: string): { ok: boolean; error?: string } {
    const identity = host.deps.getIdentity()
    if (!identity) return { ok: false, error: '未登录' }
    const hub = host.findHub()
    if (!hub) return { ok: false, error: '局域网中未发现主系统中继端' }
    // 本机即中继存储端：撤销本来就在本机执行（sendLan 会回环给自己进 outbox，走本地路径）
    if (hub.uid === identity.uid) {
      host.revokeLocal(identity.uid, itemId)
      return { ok: true }
    }
    const res = host.deps.sendLan(hub.uid, 'relay.revoke', { itemId })
    return res.ok || res.mode === 'outbox' ? { ok: true } : { ok: false, error: res.error ?? '撤回发送失败' }
  }
