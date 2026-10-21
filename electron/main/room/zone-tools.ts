/**
 * @category ROOM
 * @summary 区工具：把 ROOM 的「区」做成 AI 写给自己用的一叠纸（**逆生树结构，不是会话**）
 *
 * 为什么存在（用户裁决 2026-10-19，勿回退）：
 * - 「ROOM 那几个区，也可以用**逆生树式**的上下文管理来做」——区要有连续性、不丢信息；
 * - 「不是一张纸，而是**很多纸**」——每区是一棵逆生树（继承轴 / 时间延续 / 新话题三边都生效）；
 * - 「也**不需要全部读取**」——宿主只给索引，正文按需 `read`（可分段）；
 * - 「纸可以丢，可以开新，但**历史可以回找**」——`discard` / `create` / 按 id 回读冻结底稿；
 * - 「区**不能算是会话**，只能算是一种信息，一种工具」——不进会话池、不进会话列表、
 *   不进普通对话的路由候选。
 *
 * **复用什么**：`InternalSessionStore` 的全部语义（继承冻结 / 时间分叉 / 可写尾端判定 /
 * active 指针 / 原子写 / 写链串行），**零改动**——只换一个 root 解析器（房间自有目录）。
 * 这是本设计的关键取舍：逆生树的三边语义已在存储层实现且有回归网，区只是**换一个落点**，
 * 不另造一套「纸」的存储与关系模型。
 *
 * **存储**：`<data>/room/zones/{zone}/{ownerSessionId}/ai/*.json`
 * - 不在 `sessions/` 下 → `sessionStore.list()` 看不到、普通对话的路由候选看不到；
 * - `ownerSessionId` = 房间主会话（`room-autonomous-U{uid}-AI{aiId}`）→ 每个 AI 的房间各一堆纸，
 *   同一台机器上不同用户也天然隔离。
 *
 * **注入方式**：本文件只产出 `ToolExecutor`，由无头链路按 `purpose === 'room'` 追加进工具集
 * （见 `api/run-headless-chat.ts` 的 `extraToolExecutors`）——**普通对话的工具面零变化**。
 *
 * 不删理由：删掉即区退回「宿主替 AI 决定看什么」，正是用户否定的形态。
 */
import { join } from 'path'
import type { ToolExecutor } from '../api/llm-types'
import { InternalSessionStore } from '../services/internal-session-store'
import type { InternalSession, InternalSessionSummary } from '@shared/types'

/** 三个区（与 `RoomView` 的主区导航一致；执行器 / 采集器 / 设备） */
export const ROOM_ZONES = ['executor', 'collector', 'device'] as const
export type RoomZone = (typeof ROOM_ZONES)[number]

export function isRoomZone(v: unknown): v is RoomZone {
  return typeof v === 'string' && (ROOM_ZONES as readonly string[]).includes(v)
}

/** 单张纸的索引（**只给索引不给正文**——用户「不需要全部读取」） */
export interface ZonePaperIndex {
  id: string
  title: string
  summary: string
  gen?: number
  parentId?: string
  /** 是否可写尾端（无时间下级、无继承子）——只有可写尾端能继续承接 */
  writableTail: boolean
  /** 是否已锁定只读（已向时间下级延续 / 已被继承压缩）——可回读，不可再写 */
  locked: boolean
  isNewTopic?: boolean
  messageCount: number
  totalChars: number
  createdAt: number
  updatedAt: number
  /** 纸的绝对路径：AI 需要原文时可直接 Read（「历史可以回找」） */
  filePath: string
}

export interface RoomZoneTrees {
  /** 该区全部纸（按 updatedAt 降序）+ 可写尾端与当前落点 */
  index(zone: RoomZone): { papers: ZonePaperIndex[]; activeId: string | null }
  /** 读一张纸的正文（可分段；`limit` 省略 = 全读） */
  read(zone: RoomZone, internalId: string, offset?: number, limit?: number): { paper: ZonePaperIndex; body: string; total: number } | null
  /** 新开一张纸（`newTopic` 走逆生树虚线：空白承接、不复制父内容）并设为当前落点 */
  create(zone: RoomZone, opts: { title?: string; summary?: string; content?: string; parentId?: string; newTopic?: boolean }): ZonePaperIndex
  /** 定当前落点（只接受可写尾端，与 `session_select` 同规则） */
  select(zone: RoomZone, internalId: string): { ok: true } | { ok: false; error: string }
  /** 当前落点 id（无则 null） */
  active(zone: RoomZone): string | null
  /** 往一张纸追加一行（默认落在当前落点；无落点则报错，不隐式建纸）。异步：等落盘完成才回执 */
  append(zone: RoomZone, content: string, internalId?: string): Promise<{ ok: true; internalId: string } | { ok: false; error: string }>
  /** 丢一张纸（历史随之不可回找；当前落点被丢时一并清除） */
  discard(zone: RoomZone, internalId: string): { ok: true } | { ok: false; error: string }
}

/** 区树的构造参数 */
export interface RoomZoneTreesOptions {
  /** 区根目录（`<data>/room/zones`） */
  zonesRoot: string
  /** 房间主会话 id（`room-autonomous-U{uid}-AI{aiId}`）——纸堆的归属与隔离键 */
  ownerSessionId: string
}

/** 索引行：`list()` 给的是摘要，这里补上可写/锁定判定（与 `session_select` 同口径） */
function toIndex(
  s: InternalSessionSummary,
  childIds: ReadonlySet<string>,
  absFilePath: string
): ZonePaperIndex {
  const locked = Boolean(s.timeBranchId) || childIds.has(s.id)
  return {
    id: s.id,
    title: s.title,
    summary: s.summary,
    ...(s.gen != null ? { gen: s.gen } : {}),
    ...(s.parentId ? { parentId: s.parentId } : {}),
    writableTail: !locked,
    locked,
    ...(s.isNewTopic ? { isNewTopic: true } : {}),
    messageCount: s.messageCount,
    totalChars: s.totalChars,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    filePath: absFilePath
  }
}

/**
 * 建某房间的区树集合。
 * 每区一个 `InternalSessionStore` 实例（root = `<zonesRoot>/<zone>`，owner = 房间主会话），
 * 于是「一个区 = 一棵逆生树 + 一个自己的落点指针」，区之间天然不串。
 */
export function createRoomZoneTrees(opts: RoomZoneTreesOptions): RoomZoneTrees {
  const owner = opts.ownerSessionId
  const stores = new Map<RoomZone, InternalSessionStore>()
  const storeOf = (zone: RoomZone): InternalSessionStore => {
    let s = stores.get(zone)
    if (!s) {
      // 自定义 root：不经过 `createAiScopedSessionRoots`（那需要 owner 会话在 SessionStore 里
      // 才能解析 aiId）。区不是会话，本就不该为了解析 aiId 去 SessionStore 建一条记录。
      s = new InternalSessionStore(() => join(opts.zonesRoot, zone))
      stores.set(zone, s)
    }
    return s
  }

  const childIdsOf = (zone: RoomZone): Set<string> => {
    const ids = new Set<string>()
    for (const s of storeOf(zone).list(owner)) if (s.parentId) ids.add(s.parentId)
    return ids
  }

  const index = (zone: RoomZone): { papers: ZonePaperIndex[]; activeId: string | null } => {
    const store = storeOf(zone)
    const all = store.list(owner)
    const childIds = new Set<string>()
    for (const s of all) if (s.parentId) childIds.add(s.parentId)
    return {
      papers: all.map((s) => toIndex(s, childIds, store.absFilePath(owner, s.filePath))),
      activeId: store.getActive(owner)
    }
  }

  const paperIndex = (zone: RoomZone, internalId: string): ZonePaperIndex | null => {
    const store = storeOf(zone)
    const s = store.list(owner).find((x) => x.id === internalId)
    if (!s) return null
    return toIndex(s, childIdsOf(zone), store.absFilePath(owner, s.filePath))
  }

  return {
    index,

    read(zone, internalId, offset = 0, limit) {
      const store = storeOf(zone)
      const paper = paperIndex(zone, internalId)
      if (!paper) return null
      const full = store.get(owner, internalId)
      if (!full) return null
      const from = Math.max(0, Math.floor(offset))
      const msgs = full.messages.slice(from, limit == null ? undefined : from + Math.max(0, Math.floor(limit)))
      // 正文按「角色：内容」平铺（与内部会话锚点的读法一致，AI 读起来是时间线）
      const body = msgs.map((m) => `${m.role === 'user' ? '我' : m.role === 'assistant' ? '纸' : '注'}：${m.content}`).join('\n')
      return { paper, body, total: full.messages.length }
    },

    create(zone, o) {
      const store = storeOf(zone)
      // 父纸身份：分叉要带上「第几代」（与 `session_select` 的 create 同口径）
      const parent = o.parentId ? store.list(owner).find((x) => x.id === o.parentId) : undefined
      if (o.parentId && !parent) {
        throw new Error(`parentId ${o.parentId} 不存在于区「${zone}」（先 list 取最新清单）`)
      }
      const created: InternalSession = store.create(owner, {
        title: o.title?.trim() || `区·${zone}`,
        ...(o.summary ? { summary: o.summary } : {}),
        ...(o.content ? { content: o.content } : {}),
        ...(parent ? { parentId: parent.id, gen: (parent.gen ?? 1) + 1 } : {}),
        ...(o.newTopic ? { isNewTopic: true } : {})
      })
      // 开新即落点（与 `session_select` 的 create 语义一致）：新纸是「我现在在写的这张」
      store.setActive(owner, created.id)
      return paperIndex(zone, created.id) as ZonePaperIndex
    },

    select(zone, internalId) {
      const store = storeOf(zone)
      const s = store.list(owner).find((x) => x.id === internalId)
      if (!s) return { ok: false, error: `纸 ${internalId} 不存在于区「${zone}」（先 list 取最新清单）` }
      if (s.timeBranchId) {
        return { ok: false, error: `纸 ${internalId} 已向时间下级延续并锁定（只读）——只能回读，承接请选可写尾端或 create 新纸` }
      }
      if (childIdsOf(zone).has(internalId)) {
        return { ok: false, error: `纸 ${internalId} 已被继承压缩（有子纸承接）——冻结底稿只供回读，继续写请承接最新后继或 create 新纸` }
      }
      if (!store.setActive(owner, internalId)) return { ok: false, error: `落点设置失败：纸 ${internalId} 校验未通过` }
      return { ok: true }
    },

    active: (zone) => storeOf(zone).getActive(owner),

    async append(zone, content, internalId) {
      const store = storeOf(zone)
      const target = internalId ?? store.getActive(owner)
      if (!target) return { ok: false, error: `区「${zone}」当前无落点——先 create 开一张纸或 select 选一张（本工具不隐式建纸）` }
      const s = store.list(owner).find((x) => x.id === target)
      if (!s) return { ok: false, error: `纸 ${target} 不存在于区「${zone}」（先 list 取最新清单）` }
      // 与 select 同规则：冻结/锁定底稿不可写（否则会破坏「冻结历史自述」的语义）
      if (s.timeBranchId || childIdsOf(zone).has(target)) {
        return { ok: false, error: `纸 ${target} 已锁定（被继承压缩或已向时间下级延续）——只供回读；请 create 新纸继续写` }
      }
      const now = Date.now()
      await store.appendMessage(owner, target, {
        id: `m_${now}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'note',
        content,
        createdAt: now
      })
      return { ok: true, internalId: target }
    },

    discard(zone, internalId) {
      const store = storeOf(zone)
      if (!store.list(owner).some((x) => x.id === internalId)) {
        return { ok: false, error: `纸 ${internalId} 不存在于区「${zone}」` }
      }
      store.delete(owner, internalId)
      return { ok: true }
    }
  }
}

// ===== 房间轮专属工具（由组合根注入 provider，无头链路按 purpose 取用）=====

/**
 * 取「该用途 / 该 AI 的房间专属工具执行器」。
 * 无头链路在 `purpose === 'room'` 时把它们**追加**到前端工具集之后——
 * 因此 `room_note` **不会**出现在普通对话的工具清单里（普通对话拿到空数组）。
 */
export type RoomZoneToolProvider = (purpose: string | undefined, aiId?: number) => ToolExecutor[]

let zoneToolProvider: RoomZoneToolProvider | null = null

export function setRoomZoneToolProvider(fn: RoomZoneToolProvider | null): void {
  zoneToolProvider = fn
}

export function getRoomExtraToolExecutors(purpose: string | undefined, aiId?: number): ToolExecutor[] {
  if (purpose !== 'room') return []
  try {
    return zoneToolProvider?.(purpose, aiId) ?? []
  } catch (err) {
    // 工具面取不到不该打崩本轮（但也绝不装作没发生）
    console.error('[room] 区工具装配失败:', (err as Error).message)
    return []
  }
}

/** `room_note` 的工具说明（AI 面向文本，按 CODE-RULES §五：说清「什么时候用」） */
const ROOM_NOTE_DESCRIPTION = `在「区」上读写你自己用的纸。区不是会话，是你写给自己看的一叠纸（执行器区 = 你要做的事 / 采集器区 = 你看到的东西 / 设备区 = 你摸过的设备），有连续性、不会丢，可以随时回读旧纸。

什么时候用：
- 你需要在两轮之间记住某个结论、待办、观察，而这些不属于对话本身时 —— append 写下来；
- 你要接着上一条思路往下做，但不确定写在哪张纸上时 —— list 看清单（只给索引，很便宜）；
- 你要翻自己以前记过的东西 —— read（可分段，不必一次读完）；
- 这件事告一段落、要换一条线 —— create 开新纸（newTopic=true 表示与之前无关的新话题）。

动作：
- list（zone）：列出该区全部纸的索引（标题/摘要/第几代/是否可写/更新时间/文件绝对路径）+ 当前落点。摘要写清楚了才认得出是哪张纸。
- read（zone, internalId, offset?, limit?）：读某张纸的正文；分页给 offset/limit（省略 = 全读）。已锁定的旧纸也能读（历史可回找）。
- append（zone, content, internalId?）：往纸上追加一行。internalId 省略 = 写当前落点。纸已锁定（被继承压缩或已向时间下级延续）会被拒绝 —— 换 create 开新纸。
- create（zone, title?, summary?, content?, parentId?, newTopic?）：开一张新纸并设为当前落点。newTopic=true = 新话题（空白，不复制父纸内容）；false/省略 = 从某张纸分叉（原样继承它的内容）。summary 是给未来的你看的一句话说明。
- select（zone, internalId）：把某张可写尾端定为当前落点（之后 append 默认写它）。
- discard（zone, internalId）：丢掉一张纸（丢了就回找不到了，谨慎）。

纪律：纸是给你自己用的，不要把用户对话内容整段抄进去；写结论、写状态、写下一步，不要写流水账。`

/** `room_note` 的参数表（转 JSON schema 用；与 `ToolParameter` 同形，此处不引 base-tool 保持零依赖） */
const ROOM_NOTE_PARAMS = [
  { name: 'action', type: 'string', description: 'list / read / append / create / select / discard（必填）', required: true },
  { name: 'zone', type: 'string', description: 'executor（你要做的事）/ collector（你看到的东西）/ device（设备）；省略默认 executor', required: false },
  { name: 'internalId', type: 'string', description: 'read / append / select / discard 时的目标纸 id（append 省略 = 写当前落点）', required: false },
  { name: 'content', type: 'string', description: 'append 必填：要写下的一行；create 可选：新纸的第一行', required: false },
  { name: 'title', type: 'string', description: 'create 可选：新纸标题（3-8 字）', required: false },
  { name: 'summary', type: 'string', description: 'create 可选：新纸的摘要（一句话说明这张纸干什么，将来靠它认出来）', required: false },
  { name: 'parentId', type: 'string', description: 'create 可选：从哪张纸分叉（须为可写尾端）；省略则建独立新纸', required: false },
  { name: 'newTopic', type: 'boolean', description: 'create 可选：true = 新话题（空白承接，不复制父纸内容）', required: false },
  { name: 'offset', type: 'number', description: 'read 可选：从第几条开始（0 起）', required: false },
  { name: 'limit', type: 'number', description: 'read 可选：最多读几条（省略 = 全读）', required: false }
]

/** 参数表 → JSON schema（与 `api/tool-bridge.ts` 的 `toolParametersToJsonSchema` 同形） */
function paramsToJsonSchema(params: typeof ROOM_NOTE_PARAMS): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const p of params) {
    properties[p.name] = { type: p.type, description: p.description }
    if (p.required) required.push(p.name)
  }
  return { type: 'object', properties, required }
}

/** 结果统一为 JSON 字符串（与 `toToolExecutor` 的口径一致：AI 读 JSON） */
function ok(data: unknown): string {
  return JSON.stringify({ ok: true, ...(data as object) })
}
function fail(error: string): string {
  return JSON.stringify({ ok: false, error })
}

/**
 * 造 `room_note` 执行器。**每轮按房间现场造**（`trees` 绑定该 AI 的房间主会话），
 * 因此不需要在执行期反查「这是哪个房间」——工具实例本身就是那个房间的。
 */
export function buildRoomNoteExecutor(trees: RoomZoneTrees): ToolExecutor {
  return {
    name: 'room_note',
    description: ROOM_NOTE_DESCRIPTION,
    parameters: paramsToJsonSchema(ROOM_NOTE_PARAMS),
    execute: async (args) => {
      const action = typeof args.action === 'string' ? args.action : ''
      const zoneRaw = args.zone
      const zone: RoomZone = zoneRaw === undefined ? 'executor' : isRoomZone(zoneRaw) ? zoneRaw : 'executor'
      if (zoneRaw !== undefined && !isRoomZone(zoneRaw)) {
        return fail(`未知区「${String(zoneRaw)}」（只有 executor / collector / device）`)
      }
      const internalId = typeof args.internalId === 'string' && args.internalId ? args.internalId : undefined
      switch (action) {
        case 'list': {
          const { papers, activeId } = trees.index(zone)
          return ok({
            zone,
            activeId,
            count: papers.length,
            papers,
            hint: papers.length === 0 ? '该区还没有纸——用 create 开第一张（可带 summary）' : '先读摘要认纸；read 看正文；create 开新纸'
          })
        }
        case 'read': {
          if (!internalId) return fail('read 需要 internalId（先用 list 取清单）')
          const offset = typeof args.offset === 'number' ? args.offset : 0
          const limit = typeof args.limit === 'number' ? args.limit : undefined
          const r = trees.read(zone, internalId, offset, limit)
          if (!r) return fail(`纸 ${internalId} 不存在于区「${zone}」`)
          return ok({ zone, paper: r.paper, total: r.total, from: offset, body: r.body })
        }
        case 'create': {
          const r = trees.create(zone, {
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(typeof args.summary === 'string' ? { summary: args.summary } : {}),
            ...(typeof args.content === 'string' ? { content: args.content } : {}),
            ...(typeof args.parentId === 'string' && args.parentId ? { parentId: args.parentId } : {}),
            ...(args.newTopic === true ? { newTopic: true } : {})
          })
          return ok({ zone, action: 'create', paper: r, hint: '新纸已设为当前落点，之后 append 默认写它' })
        }
        case 'select': {
          if (!internalId) return fail('select 需要 internalId（先用 list 取清单）')
          const r = trees.select(zone, internalId)
          return r.ok ? ok({ zone, action: 'select', internalId }) : fail(r.error)
        }
        case 'append': {
          const content = typeof args.content === 'string' ? args.content : ''
          if (!content.trim()) return fail('append 需要 content（要写下的内容）')
          const r = await trees.append(zone, content, internalId)
          return r.ok ? ok({ zone, action: 'append', internalId: r.internalId }) : fail(r.error)
        }
        case 'discard': {
          if (!internalId) return fail('discard 需要 internalId（先用 list 取清单）')
          const r = trees.discard(zone, internalId)
          return r.ok ? ok({ zone, action: 'discard', internalId }) : fail(r.error)
        }
        default:
          return fail(`未知 action：${action}（应为 list / read / append / create / select / discard）`)
      }
    }
  }
}
