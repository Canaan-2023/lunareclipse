/**
 * @category API
 * @summary 工具循环的单次调用态：软超时托管工具白名单 + 护栏状态簇工厂 + 护栏提示注入
 *
 * 为什么存在：软超时托管的判定必须发生在**外墙**（唯一能决定「对话是否等得起」的位置），
 * 而工具本身没有这个视角；护栏状态簇（失败计数/无进展/runaway 计数/warn 去重/halt 标志）
 * 此前以裸局部变量散落在 `llm.ts` 的 `streamWithTools` 方法体里，无类型化契约，
 * 拆出工具循环引擎时无从传递（ADR-03 阶段 2 外移）。
 *
 * 什么作用：导出 `MANAGED_TIMEOUT_TOOLS`（托管白名单）、`TurnGuardrailState`（状态契约）、
 * `createTurnGuardrailState()`（工厂）、`pushGuardrailHint()`（软提示注入，按 code 去重）。
 *
 * 不删理由：白名单是「哪些工具值得后台跑完」的唯一真源；状态契约是工具循环引擎与护栏判定链
 * 之间的唯一接口。删任一项，超时语义退回强杀 / 护栏判定链退化为方法内联裸变量。
 *
 * ⚠️ 状态簇**必须是工厂（每次 `streamWithTools` 调用新建）**，不得改为模块级共享——
 * 否则「单次调用态」会变成「跨调用共享」，属行为变更而非纯搬移（ADR-03 §8 风险 4）。
 */
import type { WireMessage } from '../llm-types'

// ===== 软超时托管：外墙对以下工具的超时语义从「abort 强杀」改为「转后台托管」=====
// 为什么是这些工具：run_command（真实子进程，killTree 兜底可后台跑完）、code_run（代码沙箱）。
// 其余工具（文件读写/查询等）超时多为卡死，无后台价值，保留强杀；web 类工具网络请求
// 超时继续等也无意义（服务端响应已丢，外部不可控），故不托管。
// 判定放在外墙而非工具内部：外墙是唯一能决定「对话是否等得起」的位置，工具无此视角。
export const MANAGED_TIMEOUT_TOOLS = new Set(['run_command', 'code_run'])

/**
 * 单次 `streamWithTools` 调用的护栏状态簇。
 *
 * 语义边界：本对象只在**一次** `runToolLoop` 调用内有效，调用结束即弃；
 * 跨请求持久的是复读基准（`RepetitionBaseline`，属 LLMClient 实例状态），**不在本对象内**。
 *
 * 字段与既有裸局部变量逐一对应（ADR-03 §2.3 耦合点清单）：
 * - `toolFailureCounts`：失败指纹 → 连续失败次数（exact_failure）
 * - `sameToolFailure`：toolName → 连续失败轮数（same_tool_failure，参数可变）
 * - `noProgress`：失败指纹 → { 结果 hash, 重复次数 }（idempotent_no_progress）
 * - `turnWebSearchCount` / `turnSubAgentCount`：本轮 runaway 计数（loop_caps）
 * - `warnInjected`：软提示 code 去重集合（防重复 push 刷上下文）
 * - `haltInjected`：是否已注入过打断指令（防重复注入）
 * - `halted`：本轮是否触发硬 halt（交由收尾轮放行）
 * - `hardHalted`：是否为「收尾轮仍触发循环」的硬切断（日志区分 maxRounds）
 * - `forcedToolRetry`：断点兜底是否已用掉（承诺/编造/runaway 三种补检共用，只续一轮）
 */
export interface TurnGuardrailState {
  toolFailureCounts: Map<string, number>
  sameToolFailure: Map<string, number>
  noProgress: Map<string, { hash: string; count: number }>
  turnWebSearchCount: number
  turnSubAgentCount: number
  warnInjected: Set<string>
  haltInjected: boolean
  halted: boolean
  hardHalted: boolean
  forcedToolRetry: boolean
}

/** 新建状态簇。必须每次调用新建（见文件头警示），不得复用同一对象。 */
export function createTurnGuardrailState(): TurnGuardrailState {
  return {
    toolFailureCounts: new Map(),
    sameToolFailure: new Map(),
    noProgress: new Map(),
    turnWebSearchCount: 0,
    turnSubAgentCount: 0,
    warnInjected: new Set(),
    haltInjected: false,
    halted: false,
    hardHalted: false,
    forcedToolRetry: false
  }
}

/**
 * 注入一条软护栏提示（以 user 角色追加到 wire 会话），按 `code` 去重。
 *
 * 为什么需要 conversation 入参：提示的落点是 wire 数组（`conversation`），而该数组由工具循环
 * 引擎持有；本模块只负责「去重 + 定形」，不持有会话，避免状态簇与会话生命周期纠缠。
 * 与 ADR §3 的 `pushGuardrailHint(state, code, text)` 签名相比多一个 `conversation` 参数——
 * 原因是状态簇不持有会话（同上），执行记录已登记该偏离。
 */
export function pushGuardrailHint(
  state: TurnGuardrailState,
  conversation: WireMessage[],
  code: string,
  text: string
): void {
  if (state.warnInjected.has(code)) return
  state.warnInjected.add(code)
  conversation.push({ role: 'user', content: `（系统提示：${text}）` })
}
