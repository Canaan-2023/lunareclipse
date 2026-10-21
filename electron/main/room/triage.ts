/**
 * @category ROOM
 * @summary 记忆区「即时 / 长线」分诊（纯函数）
 *
 * 为什么存在：交接单 §7 的记忆区要求「分长线和短线，当前需要是即时还是可以长期分析，
 * 短期的直接做，可以长期的再长思考，**不能所有的都跑长线不看即时性**」。这条规则交接单正文没写全，
 * 由用户原话补记（见 ADR-11 修订条）。抽成纯函数后可单测、可审计。
 *
 * 判定权归属（用户裁决）：**AI 自判**。本模块提供**规则默认值**作为 AI 判断的起点与兜底，
 * 循环允许 AI 覆盖（见 `loop.ts` 的 `triage` 依赖可被替换）。
 *
 * 不删理由：删掉即所有输入都走同一条路径——要么全即时（长任务做不深），要么全长线（即时需求被拖慢）。
 */

export type TriageMode = 'immediate' | 'long-term'

export interface TriageFeatures {
  /** 本次输入的体积（字符）——越大越可能值得长线分析 */
  inputChars: number
  /** 是否含长期意图（分析 / 规划 / 复盘 / 优化 / 总结…） */
  longTermIntent: boolean
  /** 是否含即时意图（现在 / 立刻 / 当前 / 状态 / 怎么样…） */
  immediateIntent: boolean
  /** 最近是否刚做过长线分析（防连续长思考，保护即时性） */
  recentLongTerm: boolean
  /** 是否有未完成的计划（有则倾向推进既有计划） */
  hasOpenPlan: boolean
}

export interface TriageResult {
  mode: TriageMode
  reason: string
}

/** 体积阈值：超过即倾向长线（约 2000 字符 ≈ 一次实质采集/文档输入）。 */
export const LONG_TERM_INPUT_CHARS = 2000

const LONG_TERM_WORDS = ['分析', '规划', '计划', '复盘', '优化', '总结', '研究', '评估', '方案', '长期']
const IMMEDIATE_WORDS = ['现在', '立刻', '马上', '当前', '状态', '怎么样', '查看', '显示', '刚才']

/** 从原始文本提取特征（词表命中即置位）。 */
export function extractTriageFeatures(
  text: string,
  extra: { recentLongTerm?: boolean; hasOpenPlan?: boolean } = {}
): TriageFeatures {
  return {
    inputChars: text.length,
    longTermIntent: LONG_TERM_WORDS.some((w) => text.includes(w)),
    immediateIntent: IMMEDIATE_WORDS.some((w) => text.includes(w)),
    recentLongTerm: extra.recentLongTerm === true,
    hasOpenPlan: extra.hasOpenPlan === true
  }
}

/**
 * 规则默认值。**优先级**（顺序即纪律）：
 * ① 即时意图优先——用户原话「不能所有的都跑长线不看即时性」；
 * ② 刚做过长线 → 本次即时（防连续长思考）；
 * ③ 长期意图 / 大体积 / 有未完成计划 → 长线；
 * ④ 其余 → 即时。
 */
export function suggestMode(f: TriageFeatures): TriageResult {
  if (f.immediateIntent) return { mode: 'immediate', reason: '含即时意图词（即时优先）' }
  if (f.recentLongTerm) return { mode: 'immediate', reason: '刚做过长线分析（防连续长思考）' }
  if (f.longTermIntent) return { mode: 'long-term', reason: '含长期意图词' }
  if (f.inputChars > LONG_TERM_INPUT_CHARS) {
    return { mode: 'long-term', reason: `输入体积 ${f.inputChars} > ${LONG_TERM_INPUT_CHARS}` }
  }
  if (f.hasOpenPlan) return { mode: 'long-term', reason: '有未完成的计划' }
  return { mode: 'immediate', reason: '默认即时（无长线信号）' }
}
