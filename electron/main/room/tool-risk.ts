/**
 * @category ROOM
 * @summary ROOM 动作的「只读」判定真源：一律查工具注册表元数据（`behavior.readOnly`），AI 自述无效
 *
 * 为什么存在：执行器按「只读 → `t2.readonly-tools`（免授予）／其余 → `t1.executor-high-risk`（需授予）」
 * 分流，这条分流的安全性完全取决于「只读」由谁判定。若采信 AI 输出里的 `readOnly`，
 * AI 只要把写文件/执行命令标成只读即可免授予执行——分级语义被一条字段绕过
 * （2026-10-18 工程保障团队评审 P0-2 实测确认：`plan.ts` 原样采信 AI 的 `readOnly`）。
 *
 * 判据（fail-closed，任一不满足即「非只读」）：
 * 1. 工具名非空且在**当前可用集合**内（不在集合内 = 不可执行，按高风险对待）；
 * 2. 该工具**显式声明** `behavior.readOnly === true`（未声明按 `resolveToolBehavior` 的缺省 `false`）。
 *
 * 不删理由：这是「只读免授予」这条捷径的唯一准入判定；散回调用方就等于重新给 AI 留了自报口子。
 */
import type { AnyTool } from '../tools/base-tool'
import { resolveToolBehavior } from '../tools/base-tool'
import { TOOL_MAP } from '@shared/tools/registry'

/** 只读判定器：给工具名，回是否只读（fail-closed）。 */
export type ToolReadOnlyResolver = (toolName: string) => boolean

/**
 * 纯判定：由工具实例与登记元数据推出只读性。
 * 行为解析复用契约层单点 `resolveToolBehavior`（显式声明优先、缺省 fail-closed），
 * 与 `execute-tool` / `tool-bridge` / 安全层消费同一套语义，避免行为漂移。
 */
export function resolveToolReadOnly(tool: AnyTool | undefined, toolName: string): boolean {
  if (!tool) return false
  return resolveToolBehavior(tool.behavior, TOOL_MAP[toolName]).readOnly
}

/**
 * 构造只读判定器（`getTools` 惰性读当前可用集合——工具策略热更新后判定随之变化，与执行链口径一致）。
 */
export function createToolReadOnlyResolver(getTools: () => Map<string, AnyTool>): ToolReadOnlyResolver {
  return (toolName: string): boolean => resolveToolReadOnly(getTools().get(toolName), toolName)
}
