/**
 * @category ROOM
 * @summary 前置规划（Preplan）配置与滚动规划历史的持久化——主AI影子的唯一持久体
 *
 * 为什么存在：ROOM 自主模式的「前置规划AI」是每个有 aiId 主AI的专属影子（2026-10-31 用户裁决）：
 * 不占 AI 列表位、不在 ai-registry 注册、不写 RAW、不进记忆工作流。前置规划需要记住
 * 「我上几轮规划过什么、执行结果如何」才能给出不重复的下一步指令——这份历史**不能**
 * 走会话历史（room 轮不落盘）也不能走 RAW（前置规划永不写 RAW，否则与主AI记忆重复），
 * 唯一落点就是本文件：复用 ROOM「区自持存储」模式（同 `tool-zone.json` 一区一文件）。
 *
 * 不删理由：删掉即前置规划失去跨轮记忆，每轮规划都从零开始，交替循环退化成无状态复读。
 *
 * 自管理口径（用户裁决「自己管理自己，清理删减自由度拉满」）：历史环超过
 * `MAX_HISTORY` 自动删减最旧条目；读不到/文件损坏 = 空配置回退（与 ToolZoneStore 同口径），
 * 不抛错——前置规划历史丢了只是规划变朴素，不是故障。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { renameFileWithRetry } from '../utils/atomic-write'

/** 滚动历史环上限：20 条足够覆盖近期规划节奏，再多只是徒增提示词体积。 */
export const PREPLAN_MAX_HISTORY = 20

/** 一条滚动历史：某轮前置规划给出的指令 + 主AI执行结果的摘要（均已截断）。 */
export interface PreplanHistoryEntry {
  ts: number
  /** 前置规划该轮给出的指令（截断） */
  instruction: string
  /** 主AI执行结果摘要（逐条工具名+成败，截断） */
  results: string
}

export interface PreplanRoomConfig {
  /** 前置规划是否启用（缺省 false = 主AI自规划，行为与引入前置规划前逐字一致） */
  enabled: boolean
  /** 滚动规划历史环（新→旧追加在尾，超环长砍头） */
  history: PreplanHistoryEntry[]
}

export interface PreplanFile {
  updatedAt: string
  rooms: Record<string, PreplanRoomConfig>
}

/** 房间作用域键：前置规划独属于 (uid, aiId) 这位主AI——与房间配置同口径。 */
export function preplanScopeKey(uid: number, aiId: number): string {
  return `${uid}_${aiId}`
}

const EMPTY_CONFIG: PreplanRoomConfig = { enabled: false, history: [] }

/** 进程级单例 + uid 解析器（组合根 `initRoomRuntime` 装配时注册；IPC 层经 `getPreplanAccess` 取用）。
 * 为什么带 getUid：preplan.json 的键是 `{uid}_{aiId}`，而 ROOM IPC 通道只带 aiId——
 * uid 必须来自当前登录态，由装配侧注入解析器，本模块不反向依赖 userStore。 */
let preplanAccess: { store: PreplanStore; getUid: () => number | null } | null = null

export function setPreplanAccess(store: PreplanStore | null, getUid?: () => number | null): void {
  preplanAccess = store ? { store, getUid: getUid ?? (() => null) } : null
}

export function getPreplanAccess(): { store: PreplanStore; getUid: () => number | null } | null {
  return preplanAccess
}

/** 前置规划持久化（记录型 JSON，原子写——与 ToolZoneStore 同样板）。 */
export class PreplanStore {
  constructor(private readonly dir: string) {}

  private filePath(): string {
    return join(this.dir, 'preplan.json')
  }

  private loadFile(): PreplanFile {
    const p = this.filePath()
    if (!existsSync(p)) return { updatedAt: '', rooms: {} }
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf-8')) as PreplanFile
      if (!parsed || typeof parsed !== 'object' || !parsed.rooms || typeof parsed.rooms !== 'object') {
        return { updatedAt: '', rooms: {} }
      }
      return parsed
    } catch {
      return { updatedAt: '', rooms: {} }
    }
  }

  private saveFile(file: PreplanFile): void {
    const p = this.filePath()
    mkdirSync(dirname(p), { recursive: true })
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...file, updatedAt: new Date().toISOString() }, null, 2), 'utf-8')
    renameFileWithRetry(tmp, p)
  }

  /** 读某主AI的前置规划配置（无记录/损坏 = 未启用 + 空历史，不抛错）。 */
  load(uid: number, aiId: number): PreplanRoomConfig {
    const cfg = this.loadFile().rooms[preplanScopeKey(uid, aiId)]
    if (!cfg || typeof cfg !== 'object') return { ...EMPTY_CONFIG }
    return {
      enabled: cfg.enabled === true,
      history: Array.isArray(cfg.history) ? cfg.history.slice(-PREPLAN_MAX_HISTORY) : []
    }
  }

  /** 开关前置规划。 */
  setEnabled(uid: number, aiId: number, enabled: boolean): void {
    const file = this.loadFile()
    const key = preplanScopeKey(uid, aiId)
    const prev = file.rooms[key] ?? { ...EMPTY_CONFIG }
    file.rooms[key] = { enabled, history: Array.isArray(prev.history) ? prev.history : [] }
    this.saveFile(file)
  }

  /**
   * 追加一条滚动历史（自动删减到环长内）。
   * 为什么落盘而非内存：房间驱动 park/重启后前置规划仍应记得近期节奏——这正是它
   * 与「会话历史/RAW」的差异点：体量小、自管理、随时可清空重来。
   */
  appendHistory(uid: number, aiId: number, entry: PreplanHistoryEntry): void {
    const file = this.loadFile()
    const key = preplanScopeKey(uid, aiId)
    const prev = file.rooms[key] ?? { ...EMPTY_CONFIG }
    const history = [...(Array.isArray(prev.history) ? prev.history : []), entry].slice(-PREPLAN_MAX_HISTORY)
    file.rooms[key] = { enabled: prev.enabled === true, history }
    this.saveFile(file)
  }

  /** 清空某主AI的前置规划历史（开关不动）——用户想「让前置规划重新开始」时用。 */
  clearHistory(uid: number, aiId: number): void {
    const file = this.loadFile()
    const key = preplanScopeKey(uid, aiId)
    const prev = file.rooms[key]
    if (!prev) return
    file.rooms[key] = { enabled: prev.enabled === true, history: [] }
    this.saveFile(file)
  }
}
