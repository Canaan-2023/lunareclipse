/**
 * 为什么存在：内部会话无限增长会撑爆上下文预算，需持续把每轮新内容增量压缩为值得长期保留的要点。
 * 作用：给定旧摘要与本轮内容，增量产出新摘要（含字符预算限制，只留主题/结论/决策等长期价值）。
 */

import type {
  InternalSession,
  SessionSummaryConfig
} from '@shared/types'
import { formatSessionTime, parseLooseJson, truncate, type LightChat } from './session-utils'
// 内部会话摘要提示词统一集中管理（prompts/internal-session.ts），本文件只保留摘要维护逻辑
import { UPDATE_SYSTEM_PROMPT, INHERITANCE_SYSTEM_PROMPT } from '../prompts/internal-session'

/**
 * 双层会话摘要维护服务（AI 自维护）：常态增量 + 超限继承（0.17 起取代旧「超限压缩」——
 * 旧方案 generateConsolidation 原地删消息+覆盖摘要，原始数据丢失；新方案原会话不动，
 * AI 再加工生成继承摘要，新建子会话承接，原始数据保留供回翻）。
 * 失败语义（无兜底契约）：LLM 调用/解析/校验任一失败 → 返回 null = 本次摘要未执行，旧摘要保持。
 */

/** 常态增量：最近一轮对话 → 把旧摘要更新为最新（输入侧截断，输出按 cfg.summaryMaxChars 截断） */
export interface SummaryUpdateInput {
  oldSummary: string
  userContent: string
  assistantContent: string
  toolSummaries: string[]
  createdAt: number
}

/** 输入侧截断（防止单次轻量调用输入过长；常量） */
const UPDATE_USER_MAX_CHARS = 2000
const UPDATE_AI_MAX_CHARS = 2000
const UPDATE_TOOL_MAX_CHARS = 160

export async function generateSummaryUpdate(
  chat: LightChat,
  input: SummaryUpdateInput,
  cfg: SessionSummaryConfig,
  model?: string
): Promise<string | null> {
  const userContent = `【会话创建时间】${formatSessionTime(input.createdAt)}
【旧摘要】${input.oldSummary?.trim() ? truncate(input.oldSummary, cfg.summaryMaxChars) : '（无）'}
【本轮用户输入】${truncate(input.userContent || '', UPDATE_USER_MAX_CHARS)}
${input.toolSummaries?.length ? `【本轮工具调用】${truncate(input.toolSummaries.join(' | '), UPDATE_TOOL_MAX_CHARS)}\n` : ''}【AI 主回复】${truncate(input.assistantContent || '', UPDATE_AI_MAX_CHARS)}

输出 JSON：`
  let raw: string
  try {
    raw = await chat(
      [
        { role: 'system', content: UPDATE_SYSTEM_PROMPT(cfg.summaryMaxChars) },
        { role: 'user', content: userContent }
      ],
      model
    )
  } catch {
    return null
  }
  const parsed = parseLooseJson<{ summary?: unknown }>(raw)
  if (!parsed || typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null
  return parsed.summary.trim().slice(0, cfg.summaryMaxChars)
}

/** 超限继承：会话 totalChars > summaryBudgetChars 时触发；body 全量上送不截断，取舍交给 AI。
 * ⚠️ 与旧「原地压缩」不同：本函数只产出继承摘要（AI 再加工旧会话全量信息，
 * 让未来会话直接理解该会话关于什么内容），【不输出 keepIds、不删任何消息】——
 * 原会话完整保留供 AI 按 id 回翻，新会话以继承摘要单独建档（继承方案核心约束：
 * 摘要只做「未来会话的索引」，原文永远是回溯底稿，故不删不覆盖）。 */
export interface InheritanceInput {
  internal: InternalSession
  // 无需额外字段：内部会话自带 summary/cacheLocations/messages/createdAt
}

/** AI 继承摘要输出（原样契约；create 时机械落位） */
export interface InheritancePlan {
  /** 继承摘要：写入子会话 summary，作为新会话的初始化上下文锚点 */
  summary: string
  /** 需要更新会话名时给出（可选；缺省沿用父会话标题） */
  title?: string
  /** 继承给子会话的记忆缓存位置（可选；缺省沿用父会话 cacheLocations） */
  cacheLocations?: string[]
}

/** 超限继承：LLM 生成继承摘要；失败返回 null = 本次继承未执行（原会话保持，下次维护再试） */
export async function generateInheritanceSummary(
  chat: LightChat,
  input: InheritanceInput,
  model?: string
): Promise<InheritancePlan | null> {
  const { internal } = input
  const messageList = internal.messages
    .map((m, i) => `【id:${m.id}】【${i + 1}/${internal.messages.length}】【${m.role}】${m.content}`)
    .join('\n')
  const userContent = `【会话创建时间】${formatSessionTime(internal.createdAt)}
【会话名】${internal.title || '（无）'}
【旧摘要】${internal.summary || '（无）'}
【记忆缓存位置】${internal.cacheLocations?.length ? internal.cacheLocations.join('\n') : '（无）'}

【消息全文（阅读后提炼，不要原样抄写）】：
${messageList}

输出 JSON：`
  let raw: string
  try {
    raw = await chat(
      [
        { role: 'system', content: INHERITANCE_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      model
    )
  } catch {
    return null
  }
  const parsed = parseLooseJson<{ summary?: unknown; title?: unknown; cacheLocations?: unknown }>(raw)
  if (!parsed || typeof parsed !== 'object') return null
  // summary 缺失/非串 = 本次继承作废（无摘要则子会话无锚点，宁可不继承）
  if (typeof parsed.summary !== 'string' || !parsed.summary.trim()) return null
  if (parsed.title !== undefined && typeof parsed.title !== 'string') return null
  if (parsed.cacheLocations !== undefined && !Array.isArray(parsed.cacheLocations)) return null
  const plan: InheritancePlan = { summary: parsed.summary.trim() }
  if (typeof parsed.title === 'string' && parsed.title.trim()) plan.title = parsed.title.trim().slice(0, 30)
  if (Array.isArray(parsed.cacheLocations)) {
    const locs = parsed.cacheLocations.filter((c): c is string => typeof c === 'string' && c.length > 0)
    if (locs.length > 0) plan.cacheLocations = locs
  }
  return plan
}