/**
 * @category 服务
 * @summary 莉莉丝内部会话状态服务：摘要/游标/缓存索引 + 会话切换检测。
 * companion sessions 文件（%APPDATA%\LilithAI\sessions\*.json）始终是唯一真相源——
 * 本服务不复制消息正文，只维护一份"派生管理状态"（%APPDATA%\LilithAI\internal\lilith-internal.json）：
 * - sourceFile：活跃会话文件名指纹，变化（LilithMod 清空/重开会话 → 新哈希文件）即会话切换 → 重置
 * - summary：早期消息的浓缩（cursor 之前），注入时作为摘要锚点
 * - cursor：已并入摘要的消息条数（游标）；同文件清空/收缩（history.length < cursor）→ 重置
 * - cacheLocations：固定知识位置（玩家记忆文件 / lore index.json），注入时作为缓存索引锚点
 * 戳：不引入系统级上下文（工作区/工具描述/技能索引不在范围），也不新增配置项（默认启用）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { createHash } from 'crypto'
import { formatSessionTime, parseLooseJson, truncate, type LightChat } from './session-utils'
// 莉莉丝摘要提示词统一集中管理（prompts/internal-session.ts），本文件只保留管理状态逻辑
import { LILITH_UPDATE_SYSTEM_PROMPT } from '../prompts/internal-session'

/** 注入保留的原文条数（与 server.ts generateLilithReply 现状一致：最近 20 条原文直映） */
export const LILITH_RECENT_KEEP = 20

/** 莉莉丝摘要最大字符（与月蚀 sessionSummary.summaryMaxChars=200 对齐） */
export const LILITH_SUMMARY_MAX_CHARS = 200

/** 增量段输入侧截断（莉莉丝场景：游戏侧可能直接写入多轮，跨会话间隙累计） */
const LILITH_UPDATE_SEGMENT_MAX_CHARS = 4000

/** 独立状态文件根（companion sessions 之上的派生管理层，不与游戏侧共享） */
const LILITH_INTERNAL_DIR = join(process.env.APPDATA || '', 'LilithAI', 'internal')
let lilithInternalFile = join(LILITH_INTERNAL_DIR, 'lilith-internal.json')

/**
 * 测试注入：替换状态文件路径（隔离真实用户 APPDATA）。
 * 仅测试使用；传 unset 恢复默认。
 */
export function __setLilithInternalStateFileForTest(file?: string): void {
  lilithInternalFile = file ?? join(LILITH_INTERNAL_DIR, 'lilith-internal.json')
}

/** 莉莉丝内部会话派生状态（不复制消息正文；消息永远从 companion sessions 读取） */
export interface LilithInternalState {
  /** 活跃会话文件名指纹（basename，如 xxx.json / none.json）；变化 = 会话切换 */
  sourceFile: string
  /** 会话摘要（空 = 未生成；历史仍在原文窗口内时保持空 → 注入零回归） */
  summary: string
  /** 已并入摘要的消息条数（游标） */
  cursor: number
  /** 固定知识位置（玩家记忆 / lore 索引等长期可复用文件） */
  cacheLocations: string[]
  /** 会话标题（由摘要维护附带：generateLilithSummaryUpdate 可选输出 title 时更新；首次摘要未给出则保持空 → 锚点兜底默认名） */
  title: string
  createdAt: number
  updatedAt: number
}

/** 全新（空）状态：绑定当前活跃会话指纹 */
export function emptyLilithInternalState(sourceFile: string): LilithInternalState {
  const now = Date.now()
  return {
    sourceFile,
    summary: '',
    cursor: 0,
    cacheLocations: [],
    title: '',
    createdAt: now,
    updatedAt: now
  }
}

/** 活跃会话文件名指纹（basename，防路径分隔符/上级目录越界进入状态文件） */
export function lilithSourceFingerprint(activeFile: string): string {
  return basename(activeFile)
}

/** 只读状态文件（容错：缺失/损坏 → null，由 resolve 决定新建/重置） */
export function readLilithInternalState(): LilithInternalState | null {
  try {
    if (!existsSync(lilithInternalFile)) return null
    const parsed = JSON.parse(readFileSync(lilithInternalFile, 'utf8').replace(/^\uFEFF/, '')) as Partial<LilithInternalState> | null
    if (!parsed || typeof parsed !== 'object') return null
    return {
      sourceFile: typeof parsed.sourceFile === 'string' ? parsed.sourceFile : '',
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      cursor: typeof parsed.cursor === 'number' && Number.isFinite(parsed.cursor) ? Math.max(0, parsed.cursor) : 0,
      cacheLocations: Array.isArray(parsed.cacheLocations)
        ? parsed.cacheLocations.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [],
      title: typeof parsed.title === 'string' ? parsed.title : '',
      createdAt: typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : Date.now()
    }
  } catch {
    return null
  }
}

/** 内部状态串行写链（原子 .tmp + rename；与 companion sessions 同风格防并发交错） */
let lilithInternalWriteChain: Promise<void> = Promise.resolve()

/** 原子写盘（失败吞错并日志——状态是派生层，丢失不影响真相源与对话主链路） */
export function writeLilithInternalState(state: LilithInternalState): Promise<void> {
  const task = lilithInternalWriteChain.then(() => {
    try {
      mkdirSync(join(lilithInternalFile, '..'), { recursive: true })
      const tmp = `${lilithInternalFile}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
      renameSync(tmp, lilithInternalFile)
    } catch (err) {
      console.error('[lilith] 内部会话状态写入失败:', (err as Error).message)
    }
  })
  lilithInternalWriteChain = task
  return task
}

/**
 * 解析当前内部会话状态并做会话切换检测：
 * - 状态缺失 → 新建空状态（绑定当前指纹）
 * - sourceFile 与当前活跃指纹不符 → 会话已切换 → 重置为新空状态
 * switched=true 时调用方应跳过增量摘要（新会话没有可维护的历史）。
 */
export function resolveLilithInternalState(
  activeFile: string
): { state: LilithInternalState; switched: boolean } {
  const fingerprint = lilithSourceFingerprint(activeFile)
  const existing = readLilithInternalState()
  if (!existing || existing.sourceFile !== fingerprint) {
    return { state: emptyLilithInternalState(fingerprint), switched: true }
  }
  return { state: existing, switched: false }
}

/** 去重并入缓存位置（内存修改；返回是否有新增） */
export function addLilithCacheLocation(state: LilithInternalState, location: string): boolean {
  if (!location || state.cacheLocations.includes(location)) return false
  state.cacheLocations.push(location)
  return true
}

/**
 * 莉莉丝增量摘要（适配版）：
 * 输入 = 游标后的新增消息段（可能跨多轮：游戏侧直写 / 重启后累计），输出 = 新摘要 + 可选新标题；
 * 失败（LLM 调用/解析/校验任一失败）→ null = 本次未执行，旧摘要保持（与 session-summarizer 同契约）。
 */
export interface LilithSummaryUpdateInput {
  /** 游标之前已生成的摘要（空 = 首次整体摘要） */
  oldSummary: string
  /** 游标之后的新增消息段（跨多轮） */
  segment: Array<{ role: string; content: string }>
  /** 会话创建时间（摘要建立信息用） */
  createdAt: number
}

/** 莉莉丝增量摘要结果（与月蚀 InheritancePlan 同构：summary 必填、title 可选，缺省沿用原标题） */
export interface LilithSummaryUpdateResult {
  summary: string
  title?: string
}

export async function generateLilithSummaryUpdate(
  chat: LightChat,
  input: LilithSummaryUpdateInput,
  cfg: { summaryMaxChars?: number } = {},
  model?: string
): Promise<LilithSummaryUpdateResult | null> {
  const summaryMaxChars = cfg.summaryMaxChars ?? LILITH_SUMMARY_MAX_CHARS
  const segText = input.segment
    .map((m) => `${m.role === 'user' ? '玩家' : '莉莉丝'}：${m.content}`)
    .join('\n')
  const userContent = `【会话创建时间】${formatSessionTime(input.createdAt)}
【旧摘要】${input.oldSummary?.trim() ? truncate(input.oldSummary, summaryMaxChars) : '（无）'}
【新增对话】
${truncate(segText || '（无）', LILITH_UPDATE_SEGMENT_MAX_CHARS)}

输出 JSON：`
  let raw: string
  try {
    raw = await chat(
      [
        { role: 'system', content: LILITH_UPDATE_SYSTEM_PROMPT(summaryMaxChars) },
        { role: 'user', content: userContent }
      ],
      model
    )
  } catch {
    return null
  }
  const parsed = parseLooseJson<{ summary?: unknown; title?: unknown }>(raw)
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null
  if (parsed.title !== undefined && typeof parsed.title !== 'string') return null
  const result: LilithSummaryUpdateResult = { summary: parsed.summary.trim().slice(0, summaryMaxChars) }
  if (parsed.title !== undefined && parsed.title.trim()) result.title = parsed.title.trim().slice(0, 30)
  return result
}

/** 摘要锚点（有摘要时才有；无摘要返回 null → 注入段省略，短会话原文零回归） */
export function buildLilithSummaryAnchor(
  state: LilithInternalState
): { role: 'system'; content: string } | null {
  if (!state.summary?.trim()) return null
  return {
    role: 'system',
    content: `【内部会话】莉莉丝与玩家（摘要）\n标题：${state.title?.trim() || '莉莉丝与玩家'}\n创建于 ${formatSessionTime(state.createdAt)}，更新于 ${formatSessionTime(state.updatedAt)}\n【会话摘要】${state.summary}`
  }
}

/** 缓存索引锚点（有缓存位置时才有；无 → null 省略） */
export function buildLilithCacheIndexAnchor(
  state: LilithInternalState
): { role: 'system'; content: string } | null {
  if (!state.cacheLocations?.length) return null
  return {
    role: 'system',
    content: `【记忆缓存位置】\n${state.cacheLocations.join('\n')}`
  }
}

/**
 * 回复写回后异步维护：
 * 1) 会话切换（指纹变化）→ 写空状态绑定新指纹
 * 2) 同文件清空/收缩（history.length < cursor）→ 重置摘要/游标/缓存（= 新开始）
 * 3) 历史仍在原文窗口内（≤ RECENT_KEEP 且无旧摘要）→ 跳过，不推进游标（保持零回归）
 * 4) 否则：游标后段增量摘要 → 成功则推进游标并写盘；失败保持旧摘要/旧游标
 * pendingCacheLocations：本轮工具命中的固定知识位置（注入时并入内存 state，维护时统一落盘）。
 */
export async function maintainLilithInternalSession(opts: {
  chat: LightChat
  activeFile: string
  history: Array<{ role: string; content: string }>
  pendingCacheLocations?: string[]
  summaryMaxChars?: number
  model?: string
}): Promise<LilithInternalState> {
  const {
    chat,
    activeFile,
    history,
    pendingCacheLocations = [],
    summaryMaxChars,
    model
  } = opts

  // 1) 会话切换检测：指纹不符（或状态缺失）→ 新空状态（绑定当前指纹）。
  // 注意：不在此早退——新会话若已超窗口（游戏侧先聊了很多条），首次维护也应顺势生成摘要。
  const { state, switched } = resolveLilithInternalState(activeFile)

  // 2) 同文件清空/收缩（LilithMod 同 session_id 内清空重写）→ 重置派生状态
  if (history.length === 0 || history.length < state.cursor) {
    const reset: LilithInternalState = {
      ...emptyLilithInternalState(state.sourceFile),
      createdAt: state.createdAt, // 文件未换：创建时间保留（fingerprint 未变）
      updatedAt: Date.now()
    }
    await writeLilithInternalState(reset)
    return reset
  }

  // 游标后无新增 → 仅确保 pendingCache / 新会话绑定落盘
  const segment = history.slice(state.cursor)
  if (segment.length === 0) {
    for (const loc of pendingCacheLocations) addLilithCacheLocation(state, loc)
    if (switched || pendingCacheLocations.length > 0) await writeLilithInternalState(state)
    return state
  }

  // 3) 历史仍在原文窗口内且无旧摘要 → 跳过（注入走原文，零回归；不推进游标）
  if (!state.summary && history.length <= LILITH_RECENT_KEEP) {
    for (const loc of pendingCacheLocations) addLilithCacheLocation(state, loc)
    if (switched || pendingCacheLocations.length > 0) await writeLilithInternalState(state)
    return state
  }

  // 4) 增量/首整体摘要（新增对话 = 游标后全段）
  const newSummary = await generateLilithSummaryUpdate(
    chat,
    { oldSummary: state.summary, segment, createdAt: state.createdAt },
    { summaryMaxChars },
    model
  )
  if (newSummary === null) {
    // 摘要失败：保持旧摘要/旧游标；仅落盘缓存（内存已并入）与新会话绑定
    for (const loc of pendingCacheLocations) addLilithCacheLocation(state, loc)
    await writeLilithInternalState(state)
    return state
  }
  state.summary = newSummary.summary
  // title 为可选输出：模型未给出 / 空串时沿用原标题（首次摘要且未给出时保持空 → 锚点兜底默认名）
  if (newSummary.title?.trim()) state.title = newSummary.title.trim()
  state.cursor = history.length
  state.updatedAt = Date.now()
  for (const loc of pendingCacheLocations) addLilithCacheLocation(state, loc)
  await writeLilithInternalState(state)
  return state
}

/** 玩家记忆文件路径（与 bundled/lilith tools.js 同源算法，供缓存索引标注位置） */
export function lilithPlayerMemoryPath(appDataDir: string, playerName: string): string {
  const hash = createHash('sha256').update(playerName, 'utf8').digest('hex')
  return join(appDataDir, 'LilithAI', 'players', `${hash}.json`)
}

/** lore 索引路径（与 bundled/lilith tools.js 同源：{dataRoot}/frontend/character/lore/index.json） */
export function lilithLoreIndexPath(dataRoot: string): string {
  return join(dataRoot, 'frontend', 'character', 'lore', 'index.json')
}