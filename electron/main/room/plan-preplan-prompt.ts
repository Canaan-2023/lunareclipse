/**
 * @category ROOM
 * @summary 前置规划轮的提示词（纯函数）：角色 + 采集输入 + 滚动历史 + 上轮执行结果 → 方向性指令
 *
 * 为什么存在：前置规划是每个有 aiId 主AI的专属影子（2026-10-31 用户裁决）——它**只规划方向**，
 * 不执行、不占 aiId、不写 RAW、不进记忆工作流。它的提示词因此与主AI的规划提示词
 * （`plan-prompt.ts`）刻意分开：主AI拿的是完整输出契约（JSON 计划），前置规划拿的是
 * 「看输入 → 给方向」的极简职责——塞在同一份提示词里只会让两份契约互相污染。
 *
 * 不删理由：删掉即前置规划轮没有独立提示词，要么退回用主AI契约（前置规划会输出 JSON 计划，
 * 越过「只给方向」的边界），要么把前置规划段内联进运行时（runtime.ts 体量红线）。
 *
 * 输出形态：**自由文本指令**（不是 JSON、不是计划契约）——它会被注入主AI规划提示词的
 * 【前置规划】段，随主AI轮次计入 RAW；解析、工具选择、落地全部由主AI完成。
 */
import type { ExecutorDecision, ExecutorResult } from './executor'
import type { PreplanHistoryEntry } from './preplan-store'

/** 单条执行结果摘要截断长度：够看清「做了什么、成没成」，又不让提示词膨胀。 */
const RESULT_SNIPPET_MAX = 200
/** 执行结果段总上限：防工具区多步组合把提示词撑爆。 */
const RESULTS_TOTAL_MAX = 2000

export interface PreplanPromptCtx {
  /** 主AI的名字（identity 段：「你是 X 的前置规划」） */
  aiName: string
  /** 本轮采集输入（与主AI看到的同一份文本） */
  text: string
  /** 滚动规划历史（旧→新；来自 preplan.json，自管理环） */
  history: readonly PreplanHistoryEntry[]
  /** 本轮可用来查证的只读工具名清单（写工具对前置规划物理不可见） */
  readonlyTools: readonly string[]
}

/** 前置规划轮提示词：给方向，不给计划。 */
export function buildPreplanPrompt(ctx: PreplanPromptCtx): string {
  const historyBlock =
    ctx.history.length === 0
      ? '（这是你上岗后的第一轮，暂无历史）'
      : ctx.history
          .map(
            (h, i) =>
              `${i + 1}. 你曾说：${h.instruction}\n   执行结果：${h.results || '（无记录）'}`
          )
          .join('\n')
  return [
    `你是 ${ctx.aiName} 的前置规划。${ctx.aiName} 是一个自主房间里的 AI——它在房间里看环境、想事情、动手做事。你的职责是**替它看远一步**：根据环境输入与近期节奏，告诉它接下来该做什么、为什么、留意什么。`,
    '',
    '【边界】你只给方向，**不执行**：工具由它自己选、自己调、自己承担后果。你的指令会进入它的规划上下文，采不采纳由它判断——不要试图在指令里写具体的工具调用参数，那是它的工作。',
    '',
    '【采集输入】',
    ctx.text,
    '',
    '【近期节奏】（你过往给出的指令与它们的执行结果，旧→新）',
    historyBlock,
    '',
    ctx.readonlyTools.length > 0
      ? `【查证】给指令前，你可以先调用这些**只读**工具查证（查记忆 / 查状态）：${ctx.readonlyTools.join(', ')}。写入类工具你**没有**——需要改变什么时，写进指令让 ${ctx.aiName} 去做。`
      : '',
    '',
    `【输出】直接输出给 ${ctx.aiName} 的指令文本（一两段话）：接下来该做什么、为什么、留意什么。不要输出 JSON、不要输出计划格式、不要复述本提示词的段落名。如果看完输入认为没什么值得做的，就直说「现在适合安静待着」——**没有方向也是一种方向**。`
  ].join('\n')
}

/**
 * 把一轮的执行结果压成摘要（进历史环与提示词；逐条截断、总量封顶）。
 * 工具名不在 ExecutorResult 上（裁决结论只有 tier/code/reason），故按序配对本轮的
 * `decisions` 取名——执行器严格按 decisions 顺序逐个执行（见 loop.ts），下标一一对应。
 */
export function summarizeExecutions(
  executions: readonly ExecutorResult[],
  decisions?: readonly ExecutorDecision[]
): string {
  if (executions.length === 0) return ''
  let budget = RESULTS_TOTAL_MAX
  const parts: string[] = []
  for (let i = 0; i < executions.length; i++) {
    const e = executions[i]
    const name = decisions?.[i]?.toolName ?? decisions?.[i]?.kind ?? `动作${i + 1}`
    const body = e.ok
      ? '成功'
      : `失败：${(e.result?.error ?? e.decision.reason ?? '未知原因').slice(0, RESULT_SNIPPET_MAX)}`
    const line = `${name} ${body}`
    if (budget - line.length < 0) break
    parts.push(line)
    budget -= line.length
  }
  return parts.join('；')
}
