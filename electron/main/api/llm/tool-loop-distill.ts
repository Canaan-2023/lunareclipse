/**
 * @category API
 * @summary 工具结果蒸馏记账：收集本轮 tool 消息 → 快照意图 → 并行蒸馏 → 写回并重包护栏
 *
 * 为什么独立成模块：蒸馏是「工具结果 → 下一轮请求上下文」之间的**批处理阶段**，
 * 时机与顺序都有硬约束（见下方「时机」「顺序依赖」注释），此前内联在 `llm.ts` 的
 * `streamWithTools`（1205 行）方法体中部，无法单独测试，也无法与工具循环引擎分开演进。
 *
 * 什么作用：`createDistillBookkeeper(deps)` 返回记账器——`record()` 登记本轮每条 tool 结果，
 * `flush()` 在**下一轮请求构建前**批量蒸馏并就地替换 `conversation` 中的原文。
 *
 * 不删理由：删掉即工具结果不再蒸馏，大段工具原文直灌上下文（上下文膨胀 + 成本上升），
 * 且 `_result_mode=full` 的「原文保留」语义失去对照实现。
 */
import { DEFAULT_TOOL_RESULT_DISTILL } from '@shared/types'
import type { WireMessage } from '../llm-types'
import { classifyToolSource, wrapGuardrail } from '../message-guardrail'
import { buildTurnPairsIntent } from './turn-pairs'

/** 一条待蒸馏的 tool 消息记录（对应 conversation 中一个下标） */
export interface DistillEntry {
  /** 该 tool 消息在 conversation 中的下标（写回时按下标就地替换） */
  index: number
  toolName: string
  toolCallId: string
  result: string
  /** LLM 在工具参数中声明的结果处理方式：full = 原文保留（跳过蒸馏）；distill = 蒸馏 */
  resultMode: 'full' | 'distill'
}

export interface DistillBookkeeper {
  /** 本轮已登记的 tool 结果（只读视图；引擎用它取计数做日志） */
  readonly entries: readonly DistillEntry[]
  record(entry: DistillEntry): void
  flush(): Promise<void>
}

export interface DistillDeps {
  /** 本轮 wire 会话副本（就地替换 tool 消息 content） */
  conversation: WireMessage[]
  /** 消息来源护栏作用域键：有值时蒸馏摘要需按工具名重新包裹，保持「每条消息都有来源」契约 */
  guardrailKey?: string
  distillToolResult?: (
    toolName: string,
    toolCallId: string,
    result: string,
    intent?: string
  ) => Promise<string | undefined>
  /** 意图上下文对话对数量；缺省回退 shared 单源默认 */
  distillIntentTurnPairs?: number
}

/**
 * 创建蒸馏记账器。
 *
 * 时机（不可移位）：`conversation` 是每次 `streamWithTools` 内部的 wire 副本，不进 session 历史、
 * 不出本函数（session 只落 user/assistant，见 stream-runner 落盘），因此「流结束时替换」对任何
 * 后续请求都不可观测，等于白跑。唯一有实际效果的位置是**工具轮执行完、下一轮请求发出之前**——
 * AI 后续轮次看到的是提炼摘要而非大段原文。
 */
export function createDistillBookkeeper(deps: DistillDeps): DistillBookkeeper {
  const entries: DistillEntry[] = []

  const flush = async (): Promise<void> => {
    // 意图上下文对话对数量：由服务端从设置注入（缺省回退 shared 单源默认），
    // 组装「该工具调用前的完整对话形态」传给蒸馏器判断相关性——与调取工具的那个
    // AI 同视角（含其思考、工具调用声明与此前工具消息链），见 buildTurnPairsIntent
    const intentPairs = deps.distillIntentTurnPairs ?? DEFAULT_TOOL_RESULT_DISTILL.intentTurnPairs
    // 第一步：统一快照全部待蒸馏条目与各自意图（LLM 声明 full = 原文完整保留：跳过蒸馏）。
    // 顺序依赖说明：意图必须基于「该工具调用前的原始 wire 副本」组装——若边蒸馏边替换
    // conversation，后蒸馏工具的意图会读到前一个已被替换成摘要的消息，意图即失真；
    // 先快照后执行可保证每条 intent 与调用者视角严格一致（原串行实现的隐患，一并修正）。
    const todo = entries
      .filter((tm) => tm.resultMode !== 'full')
      .map((tm) => ({ tm, intent: buildTurnPairsIntent(deps.conversation, tm.index, intentPairs) }))
    // 第二步：并行蒸馏。每条最多尝试 2 次（失败 falsy/抛错重试一次，防瞬时超限/断流）；
    // 并发上限不在此叠加——distiller 内部已有信号量并发控制（acquire/release + waiters
    // 队列，见 services/tool-result-distiller.ts），外墙只需并行发起、由信号量统一限流。
    // 性能动机：多工具轮次（N 条结果）若逐条串行 await，下一轮请求构建被拖成 N 次串行
    // LLM 调用；工具消息之间无顺序依赖，并行后总耗时收敛为信号量允许的最大并发批。
    const settled = await Promise.allSettled(
      todo.map(async ({ tm, intent }) => {
        let distilled: string | undefined
        for (let attempt = 0; attempt < 2 && !distilled; attempt++) {
          try {
            distilled = await deps.distillToolResult?.(tm.toolName, tm.toolCallId, tm.result, intent)
          } catch {
            distilled = undefined
          }
        }
        return { tm, distilled }
      })
    )
    // 第三步：统一写回，保持原消息顺序。成功 → 摘要替换原文并重包护栏；失败 → 保留原文。
    // 摘要替换时保留消息来源护栏：同样按工具名分类重新包裹，否则下一轮请求中该 tool
    // 消息会退回无护栏裸文本，破坏「每条消息都有来源」契约。
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue // 重试内已全量 catch，此处仅防御异常路径
      const { tm, distilled } = r.value
      if (!distilled) continue // 重试仍失败：保留原文进上下文
      const toolSource = deps.guardrailKey ? classifyToolSource(tm.toolName) : null
      deps.conversation[tm.index].content =
        toolSource && deps.guardrailKey
          ? wrapGuardrail(distilled, toolSource, deps.guardrailKey)
          : distilled
    }
  }

  return {
    entries,
    record: (entry: DistillEntry): void => {
      entries.push(entry)
    },
    flush
  }
}
