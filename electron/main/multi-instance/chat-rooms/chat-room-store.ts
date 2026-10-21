/**
 * 为什么存在：房间清单（成员、名称、拥有者）需在重启后保留，且与消息文件分离以便独立读写。
 * 作用：按 gid 读写/删除聊天室元数据（federation/chat-rooms/{gid}.json），损坏时安全返回空值。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { renameFileWithRetry } from '../../utils/atomic-write'
import type { ChatRoomInfo } from './chat-room-types'

/**
 * 聊天室信息存储（abyssac_data/federation/chat-rooms/{gid}.json）。
 * 本机持有 × 崩溃安全：整文件原子覆写（.tmp + rename）。
 */
export class ChatRoomStore {
  private readonly dir: string

  constructor(root: string) {
    this.dir = join(root, 'federation', 'chat-rooms')
    mkdirSync(this.dir, { recursive: true })
  }

  private path(gid: string): string {
    return join(this.dir, `${gid}.json`)
  }

  load(gid: string): ChatRoomInfo | null {
    try {
      const p = this.path(gid)
      if (!existsSync(p)) return null
      return JSON.parse(readFileSync(p, 'utf-8')) as ChatRoomInfo
    } catch {
      return null
    }
  }

  save(info: ChatRoomInfo): void {
    const p = this.path(info.gid)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...info, updatedAt: Date.now() } satisfies ChatRoomInfo, null, 2), 'utf-8')
    // 原子替换：走公共 renameFileWithRetry（EPERM 重试 + 删目标兜底）。
    // 2026-10-17 修复：此处原为裸 renameSync，是同级 store 中唯一未收敛到公共助手的一处
    // （chat-room-chat-store/publish-board-store/publish-comment-store/internal-session-store 都已收敛）。
    // Windows 下目标被杀软/句柄短暂占用时 renameSync 抛 EPERM，表现为保存失败 + 测试偶发挂
    // （分发前 T1 验收实测：全量跑 226/227，唯一失败即本 store 的 EPERM）。
    renameFileWithRetry(tmp, p)
  }

  delete(gid: string): void {
    try {
      const p = this.path(gid)
      if (existsSync(p)) unlinkSync(p)
    } catch { /* ignore */ }
  }

  /** 加载全部聊天室 */
  listAll(): ChatRoomInfo[] {
    try {
      return readdirSync(this.dir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => this.load(f.replace(/\.json$/, '')))
        .filter((g: ChatRoomInfo | null): g is ChatRoomInfo => g !== null)
    } catch {
      return []
    }
  }
}
