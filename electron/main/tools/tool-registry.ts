/**
 * @category 工具
 * @summary 统一工具集工厂：前端 AI 和 DMN 共用，按 policy / visible 条件过滤所有工具
 * @note 由 index.ts 拆分而来：只搬位置，不改变任何行为与导出
 * @note 为什么存在：前端 AI 与 DMN 需要按各自的策略/可见性过滤出可用工具集，
 * 本模块是这套过滤逻辑的唯一实现，保证两侧口径一致。
 */
import type { AnyTool, ToolContext } from './base-tool'
import { ALL_TOOL_CTORS, toAnyTool } from './tool-ctors'
import { isToolEnabled, isToolForAgent, TOOL_MAP } from '@shared/tools/registry'
import type { ToolPolicy } from '@shared/types'
import { adaptMcpTool } from '../mcp/tool-adapter'
import type { McpClientManager } from '../mcp/client-manager'

export interface ToolRegistry {
  tools: Map<string, AnyTool>
  ctx: ToolContext
  queriedTools: Set<string>
}

// 统一工具集构造选项（前端 AI 和 DMN 共用）
export interface ToolRegistryOptions {
  /** per-tool 启用策略（key=工具 id，未配置则用 registry 的 defaultEnabled） */
  toolsPolicy?: Record<string, ToolPolicy>
  /** MCP 客户端管理器（提供动态发现的 MCP 工具） */
  mcpClientManager?: McpClientManager
  /**
   * 显式指定工具集归属的 agent 类型。
   * - 不传：自动从 ctx.dmnId 推断（有 dmnId → 'dmn'，无 → 'frontend'）
   * - 'frontend'：只包含 agents 含 'frontend' 的工具
   * - 'dmn'：只包含 agents 含 'dmn' 的工具
   * - 'lilith'（边界隔离）：前端工具 + 莉莉丝专属工具（lilith_*）

   * 用于全局 DMN 工具池创建（ctx 无 dmnId 但需要 DMN 工具集时显式传 'dmn'）。
   */
  agent?: 'frontend' | 'dmn' | 'lilith'
  /**
   * 权限绿通模式（permissionGreenlight）开启时自动启用的工具。
   * 仅 app_restart（自我重启）依赖绿通——它是 defaultEnabled=false 的新工具，
   * 绿通开 = 用户显式授权 AI 自我重启，自动启用；绿通关 = AI 看不到此工具，安全。
   * 其余系统调用工具（run_command 等）由用户在设置页手动启用，绿通只影响权限放行。
   * 仅对前端 AI 生效。
   */
  greenlightEnabled?: boolean
  /** 应用配置子集：供工具元数据的 visible 条件判定（如 webSearchEnabled=false 时 web_search 不暴露） */
  config?: { webSearchEnabled?: boolean }
  /** 插件工具（PluginLoader.getTools() 的结果，运行时动态，与 MCP 工具同机制并入统一池） */
  pluginTools?: AnyTool[]
}

/**
 * 统一工具集工厂：前端 AI 和 DMN 共用，按 policy 过滤所有工具。

 * 设计原则：
 * - 所有工具对所有 AI 可注入（不再硬编码"前端专属/DMN专属"分类）
 * - 由 toolsPolicy 配置决定每个 AI 实际启用哪些工具
 * - DMN 专属工具（dmn_ask_user 等）内部检查 ctx，前端 AI 调用会得到明确错误
 * - 直接注入模式：所有启用工具 schema 直接注入 prompt（onDemand 两步机制已退役）

 * @param ctx 工具上下文（sessionId / dmnId / supervisor / paths 等）
 * @param options 构造选项（toolsPolicy / mcpClientManager / greenlightEnabled / config）
 */
export function createToolRegistry(
  ctx: ToolContext = {},
  options?: ToolRegistryOptions
): ToolRegistry {
  const policy = options?.toolsPolicy ?? {}

  // 判断当前是为前端 AI 还是 DMN 创建工具集
  // 优先用显式传入的 agent 参数，否则从 ctx.dmnId 推断
  // 'lilith'（边界隔离）：莉莉丝工具面 = 前端工具 + 莉莉丝专属工具
  const agent: 'frontend' | 'dmn' | 'lilith' = options?.agent ?? (ctx.dmnId ? 'dmn' : 'frontend')

  // 权限绿通：仅自动启用 app_restart（唯一依赖绿通的系统工具——绿通开启 = 用户授权 AI 自我重启）。
  // 注意：run_command/launch_app/system_setting/clipboard 不需要在这里处理——它们由用户在设置页
  // 手动启用（config.frontendToolPolicy.tools），绿通只影响 requestPermission 权限放行，不影响工具启用。
  // 黑名单命令拦截在 run_command 内部，天然优先于绿通放行，不受此影响。
  const GREENLIGHT_TOOLS = ['app_restart']
  const effectivePolicy =
    options?.greenlightEnabled && agent === 'frontend'
      ? { ...policy, ...Object.fromEntries(GREENLIGHT_TOOLS.map((id) => [id, { enabled: true }])) }
      : policy

  const tools = new Map<string, AnyTool>()
  const queriedTools = new Set<string>()

  // 按需工具池：先按 agents 归属过滤，再按 policy 过滤，最后按 visible 条件过滤
  const onDemandMap = new Map<string, AnyTool>()
  for (const { id, ctor } of ALL_TOOL_CTORS) {
    const tool = toAnyTool(ctor)
    // 先检查工具是否对当前 agent 可见（agents 字段）
    if (!isToolForAgent(id, agent)) continue
    // 再检查 policy 启用状态
    if (isToolEnabled(id, effectivePolicy)) {
      // 最后检查 visible 条件（配置不允许时根本不暴露，如关闭联网后 web_search 不可见）
      const meta = TOOL_MAP[id]
      if (meta?.visible && !meta.visible(options?.config)) continue
      onDemandMap.set(id, tool)
    }
  }

  // 合并 MCP 工具到 onDemandMap（按 agents 归属 + policy 过滤）
  // 归属与内置工具统一（adaptMcpToolMeta 的 agents=['frontend','dmn'] → DMN 可用、莉莉丝不可见）
  if (options?.mcpClientManager) {
    const mcpTools = options.mcpClientManager.getAllTools()
    const callToolBound = options.mcpClientManager.callTool.bind(options.mcpClientManager)
    for (const { serverName, tool } of mcpTools) {
      const adapted = adaptMcpTool(serverName, tool, callToolBound)
      if (isToolForAgent(adapted.name, agent) && isToolEnabled(adapted.name, effectivePolicy)) {
        onDemandMap.set(adapted.name, adapted)
      }
    }
  }

  // 合并插件工具到 onDemandMap（为什么存在：插件脚本注册的浏览器/计算机等工具必须进统一工具池，
  // 否则 AI 看到描述却无实现可调，或实现存在却因未注册而注入失败——两端必须同源）。
  // 作用：把插件工具按 agents 归属 + 设置页显式关闭过滤后并入 onDemandMap。
  // 启用语义（2026-08-18 修复，勿回退）：PluginLoader.getTools() 已按插件级整体 enabled 过滤
  // （插件开才返回工具），这里【不再】按 meta.defaultEnabled 二次过滤——否则插件已启用、
  // 工具仍因 defaultEnabled=false 永不进池（如 computer-use 的 screen_capture），插件形同虚设。
  // 仅设置页显式关闭（policy enabled=false）时排除，使插件工具的开关真实生效——
  // 否则用户关闭 browser_* 等插件工具时注入仍发生，设置页开关形同虚设（无效按钮）。
  if (options?.pluginTools) {
    for (const tool of options.pluginTools) {
      if (!isToolForAgent(tool.name, agent)) continue
      const entry = effectivePolicy[tool.name]
      if (entry && !entry.enabled) continue // 仅显式关闭才排除；未配置/显式开启均视为启用
      onDemandMap.set(tool.name, tool)
    }
  }

  // 直接注入模式（onDemand 两步机制已退役）：
  // 所有按 policy + visible 条件过滤后的工具 schema 直接注入 prompt，AI 直接调用
  for (const [name, tool] of onDemandMap) {
    tools.set(name, tool)
  }

  return { tools, ctx, queriedTools }
}

// ===== 向后兼容别名（旧调用方无需改动）=====

/** @deprecated 用 createToolRegistry 替代 */
export type FrontendToolRegistryOptions = ToolRegistryOptions

/** @deprecated 用 createToolRegistry 替代 */
export function createFrontendToolRegistry(
  ctx: ToolContext = {},
  options?: ToolRegistryOptions
): ToolRegistry {
  return createToolRegistry(ctx, options)
}

/**
 * @deprecated 用 createToolRegistry 替代
 * 旧 DMN 工厂映射：includeOnDemand=true → onDemandEnabled=true（按需加载），false → onDemandEnabled=false（直接注入）
 */
export function createDmnToolRegistry(
  ctx: ToolContext = {},
  _includeOnDemand = true,
  options?: { toolsPolicy?: Record<string, ToolPolicy>; mcpClientManager?: McpClientManager }
): ToolRegistry {
  // onDemand 两步机制已退役：第二个参数保留仅为向后兼容，不再影响行为
  return createToolRegistry(ctx, {
    toolsPolicy: options?.toolsPolicy,
    mcpClientManager: options?.mcpClientManager
  })
}