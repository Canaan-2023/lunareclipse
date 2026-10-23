/**
 * 为什么存在：增量同步必须有序可续传：崩溃后从已确认水位继续，避免重复或丢失；失败需退避重试。
 * 作用：管理待发队列与同步状态（ackedSeq/nextSeq），定时 flush、失败 30s 退避重试、停止时清理定时器。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { type OpEntry, type SyncPushResult } from '../types'
import { HttpError, SatelliteClient } from './satellite-client'
import type { OpInput } from './oplog-capture'

/** 同步游标/序号状态：{root}/.sync/state.json */
interface SyncState {
  /** 已由主系统 ack 的最高 seq（断点续传游标，落盘防丢） */
  ackedSeq: number
  /** 已分配的下一序号（单调递增，重启不回落） */
  nextSeq: number
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 分系统同步引擎（单向推主系统）：
 * - 采集器产出 OpInput → 分配单调 seq → 追加本地 outbox（落盘持久化，断网不丢）
 * - 防抖批量推送（合并短窗内多次写入 → 一次 push）
 * - push 成功按 ackedSeq 清理 outbox；失败/断网保留，退避重试补推
 * - seq 由本机分配（分系统为唯一数据源头），主系统按 (instanceId,key,seq) 幂等收敛
 */
export class SyncEngine {
  private outboxDir: string
  private statePath: string
  private state: SyncState
  private pending: OpEntry[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private stopped = false
  /** 连续失败退避：30s → 60s → 2min → 5min 封顶 */
  private retryDelayMs = 30_000
  private retryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly root: string,
    private readonly client: SatelliteClient,
    private readonly opts: {
      instanceId: string
      getToken: () => string | null
      /** 令牌失效（401）时刷新并返回新令牌；返回 null 表示刷新失败，维持退避 */
      refreshToken?: () => Promise<string | null>
      /**
       * 推送 staged 条目的实体字节（同步分块面）：把本地 {root}/{entry.key} 文件经 lan-stream
       * 分块通道（块 sha256 + 停滞判定 + 整体 sha256）推送到主系统 sync_staging；返回 true 表示
       * 实体已完整送达暂存区。外部注入（index.ts 装配），未注入或返回 false 时该条退回重试、
       * 后续条目照推（实体缺席导致 applyPush 校验不过，主系统停留在先序 ack，不丢数据）。
       */
      sendStagedEntity?: (entry: OpEntry) => Promise<boolean>
    }
  ) {
    this.outboxDir = join(root, '.sync', 'outbox')
    this.statePath = join(root, '.sync', 'state.json')
    mkdirSync(this.outboxDir, { recursive: true })
    this.state = this.loadState()
  }

  /** 采集器回调：分配 seq、追加 outbox（同步落盘，崩溃不丢），随后调度推送 */
  enqueue(input: OpInput): void {
    const entry: OpEntry = {
      instanceId: this.opts.instanceId,
      uid: input.uid,
      aiId: input.aiId,
      op: input.op,
      key: input.key,
      // staged 标志与实体字节数必须原样透传：采集器统一产出 staged 条目（upsert 一律
      // 实体外置、content 不进出 outbox），enqueue 若丢弃 staged/size，flush 会拿不到
      // 实体字节数、applyPush 校验失败且 ack 永不推进
      size: input.size,
      staged: input.staged,
      hash: input.hash,
      seq: this.state.nextSeq,
      ts: nowIso()
    }
    this.state.nextSeq += 1
    this.persistState()
    this.writeOutbox(entry)
    this.pending.push(entry)
    this.scheduleFlush(200)
  }

  start(): void {
    this.stopped = false
    // 启动先补推上次未完成的 outbox（断网/崩溃遗留），再恢复实时推送
    this.loadOutboxIntoPending()
    this.scheduleFlush(500)
  }

  stop(): void {
    this.stopped = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.flushTimer = null
    this.retryTimer = null
  }

  /** 当前 ack 游标（管理窗口展示用） */
  getAckedSeq(): number {
    return this.state.ackedSeq
  }

  /** 待推条目数（内存队列 + 未 ack 的 outbox，管理窗口展示用） */
  getPendingCount(): number {
    return this.pending.length + this.listOutboxFiles().filter((n) => n > this.state.ackedSeq).length
  }

  private loadState(): SyncState {
    if (!existsSync(this.statePath)) {
      return { ackedSeq: 0, nextSeq: 1 }
    }
    try {
      const state = JSON.parse(readFileSync(this.statePath, 'utf-8')) as Partial<SyncState>
      return {
        ackedSeq: typeof state.ackedSeq === 'number' ? state.ackedSeq : 0,
        // 兜底：游标文件缺失/损坏时，从 outbox 现存最大 seq 恢复序号（不重复不回落）
        nextSeq: typeof state.nextSeq === 'number' ? state.nextSeq : this.maxOutboxSeq() + 1
      }
    } catch {
      return { ackedSeq: 0, nextSeq: this.maxOutboxSeq() + 1 }
    }
  }

  private persistState(): void {
    try {
      writeFileSync(this.statePath, JSON.stringify(this.state), 'utf-8')
    } catch {
      // 游标落盘失败不阻塞推送；下次成功会再写（内存中仍单调）
    }
  }

  private maxOutboxSeq(): number {
    try {
      const files = readdirSync(this.outboxDir).filter((f) => f.endsWith('.json'))
      let max = 0
      for (const f of files) {
        const n = Number(f.replace(/\.json$/, ''))
        if (Number.isFinite(n) && n > max) max = n
      }
      return max
    } catch {
      return 0
    }
  }

  /** 启动恢复：把 outbox 中未 ack 的条目重载进待推队列（保持 seq 序） */
  private loadOutboxIntoPending(): void {
    const files = this.listOutboxFiles()
    const seqs = files.filter((n) => n > this.state.ackedSeq).sort((a, b) => a - b)
    for (const seq of seqs) {
      const entry = this.readOutbox(seq)
      if (entry) this.pending.push(entry)
    }
  }

  private listOutboxFiles(): number[] {
    try {
      return readdirSync(this.outboxDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => Number(f.replace(/\.json$/, '')))
        .filter((n) => Number.isFinite(n))
    } catch {
      return []
    }
  }

  private writeOutbox(entry: OpEntry): void {
    writeFileSync(join(this.outboxDir, `${entry.seq}.json`), JSON.stringify(entry), 'utf-8')
  }

  private readOutbox(seq: number): OpEntry | null {
    try {
      const raw = readFileSync(join(this.outboxDir, `${seq}.json`), 'utf-8')
      return JSON.parse(raw) as OpEntry
    } catch {
      return null
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (this.stopped || this.flushing || this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delayMs)
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.flushing) return
    if (this.pending.length === 0) return
    this.flushing = true
    const batch = this.pending.splice(0, 200)
    try {
      const token = this.opts.getToken()
      if (!token) {
        // 未登录/无令牌：退回队列；退避重试直到登录成功（不丢 outbox）
        this.pending.unshift(...batch)
        this.scheduleRetry()
        return
      }
      // ===== staged 实体（upsert 一律外置）先经 LAN 分块面推实体，再由 applyPush 按
      // ===== size/hash 校验 staging 落镜像。实体未达 → 本条退回重试、其余照推
      // ===== （缺实体的条不出网，applyPush 不会被它截断后续 ack）；delete 无实体字节，
      // ===== 只随元数据内联推送（走既有删除路径）。无内联/降级两级分流：upsert 不分
      // ===== 体积或格式，全部同一条分块通道，任意字节统一承载。=====
      const retried: OpEntry[] = []
      const toPush: OpEntry[] = []
      for (const entry of batch) {
        if (entry.op === 'delete') {
          toPush.push(entry)
          continue
        }
        let ok = false
        try {
          // 实体面异常（LAN 未启动/文件缺失等）按未送达处理
          ok = this.opts.sendStagedEntity ? await this.opts.sendStagedEntity(entry) : false
        } catch {
          ok = false
        }
        if (!ok) {
          retried.push(entry)
          continue
        }
        toPush.push(entry)
      }
      // 重试条退回队首（逆序 unshift 后整体保持升序），后续 flush 优先重推
      if (retried.length > 0) {
        retried.sort((a, b) => b.seq - a.seq)
        this.pending.unshift(...retried)
        // 有实体未达不代表整体失败：其余条目照推，重试由退避定时器接管
        this.scheduleRetry()
      }
      if (toPush.length === 0) {
        // 整批都是 staged 且实体全部未送达：不前推 ack，退避重试（30s 后 LAN 通常已就绪）
        return
      }
      const result: SyncPushResult = await this.client.push(token, toPush)
      if (!result.ok) {
        // ack 失败：退回队列重试
        this.pending.unshift(...toPush)
        this.scheduleRetry()
        return
      }
      // ack 成功：清理 <= ackedSeq 的 outbox 条目，推进游标
      const acked = Math.max(result.ackedSeq, this.state.ackedSeq)
      this.state.ackedSeq = acked
      this.persistState()
      this.removeAcked(toPush, acked)
      // 退避基线回落：网络恢复后下次失败从 30s 重新起算，避免长期保底 5min 延迟
      this.retryDelayMs = 30_000
      if (this.pending.length > 0) {
        this.scheduleFlush(0)
      }
    } catch (err) {
      // 令牌失效（401）：先尝试刷新令牌，成功后立即重推本批（不消耗退避计数）
      if (err instanceof HttpError && err.status === 401 && this.opts.refreshToken) {
        try {
          const newToken = await this.opts.refreshToken()
          if (newToken) {
            this.pending.unshift(...batch)
            this.scheduleFlush(0)
            return
          }
        } catch {
          // 刷新失败落回常规退避路径
        }
      }
      // 网络错误/主系统不可达/刷新失败：已 splice 的批次退回队列，退避重试
      console.warn(`[sync-engine] 推送失败，${this.retryDelayMs / 1000}s 后重试:`, (err as Error).message)
      this.pending.unshift(...batch)
      this.scheduleRetry()
    } finally {
      this.flushing = false
    }
  }

  private removeAcked(batch: OpEntry[], acked: number): void {
    for (const entry of batch) {
      if (entry.seq <= acked) {
        try {
          rmSync(join(this.outboxDir, `${entry.seq}.json`), { force: true })
        } catch {
          // 删除失败不影响游标推进；残留条目不重推（seq <= acked 会被主系统幂等丢弃）
        }
      }
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.scheduleFlush(0)
    }, this.retryDelayMs)
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, 300_000)
  }
}