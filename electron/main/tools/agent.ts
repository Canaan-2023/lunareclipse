/**
 * 子 agent 委托工具：为什么存在——主对话需要把可拆分的子任务派给独立上下文的子 agent
 * 执行（串行/并行），避免长任务阻塞主对话或撑爆上下文。
 * 作用：Agent 工具封装 ctx.launchSubAgent，按 tasks + mode 派发并汇总各子 agent 输出。
 */
import type { Tool, ToolResult, ToolContext } from './base-tool'

export interface AgentTask {
  prompt: string
  /** 工具白名单（只允许使用的工具名，不填则继承全部启用工具） */
  tools?: string[]
  /** 工具黑名单（从继承列表中移除的工具名） */
  disallowedTools?: string[]
  /** 最大轮次（2026-10-02 取消默认上限：不传即不限制，由超时兜底） */
  maxTurns?: number
  /** 超时毫秒（默认 600000 = 10 分钟） */
  timeoutMs?: number
}

export interface AgentToolParams {
  tasks: AgentTask[]
  mode?: 'serial' | 'parallel'
}

export class AgentTool implements Tool<AgentToolParams> {
  name = 'Agent'
  description =
    '派发子 agent 处理子任务（每个子 agent 独立上下文），返回各子任务输出。tasks 必填（数组，每项含 prompt 及可选 tools/disallowedTools/maxTurns（不传即不限制，由 timeoutMs 兜底）/timeoutMs 默认600000=10分钟）；mode 选填：serial=顺序执行前一个输出作后一个上下文（默认）、parallel=并行结果独立。独立任务用 parallel，有依赖用 serial。\n\nprompt 纪律（简报式委托）：①子 agent 无会话上下文，需说明目标/原因/已排除项，给足判断上下文；②查找类给确切命令，调查类给问题；③不委托理解——给文件路径+行号+具体要改什么；④派发后等结果返回再评估，不提前预判子任务输出；⑤需短回复在 prompt 注明（如"200 字以内"）。'
  parameters = [
    {
      name: 'tasks',
      type: 'array' as const,
      description:
        '任务数组，每项 {prompt: 子agent提示词, tools?: 工具白名单, disallowedTools?: 工具黑名单, maxTurns?: 最大轮次（不传即不限制，由 timeoutMs 兜底）, timeoutMs?: 超时毫秒默认600000=10分钟}。单任务就传长度1的数组',
      required: true
    },
    {
      name: 'mode',
      type: 'string' as const,
      description: '执行模式：serial（顺序，默认）或 parallel（并行）',
      required: false
    }
  ]

  async execute(params: AgentToolParams, ctx?: ToolContext): Promise<ToolResult> {
    if (!ctx?.launchSubAgent) {
      return { ok: false, error: 'ToolContext.launchSubAgent 未初始化' }
    }
    if (!params.tasks || !Array.isArray(params.tasks) || params.tasks.length === 0) {
      return { ok: false, error: 'tasks 必须是非空数组' }
    }
    for (let i = 0; i < params.tasks.length; i++) {
      const t = params.tasks[i]
      if (!t.prompt || t.prompt.trim().length === 0) {
        return { ok: false, error: `tasks[${i}].prompt 不能为空` }
      }
    }
    const mode = params.mode === 'parallel' ? 'parallel' : 'serial'
    try {
      const outputs = await ctx.launchSubAgent(params.tasks, mode)
      return { ok: true, data: { outputs } }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
}
