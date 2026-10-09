/**
 * L8 工作流引擎：skill 节点处理器
 *
 *
 *
 * 职责：加载 SKILL 正文注入到 context，后续 llm 节点可以引用 {{context.节点id}}
 *
 * 复用现有能力：
 * - skills/loader.ts 的 SkillLoader（与 use_skill 工具走同一加载路径）
 *
 * 行为：
 * - 调 skillLoader.load(skillId) 获取 SKILL 正文
 * - SKILL 正文作为 output 写进 context（后续 llm 节点用 {{context.节点id}} 引用）
 * - 不存落盘（SKILL 正文是静态文本，直接进上下文）
 *
 * 与 use_skill 工具的关系：
 * - use_skill 工具是 AI 主动调用的（运行时按需加载）
 * - skill 节点是工作流编排预定义的（执行到该节点时自动加载）
 * - 两者底层都走 SkillLoader.loadBody，只是触发时机不同
 * 为什么存在：模板需要在节点处预载 SKILL 正文供后续 llm 节点引用（编排式加载），与 AI 运行时主动 use_skill 互补。
 */
import type { NodeHandler, NodeHandlerContext, SkillConfig } from '@shared/workflow/types'
import { validateConfig } from './validate'

export class SkillHandler implements NodeHandler {
  async handle(ctx: NodeHandlerContext): Promise<{ output: string }> {
    const config = validateConfig<SkillConfig>(ctx.node, ['skillId'])

    if (!ctx.skillLoader) {
      throw new Error('skill 节点处理器需要 skillLoader 能力，但未注入')
    }

    const result = ctx.skillLoader.load(config.skillId)
    if (!result.ok || !result.body) {
      throw new Error(`加载 SKILL "${config.skillId}" 失败: ${result.error ?? '未知错误'}`)
    }

    // SKILL 正文作为 output（写进 context.节点id，后续 llm 节点可引用）
    // 不落盘（SKILL 正文是静态文本，直接进上下文）
    return { output: result.body }
  }
}
