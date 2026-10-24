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
import { parseRoomScene, type RoomSceneDirective } from '@shared/room/room-scene'

export interface ParsedPlan {
  decisions: ExecutorDecision[]
  /** 计划说明（AI 自述） */
  note?: string
  /** 被丢弃的动作说明（不在工具白名单 / 形状非法） */
  dropped: string[]
  /** 解析失败原因（无 JSON / JSON 非法） */
  parseError?: string
  /**
   * AI 声明的待机时长（毫秒）：期间不主动做事；到期回到空闲并重新激活。
   * **没有产品上限**（用户 2026-10-20 裁决「待机时间应该是 AI 自己配置」）：
   * 只要求正有限数；运行时用分片定时绕过 JS `setTimeout` 的 32 位上限。
   */
  standbyMs?: number
  /**
   * AI 对**重复动作**的自决（用户 2026-10-20 裁决「不是三次这种魔法」）：
   * - 省略：连续提出完全相同动作时转入空闲（不执行重复动作），把控制权交回环境；
   * - `'continue'`：我确认要再做一次（显式同意才执行）；
   * - `'stop'`：主动结束这一段，转入空闲。
   */
  repeat?: 'continue' | 'stop'
  /**
   * AI 对**感知器**的自决（0.53.3）：是否感知 / 屏蔽哪个信号 / 采样间隔 / 变化阈值。
   * 原样透传——校验在 `@shared/room/sensor-policy`，应用在 `runtime.ts`。
   */
  sensor?: unknown
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
  /**
   * AI 主动声明的**落点**（可选，ADR-30）：在**承载会话的逆生树**里承接某个节点
   * 或开一个新节点。形状 `{action:'continue'|'create', internalId?, title?, summary?, newTopic?}`。
   * 同样**原样透传**——校验与应用在 `runtime.ts` → `applyLanding`（复用 `session_select` 的规则）。
   */
  landing?: unknown
  /**
   * AI 对用户/镜头说的一句话（直播字幕）。非空时运行时写入 `lastReply` 并落回会话历史。
   * 与 `note` 分开：`note` 是计划说明（可观测），`reply` 是给用户看的话。
   */
  reply?: string
  /**
   * AI 直接声明的房间动作（直播里「我在哪 / 做什么」）。形状
   * `{zone:'home'|'plan'|'work'|'memory'|'device'|'lan', action:'walk'|'observe'|'work'|'read'|'think'|'rest', say?:string}`。
   * 解析层做闭集校验；渲染侧只认这里的结果。
   */
  scene?: RoomSceneDirective
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
    repeat?: unknown
    sensor?: unknown
    avatar?: unknown
    collectorView?: unknown
    landing?: unknown
    reply?: unknown
    scene?: unknown
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
    // AI 主动声明待机（毫秒）：期间不主动做事，到期回到空闲并重新激活。
    // **不夹产品上限**（AI 自己配置）；只接受正有限数。运行时负责分片定时。
    ...(typeof obj.standbyMs === 'number' && Number.isFinite(obj.standbyMs) && obj.standbyMs > 0
      ? { standbyMs: Math.floor(obj.standbyMs) }
      : {}),
    // AI 对重复动作的自决：只认 continue / stop；其余值丢弃（回落默认「重复即停」）
    ...(obj.repeat === 'continue' || obj.repeat === 'stop' ? { repeat: obj.repeat } : {}),
    // AI 对感知器的自决：原样透传，应用点（runtime）负责校验 + 应用
    ...(obj.sensor !== undefined ? { sensor: obj.sensor } : {}),
    // AI 重画自己的像素形象（P3）：原样透传，应用点（runtime → AvatarStore）负责校验 + 门控
    ...(obj.avatar !== undefined ? { avatar: obj.avatar } : {}),
    // AI 决定采集什么（诉求 10）：原样透传，应用点（runtime → validateCollectorView）负责校验
    ...(obj.collectorView !== undefined ? { collectorView: obj.collectorView } : {}),
    // AI 主动落点（ADR-30）：原样透传，应用点（runtime → applyLanding）负责校验与应用
    ...(obj.landing !== undefined ? { landing: obj.landing } : {}),
    // 对用户/镜头说的话（直播字幕）：空白不写；上限 500 字符
    ...(typeof obj.reply === 'string' && obj.reply.trim()
      ? { reply: obj.reply.trim().slice(0, 500) }
      : {}),
    // AI 直接声明房间动作：闭集校验（非法 → 丢弃，不影响 decisions）
    ...(obj.scene !== undefined ? parseSceneField(obj.scene) : {})
  }
}

function parseSceneField(raw: unknown): { scene?: RoomSceneDirective } {
  const scene = parseRoomScene(raw)
  return scene ? { scene } : {}
}
