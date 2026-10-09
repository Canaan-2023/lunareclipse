/**
 * 为什么存在：成员离线或未即时响应时的入群邀请不能丢，需落盘暂存并在成员上线时补处理。
 * 作用：把待处理入群邀请持久化到 federation/pending-invites.json，支持列举、添加与清除。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * 待处理聊天室邀请存储（abyssac_data/federation/pending-invites.json）。

 * 入站 chat-room.invite 到达时落盘，重启应用后仍能在「邀请」tab 看到；
 * 接受或忽略后移除。整文件原子覆写（.tmp + rename），崩溃不留半截文件。
 */
export interface PendingInvite {
  /** 聊天室 ID */
  gid: string
  /** 聊天室名 */
  chatRoomName: string
  /** 邀请人 uid */
  fromUid: number
  /** 邀请人显示名 */
  fromName: string
  /** 室主 uid（接受时用于重建本地空壳并定向 join） */
  ownerUid: number
  /** 收到邀请的时间（epoch ms） */
  ts: number
}

export class PendingInviteStore {
  private readonly file: string

  constructor(root: string) {
    const dir = join(root, 'federation')
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'pending-invites.json')
  }

  /** 全部待处理邀请（落盘顺序） */
  list(): PendingInvite[] {
    try {
      if (!existsSync(this.file)) return []
      const v = JSON.parse(readFileSync(this.file, 'utf-8')) as unknown
      return Array.isArray(v) ? (v as PendingInvite[]) : []
    } catch {
      return []
    }
  }

  /** 新增邀请：同 gid 覆盖（保留最新一次邀请信息） */
  add(invite: PendingInvite): void {
    const rest = this.list().filter((i) => i.gid !== invite.gid)
    this.write([...rest, invite])
  }

  /** 移除邀请（接受/忽略后） */
  remove(gid: string): void {
    const rest = this.list().filter((i) => i.gid !== gid)
    if (rest.length === this.list().length) return
    this.write(rest)
  }

  private write(list: PendingInvite[]): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf-8')
    renameSync(tmp, this.file)
  }
}
