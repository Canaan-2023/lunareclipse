/**
 * @category ROOM
 * @summary ROOM 事件落盘：`<data>/room/room-events.jsonl`（**有界**追加）
 *
 * 为什么存在：SRE 要求 ROOM 可观测——启停 / 相位序列 / 唤醒源 / 熔断都要能事后查。
 * 此前只有内存事件环（重启即丢），出问题无从回溯。
 *
 * **有界**：超过 `MAX_BYTES` 即把当前文件滚成 `.1`（只保留一代）——避免 JSONL 无限增长
 * （这是 review 对「直连 audit.jsonl 会持续增长」的处置：room 侧事件单独落盘 + 上限）。
 *
 * 纪律：落盘是**旁路**——任何失败都静默吞掉，绝不把异常抛回循环（见 `runtime.ts` 的 `pushEvent`）。
 *
 * 不删理由：删掉即 ROOM 的事故现场无法复盘。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'fs'
import { dirname, join } from 'path'

/** 单文件上限（超过即滚动一代） */
const MAX_BYTES = 512 * 1024

export class RoomEventLog {
  constructor(private readonly dir: string) {}

  private filePath(): string {
    return join(this.dir, 'room-events.jsonl')
  }

  /**
   * 追加一条事件（一行一条 JSON）。
   * **不吞异常**（用户裁决：兜底不要轻易下放）——失败就抛，由调用方决定怎么处置
   * （当前调用方 `runtime.ts` 的 `pushEvent` 会记 `console.error` 并继续，不阻断循环）。
   */
  append(entry: Record<string, unknown>): void {
    const p = this.filePath()
    mkdirSync(dirname(p), { recursive: true })
    if (existsSync(p) && statSync(p).size > MAX_BYTES) {
      renameSync(p, `${p}.1`)
    }
    appendFileSync(p, `${JSON.stringify(entry)}\n`, 'utf-8')
  }
}
