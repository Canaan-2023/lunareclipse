/**
 * @category ROOM
 * @summary AI 像素形象的持久化：`<data>/room/avatar.json`
 *
 * 为什么存在：AI 自决像素（P3）要把 AI 画的规格落盘，且渲染侧要读同一份（单一真源）。
 * 记录型 JSON 走 §3.8 的原子写收敛（`renameFileWithRetry`，Windows EPERM 重试）。
 *
 * **fail-closed**：读到的文件先过 `validateAvatarSpec`，不合法即回落默认规格——
 * 绝不把未校验的像素数据交给渲染端（AI 生成内容，边界必须在入口收）。
 *
 * 不删理由：删掉即形象无法持久化，每次启动都退回默认。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { validateAvatarSpec, type RoomAvatarSpec } from '@shared/room/avatar-spec'
import { renameFileWithRetry } from '../utils/atomic-write'
import { DEFAULT_AVATAR_SPEC } from './default-art'

export class AvatarStore {
  /**
   * `dir` = 当前 AI 的房间目录（`<data>/room/AI{aiId}`）；
   * `fallbackDir` = 全局 `<data>/room`（兼容 0.53.4 之前的单份 avatar.json）。
   */
  constructor(
    private readonly dir: string,
    private readonly fallbackDir?: string
  ) {}

  private filePath(): string {
    return join(this.dir, 'avatar.json')
  }

  /** 读取并校验；当前 AI 没有则回落全局，仍缺失/非法一律回落默认规格。 */
  load(): RoomAvatarSpec {
    const own = this.filePath()
    const fallback = this.fallbackDir ? join(this.fallbackDir, 'avatar.json') : null
    const p = existsSync(own) ? own : fallback && existsSync(fallback) ? fallback : null
    if (!p) return DEFAULT_AVATAR_SPEC
    try {
      const v = validateAvatarSpec(JSON.parse(readFileSync(p, 'utf-8')))
      return v.ok ? v.spec : DEFAULT_AVATAR_SPEC
    } catch {
      return DEFAULT_AVATAR_SPEC
    }
  }

  /** 写入（**调用方必须先 `validateAvatarSpec`**——本方法不做二次校验，只负责原子落盘）。 */
  save(spec: RoomAvatarSpec): void {
    const p = this.filePath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(spec, null, 2), 'utf-8')
    renameFileWithRetry(tmp, p)
  }
}
