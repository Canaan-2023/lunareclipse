/**
 * @category 多实例
 * @summary 中继收件器：把带 relay 标记的流落盘到目标，非中继流整流忽略
 *
 * 为什么独立成文件：收件器是**自包含**的落盘状态机（幂等跳过 / .part 临时写 / abort 清理半成品），
 * 与中继业务语义（条目状态机、同意制）无耦合，却原先与 1093 行的 RelayService 同处一文件。
 *
 * ADR-09 拆分自 relay-service.ts（纯搬移不改行为）：函数收 `host` 句柄，
 * 状态与共享能力经该句柄读写（宿主 facade 以闭包提供，**不放宽类成员可见性**）。
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import type { WriteStream } from 'fs'
import type { LanStreamBeginMeta } from '../lan/lan-stream'

/** 中继收件器：把带 relay 标记的流落盘到 resolve 给出的目标；非中继流整流忽略（与实时链共存） */
export interface RelaySinkTarget {
  rootDir: string
  /** 相对目标根的多级子路径（已逐段净化；空数组 = 根目录直落） */
  parts: string[]
  /** 目录项流（size=0，只 mkdir 不写 .part） */
  isDir: boolean
}

export interface RelaySinkDeps {
  /** 解析流的落盘目标；返回 accept=false 整流忽略（无权/非中继/非法标记） */
  resolve: (peerUid: number, meta: LanStreamBeginMeta) => { accept: false } | { accept: true; target: RelaySinkTarget }
}

interface SinkEntry {
  target: string
  w: WriteStream
  size: number
  skipped: boolean
  isDir: boolean
}

const IGNORE_ENTRY: SinkEntry = { target: '', w: void 0 as unknown as WriteStream, size: 0, skipped: true, isDir: false }

/** 流落盘器：幂等（正式目标已存在即跳过）、.part 临时写、abort 清理半成品——与 LanFileSink 同语义 */
export class RelaySink {
  private readonly entries = new Map<number, SinkEntry>()

  constructor(private readonly deps: RelaySinkDeps) {}

  /** 对端离线/服务停止：丢弃未收齐的 .part（不产生半成品文件） */
  reset(): void {
    for (const [sid, e] of this.entries) {
      if (!e.skipped && !e.isDir) this.abortEntry(sid, e)
    }
    this.entries.clear()
  }

  onBegin(peerUid: number, streamId: number, meta: LanStreamBeginMeta): void {
    if (this.entries.has(streamId)) return
    if (!meta.relay) {
      // 非中继流：实时链的 LanFileSink 已接管，本收件器整流忽略
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    const resolved = this.deps.resolve(peerUid, meta)
    if (!resolved.accept) {
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    const { rootDir, parts, isDir } = resolved.target
    const target = join(rootDir, ...parts)
    // 路径防线：目标必须在传入的 rootDir 之内（parts 已逐段净化；这里再断言防 join 逃逸）
    if (!target.startsWith(rootDir + '\\') && !target.startsWith(rootDir + '/')) {
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    if (isDir) {
      if (existsSync(target)) {
        this.entries.set(streamId, IGNORE_ENTRY) // 幂等：目录已存在（重放场景）跳过
        return
      }
      mkdirSync(target, { recursive: true })
      this.entries.set(streamId, { target, w: void 0 as unknown as WriteStream, size: 0, skipped: false, isDir: true })
      return
    }
    // 幂等：正式目标已存在（重复下载/重放）→ 跳过，不覆盖已落盘的完整文件
    if (existsSync(target)) {
      this.entries.set(streamId, IGNORE_ENTRY)
      return
    }
    mkdirSync(dirname(target), { recursive: true })
    const w = createWriteStream(`${target}.part`)
    w.on('error', () => {}) // 吞掉写盘 IO 错误：由 abort/清理路径兜底，不炸主进程
    this.entries.set(streamId, { target, w, size: 0, skipped: false, isDir: false })
  }

  onData(peerUid: number, streamId: number, offset: number, data: Buffer): void {
    const e = this.entries.get(streamId)
    if (!e || e.skipped) return
    if (e.isDir) {
      this.entries.delete(streamId) // 目录项流不应携带数据：协议异常，丢弃本流
      return
    }
    if (offset !== e.size) {
      this.entries.delete(streamId)
      this.abortEntry(streamId, e) // 序内缺口说明状态异常：中止防半截文件
      return
    }
    e.size += data.length
    e.w.write(data)
    void peerUid
  }

  onEnd(peerUid: number, streamId: number, meta: { name: string; size: number }, error?: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return // 无权/幂等/非中继：无产出，静默收敛
    if (e.isDir) return // 目录项流：目录已建立
    e.w.end(() => {
      if (error) {
        this.removePart(streamId, e) // 协议层校验失败：删 .part，不产出损坏文件
        return
      }
      try {
        renameSync(`${e.target}.part`, e.target)
      } catch (err) {
        console.warn(`[relay] 中继落盘失败（streamId=${streamId}）:`, (err as Error).message)
        this.removePart(streamId, e)
      }
      void peerUid
      void meta
    })
  }

  onAbort(peerUid: number, streamId: number, reason: string): void {
    const e = this.entries.get(streamId)
    if (!e) return
    this.entries.delete(streamId)
    if (e.skipped) return
    if (!e.isDir) this.abortEntry(streamId, e)
    void peerUid
    void reason
  }

  private abortEntry(streamId: number, e: SinkEntry): void {
    const part = `${e.target}.part`
    try {
      e.w.destroy()
    } catch {
      // 忽略
    }
    // fd 释放后再删 .part：Windows 上持有句柄直接 rmSync 会失败或与异步 open 竞态
    e.w.once('close', () => {
      try {
        rmSync(part, { force: true })
      } catch {
        // 忽略
      }
    })
    setTimeout(() => {
      try {
        rmSync(part, { force: true })
      } catch {
        // 忽略
      }
    }, 1000).unref()
    void streamId
  }

  private removePart(streamId: number, e: SinkEntry): void {
    try {
      rmSync(`${e.target}.part`, { force: true })
    } catch {
      // 忽略
    }
    void streamId
  }
}
