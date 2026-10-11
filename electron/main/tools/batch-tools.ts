/**
 * @category 工具
 * @summary 批量执行工具：一次调用按顺序执行多个子工具，合并返回一次结果
 *
 * 为什么存在（用户需求 2026-10-08）：AI 常为捕捉足够信息连续调用多个只读工具（Read/Grep/LS/Glob），
 * 每次调用都是一轮"工具→结果→蒸馏"的往返，即使蒸馏机制保证上下文干净，往返次数仍然过高。
 * 作用：让 AI 把多个独立行为排进一个 steps 数组，宿主按顺序逐个执行并合并为一条结果返回——
 * 减少调用次数、保留蒸馏前端的"一次完整批次"形态（最终仍走现有蒸馏结果，不新增旁路）。
 * 不删理由：调用次数与蒸馏开销是月蚀工具循环的主要成本，本工具是唯一按"批次"而非"单行为"
 * 收敛返回的通道；删除即退回逐轮往返，需求目标落空。
 *
 * 为什么子步骤不在此直接执行：子工具必须与主链路完全同一条执行链（见 base-tool.ts 的
 * executeSubTool 注释：能力闸 + Pre/PostToolUse Hook + 脱敏），本实现只做编排与合并，
 * 绝不绕过 executeTool 直调工具实例——否则任何安全审批或审计都会被批次旁路。
 *
 * 为什么无步数上限、不截断（用户需求 2026-10-08）：批量规模与单步结果完整性由 AI 按当前
 * 任务自行权衡，宿主不做预设限制；过长上下文由现有蒸馏机制收敛，不重复设闸。
 *
 * 为什么子步骤剥离子 _result_mode：主链路在解析层（llm.ts）剥离该字段后才把参数交给工具本体；
 * 子步骤不经解析层直达工具本体，AI 若在子步骤 params 里模仿主链路写下 _result_mode（'full' 等），
 * 会被原样透传给子工具——污染其参数。且子步骤声明本无实际作用：子步骤结果合并进批次整体后，
 * 蒸馏与否由 batch_tools 主调用的 _result_mode 决定（批次作为一条工具消息进入 toolMsgIndices）。
 * 因此 normalizeSteps 一律剔除子步骤中的 _result_mode，与主链路「系统层选项不落入工具本体」语义一致。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

interface BatchStep {
  tool: string
  params: Record<string, unknown>
}

interface BatchStepResult {
  tool: string
  ok: boolean
  data?: unknown
  error?: string
}

/** 把一步的 ToolResult 收敛为可合并的条目：data 统一 JSON 化后原样带回，error 原样带回（不截断，AI 自行决定关注点） */
function toStepResult(tool: string, result: ToolResult): BatchStepResult {
  if (result.ok) {
    let text: string
    try {
      // JSON.stringify 对 undefined/函数等值返回 undefined，兜底转 String 保证 text 恒为字符串
      text = typeof result.data === 'string' ? result.data : (JSON.stringify(result.data) ?? String(result.data))
    } catch {
      text = String(result.data)
    }
    return { tool, ok: true, data: text }
  }
  return { tool, ok: false, error: result.error ?? '未知错误' }
}

/**
 * 校验并规整 steps 入参：LLM 传入的 JSON 类型不可信，先做结构校验再执行。
 * 返回规整后的步骤数组（params 省略时补空对象）；不合法返回 null 并附带明确错误原因——
 * 结构性问题整体拒绝（宁可一次失败也不执行一半），单步运行时失败才走 stopOnError 控制。
 * 同时剥离子步骤 params 中的系统层选项 _result_mode：主链路解析层（llm.ts）会在工具参数
 * 进入工具本体前剥掉它，但子步骤不经该解析层、直达工具本体，若透传会污染子工具参数——
 * 批次整体的全文/蒸馏由 batch_tools 主调用的 _result_mode 决定（详见类顶部注释）。
 */
function normalizeSteps(raw: unknown): { steps: BatchStep[] } | { error: string } {
  if (!Array.isArray(raw)) {
    return { error: 'steps 必须是数组，每项为 { tool: 工具名, params: 参数对象 }' }
  }
  if (raw.length === 0) {
    return { error: 'steps 不能为空' }
  }
  const steps: BatchStep[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { error: 'steps 内每项必须是对象 { tool, params }' }
    }
    const s = item as Record<string, unknown>
    if (typeof s.tool !== 'string' || s.tool.trim().length === 0) {
      return { error: 'steps 内每项的 tool 必须是非空工具名字符串' }
    }
    if (s.params !== undefined && (typeof s.params !== 'object' || s.params === null || Array.isArray(s.params))) {
      return { error: `步骤 ${s.tool} 的 params 必须是参数对象（省略时视为空参数）` }
    }
    const params = (s.params as Record<string, unknown>) ?? {}
    // 剥离子步骤的系统层选项：_result_mode 只对「当前这轮工具调用」有意义（由主链路解析层消费），
    // 子步骤结果会合并进批次整体、由 batch_tools 主调用的 _result_mode 决定蒸馏与否，
    // 子步骤声明它既无实际作用、又会污染子工具参数（严格校验参数的工具可能报错），故一律剔除。
    if ('_result_mode' in params) delete params._result_mode
    steps.push({ tool: s.tool, params })
  }
  // 嵌套拒绝：batch_tools 内再套 batch_tools 会指数级放大执行时间与返回体积，且违背"编排一次收敛"的初衷
  for (const s of steps) {
    if (s.tool === 'batch_tools') {
      return { error: '不允许在 batch_tools 的步骤中嵌套调用 batch_tools' }
    }
  }
  return { steps }
}

export class BatchTool implements Tool<{ steps?: unknown; stopOnError?: boolean }> {
  name = 'batch_tools'
  description =
    '批量执行：把多个工具调用作为一次调用顺序执行，整体只返回一条合并结果。参数 steps（必填）：步骤数组，每项 { tool: 工具名, params: 该工具的参数对象（无参工具可省略）}，按顺序逐个执行、后一步可参考前一步结果设计；stopOnError（选填，默认 false）：某步失败是否立即停止。返回 { results: [{ tool, ok, data 或 error }, ...] }。用途：把多轮只读探查（Read/Grep/LS/Glob 等）合并成一次调用，减少往返次数；不设步数上限、结果不截断，步子数与单步内容由你自行权衡（过长的返回内容会自动压缩为摘要，无需你自行精简）；嵌套 batch_tools 会被拒绝；每个子步骤与直接调用受完全相同的权限与安全检查（工具开关、审批、敏感信息处理均一致），工具关闭或未注册的步骤会单项报错，其余步骤不受影响（除非 stopOnError）。批次整体的结果处理方式由本工具的 _result_mode 决定；子步骤按普通参数执行，无需也不必单独指定 _result_mode（写了会被忽略，不影响子步骤执行）。仅在子步骤相互独立、无需中间结果参与设计时使用；需要上一步结果决定下一步参数的调用请手动逐步调用。'
  parameters = [
    {
      name: 'steps',
      type: 'array' as const,
      description: '要顺序执行的子工具步骤数组，每项 { tool: 工具名, params: 参数对象 }',
      required: true
    },
    {
      name: 'stopOnError',
      type: 'boolean' as const,
      description: '某一步失败时是否立即停止（默认 false = 记录失败继续后续步骤）',
      required: false,
      default: false
    }
  ]

  async execute(params: { steps?: unknown; stopOnError?: boolean }, ctx?: ToolContext): Promise<ToolResult> {
    // 环境守卫：executeSubTool 由宿主（server.ts 前端链路）注入；未注入的环境没有"当前生效执行器集合"，批次不可用
    if (!ctx?.executeSubTool) {
      return { ok: false, error: '当前环境不支持批量执行（未注入 executeSubTool）' }
    }
    const normalized = normalizeSteps(params.steps)
    if ('error' in normalized) {
      return { ok: false, error: normalized.error }
    }
    const stepDefs = normalized.steps
    const stopOnError = params.stopOnError === true

    const results: BatchStepResult[] = []
    let stoppedAt: number | undefined
    for (let i = 0; i < stepDefs.length; i++) {
      const step = stepDefs[i]
      const result = await ctx.executeSubTool(step.tool, step.params)
      results.push(toStepResult(step.tool, result))
      if (stopOnError && !result.ok) {
        stoppedAt = i + 1
        break
      }
    }

    const data: Record<string, unknown> = {
      total: stepDefs.length,
      results
    }
    if (stoppedAt !== undefined) {
      data.stoppedAt = stoppedAt
    }
    return { ok: true, data }
  }
}