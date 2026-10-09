/**
 * 为什么存在：分系统增量同步需要知道"哪些文件变了"，须把 watcher 事件归一为可推送的操作日志并去重。
 * 作用：用 @parcel/watcher 监视多同步根目录，解析事件作用域（uid/aiId）与增删类型，产出带指纹的 OpEntry。
 */

import { subscribe, type AsyncSubscription } from '@parcel/watcher'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { normalizePath } from '../../models/paths'
import type { OpEntry } from '../types'

/**
 * 同步白名单根（federation/插件/技能/配置天然不在内，永不采集）。
 * cache 在同步域：分系统 CacheSync 从 NNG 派生出 cache 后经 oplog 上送，
 * 主系统直接收镜像（分账号 cache 不再由主系统本机生成，分摊同步器压力）。
 * ABYSS 在同步域：用户级 USER.md（ABYSS/U{uid}/USER.md）与 AI 级 AI.md
 * （ABYSS/U{uid}/AI{aiId}/AI.md）随其它数据一起上送，主/分系统资料一致。
 */
const SYNC_ROOTS = ['memory', 'sessions', 'NNG', 'cache', 'ABYSS'] as const

export type OpInput = Omit<OpEntry, 'seq' | 'ts'>

interface Fingerprint {
  m: number
  s: number
}

/** 从相对 dataRoot 的 key 解析作用域：memory/sessions 为 U{uid}/AI{aiId}，NNG/cache 为 AI{aiId}/U{uid}，ABYSS 为 U{uid}（USER.md→aiId=0，AI.md→实际 aiId；目录本身→aiId=0） */
function parseScope(key: string): { uid: number; aiId: number } | null {
  const parts = key.split('/')
  const root = parts[0] as (typeof SYNC_ROOTS)[number]
  if (!(SYNC_ROOTS as readonly string[]).includes(root)) return null
  // 统一 U/AI 字面前缀（设计依据：主/分系统账号数据同存 memory/、sessions/U{uid}/AI{aiId}/
  // 便于多实例共用同一工作域，碰撞隔离靠 uid 全局唯一发放；U/AI 前缀是作用域的显式语义标记）
  if (root === 'memory' || root === 'sessions') {
    const uidMatch = /^U(\d+)$/.exec(parts[1])
    const aiMatch = /^AI(\d+)$/.exec(parts[2])
    if (!uidMatch || !aiMatch) return null
    return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
  }
  if (root === 'ABYSS') {
    // ABYSS/U{uid}/USER.md → 用户级 {uid, 0}；ABYSS/U{uid}/AI{aiId}/AI.md → {uid, aiId}
    // 目录级（ABYSS/U{uid}）→ {uid, 0}：整棵用户资料树删除/创建时 watcher 只报目录路径，
    // 作用域必须能解析到目录本身，否则目录树删除事件被丢弃、主系统镜像残留空目录
    const uidMatch = /^U(\d+)$/.exec(parts[1])
    if (!uidMatch) return null
    if (parts.length === 2) return { uid: Number(uidMatch[1]), aiId: 0 }
    if (parts[2] === 'USER.md' && parts.length === 3) return { uid: Number(uidMatch[1]), aiId: 0 }
    const aiMatch = /^AI(\d+)$/.exec(parts[2])
    if (aiMatch && parts[3] === 'AI.md' && parts.length === 4) {
      return { uid: Number(uidMatch[1]), aiId: Number(aiMatch[1]) }
    }
    return null
  }
  if (root === 'NNG' || root === 'cache') {
    const aiMatch = /^AI(\d+)$/.exec(parts[1])
    const uidMatch = /^U(\d+)$/.exec(parts[2])
    if (!aiMatch || !uidMatch) return null
    return { aiId: Number(aiMatch[1]), uid: Number(uidMatch[1]) }
  }
  return null
}

/** 原始字节 sha256（staged 条目哈希，格式 'sha256:'+hex；采集合一后所有 upsert 都走原始字节指纹） */
function sha256Buffer(raw: Buffer): string {
  return 'sha256:' + createHash('sha256').update(raw).digest('hex')
}

/** 是否缓存注入目录文件（cache/…/injection/…）：AI 会话期瞬态注入视图，非持久记忆，不参与同步 */
function isInjectionFile(key: string): boolean {
  return key.includes('/injection/')
}

/**
 * 分系统 oplog 采集（单向，数据源头在分系统）：
 * - watcher 实时捕获 memory/sessions/NNG/cache 增删改，产出 OpEntry 输入
 * - 启动时做指纹对账：上次运行后未捕获的增删改/未推全量基线在此补推
 * - federation/ 不在白名单、插件/技能/配置目录不在采集范围
 */
export class OplogCapture {
  private subs: AsyncSubscription[] = []
  private fingerprint: Record<string, Fingerprint> = {}
  private fingerprintPath: string

  constructor(
    private readonly root: string,
    private readonly onOp: (op: OpInput) => void
  ) {
    this.fingerprintPath = join(root, '.sync', 'fingerprint.json')
    this.loadFingerprint()
  }

  async start(): Promise<void> {
    if (this.subs.length > 0) return
    this.scanBaseline()
    this.persistFingerprint()
    for (const root of SYNC_ROOTS) {
      const dir = join(this.root, root)
      if (!existsSync(dir)) continue
      try {
        const sub = await subscribe(
          dir,
          (err, events) => {
            if (err) {
              console.error(`[oplog] watcher error (${root}):`, err.message)
              return
            }
            this.handleEvents(events)
          },
          // 与 path-sync-monitor 一致：显式 Windows 原生后端，避免 watchman 探测
          { backend: 'windows' }
        )
        this.subs.push(sub)
      } catch (err) {
        console.error(`[oplog] 订阅失败 (${root}):`, (err as Error).message)
      }
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subs) {
      try {
        await sub.unsubscribe()
      } catch {
        // 订阅已失效时忽略
      }
    }
    this.subs = []
  }

  private loadFingerprint(): void {
    if (!existsSync(this.fingerprintPath)) return
    try {
      this.fingerprint = JSON.parse(readFileSync(this.fingerprintPath, 'utf-8')) as Record<string, Fingerprint>
    } catch {
      this.fingerprint = {}
    }
  }

  private persistFingerprint(): void {
    mkdirSync(join(this.root, '.sync'), { recursive: true })
    writeFileSync(this.fingerprintPath, JSON.stringify(this.fingerprint), 'utf-8')
  }

  /** 启动对账：指纹 diff → 新增/变化补推 upsert，消失补推 delete；首次运行即全量基线 */
  private scanBaseline(): void {
    const current: Record<string, Fingerprint> = {}
    for (const root of SYNC_ROOTS) {
      const dir = join(this.root, root)
      if (!existsSync(dir)) continue
      const files: string[] = []
      walkFiles(dir, files)
      for (const abs of files) {
        const key = this.toKey(abs)
        const fp = fpOf(abs)
        if (!fp || !key) continue
        const prev = this.fingerprint[key]
        if (!prev || prev.m !== fp.m || prev.s !== fp.s) {
          // 读取失败（文件正在写入中）→ 不记指纹，留待 watcher 事件或下次启动对账
          if (!this.emitUpsert(abs, key)) continue
        }
        current[key] = fp
      }
    }
    const missingDirs = new Set<string>()
    for (const key of Object.keys(this.fingerprint)) {
      if (current[key]) continue
      const root = key.split('/')[0]
      if (!(SYNC_ROOTS as readonly string[]).includes(root)) {
        // 已退出同步域的残留指纹（历史曾白名单变动的域）：只清理指纹，不发射操作
        delete this.fingerprint[key]
        continue
      }
      this.emitDelete(key)
      // 目录收尾：文件消失但父目录在磁盘上已不存在（离线/停订阅期间整树被删，
      // watcher 目录事件丢帧）→ 对最顶层不存在的目录发目录级 delete，
      // 主系统 recursive 删除镜像整树，避免残留空目录骨架
      const topMissing = this.emitMissingParentDirs(key)
      if (topMissing) missingDirs.add(topMissing)
    }
    for (const dirKey of missingDirs) {
      const scope = parseScope(dirKey)
      if (!scope) continue
      this.onOp({
        instanceId: '',
        uid: scope.uid,
        aiId: scope.aiId,
        op: 'delete',
        key: dirKey
      })
    }
    this.fingerprint = current
  }

  private handleEvents(events: Array<{ path: string; type: string }>): void {
    for (const ev of events) {
      const key = this.toKey(ev.path)
      if (!key) continue
      if (ev.type === 'delete') {
        this.emitDelete(key)
        continue
      }
      this.emitUpsert(ev.path, key)
    }
  }

  private toKey(abs: string): string | null {
    const norm = normalizePath(abs)
    const root = normalizePath(this.root)
    if (!norm.startsWith(root)) return null
    const key = norm.slice(root.length + 1)
    return key.length > 0 ? key : null
  }

  /** 推 upsert 事件；读取失败返回 false（文件正在写入中，不更新指纹） */
  private emitUpsert(abs: string, key: string): boolean {
    // 缓存注入目录（cache/.../injection/）是 AI 会话期的临时注入视图，非持久记忆：
    // 每次会话重写、无跨机消费价值，且与主系统 handler 的 isInInjection 语义对齐，不同步
    if (isInjectionFile(key)) return false
    const scope = parseScope(key)
    if (!scope) return false
    // 读原始字节一次，统一产出 staged 条目（size + hash，content 省略）：
    // 实体由 sync-engine 在 push 前经 lan-stream 分块面推送到主系统 staging，落镜像前校验 hash。
    // 为什么不再分级内联：分块面承载任意字节、块级停滞判定 + 整体 sha256 终校验后，内联只是
    // 一条与分块面并行的重复路径（8MB 阈值还逼迫非 UTF-8/超限文件走第二套语义）；统一走分块面
    // 让"UTF-8 契约"彻底退出同步语义——图片/GBK 文档等任意字节与文本同一条可靠通道，无阈值、
    // 无格式限制、无内联/降级两级分流。
    let raw: Buffer
    try {
      raw = readFileSync(abs)
    } catch {
      // 文件正被写入中（读失败）：指纹不更新，下次事件/下次启动对账会再读
      return false
    }
    const fp = fpOf(abs)
    if (fp) this.fingerprint[key] = fp
    this.onOp({
      instanceId: '',
      uid: scope.uid,
      aiId: scope.aiId,
      op: 'upsert',
      key,
      size: raw.length,
      staged: true,
      hash: sha256Buffer(raw)
    })
    return true
  }

  private emitDelete(key: string): void {
    if (isInjectionFile(key)) return
    const scope = parseScope(key)
    if (!scope) return
    delete this.fingerprint[key]
    this.onOp({
      instanceId: '',
      uid: scope.uid,
      aiId: scope.aiId,
      op: 'delete',
      key
    })
  }

  /** 消失文件所在目录若在磁盘上已不存在，向上回溯并返回最顶层缺失目录 key（基线对账的目录收尾）。
   * 为什么存在：@parcel/watcher 订阅中断/离线期间目录树整体被删时，仅靠文件级
   * 指纹消失无法让主系统删掉镜像目录骨架；找到磁盘上已不存在的最顶层父目录，
   * 由调用方统一发目录级 delete op 让主系统整树收敛（去重后发射，避免逐文件重复）。
   * 只返回最顶层缺失目录：主系统 applyPush 对目录 delete 递归删除，覆盖整棵子树，
   * 深层缺失目录无需逐级各发一条（冗余 op 幂等但浪费带宽）。 */
  private emitMissingParentDirs(fileKey: string): string | null {
    const parts = fileKey.split('/')
    // 目录级同步下界：ABYSS 为 ABYSS/U{uid}（2 段）；其余域为作用域根（3 段）。
    // 低于该层不再向上（用户级根目录只是容器，不属于同步 pid 边界）
    const minParts = parts[0] === 'ABYSS' ? 2 : 3
    let topMissing: string | null = null
    for (let i = parts.length - 1; i >= minParts; i--) {
      const dirKey = parts.slice(0, i).join('/')
      const scope = parseScope(dirKey)
      if (!scope) continue
      const abs = join(this.root, dirKey)
      if (existsSync(abs)) break // 自深向浅找到第一个仍存在的目录：其下的缺失树已穷尽
      topMissing = dirKey // 缺失目录不断上移，循环结束保留最顶层缺失目录
    }
    return topMissing
  }
}

function walkFiles(dir: string, out: string[]): void {
  let items: import('fs').Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const item of items) {
    const p = join(dir, item.name)
    if (item.isDirectory()) walkFiles(p, out)
    else if (item.isFile()) out.push(p)
  }
}

function fpOf(abs: string): Fingerprint | null {
  try {
    const st = statSync(abs)
    return st.isFile() ? { m: st.mtimeMs, s: st.size } : null
  } catch {
    return null
  }
}

