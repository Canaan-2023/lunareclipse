/**
 * @category ROOM
 * @summary 自主循环的「规划」解析（纯函数）：AI 回复文本 → 结构化决策列表
 *
 * 为什么存在：ROOM 的规划由 AI 产出（`getHeadlessChatRunner` 跑完整月蚀链路后返回文本），
 * 但执行器要的是**结构化决策**。这层转换必须严格且可测——否则 AI 一句自然语言就可能被误解成动作。
 *
 * 不删理由：删掉即「文本 → 动作」的转换散进循环，既不可测也无法做工具白名单过滤。
 *
 * 安全口径（§0）：**工具白名单过滤**——计划里的动作必须落在调用方给的允许集合内，
 * 不在集合内的动作被丢弃并记入 `dropped`（不抛错，循环继续）。这让「AI 想调一个不该调的工具」
 * 变成「该动作不执行」而不是「整个循环崩掉」。
 */
import type { ExecutorDecision } from './executor'

export interface ParsedPlan {
  decisions: ExecutorDecision[]
  /** 计划说明（AI 自述） */
  note?: string
  /** 被丢弃的动作说明（不在工具白名单 / 形状非法） */
  dropped: string[]
  /** 解析失败原因（无 JSON / JSON 非法） */
  parseError?: string
  /** AI 声明的待机时长（毫秒，已夹到 ≤24h）：期间采集器不返回 */
  standbyMs?: number
  /**
   * AI 重画自身像素形象/房间的规格（P3，可选）。**原样透传**——
   * 校验在应用点（`AvatarStore` 入口 + `validateAvatarSpec`）做，解析层不做像素语义判断。
   */
  avatar?: unknown
  /**
   * AI 声明的**采集视图**（P-BC，可选）：决定「采集什么」（scope × 字段白名单）。
   * 同样**原样透传**——校验在应用点（`validateCollectorView`）。
   */
  collectorView?: unknown
}

interface RawDecision {
  tool?: unknown
  params?: unknown
  description?: unknown
  fromToolZone?: unknown
}

/** 从文本中抽出第一个 JSON 对象：优先 ```json 代码块，其次第一个平衡的 `{...}`。 */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const start = text.indexOf('{')
  if (start >= 0) {
    let depth = 0
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  for (const c of candidates) {
    try {
      JSON.parse(c)
      return c
    } catch {
      /* 试下一个候选 */
    }
  }
  return null
}

/**
 * 解析 AI 的规划文本。期望形状：
 * `{ "decisions": [{ "tool": "read", "params": {...}, "description": "..." }], "note": "..." }`
 * 兼容 `actions` 作为 `decisions` 的别名。
 *
 * **不解析 `readOnly`（P0-2）**：只读性由工具注册表元数据判定（见 `./tool-risk`），
 * AI 自述的 `readOnly` 一律丢弃——否则高风险动作可自报只读以走 T2 免授予。
 */
export function parsePlan(text: string, allowedTools: readonly string[]): ParsedPlan {
  const json = extractJsonObject(text)
  if (!json) return { decisions: [], dropped: [], parseError: '未找到 JSON 计划块' }

  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    return { decisions: [], dropped: [], parseError: `JSON 解析失败：${(err as Error).message}` }
  }

  const obj = (raw ?? {}) as {
    decisions?: unknown
    actions?: unknown
    note?: unknown
    standbyMs?: unknown
    avatar?: unknown
    collectorView?: unknown
  }
  const list = Array.isArray(obj.decisions) ? obj.decisions : Array.isArray(obj.actions) ? obj.actions : []
  const allowed = new Set(allowedTools)
  const decisions: ExecutorDecision[] = []
  const dropped: string[] = []

  for (const item of list) {
    const d = (item ?? {}) as RawDecision
    const tool = typeof d.tool === 'string' ? d.tool.trim() : ''
    if (!tool) {
      dropped.push('缺少 tool 字段')
      continue
    }
    if (!allowed.has(tool)) {
      dropped.push(`工具「${tool}」不在允许集合内`)
      continue
    }
    decisions.push({
      kind: 'tool',
      toolName: tool,
      params: (d.params && typeof d.params === 'object' ? d.params : {}) as Record<string, unknown>,
      fromToolZone: d.fromToolZone === true,
      description: typeof d.description === 'string' && d.description ? d.description : `调用工具 ${tool}`
    })
  }

  return {
    decisions,
    dropped,
    ...(typeof obj.note === 'string' && obj.note ? { note: obj.note } : {}),
    // AI 主动声明待机（毫秒）：期间采集器不返回（感官闭眼），到期回到空闲并重新激活。
    // 只接受正有限数，上限 24h（防 AI 写出天文数字把房间永久睡死）。
    ...(typeof obj.standbyMs === 'number' && Number.isFinite(obj.standbyMs) && obj.standbyMs > 0
      ? { standbyMs: Math.min(obj.standbyMs, 24 * 3600_000) }
      : {}),
    // AI 重画自己的像素形象（P3）：原样透传，应用点（runtime → AvatarStore）负责校验 + 门控
    ...(obj.avatar !== undefined ? { avatar: obj.avatar } : {}),
    // AI 决定采集什么（诉求 10）：原样透传，应用点（runtime → validateCollectorView）负责校验
    ...(obj.collectorView !== undefined ? { collectorView: obj.collectorView } : {})
  }
}
