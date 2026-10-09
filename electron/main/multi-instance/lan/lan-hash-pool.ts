/**
 * 为什么存在：局域网二进制流按块校验（sha256）是超大文件传输的正确性底线，
 * 但 Node 主线程单核做哈希会与 socket 收发/文件读写争 CPU（crypto 同步阻塞事件循环）。
 * 作用：一组常驻 worker_threads 并行计算分块 sha256，主线程只负责任务投递，
 * 让哈希吞吐随 CPU 核数扩展（多核利用），避免串行哈希成为传输瓶颈。
 *
 * 容量策略：池大小 = max(1, min(cpuCount - 1, 8))，留出主线程与网络栈的核；
 * 每 worker 一次只持有一个任务（消息驱动、天然背压），不设任务队列堆积。
 *
 * 故障隔离：每个任务记录其所属 worker，单 worker 崩溃只拒绝该 worker 名下的未决任务，
 * 其余 worker 继续服务（哈希算错/崩溃是局部故障，不应拖垮整条传输）。
 */

import { Worker } from 'worker_threads'
import { cpus } from 'os'
import { createHash } from 'crypto'

/** hash worker 源码（eval 模式内置，避免打包附加文件；与 code-sandbox 同款做法） */
const HASH_WORKER_SOURCE = `
const { parentPort } = require('worker_threads')
const { createHash } = require('crypto')
parentPort.on('message', (msg) => {
  const { id, data } = msg
  try {
    const hash = createHash('sha256').update(data).digest('hex')
    parentPort.postMessage({ id, ok: true, hash })
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) })
  }
})
`

export interface HashPoolOptions {
  /** 池大小上限（默认 min(cpus-1, 8)）；仅测试可注入小池验证并发路径 */
  maxWorkers?: number
}

export class LanHashPool {
  private readonly workers: Worker[] = []
  private readonly pending = new Map<number, { resolve: (hash: string) => void; reject: (err: Error) => void }>()
  /** 任务 → 所属 worker：worker 崩溃时只拒绝其名下任务 */
  private readonly workerOfId = new Map<number, Worker>()
  /** worker → 其名下未决任务数（等值于 pending 中该 worker 的任务，便于 error 分支快速选择） */
  private nextId = 1
  private readonly size: number
  private destroyed = false

  constructor(options: HashPoolOptions = {}) {
    const cpusCount = cpus().length
    this.size = Math.max(1, Math.min(options.maxWorkers ?? Math.max(1, cpusCount - 1), 8))
    for (let i = 0; i < this.size; i += 1) {
      const worker = new Worker(HASH_WORKER_SOURCE, { eval: true })
      worker.on('message', (msg: { id: number; ok: boolean; hash?: string; error?: string }) => {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.pending.delete(msg.id)
        this.workerOfId.delete(msg.id)
        if (msg.ok && msg.hash) {
          entry.resolve(msg.hash)
        } else {
          entry.reject(new Error(`分块哈希失败: ${msg.error ?? 'unknown'}`))
        }
      })
      worker.on('error', (err) => {
        // 仅拒绝该 worker 名下的未决任务（round-robin 会把任务摊到多个 worker，不能无差别清空）
        for (const [id, owner] of [...this.workerOfId]) {
          if (owner !== worker) continue
          const entry = this.pending.get(id)
          if (!entry) continue
          this.pending.delete(id)
          this.workerOfId.delete(id)
          entry.reject(new Error(`哈希 worker 异常: ${err.message}`))
        }
      })
      this.workers.push(worker)
    }
  }

  /** 池大小（测试断言用） */
  getSize(): number {
    return this.size
  }

  /** 计算单个 Buffer 的 sha256（hex） */
  hash(data: Buffer): Promise<string> {
    if (this.destroyed) return Promise.reject(new Error('哈希池已销毁'))
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // round-robin 投递：均摊到各 worker，天然并行（postMessage 是同步复制，无跨任务竞争）
      const worker = this.workers[id % this.size]
      this.workerOfId.set(id, worker)
      try {
        worker.postMessage({ id, data })
      } catch (err) {
        this.pending.delete(id)
        this.workerOfId.delete(id)
        reject(new Error(`哈希任务投递失败: ${(err as Error).message}`))
      }
    })
  }

  /** 批量并行哈希：多块同时投递到各 worker，返回与入参同序的 hash 数组 */
  async hashMany(buffers: Buffer[]): Promise<string[]> {
    const results = new Array<string>(buffers.length)
    await Promise.all(
      buffers.map(async (buf, i) => {
        results[i] = await this.hash(buf)
      })
    )
    return results
  }

  /** 终止全部 worker（进程退出/服务停机时调用，防句柄泄漏） */
  destroy(): void {
    this.destroyed = true
    for (const worker of this.workers) {
      try {
        void worker.terminate()
      } catch {
        // 已终止的 worker 忽略
      }
    }
    this.workers.length = 0
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      this.workerOfId.delete(id)
      entry.reject(new Error('哈希池已销毁'))
    }
  }

  /** 便捷工具：同步算一块（单测/小载荷用，不占池） */
  static sha256(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex')
  }
}