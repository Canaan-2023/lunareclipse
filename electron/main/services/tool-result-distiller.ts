/**
 * 为什么存在：工具输出可达数十 KB，直接进上下文既超预算又稀释注意力，需 LLM 蒸馏为要点并缓存复用。
 * 作用：按 DistillConfig（阈值/并发/超时/模型）蒸馏长工具输出，缓存摘要，失败时回退原文。
 */

import { createHash } from 'crypto'
import type { ApiMessage, ToolDef } from '../api/llm'
import { DEFAULT_TOOL_RESULT_DISTILL, type ToolResultDistillConfig } from '@shared/types'
// 蒸馏提示词统一集中管理（prompts/distill.ts），本文件只保留蒸馏调度/缓存/限流逻辑
import { DISTILL_SYSTEM_PROMPT } from '../prompts/distill'
// 动态性能优化：'auto' 并发由运行时设备参数（核数/内存/负载）推导，负载高自动收拢
import { resolveDynamicConcurrency } from '../performance/dynamic-pool'

/**
 * 工具结果 LLM 蒸馏层。

 * 解决的问题：工具（搜索/读文件/浏览/局域网三工具）返回的大量信息里通常只有
 * 一小部分有用，原样进上下文会无边际消耗 token。本层在工具结果消息进入上下文前
 * 用 LLM 做二次提取，蒸馏成功则摘要（重包消息来源护栏）直接替换 conversation 中
 * 对应 tool 消息原文；失败重试一次，仍失败保留原文进上下文（不落盘、不截断）。

 * 与既有机制的关系：
 * - 本层只负责「生成蒸馏摘要文本」；替换/重包护栏由上游 llm.ts distillAllToolMessages 完成。
 * - 失败/跳过一律返回 undefined，上游保留原文，不改变原有行为。

 * 递归防护（三重）：
 * 1. 蒸馏调用走 chatWithTools(msgs, [])，tools 恒为空数组，物理上无法触发工具循环；
 * 2. 并发控制走信号量（active + waiters），超并发时排队等待而非静默丢弃；
 * 3. 不走 streamWithTools，不产生 toolMsgIndices，不会再次进入蒸馏流程。
 */

/** 蒸馏所需的最小 LLM 接口：仅用非流式一次性调用 */
export interface DistillLLM {
  chatWithTools(
    messages: ApiMessage[],
    tools: ToolDef[],
    model?: string
  ): Promise<{ content: string | null }>
}

/** 工具结果蒸馏配置（复用 shared ToolResultDistillConfig，不再本地另定义一份同字段接口——
 * 评审：重复定义导致两处类型漂移风险；distiller 与设置页/默认配置共用同一契约） */
export type DistillConfig = ToolResultDistillConfig

/**
 * 蒸馏默认配置（值单源：shared DEFAULT_TOOL_RESULT_DISTILL，见 defaults.ts 的抽取理由注释）。
 * 默认值说明（仅当前代码默认）：minChars=0 表示无体积门槛、
 * onlyListSearchTools=false 表示不限制工具白名单、maxPerTurn=60 表示每分钟上限较宽。
 * 这三个字段保留为配置而非写死：实际运行值以用户配置为准（如只蒸馏大结果/只蒸馏
 * 白名单工具），仅改 defaults 即可回退旧行为，无需改动蒸馏核心逻辑。
 */
export const DEFAULT_DISTILL_CONFIG: DistillConfig = DEFAULT_TOOL_RESULT_DISTILL

/**
 * 白名单：天然「过程多、命中少」的工具。
 * onlyListSearchTools=true 时只蒸馏这些工具。
 */
export const DISTILL_TOOL_WHITELIST: ReadonlySet<string> = new Set([
  'web_search',
  'tool_search',
  'grep',
  'glob',
  'list_dir',
  'read_file',
  'friend_manage',
  'chat_room_manage',
  'publish_board_manage'
])

/** 缓存条目上限（LRU） */
const CACHE_MAX = 500
/** 速率窗口 */
const RATE_WINDOW_MS = 60_000
// 蒸馏结果不设字符上限（2026-10-07 用户要求：蒸馏结果不要有什么限制）：
// 摘要/要点由蒸馏 LLM 按调用背景完整提炼，本层不硬性截断——硬截断会切割语义，
// 与「按对话对而非字数配置」同一原则。仅保留输入侧 maxInputChars 配置保护预算。
/** 截断时头部保留的比例（余下给尾部：头部通常含结论性信息，尾部含错误/结束部分） */
const TRUNCATE_HEAD_RATIO = 0.8
// 注意：意图上下文长度不做字符级魔法数字——由调用方按配置 intentTurnPairs
// （最近 N 对历史 user+assistant 对话）组装，本层只负责接收与复用。

/**
 * 结果内容哈希（工具名 + 调用意图 + 原文），用于同结果不重复蒸馏。
 * 意图纳入指纹：同一工具同一原文在不同任务背景下，有用信息可能不同——
 * 不含意图会在上下文 A 生成摘要后、上下文 B 直接复用，摘要错配；
 * 含意图保证「同工具 + 同原文 + 同意图」才复用，意图不同则重新蒸馏。
 */
function hashResult(toolName: string, resultStr: string, intent: string): string {
  return createHash('sha256').update(`${toolName}\u0000${intent}\u0000${resultStr}`).digest('hex')
}

/** 头 TRUNCATE_HEAD_RATIO + 尾余量截断（尾部常含错误/结束信息，保留一段） */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.floor(max * TRUNCATE_HEAD_RATIO)
  const tail = max - head
  return `${text.slice(0, head)}\n…（中间已截断 ${text.length - max} 字符）…\n${text.slice(-tail)}`
}

/** 摘要文本净化：压平空白（不截断——蒸馏结果不设长度限制） */
function sanitizeMarkerText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 从模型输出中抽取 JSON（容忍 ```json 围栏与前后噪声） */
function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : raw).trim()
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return body.slice(start, end + 1)
}

/** 解析蒸馏输出为摘要文本；失败返回 null（上游保留原文） */
function parseDistillOutput(raw: string): string | null {
  const jsonText = extractJson(raw)
  if (!jsonText) return null
  let obj: { useful?: unknown; summary?: unknown; facts?: unknown }
  try {
    obj = JSON.parse(jsonText) as typeof obj
  } catch {
    return null
  }
  if (obj.useful === false) return '无有用信息'
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  const facts = Array.isArray(obj.facts)
    ? obj.facts
        .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f) => f.trim())
    : []
  const parts = [summary, ...facts].filter((p) => p.length > 0)
  if (parts.length === 0) return null
  return sanitizeMarkerText(parts.join('；'))
}

/** 超时包装：超时返回 null（底层请求由 chatWithTools 自带总超时兜底释放） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

export class ToolResultDistiller {
  /** 结果哈希 → 摘要文本（LRU，Map 插入序即新旧序） */
  private readonly cache = new Map<string, string>()
  /** 当前并发数（信号量：实际执行中的蒸馏调用数，不超过 maxConcurrent） */
  private active = 0
  /** 等待槽位的排队者（信号量队列：并发超限时排队，不静默丢弃） */
  private readonly waiters: Array<() => void> = []
  /** 滚动窗口内的调用时间戳 */
  private readonly callTimes: number[] = []

  constructor(
    private readonly getLlm: () => DistillLLM | null,
    private readonly getCfg: () => DistillConfig
  ) {}

  /**
   * 蒸馏一次工具结果。
   * @param toolName 工具名
   * @param resultStr 工具原始返回
   * @param intent 调用意图上下文（由调用方按 cfg.intentTurnPairs 组装：该工具调用前
   * 完整对话形态，窗口内含调用者思考/工具声明/此前工具消息链，与调取工具的那个 AI
   * 同视角），蒸馏 LLM 以此评估结果相关性；缺省为空串（配置 0 或不传时行为与旧版一致）
   * @returns 提炼后的摘要文本；null 表示不蒸馏/失败（上游应保留原文）
   */
  async distill(toolName: string, resultStr: string, intent = ''): Promise<string | null> {
    const cfg = this.getCfg()
    if (!cfg.enabled) return null
    if (!resultStr) return null
    // 指令型工具豁免蒸馏（2026-10-08）：此类工具（如 use_skill）返回的是行为契约/规范正文
    // 而非过程数据——蒸馏压缩即丢失约束（审查清单、方法论步骤、输出纪律），且 LLM 声明
    // _result_mode:'full' 不可靠（每次调用都要恰好记得写）。此豁免优先于白名单与体积阈值：
    // 名单中的工具结果无条件逐字保留，保证主 AI 后续每一轮都看到完整指令。
    if (cfg.skipTools?.includes(toolName)) return null
    // 白名单过滤（V1 参数化）：cfg.whitelist 显式配置时优先，缺省用内置白名单
    if (cfg.onlyListSearchTools) {
      const whitelist = cfg.whitelist?.length ? new Set(cfg.whitelist) : DISTILL_TOOL_WHITELIST
      if (!whitelist.has(toolName)) return null
    }
    // 体积门槛：0 = 无体积门槛（是否蒸馏由用户配置 minChars 决定，非默认全量蒸馏的硬性约定）
    if (resultStr.length < cfg.minChars) return null
    // 错误结果不蒸馏——错误原文必须完整交给模型（AI 需要看到确切失败原因才能决策）
    // 注意：只跳过「能解析出错误包装」的结果；非 JSON 纯文本结果不在此列，体积达标即正常进入蒸馏。
    let parsed: { ok?: boolean; error?: string } | null = null
    try {
      parsed = JSON.parse(resultStr) as { ok?: boolean; error?: string }
    } catch {
      // 非 JSON 视为无错误包装，继续走正常蒸馏流程
    }
    if (parsed && (parsed.ok === false || parsed.error)) return null

    // 意图参与指纹：意图长度由调用方按「对话对」组装时天然受控（turnPairs × 每对消息），
    // 本层不再做字符截断——按字数硬切会割裂语义，正是「按对话对而非字数配置」要避免的。
    const key = hashResult(toolName, resultStr, intent)
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached

    // 速率上限（先过滤再进队列，避免排队占住限流窗口）
    if (!this.allowByRate(cfg.maxPerTurn)) return null

    await this.acquire(resolveDynamicConcurrency(cfg.maxConcurrent))
    try {
      const summary = await this.callLlm(toolName, resultStr, cfg, intent)
      if (summary) this.remember(key, summary)
      return summary
    } catch {
      return null
    } finally {
      this.release()
    }
  }

  /**
   * 实际发起蒸馏 LLM 调用。
   * @param intent 调用意图上下文（调用方按对话对组装后的完整对话形态快照，含调用者
   * 思考/工具声明/此前工具消息链），注入调用背景让蒸馏器与调用者同视角评估相关性
   */
  private async callLlm(
    toolName: string,
    resultStr: string,
    cfg: DistillConfig,
    intent = ''
  ): Promise<string | null> {
    const llm = this.getLlm()
    if (!llm) return null
    const input = truncateMiddle(resultStr, cfg.maxInputChars)
    const messages: ApiMessage[] = [
      { role: 'system', content: DISTILL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `工具名：${toolName}\n\n${intent ? `调用背景（为什么调用它）：\n${intent}\n\n` : ''}原始返回：\n${input}`
      }
    ]
    // tools 恒为空数组：物理上不可能触发工具循环，杜绝递归蒸馏
    const res = await withTimeout(llm.chatWithTools(messages, [], cfg.model || undefined), cfg.timeoutMs)
    if (!res?.content) return null
    return parseDistillOutput(res.content)
  }

  /** 滚动窗口限流 */
  private allowByRate(maxPerWindow: number): boolean {
    const now = Date.now()
    while (this.callTimes.length > 0 && now - this.callTimes[0] > RATE_WINDOW_MS) {
      this.callTimes.shift()
    }
    if (this.callTimes.length >= maxPerWindow) return false
    this.callTimes.push(now)
    return true
  }

  /** 写入 LRU 缓存 */
  private remember(key: string, summary: string): void {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, summary)
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  /** 获取并发槽位 */
  private async acquire(max: number): Promise<void> {
    if (this.active < max) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    // 槽位由 release 直接转交，此处不再自增
  }

  /** 释放并发槽位（优先转交给排队者） */
  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    this.active = Math.max(0, this.active - 1)
  }
}
