/**
 * 为什么存在：内部会话按主题组织，新输入须判定"续接旧会话还是新建"，否则串扰话题、浪费上下文。
 * 作用：LLM 二分类（continue/create）配合时间/主题辅助规则，输出 internalId/title/reason 供上层执行。
 */

import type { InternalSessionSummary, SessionSummaryConfig } from '@shared/types'
import { formatSessionTime, parseLooseJson, type LightChat } from './session-utils'
import { describePlacement } from './session-placement'
// 内部会话路由/确认提示词统一集中管理（prompts/internal-session.ts），本文件只保留路由逻辑
import { ROUTER_SYSTEM_PROMPT, CONFIRM_SYSTEM_PROMPT } from '../prompts/internal-session'

/** 路由输入：本轮用户输入 + 该用户会话的候选内部会话清单。
 * 候选 = 继承链最新叶子（有子会话的父会话已被调用方过滤，不参与路由——继承链路由语义①）：
 * 继承后老会话冻结保留供回翻，AI 继续对话只进最新叶子。按 updatedAt 降序，由调用方提供。 */
export interface RouteInput {
  userInput: string
  /** 当前时刻（路由提示词与 createdAt 展示用） */
  now: number
  /** 候选内部会话摘要（不传消息正文）；由调用方按 updatedAt 降序传入（最新在前，与 InternalSessionStore.list 一致） */
  candidates: InternalSessionSummary[]
  /** 可选：用户界面会话最近 N 对话对的预览文本（路由前 AI 可见的参考上下文）。
   * 为什么需要：路由 LLM 只看本轮 userInput 难以判断话题连续性与候选的承接关系（用户需求，
   * 2026-10-08）——候选摘要只描述内部会话自身主题，不含用户界面上这轮对话前发生了什么；
   * 带上前文让路由在「续哪个内部会话」上获得与对话历史一致的语境。何时使用：调用方在
   * 未注入内部会话前（routeSession/confirmSessionMatch 阶段）提供，选完后不再出现。 */
  preview?: string
}

/** R 表：路由输出只有 continue / create 二值 + reason（选择阶段）
 * 语义：continue = AI 初步选中某候选会话（进入二次确认，见 confirmSessionMatch）；
 * create = AI 认为无匹配主题，新建。create 可带 parentId——调用方从该可写尾端
 * 分叉出新线：newTopic=true 时新话题空白承接（虚线，不复制任何内容）；
 * newTopic 缺省/false 时原样继承尾端内容（实线，时间/继承延续）。
 * 不带 parentId 时由调用方决定挂接位置（无承接上下文时建独立根）。
 * 全量留存：除空输入外本函数不返回 null——LLM 失败/解析失败/目标不在候选
 * 时回退 create 兜底建档，保证每条输入都落入某个内部会话（寒暄不丢）。 */
export interface SessionRouteResult {
  action: 'continue' | 'create'
  /** action=continue 时必填：目标内部会话 id（必须在候选清单内，否则路由作废） */
  internalId?: string
  /** action=create 时可选：新内部会话标题（AI 用 3-8 字概括） */
  title?: string
  /** action=create 时可选：新会话初始摘要（AI 写的一句话，描述新线干什么；写入 summary 字段供后续选择识别） */
  summary?: string
  /** action=create 时可选：从该可写尾端分叉出新线所挂的 parentId（必须取自候选清单；留空 = 由调用方决定挂接） */
  parentId?: string
  /** action=create 时：true=AI 判定话题新开的新会话（虚线，空白承接不复制）；缺省/false=延续复制（实线） */
  newTopic?: boolean
  /** 一句话路由理由（AI 自述，不回写会话） */
  reason?: string
}

/** 二次确认输入：路由选中的候选会话 + 本轮用户输入（确认阶段用） */
export interface ConfirmMatchInput {
  userInput: string
  /** 选中的候选会话摘要（不传消息正文；确认仅需 title/summary/时间即可裁决） */
  candidate: InternalSessionSummary
  /** 当前时刻（提示词时间基准） */
  now: number
  /** 可选：用户界面会话最近 N 对话对的预览文本（与 RouteInput.preview 同语义，确认阶段同样可见） */
  preview?: string
}

/** 二次确认结果：false = 不注入该会话（调用方需新建） */
export interface ConfirmMatchResult {
  /** true = 确认该会话确实是本输入需要承接的，可注入；false = 无关，不注入 */
  matched: boolean
  /** 确认理由（AI 自述，不回写会话） */
  reason?: string
}

/** 路由/确认前的用户界面会话预览段落（空输入时不渲染整段，避免空行噪音）。
 * 位置语义：放在「用户输入」之后、候选清单之前——路由先看到本轮输入与用户界面上下文，
 * 再对照内部会话候选，符合「以输入与语境选会话」的判定顺序。 */
function renderPreviewBlock(preview: string | undefined): string {
  const text = (preview ?? '').trim()
  if (!text) return ''
  return `\n用户界面最近对话（本轮输入之前的上下文，参考用）：\n${text}\n`
}

/** 路由入口：给一条用户消息选「承接哪个内部会话」或「新建一个内部会话」。
 * 全量留存（0.31 起）：除空输入外【不返回 null】——空候选、LLM 失败/解析失败、
 * continue 目标不在候选（已冻结/锁定/幻觉）都会回退 create 兜底建档，保证每条
 * 输入（含寒暄）都落入某个内部会话。返回 null 仅剩空输入一种情况。 */
export async function routeSession(
  chat: LightChat,
  input: RouteInput,
  cfg: SessionSummaryConfig,
  model?: string
): Promise<SessionRouteResult | null> {
  if (!input.userInput?.trim()) return null
  const candidates = input.candidates.slice(0, cfg.routerMaxSessions)
  if (candidates.length === 0) {
    // 无候选可续：continue 无对象，create 是唯一建档动作。全量留存语义（0.31 起）：
    // 每条用户输入都必须落入某个内部会话（寒暄也不丢），因此本分支【必建档】——
    // LLM 只负责给标题/摘要，输出 continue（寒暄）或解析失败时仍建档兜底（默认标题，
    // 由调用方 createAndActivate 兜底）。不引入字符长度阈值判断寒暄（未经论证的数字
    // = 魔法数字，M6 禁止），寒暄性输入建第一个会话后可被后续轮次 continue 承接。
    const userContent = `当前时间：${formatSessionTime(input.now)}
用户输入：${input.userInput}
${renderPreviewBlock(input.preview)}
暂无内部会话：请为这轮输入新建第一个内部会话（实质内容给 3-8 字标题与简要摘要；
纯寒暄可用「问候」「开场」等概括标题）。输出 JSON：`
    try {
      const raw = await chat(
        [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        model
      )
      const parsed = parseLooseJson<{ title?: unknown; summary?: unknown; reason?: unknown }>(raw)
      return {
        action: 'create',
        ...(parsed && typeof parsed.title === 'string' && parsed.title.trim()
          ? { title: parsed.title.trim().slice(0, 30) }
          : {}),
        ...(parsed && typeof parsed.summary === 'string' && parsed.summary.trim()
          ? { summary: parsed.summary.trim().slice(0, 200) }
          : {}),
        reason:
          parsed && typeof parsed.reason === 'string'
            ? parsed.reason.slice(0, 200)
            : '无现有内部会话，创建首个会话承接本轮输入'
      }
    } catch {
      // 路由 LLM 不可用 → 建档兜底（默认标题），不阻塞主对话；输入仍进入内部会话
      return { action: 'create', reason: '路由不可用，建档兜底承接本轮输入' }
    }
  }
  const candidateList = candidates
    .map((c, i) => {
      // 逆生树三边摆放结构（单源 describePlacement，与锚点注入/session_select 同口径）：
      // 继承轴（向下，第 N 代/继承自父，实线）+ 时间轴（分叉/锁定/同级，实线）+ 新话题
      // （isNewTopic，AI 判定新开，虚线）；时间标记单独
      // 前缀醒目（候选按契约已是可写尾端，时间锁定防御性显示，兼容未来调用方直接喂全量）。
      const placement = describePlacement(c, {
        get: (id) => candidates.find((x) => x.id === id) ?? null,
        listSiblings: () => candidates
      })
      const timeMark = c.timeBranchId ? '[时间线已锁定·只读]' : c.isTimeFork ? '[时间分叉]' : ''
      return `#${i + 1} [${c.id}] ${c.title || '（无标题）'}${timeMark} | ${placement.genLine}${placement.timeLineBlock ? ` | ${placement.timeLineBlock}` : ''} | 创建于 ${formatSessionTime(c.createdAt)} | 更新于 ${formatSessionTime(c.updatedAt)} | ${c.messageCount} 条 / ${c.totalChars} 字符 | ${c.summary || '（无摘要）'}`
    })
    .join('\n')
  const userContent = `当前时间：${formatSessionTime(input.now)}
用户输入：${input.userInput}
${renderPreviewBlock(input.preview)}
内部会话（均为可继续的最新叶子，按最近更新排序；数字 = 第几代，根会话为第 1 代）：
${candidateList}

输出 JSON：`
  let raw: string
  try {
    raw = await chat(
      [
        { role: 'system', content: ROUTER_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      model
    )
  } catch {
    // 路由 LLM 不可用 → 回退 create 兜底建档（继承最近可写尾端承接本轮输入），
    // 全量留存语义：输入不因路由故障而丢失（有候选时由 createAndActivate 自动挂最近尾端）。
    return { action: 'create', reason: '路由不可用，回退建档承接本轮输入' }
  }
  const parsed = parseLooseJson<{ action?: unknown; internalId?: unknown; title?: unknown; summary?: unknown; parentId?: unknown; newTopic?: unknown; reason?: unknown }>(raw)
  if (!parsed || (parsed.action !== 'continue' && parsed.action !== 'create')) {
    // LLM 输出不合法 → 建档兜底（同上：create 由调用方挂最近可写尾端）
    return { action: 'create', reason: '路由输出不合法，回退建档承接本轮输入' }
  }
  const result: SessionRouteResult = {
    action: parsed.action,
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : undefined
  }
  if (parsed.action === 'continue') {
    if (typeof parsed.internalId !== 'string') {
      // continue 缺目标（寒暄归入最近会话）→ 兜底 create（由调用方挂最近可写尾端承接）
      return { action: 'create', reason: 'continue 目标缺失，回退建档承接本轮输入' }
    }
    const hit = candidates.find((c) => c.id === parsed.internalId)
    if (!hit) {
      // 路由目标不在候选清单内（已冻结/已锁定/幻觉）→ 回退 create 兜底，绝不 continue 到非法目标
      return { action: 'create', reason: `continue 目标 ${parsed.internalId} 不在候选，回退建档` }
    }
    result.internalId = hit.id
  } else {
    if (typeof parsed.title === 'string' && parsed.title.trim()) {
      result.title = parsed.title.trim().slice(0, 30)
    }
    // create 可携带初始摘要（AI 写的一句话，写入新会话 summary，供后续选择识别）
    if (typeof parsed.summary === 'string' && parsed.summary.trim()) {
      result.summary = parsed.summary.trim().slice(0, 200)
    }
    // AI 判定话题新开 → newTopic=true（新会话虚线，空白承接，不复制父内容）
    if (parsed.newTopic === true) result.newTopic = true
  }
  // create 的 parentId：必须取自候选清单（候选均为可写尾端），否则忽略回退由调用方决定，
  // 防止把新会话从已冻结/已锁定的父会话分叉（父不合法时复制与挂接都会破坏树语义）。
  if (parsed.action === 'create' && typeof parsed.parentId === 'string' && parsed.parentId.trim()) {
    const hit = candidates.find((c) => c.id === parsed.parentId)
    if (hit) result.parentId = hit.id
  }
  return result
}

/* ============================ 二次确认（选择→确认→注入） ============================ */

/** 二次确认：路由选中候选后，确认该候选是否确实匹配当前输入。
 * 返回 null（LLM 失败/解析失败）时，调用方按「不匹配」处理（新建），
 * 确保不可靠的确认结果不把无关会话注入上下文（fail-closed）。
 * 为什么调用方用 fail-closed 而非 fail-open：误注入错误历史比多建一个空会话危害大得多——
 * 错误历史会污染整个轮次的上下文，而空会话可随时由用户/AI 清理。 */
export async function confirmSessionMatch(
  chat: LightChat,
  input: ConfirmMatchInput,
  model?: string
): Promise<ConfirmMatchResult | null> {
  if (!input.userInput?.trim()) return null
  const c = input.candidate
  const userContent = `当前时间：${formatSessionTime(input.now)}
用户输入：${input.userInput}
${renderPreviewBlock(input.preview)}
被选中的内部会话：
- [${c.id}] ${c.title || '（无标题）'}
- 第 ${c.gen ?? 1} 代${c.parentId ? `（继承自 ${c.parentId}）` : '（根会话）'}
- ${c.timeBranchId ? '时间线已向 ' + c.timeBranchId + ' 延续并被锁定（只读）' : c.isTimeFork ? `时间分叉副本（复制自 ${c.timeSourceId ?? '未知'}）` : '时间线尾端（可继续写入）'}
- 创建于 ${formatSessionTime(c.createdAt)}，更新于 ${formatSessionTime(c.updatedAt)}
- ${c.messageCount} 条消息 / ${c.totalChars} 字符
- 摘要：${c.summary || '（无摘要）'}

确认该会话是否确实承接当前输入（只输出 JSON）：`
  try {
    const raw = await chat(
      [
        { role: 'system', content: CONFIRM_SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      model
    )
    const parsed = parseLooseJson<{ matched?: unknown; reason?: unknown }>(raw)
    if (!parsed || typeof parsed.matched !== 'boolean') return null
    return {
      matched: parsed.matched,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : undefined
    }
  } catch {
    return null
  }
}