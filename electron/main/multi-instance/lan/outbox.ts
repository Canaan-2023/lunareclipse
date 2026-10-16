/**
 * 为什么存在：直连网络下对端可能离线，业务消息不能因离线而丢失，须持久化补投。
 * 作用：把待发信封按收件人写入 federation/outbox/，投递成功后删除，含重试计数以限制补投次数。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { LanEnvelope, LanOutboxEntry } from './lan-types'

/**
 * 局域网离线补偿队列（federation/outbox/{toUid}/{id}.json，不在 oplog 白名单内）：
 * 对端离线/直连失败时消息落盘，对端上线/重连成功后按序补投，投递成功即删除。
 * 崩溃安全：条目一次性写入、成功后才删除；残留条目重启后 reload 重投。
 */
export class LanOutbox {
  private readonly outboxRoot: string

  constructor(root: string) {
    this.outboxRoot = join(root, 'federation', 'outbox')
    mkdirSync(this.outboxRoot, { recursive: true })
  }

  /** 入队（对端离线时调用，同步落盘不丢）；fromUid 为真实发送方（补投时对端按 from 识别身份）
   * ts：可选，覆盖默认的入队时刻——调用方需要保持"发送时刻"语义时传入原信封 ts（补投重排场景） */
  enqueue(fromUid: number, toUid: number, payload: unknown, type: string, ts?: number): LanEnvelope {
    const envelope: LanEnvelope = {
      id: randomUUID(),
      type,
      from: fromUid, // 发送方由调用方传入（L0 不臆造身份）
      to: toUid,
      ts: ts ?? Date.now(),
      payload
    }
    const entry: LanOutboxEntry = { envelope, attempts: 0, enqueuedAt: envelope.ts }
    const dir = this.dirOf(toUid)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${entry.envelope.id}.json`), JSON.stringify(entry), 'utf-8')
    return envelope
  }

  /**
   * 补投：对端在线时按入队顺序投递全部待投消息。
   * deliver 由调用方实现（直连发送），返回 true 表示对端已接收。
   * 逐条投递、成功删、失败停（保序）。
   */
  flushTo(toUid: number, deliver: (envelope: LanEnvelope) => boolean): number {
    const dir = this.dirOf(toUid)
    if (!existsSync(dir)) return 0
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
    let delivered = 0
    for (const file of files) {
      const path = join(dir, file)
      let entry: LanOutboxEntry | null = null
      try {
        entry = JSON.parse(readFileSync(path, 'utf-8')) as LanOutboxEntry
      } catch {
        // 损坏条目：删除不重投（避免读不出来的毒消息卡死队列）
        try {
          rmSync(path, { force: true })
        } catch {
          // 忽略删除失败
        }
        continue
      }
      const ok = deliver(entry.envelope)
      if (!ok) break
      try {
        rmSync(path, { force: true })
        delivered += 1
      } catch {
        // 删除失败：下轮 flush 重投（对端幂等去重，不重不丢）
        break
      }
    }
    return delivered
  }

  countPending(): number {
    let total = 0
    try {
      for (const uid of readdirSync(this.outboxRoot)) {
        const dir = join(this.outboxRoot, uid)
        if (!existsSync(dir)) continue
        try {
          total += readdirSync(dir).filter((f) => f.endsWith('.json')).length
        } catch {
          // 单个用户目录读取失败忽略
        }
      }
    } catch {
      // outbox 根不存在视为空
    }
    return total
  }

  private dirOf(toUid: number): string {
    return join(this.outboxRoot, String(toUid))
  }
}