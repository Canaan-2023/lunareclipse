/**
 * mission-store.ts
 * 长期任务（Mission）持久化层 —— 自主 AGENT ① + ④ 的载体。

 * 参照参考实现的 kanban 任务板语义：
 * - 任务有完整生命周期状态机（active / paused / done / blocked）
 * - 失败重试有 attempt 计数 + failure_limit（DEFAULT_FAILURE_LIMIT=2）
 * - blocked 细分为 blockKind（dependency / needs_input / capability / transient）——
 * transient 可重试，truly-blocked(needs_input/capability) 要人介入，防"unblock↔re-block 死循环"

 * 与 AsyncDelegationManager 的关系：async-delegation 是一次性后台子任务（executor）；
 * MissionStore 是"长期目标"的真相源——记录 goal（目标）、跨 dispatch 累计的迭代预算、
 * 失败尝试计数。月蚀 AI/用户派发一个 mission，实际执行走 asyncDelegation.dispatch，
 * 但目标/进度/预算累计/失败重试状态都存在 MissionStore（文件即真相源，对齐月蚀哲学）。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'fs'
import { join } from 'path'

/** 阻塞类型（对齐参考实现 kanban VALID_BLOCK_KINDS） */
export type MissionBlockKind = 'dependency' | 'needs_input' | 'capability' | 'transient'

/** Mission 持久化记录 */
export interface MissionRecord {
  id: string
  /** 长期目标（任务描述，供后续续接/回顾） */
  goal: string
  status: 'active' | 'paused' | 'done' | 'blocked'
  createdAt: number
  updatedAt: number
  /** 跨 dispatch 累计已用迭代（② 长期目标跨段累计的核心） */
  iterationsUsed: number
  /** 迭代预算上限（2026-10-02 起默认 MAX_SAFE_INTEGER=不限制） */
  maxIterations: number
  /** 已派发段数（每 dispatch 一段） */
  segments: number
  /** 失败重试计数（④，对齐 failure_limit） */
  attemptCount: number
  /** 失败重试上限（对齐 DEFAULT_FAILURE_LIMIT=2） */
  failureLimit: number
  /** 最近一次失败原因 */
  lastError?: string
  /** 阻塞类型（truly-blocked 时填） */
  blockKind?: MissionBlockKind
  /** 最近一次成功产物摘要 */
  lastResult?: string
}

/** Mission 目录根 */
function missionRoot(projectRoot: string): string {
  return join(projectRoot, 'mission')
}

/**
 * MissionStore：持久化长期任务，支持跨段累计预算 + 失败重试计数 + 阻塞分类。
 * 文件即真相源：每个 mission 一个 JSON 文件 {root}/mission/{id}.json，
 * 原子写（.tmp + rename）防崩溃截断（对齐 session-store 的 atomicWrite 教训）。
 */
export class MissionStore {
  constructor(private root: string) {
    mkdirSync(missionRoot(root), { recursive: true })
  }

  private fileOf(id: string): string {
    return join(missionRoot(this.root), `${id}.json`)
  }

  /** 创建 mission（不存在时）。返回该 mission */
  create(id: string, goal: string, opts?: { maxIterations?: number; failureLimit?: number }): MissionRecord {
    const now = Date.now()
    const rec: MissionRecord = {
      id,
      goal,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      iterationsUsed: 0,
      // 2026-10-02 取消迭代预算上限：默认不再限制（JSON 持久化须用极大值，Infinity 会变 null）
      maxIterations: opts?.maxIterations ?? Number.MAX_SAFE_INTEGER,
      segments: 0,
      attemptCount: 0,
      failureLimit: opts?.failureLimit ?? 2,
    }
    this.write(rec)
    return rec
  }

  /** 读取 mission；不存在返回 null */
  get(id: string): MissionRecord | null {
    const p = this.fileOf(id)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8')) as MissionRecord
  }

  /** 列出全部 mission */
  list(): MissionRecord[] {
    const dir = missionRoot(this.root)
    if (!existsSync(dir)) return []
    const out: MissionRecord[] = []
    for (const f of readdirSafe(dir)) {
      if (!f.endsWith('.json')) continue
      const rec = this.get(f.replace(/\.json$/, ''))
      if (rec) out.push(rec)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 记录"一段执行结束"（① 跨段累计预算 + ④ 失败计数）。
   * - 成功：iterationsUsed += usedThisSegment，status=done（若目标完成）或保持 active，清除失败计数
   * - 失败：attemptCount += 1；若是 transient 且未超 failureLimit → 保持 active（可重试）；
   * 超限或 truly-blocked（needs_input/capability）→ status=blocked
   * 返回更新后的 mission。
   */
  completeSegment(
    id: string,
    info: {
      usedThisSegment: number
      ok: boolean
      error?: string
      blockKind?: MissionBlockKind
      done?: boolean
      result?: string
    },
  ): MissionRecord | null {
    const rec = this.get(id)
    if (!rec) return null
    rec.segments += 1
    rec.iterationsUsed += info.usedThisSegment
    rec.updatedAt = Date.now()
    if (info.result) rec.lastResult = info.result

    if (info.ok) {
      rec.lastError = undefined
      // 成功一次重置失败计数（可继续推进）
      if (info.done) {
        rec.status = 'done'
      } else {
        rec.status = 'active'
        // 允许继续：若此前 transient 阻塞，成功后解除
        rec.blockKind = undefined
      }
    } else {
      rec.lastError = info.error
      // ④ 失败分类：truly-blocked(capability/needs_input/dependency) 要人介入且不累计重试次数；
      // transient 可重试，但连续失败达 failureLimit（对齐 DEFAULT_FAILURE_LIMIT=2）→ blocked 防死循环
      const kind = info.blockKind ?? 'transient'
      if (kind === 'transient') {
        rec.attemptCount += 1
        if (rec.attemptCount >= rec.failureLimit) {
          rec.status = 'blocked'
          rec.blockKind = kind
        } else {
          rec.status = 'active' // 等待下次重试
        }
      } else {
        rec.status = 'blocked'
        rec.blockKind = kind
      }
    }
    this.write(rec)
    return rec
  }

  /** 重试一次 transient 失败的 mission（④）：清掉 attemptCount 后重新激活（由调度方 dispatch 执行） */
  retry(id: string): MissionRecord | null {
    const rec = this.get(id)
    if (!rec) return null
    if (rec.status === 'blocked') return null
    rec.attemptCount = 0 // 重新开始计数
    rec.status = 'active'
    rec.updatedAt = Date.now()
    this.write(rec)
    return rec
  }

  /** 标记需人/父对话介入（capability/needs_input） */
  block(id: string, kind: MissionBlockKind, reason: string): MissionRecord | null {
    const rec = this.get(id)
    if (!rec) return null
    rec.status = 'blocked'
    rec.blockKind = kind
    rec.lastError = reason
    rec.updatedAt = Date.now()
    this.write(rec)
    return rec
  }

  /** 计算续接预算：maxIterations - 累计已用（② 跨段累计防总超限） */
  remainingBudget(id: string): number {
    const rec = this.get(id)
    if (!rec) return 0
    return Math.max(0, rec.maxIterations - rec.iterationsUsed)
  }

  private write(rec: MissionRecord): void {
    const p = this.fileOf(rec.id)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf-8')
    renameSync(tmp, p)
  }
}

/** 安全读目录（目录不存在返回空） */
function readdirSafe(dir: string): string[] {
  return readdirSync(dir)
}
