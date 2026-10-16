/**
 * L8 工作流引擎：tool 节点处理器



 * 职责：调工具（内置工具 + MCP 工具，平等可用），收结果写进 context

 * 复用现有能力：
 * - 工具池 tools/index.ts 的 createToolRegistry（内置工具）
 * - MCP client-manager（MCP 工具）

 * 行为：
 * - 解析 args 中的 {{context.xxx}} 变量
 * - 调用 toolExecutor.execute(toolId, args)
 * - toolId 以 mcp_ 开头时走 MCP 路径，否则走内置工具路径（由上层注入的 toolExecutor 统一处理）
 * - 工具完整结果作为 output 写进 context（后续节点用 {{context.节点id}} 引用）
 * 为什么存在：工作流需在节点处编排式调用工具（内置与 MCP 平等可用），结果要写进 context 供后续节点消费，故独立处理器统一入口。
 */
import type { NodeHandler, NodeHandlerContext, ToolConfig } from '@shared/workflow/types'
import { validateConfig, assertObject } from './validate'

export class ToolHandler implements NodeHandler {
  async handle(ctx: NodeHandlerContext): Promise<{ output: string }> {
    const config = validateConfig<ToolConfig>(ctx.node, ['toolId', 'args'])
    assertObject(ctx.node, 'args', config.args)

    if (!ctx.toolExecutor) {
      throw new Error('tool 节点处理器需要 toolExecutor 能力，但未注入')
    }

    // 解析 args 模板变量
    // H4 修复：优先用 resolveValue 保留原始类型（数字/布尔/对象），
    // 避免 tool 收到字符串 "42" 而非数字 42，或 "[object Object]" 而非对象
    const resolvedArgs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(config.args)) {
      if (ctx.resolveValue) {
        resolvedArgs[k] = ctx.resolveValue(v)
      } else {
        resolvedArgs[k] = ctx.resolveTemplate(v)
      }
    }

    const result = await ctx.toolExecutor.execute(config.toolId, resolvedArgs)

    // 失败时抛错（让引擎捕获并标记节点失败）
    if (!result.ok) {
      throw new Error(`工具 ${config.toolId} 执行失败: ${result.error ?? '未知错误'}`)
    }

    // output 是工具的完整结果（结论），结构化结果统一转字符串
    const output = typeof result.data === 'string'
      ? result.data
      : JSON.stringify(result.data ?? '')

    return { output }
  }
}
