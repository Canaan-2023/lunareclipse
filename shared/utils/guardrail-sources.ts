/**
 * 消息来源分类（shared 纯函数）。
 * 为什么存在：来源枚举与分类逻辑同时被主进程（wire 护栏注入 message-guardrail.ts）与
 *   前端（消息来源徽章展示）消费，放 shared 保证两侧口径一致、无重复定义。
 * 为什么不带 crypto：这里只有纯分类语义（无 HMAC/哈希/签名），护栏包裹与校验的实现
 *   仍在主进程 message-guardrail.ts，前端只读标签与分类结果。
 */

/** 消息来源枚举（固定语义字段，AI 依此解析） */
export type GuardrailSource =
  | 'user'
  | 'ai'
  | 'subagent'
  | 'code-review'
  | 'web-search'
  | 'file-read'
  | 'tool-return'

/** 各来源的中文语义标签（护栏说明段、前端来源徽章共用） */
export const GUARDRAIL_SOURCE_LABEL: Record<GuardrailSource, string> = {
  user: '用户消息',
  ai: 'AI消息',
  subagent: '子AGENT消息',
  'code-review': '代码审查AI消息',
  'web-search': '网页搜索',
  'file-read': '文件读取',
  'tool-return': '工具返回'
}

/** 网页搜索类工具（结果为抓取/检索到的网页信息） */
export const WEB_SEARCH_TOOLS = new Set(['web_search', 'web_extract'])

/** 文件读取类工具（结果为本地文件/目录内容） */
export const FILE_READ_TOOLS = new Set(['Read', 'read_md', 'Grep', 'Glob', 'LS'])

/** 子 agent / 团队类工具（结果为子代理/成员输出） */
export const SUBAGENT_TOOLS = new Set(['Agent', 'team_launch', 'delegate_task'])

/** 按工具名判定工具结果的来源分类 */
export function classifyToolSource(toolName: string): GuardrailSource {
  if (WEB_SEARCH_TOOLS.has(toolName)) return 'web-search'
  if (FILE_READ_TOOLS.has(toolName)) return 'file-read'
  if (SUBAGENT_TOOLS.has(toolName)) return 'subagent'
  return 'tool-return'
}

/** 代码审查轮消息 id 判定（共享口径：wire 护栏分类与前端来源标签共用同一正则，
 * 避免"主进程判 code-review、前端不标审查"或反之的错位）：
 * review_{轮}_{时间戳} / rework_{轮}_{时间戳}（审查轮输出与返工轮输出）。 */
export const REVIEW_MESSAGE_ID_RE = /^(review|rework)_\d+_\d+$/

/** id 是否为代码审查轮消息（assistant 审查回复/返工输出） */
export function isReviewerMessageId(id: unknown): boolean {
  return typeof id === 'string' && REVIEW_MESSAGE_ID_RE.test(id)
}

/** classifyMessageSource 的输入最小结构（主进程传 ChatMessage，前端亦可传） */
export interface MessageSourceLike {
  role: 'user' | 'assistant' | 'system'
  id?: unknown
  activation?: boolean
  content?: unknown
}

/**
 * 按消息属性判定来源。
 * - system → null（注入段不包裹）
 * - user + activation + 【代码审查】前缀 → code-review（审查指令 phaseMsg）
 * - assistant + id 匹配 review_/rework_ 格式 → code-review（审查轮输出）
 * - user → user；assistant → ai
 */
export function classifyMessageSource(m: MessageSourceLike): GuardrailSource | null {
  if (m.role === 'system') return null
  if (m.role === 'user') {
    if (m.activation && typeof m.content === 'string' && m.content.startsWith('【代码审查】')) {
      return 'code-review'
    }
    return 'user'
  }
  if (m.role === 'assistant') {
    if (isReviewerMessageId(m.id)) return 'code-review'
    return 'ai'
  }
  return 'tool-return'
}

/** 是否为合法来源枚举 */
export function isGuardrailSource(s: string): s is GuardrailSource {
  return (
    s === 'user' ||
    s === 'ai' ||
    s === 'subagent' ||
    s === 'code-review' ||
    s === 'web-search' ||
    s === 'file-read' ||
    s === 'tool-return'
  )
}

/**
 * 从消息的行协议/工具调用中收集"活动来源"（子AGENT/网页搜索/文件读取/工具返回）。
 * 为什么存在：消息正文来源（classifyMessageSource 判 role）只覆盖"谁在说话"，
 *   工具活动来源藏在 rows（toolCall/subagent 行）与 toolCalls 列表里——前端来源
 *   徽章用此函数聚合展示，与 wire 层护栏分类口径一致（同一 classifyToolSource）。
 * @param m 消息结构（最小化字段，前端 ChatMessage 直接可用）
 * @returns 去重保序的活动来源枚举；无工具活动时返回空数组
 */
export interface MessageActivityLike {
  rows?: ReadonlyArray<{
    kind?: string
    toolName?: string
    subagentType?: string
  }>
  toolCalls?: ReadonlyArray<{ toolName: string }>
}

export function collectMessageActivitySources(m: MessageActivityLike): GuardrailSource[] {
  const seen = new Set<GuardrailSource>()
  const out: GuardrailSource[] = []
  const push = (s: GuardrailSource) => {
    if (seen.has(s)) return
    seen.add(s)
    out.push(s)
  }
  // 行协议优先（含流式增量与持久化全量）；toolCalls 兜底旧结构/合成行
  if (m.rows && m.rows.length > 0) {
    for (const row of m.rows) {
      if (!row) continue
      if (row.kind === 'subagent') {
        push('subagent')
      } else if (row.kind === 'toolCall' && row.toolName) {
        push(classifyToolSource(row.toolName))
      }
    }
    return out
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    for (const tc of m.toolCalls) {
      if (tc && tc.toolName) push(classifyToolSource(tc.toolName))
    }
  }
  return out
}