/**
 * L8 工作流引擎：human 节点处理器



 * 职责：暂停工作流，弹窗让用户输入，用户响应后结果写进 context

 * 复用现有能力：
 * - 前端弹窗（HumanInputDialog.tsx，Phase 2 实现）
 * - IPC 回调机制（manager 维护 pendingResolvers Map）

 * 行为：
 * - 校验 config（prompt 非空、inputType 合法、choice 时 options ≥ 2）
 * - 解析 prompt 模板变量
 * - 调 requestHumanInput(prompt, inputType, options, timeoutMs)
 * - 上层（manager）注入此回调：发 wf:paused 事件 + 创建 Promise + 超时 timer
 * - 前端收到 wf:paused 事件，显示弹窗（有 timeoutMs 时显示倒计时）
 * - 用户响应后通过 IPC 调 workflow:respondHumanInput，manager resolve Promise + 清理 timer
 * - 超时后 manager 自动 reject，handler 抛错，引擎标记节点 failed
 * - 用户响应作为 output 写进 context

 * 崩溃恢复：
 * - 若进程崩溃时正卡在 human 节点，重启后实例状态为 paused + pauseReason=human
 * - manager 重新发 wf:paused 事件，前端重新弹窗（用户可能需要再答一次）
 * - 注意：超时 timer 不持久化，崩溃恢复后会重置计时（可接受，避免假超时）
 * 为什么存在：工作流执行中可能停在需要人工输入的节点，"弹窗等输入→回写 context"必须实现为可挂起/恢复的节点语义。
 */
import type { NodeHandler, NodeHandlerContext, HumanConfig } from '@shared/workflow/types'
import { validateConfig, assertEnum } from './validate'

/** HumanConfig.inputType 的合法值集合 */
const HUMAN_INPUT_TYPES = ['confirm', 'text', 'choice'] as const

export class HumanHandler implements NodeHandler {
  async handle(ctx: NodeHandlerContext): Promise<{ output: string }> {
    const config = validateConfig<HumanConfig>(ctx.node, ['prompt', 'inputType'])

    if (!ctx.requestHumanInput) {
      throw new Error('human 节点处理器需要 requestHumanInput 能力，但未注入')
    }

    // 校验 inputType 合法
    assertEnum(ctx.node, 'inputType', config.inputType, HUMAN_INPUT_TYPES)

    // choice 类型必须至少有 2 个选项（否则没有选择的必要）
    if (config.inputType === 'choice') {
      if (!Array.isArray(config.options) || config.options.length < 2) {
        throw new Error(
          `节点 "${ctx.node.name}"(${ctx.node.id}) 配置无效: inputType 为 choice 时 options 至少需要 2 个选项`
        )
      }
      if (!config.options.every((o) => typeof o === 'string')) {
        throw new Error(
          `节点 "${ctx.node.name}"(${ctx.node.id}) 配置无效: options 必须全部为字符串`
        )
      }
    }

    // 校验 timeoutMs（若提供必须是正数）
    if (config.timeoutMs !== undefined) {
      if (typeof config.timeoutMs !== 'number' || config.timeoutMs <= 0 || !Number.isFinite(config.timeoutMs)) {
        throw new Error(
          `节点 "${ctx.node.name}"(${ctx.node.id}) 配置无效: timeoutMs 必须是正数，实际为 ${JSON.stringify(config.timeoutMs)}`
        )
      }
    }

    // 解析 prompt 模板变量
    const resolvedPrompt = ctx.resolveTemplate(config.prompt)

    // 调用 requestHumanInput（阻塞，等用户响应或超时）
    // 上层 manager 负责发 wf:paused 事件 + 创建 Promise + 管理 timer
    const userResponse = await ctx.requestHumanInput(
      resolvedPrompt,
      config.inputType,
      config.options,
      config.timeoutMs
    )

    // 用户响应作为 output（写进 context.节点id 和 context.user_response）
    return { output: userResponse }
  }
}
