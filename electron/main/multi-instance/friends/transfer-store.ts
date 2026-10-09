/**
 * 为什么存在：邀请制文件传输的发送方必须跨重启记住「transferId ↔ 本地路径」，
 * 才能在对端同意时重新找到文件实体——尤其本方离线、同意信封经 outbox 补投到达时，
 * 启动后的服务需要凭记录恢复推流。纯内存会在重启后丢失，对端邀请将永久停留在"待发送"。
 * 作用：federation/transfers/{transferId}.json 的登记/查询/删除。
 * 只见登记清单与本地路径，不存内容字节；transferId 只接受 uuid 白名单（防路径穿越读盘）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

/** 发送方登记条目（一条邀请一条记录，直到完成/拒绝/取消才删除） */
export interface FriendTransferRecord {
  transferId: string
  /** 接收方 uid（校验 accept 信封来源，防他人冒领文件） */
  uid: number
  /** 待发送的本地文件/文件夹绝对路径（仅发送方本机有意义） */
  localPath: string
  name: string
  size: number
  kind: 'file' | 'dir'
  files?: number
  dirs?: number
  /** 邀请发起时刻（epoch ms） */
  ts: number
  /** pending=待对方同意；streaming=已同意、推流中（防重复 accept 双推） */
  status: 'pending' | 'streaming'
}

/** transferId 白名单：uuid v4 形态（含短横线），仅字母数字连字符；防 join 路径穿越 */
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/

export class TransferStore {
  private readonly dir: string

  constructor(root: string) {
    this.dir = join(root, 'federation', 'transfers')
    mkdirSync(this.dir, { recursive: true })
  }

  private path(transferId: string): string {
    return join(this.dir, `${transferId}.json`)
  }

  put(rec: FriendTransferRecord): void {
    if (!TRANSFER_ID_RE.test(rec.transferId)) return
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.path(rec.transferId), JSON.stringify(rec, null, 2), 'utf-8')
  }

  get(transferId: string): FriendTransferRecord | null {
    if (!TRANSFER_ID_RE.test(transferId)) return null
    try {
      if (!existsSync(this.path(transferId))) return null
      const raw = JSON.parse(readFileSync(this.path(transferId), 'utf-8')) as FriendTransferRecord
      return raw && typeof raw.transferId === 'string' && typeof raw.localPath === 'string' ? raw : null
    } catch {
      return null
    }
  }

  remove(transferId: string): void {
    if (!TRANSFER_ID_RE.test(transferId)) return
    rmSync(this.path(transferId), { force: true })
  }

  /** 列出全部登记（含残留 stream 记录，供启动恢复扫描）；单个损坏条目跳过 */
  list(): FriendTransferRecord[] {
    try {
      if (!existsSync(this.dir)) return []
      return readdirSync(this.dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => this.get(n.slice(0, -'.json'.length)))
        .filter((r): r is FriendTransferRecord => r !== null)
    } catch {
      return []
    }
  }
}