/**
 * @category 工具
 * @summary 工具策略与过滤（shared）
 *
 * 为什么存在：各端（前端 AI / 记忆工作流）看到的工具面不同，需要按策略与排除清单过滤，并支持用户配置覆盖默认值。
 * 不删理由：本模块由 `shared/tools/registry.ts` 按 ADR-06 拆分而来，宿主降级为 barrel
 * 保全部消费方零改动；职责单一化后，改动面互不干扰（原单文件同时承载类型/目录/动态注册/
 * 策略/标签五类职责，任一处改动都会与其它职责在 merge 上冲突）。
 */

import type { ToolMeta } from './meta'
import { TOOL_REGISTRY } from './catalog'
import { getAllToolMetas, findToolMeta } from './dynamic'

/** 获取前端 AI 工具列表（含 MCP 动态注册的工具） */
export function getFrontendTools(): ToolMeta[] {
  return getAllToolMetas().filter((t) => t.agents.includes('frontend'))
}

/** 获取记忆工作流工具列表（含 MCP 动态注册的工具） */
export function getWorkflowTools(): ToolMeta[] {
  return getAllToolMetas().filter((t) => t.agents.includes('dmn'))
}


/** 工具是否启用（policy 优先，未配置则用 defaultEnabled） */
export function isToolEnabled(
  toolId: string,
  policy: Record<string, { enabled: boolean }>
): boolean {
  const meta = findToolMeta(toolId)
  // 修复（前H4）：原实现 `if (!meta) return false`——MCP 工具是运行时动态注册的，
  // 不在静态 TOOL_MAP → 恒 false → MCP 工具整体无法注入（已购死 bug）。
  // 查不到元数据时回退"策略显式配置优先，否则默认启用"（MCP server 配了就是要用其工具；
  // 未知 id 不在任何工具池里，默认启用无实际风险）。
  if (!meta) return policy[toolId] ? policy[toolId].enabled : true
  if (meta.isMechanism) return true // 机制入口由全局开关控制，不受 per-tool policy 影响
  const entry = policy[toolId]
  return entry ? entry.enabled : meta.defaultEnabled
}

/**
 * 工具是否对指定 agent 可见（基于 agents 字段）

 * 在 isToolEnabled 之前过滤：先判断工具归属，再判断启用策略。
 * - 前端 AI 只能看到 agents 含 'frontend' 的工具
 * - 记忆工作流只能看到 agents 含 'dmn' 的工具

 * @param toolId 工具 id
 * @param agent 'frontend' | 'dmn'
 */
export function isToolForAgent(toolId: string, agent: 'frontend' | 'dmn'): boolean {
  // 修复（前#25 配套）：MCP 动态工具同样可判定（findToolMeta 查静态 + 动态）
  const meta = findToolMeta(toolId)
  if (!meta) return false
  return meta.agents.includes(agent)
}

/**
 * 构建记忆工作流工具策略：仅启用指定工具，禁用其余工作流可用工具

 * 用于为每个记忆工作流阶段生成精确的工具集，避免工作流看到无关工具导致误用。
 * 机制入口（tool_info/call_tool）不受此策略影响（由全局开关控制）。

 * @param enabledTools 需要启用的工具 id 列表
 * @returns ToolPolicy 记录，包含所有工作流可用工具的启用/禁用状态
 */
export function buildWorkflowToolPolicy(enabledTools: string[]): Record<string, { enabled: boolean }> {
  const enabledSet = new Set(enabledTools)
  const policy: Record<string, { enabled: boolean }> = {}
for (const tool of TOOL_REGISTRY as readonly ToolMeta[]) {
    // 只为工作流可用的非机制工具生成策略
    if (tool.agents.includes('dmn') && !tool.isMechanism) {
      policy[tool.id] = { enabled: enabledSet.has(tool.id) }
    }
  }
  return policy
}

/**
 * 记忆处理工作流各阶段的默认工具策略

 * 设计原则：每个阶段只拿到它职责所需的工具，避免看到无关工具导致误用或困惑。
 * 用户可在设置页调整，也可通过"一键重置"恢复到此默认配置。

 * 记忆处理已合并为 MEMORY_PIPELINE_TEMPLATE 工作流，工具策略通过 mergeWorkflowToolPolicies()
 * 取并集后下发给工作流引擎（确保工作流任意节点所需工具都可用）。
 * 这里的 memory_filter/memory_dedup 等键是工作流各阶段工具策略的命名沿用
 * （对应 filter/dedup/contradict 等节点 ID），不代表独立 agent。
 */
export const DEFAULT_WORKFLOW_TOOL_POLICIES: Record<string, Record<string, { enabled: boolean }>> = {
// 过滤与归档：将对齐对话归档为记忆和 NNG
  memory_filter: buildWorkflowToolPolicy([
    'create_memory', 'create_nng', 'rename_raw_memory',
    'nng_graph', 'cache_graph',
    'Read', 'read_md', 'Edit', 'Write', 'Glob', 'Grep', 'LS',
    'MoveFile', 'DeleteFile',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 重复归档与归并：检测重复并归档/归并/合并 NNG
  memory_dedup: buildWorkflowToolPolicy([
    'create_memory', 'create_nng',
    'nng_graph',
    'Read', 'Edit', 'Glob', 'Grep', 'LS',
    'MoveFile', 'DeleteFile',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 矛盾归档：检测矛盾记忆并归档旧版本
  memory_contradict: buildWorkflowToolPolicy([
    'Read', 'Edit', 'Write',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 张力处理：检测张力/跨领域关系，建 high/meta NNG
  memory_tension: buildWorkflowToolPolicy([
    'create_memory', 'create_nng',
    'nng_graph',
    'Read', 'Edit', 'Write', 'Glob', 'Grep', 'LS',
    'MoveFile', 'DeleteFile',
    'TodoWrite',
    'dmn_ask_user'
  ]),
  // 统一检查：审查各阶段工作质量并决策重做
  memory_qa: buildWorkflowToolPolicy([
    'Read', 'Edit', 'Write',
    'TodoWrite',
    'dmn_ask_user'
  ])
}

/**
 * 合并所有记忆工作流阶段的默认工具策略为并集（任一阶段启用的工具即启用）。

 * 用于工作流引擎等跨阶段场景：工作流可执行任意记忆处理任务（filter/dedup 等节点），
 * 工具集必须覆盖所有阶段所需，而不是只匹配某一个阶段的精简策略。
 * 否则 defaultEnabled=false 的高风险工具（如 DeleteFile）会被 isToolEnabled
 * 回退逻辑过滤掉，导致工作流 LLM 节点报"未注册"警告且工具不可用。
 */
export function mergeWorkflowToolPolicies(): Record<string, { enabled: boolean }> {
  const merged: Record<string, { enabled: boolean }> = {}
  for (const key of Object.keys(DEFAULT_WORKFLOW_TOOL_POLICIES)) {
    const policy = DEFAULT_WORKFLOW_TOOL_POLICIES[key]
    for (const [toolId, entry] of Object.entries(policy)) {
      // 任一阶段启用则启用；已有 true 的保留不被覆盖
      if (!merged[toolId] || entry.enabled) {
        merged[toolId] = { enabled: entry.enabled }
      }
    }
  }
  // 多模态生成工具：agents 含 'dmn' 后会被各记忆阶段策略显式置 false（不在阶段清单里），
  // 但它们 defaultEnabled=true 且低风险——通用工作流（素材生成等）需要，恢复默认启用
  for (const toolId of ['image_gen', 'video_gen', 'audio_gen', 'create_document']) {
    merged[toolId] = { enabled: true }
  }
  return merged
}
