/**
 * @category 工具
 * @summary 工具策略与过滤（shared）
 *
 * 为什么存在：各端（前端 AI / 记忆工作流 / 莉莉丝）看到的工具面不同，需要按策略与排除清单过滤，并支持用户配置覆盖默认值。
 * 不删理由：本模块由 `shared/tools/registry.ts` 按 ADR-06 拆分而来，宿主降级为 barrel
 * 保全部消费方零改动；职责单一化后，改动面互不干扰（原单文件同时承载类型/目录/动态注册/
 * 策略/标签五类职责，任一处改动都会与其它职责在 merge 上冲突）。
 */

import type { ToolPolicy } from '../types'
import type { ToolMeta } from './meta'
import { TOOL_REGISTRY } from './catalog'
import { getAllToolMetas, findToolMeta } from './dynamic'

/** 获取前端 AI 工具列表（含 MCP 动态注册的工具） */
export function getFrontendTools(): ToolMeta[] {
  return getAllToolMetas().filter((t) => t.agents.includes('frontend'))
}

/**
 * 月蚀专属排除清单（用户"角色塑造是给月蚀的"——莉莉丝工具面收窄）：
 * 这些是月蚀的系统管理/自我管理工具，莉莉丝（角色）不该有：
 * - 自我塑造：设定角色/更新角色设定/改自己名字（月蚀改自己 persona 的通道）
 * - AI 自我管理：用户档案/轻量记忆/SKILL 维护/自我安全/自我重启
 * - 任务编排：派发子任务/任务清单/上下文管理
 * - 工作流编排：workflow_* 8 个
 * 保留：莉莉丝专属（lilith_*）+ 记忆/文件/浏览器/联网 + 有授权通道的高风险工具（run_command 等，
 * 依授权体系保留而非默认排除——高危工具在角色不擅权的边界内仍可执行系统操作）
 */
const LILITH_EXCLUDED_TOOLS = new Set([
  'update_abyss_md', 'update_ai_name',
  'create_ai',
  'search_users', 'get_user_profile',
  'skill_manage', 'use_skill', 'curator',
  'app_restart',
  'kernel_inspect', 'module_inspect',
  'Agent', 'TodoWrite', 'context_usage',
  'batch_tools', // 批量执行依赖前端主链路的 executeSubTool 注入（toolExecutorsRef），莉莉丝侧无此注入
  'workflow_define', 'workflow_run', 'workflow_status', 'workflow_modify', 'workflow_save',
  'workflow_list', 'workflow_edit', 'workflow_io'
])

/** 获取莉莉丝工具列表（边界隔离：前端工具 = 她的能力面 + 莉莉丝专属工具 = 她的记忆工具；排除月蚀专属管理类） */
export function getLilithTools(): ToolMeta[] {
  return getAllToolMetas().filter(
    (t) => (t.agents.includes('frontend') || t.agents.includes('lilith')) && !LILITH_EXCLUDED_TOOLS.has(t.id)
  )
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
 * - 莉莉丝（'lilith'）看到 前端工具 + 莉莉丝专属工具（边界隔离：
 *   她的能力面 = 前端全量（agent 模式/白名单），外加她自己的记忆工具 lilith_*）

 * @param toolId 工具 id
 * @param agent 'frontend' | 'dmn' | 'lilith'
 */
export function isToolForAgent(toolId: string, agent: 'frontend' | 'dmn' | 'lilith'): boolean {
  // 修复（前#25 配套）：MCP 动态工具同样可判定（findToolMeta 查静态 + 动态）
  const meta = findToolMeta(toolId)
  if (!meta) return false
  if (agent === 'lilith') {
    // 莉莉丝工具面 = 前端工具 + 莉莉丝专属工具，排除月蚀专属管理类（用户"角色塑造是给月蚀的"）
    return (meta.agents.includes('frontend') || meta.agents.includes('lilith')) && !LILITH_EXCLUDED_TOOLS.has(toolId)
  }
  return meta.agents.includes(agent)
}

/**
 * 构建莉莉丝工具策略（用户需求：工具可配置，与常规线路连通）。
 * 与记忆工作流同一套白名单机制：仅启用指定工具，禁用其余前端可用工具。
 * 默认白名单 = 记忆/情绪/浏览器类（memory/lilith_player_memory/lilith_lore_query/lilith_emotion/browser_*——她会"记得"事）；用户在设置页可增删。
 */
export function buildLilithToolPolicy(enabledTools: string[]): Record<string, { enabled: boolean }> {
  const enabledSet = new Set(enabledTools)
  const policy: Record<string, { enabled: boolean }> = {}
for (const tool of TOOL_REGISTRY as readonly ToolMeta[]) {
    // 莉莉丝工具集 = 前端可用工具 + 莉莉丝专属工具（边界隔离后 lilith_* 标 agents ['lilith']），
    // 排除月蚀专属管理类（LILITH_EXCLUDED_TOOLS）
    if ((tool.agents.includes('frontend') || tool.agents.includes('lilith')) && !tool.isMechanism && !LILITH_EXCLUDED_TOOLS.has(tool.id)) {
      policy[tool.id] = { enabled: enabledSet.has(tool.id) }
    }
  }
  return policy
}

/** 莉莉丝默认工具策略（记忆类 + 浏览器类 + 情绪控制白名单；用户配置覆盖） */
export const DEFAULT_LILITH_TOOL_POLICIES: Record<string, { enabled: boolean }> = buildLilithToolPolicy([
  // 记忆类（她会"记得"事）
  'memory',
  'lilith_player_memory', 'lilith_lore_query',
  // 情绪控制（用户明确：莉莉丝控制莉莉丝——她自己控制 LIVE2D 情绪/动画）
  'lilith_emotion',
  // 浏览器类（用户需求："解除一点限制，让她能完整操控浏览器，输出保持风格"）
  // 注意：browser_* 是 bundled/headless-browser 插件动态注册的工具，不在静态 TOOL_REGISTRY 中，
  // buildLilithToolPolicy 只遍历静态表，以下 id 实际不会生成 policy 条目——插件工具默认启用由其
  // meta.defaultEnabled（=true）决定，并经 tool-registry 的 isToolEnabled 过滤支持设置页开关。
  // 此处保留真实存在的 8 个 id 作语义白名单文档，便于读者核对插件工具面。
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type',
  'browser_scroll', 'browser_evaluate', 'browser_status', 'browser_takeover'
])

/** 合并莉莉丝工具策略：默认白名单基础上应用用户配置（用户可启用额外工具或关闭记忆类） */
export function mergeLilithToolPolicy(userPolicy?: Record<string, ToolPolicy>): Record<string, { enabled: boolean }> {
  const merged: Record<string, { enabled: boolean }> = { ...DEFAULT_LILITH_TOOL_POLICIES }
  if (userPolicy) {
    for (const [id, p] of Object.entries(userPolicy)) {
      merged[id] = { enabled: p.enabled }
    }
  }
  return merged
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
