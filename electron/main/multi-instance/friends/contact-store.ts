/**
 * 为什么存在：好友名单是各实例"本机持有"的资产，需落盘并在重启后恢复，不随 LAN 断线丢失。
 * 作用：读写好友联系人清单（federation/contacts.json），结构损坏时安全回退空列表。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ContactsFile, FriendContact, FriendStatus } from './friend-types'

/**
 * 好友簿存储（abyssac_data/federation/contacts.json）。
 * 本机持有 × 崩溃安全：整文件原子覆写（.tmp + rename）。
 * 不产生 oplog、不进主分记忆汇聚（与 L0 目录白名单一致）。
 */
export class ContactStore {
  private readonly path: string

  constructor(root: string) {
    const dir = join(root, 'federation')
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'contacts.json')
  }

  load(): FriendContact[] {
    try {
      if (!existsSync(this.path)) return []
      const raw = JSON.parse(readFileSync(this.path, 'utf-8')) as ContactsFile
      if (!Array.isArray(raw.contacts)) return []
      return raw.contacts.filter((c) => typeof c.uid === 'number')
    } catch {
      return []
    }
  }

  private save(contacts: FriendContact[]): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), contacts } satisfies ContactsFile, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }

  get(uid: number): FriendContact | null {
    return this.load().find((c) => c.uid === uid) ?? null
  }

  /** 新增或覆盖更新（保留 status/direction/addedAt 由调用方传入） */
  upsert(contact: FriendContact): void {
    const contacts = this.load()
    const idx = contacts.findIndex((c) => c.uid === contact.uid)
    if (idx >= 0) contacts[idx] = contact
    else contacts.push(contact)
    this.save(contacts)
  }

  /** 状态流转：friend | blocked | pending（附方向） */
  setStatus(uid: number, status: FriendStatus, direction?: 'in' | 'out'): FriendContact | null {
    const contacts = this.load()
    const idx = contacts.findIndex((c) => c.uid === uid)
    if (idx < 0) return null
    const updated: FriendContact = { ...contacts[idx], status, ...(direction ? { direction } : {}) }
    contacts[idx] = updated
    this.save(contacts)
    return updated
  }

  /** 更新展示字段（昵称快照/备注/分组） */
  patch(uid: number, patch: Partial<Pick<FriendContact, '昵称' | '备注' | '分组'>>): FriendContact | null {
    const contacts = this.load()
    const idx = contacts.findIndex((c) => c.uid === uid)
    if (idx < 0) return null
    const updated: FriendContact = { ...contacts[idx], ...patch }
    contacts[idx] = updated
    this.save(contacts)
    return updated
  }

  remove(uid: number): void {
    this.save(this.load().filter((c) => c.uid !== uid))
  }
}