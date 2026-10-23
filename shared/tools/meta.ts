/**
 * @category 工具
 * @summary 内置工具元数据模型（shared，纯类型）
 *
 * 为什么存在：工具的类别/风险/默认归属 agent 等元数据模型是前后端配置面板、工具集按策略过滤、工具调用可视化三处的共同契约，必须双端共享同一份类型定义。
 * 不删理由：本模块由 `shared/tools/registry.ts` 按 ADR-06 拆分而来，宿主降级为 barrel
 * 保全部消费方零改动；职责单一化后，改动面互不干扰（原单文件同时承载类型/目录/动态注册/
 * 策略/标签五类职责，任一处改动都会与其它职责在 merge 上冲突）。
 */

import type { ToolCategory } from '../types'

/**
 * 工具元数据。前后端共享单一数据源，用于：
 * - 配置面板展示工具列表（id/name/category）
 * - 工具集构造按 policy 过滤
 * - 工具调用可视化时的分类+中文标签

 * fullDescription 不存此处（太长），运行时从工具实例的 description 属性获取。
 */

/**
 * 工具可见性判定的 config 子集（对应 AppConfig 的受支持读取字段）。
 * 为什么抽成命名类型：visible 回调、buildToolDescription 缓存键、segments 装配三处
 * 都按此子集读取配置（webSearchEnabled/aiMode/imageGen/generation），集中标注避免
 * 各层用 `as` 强转或漏字段导致类型漂移。
 */
export interface ToolVisibleConfig {
  webSearchEnabled?: boolean
  imageGen?: { enabled?: boolean }
  aiAssist?: { platforms?: Array<{ enabled?: boolean }> }
  aiMode?: string
  generation?: { video?: { enabled?: boolean }; audio?: { enabled?: boolean } }
}

export interface ToolMeta {
  id: string
  name: string
  category: ToolCategory
  description: string
  defaultEnabled: boolean
  riskLevel: 'low' | 'medium' | 'high'
  isMechanism?: boolean
  /**
   * 延迟披露：默认不进 system prompt 工具清单（低频/特化内置工具）。AI 需要时用
   * tool_search 搜索发现（"select:<工具名>" 直接取说明）；function schema 仍全量注入
   * LLM 调用层、执行链按工具名查注册表不受影响——只省"文本描述"上下文，不损可用性。
   */
  deferred?: boolean
  /**
   * 该工具的默认归属 agent（仅影响 UI 配置面板默认展示分组，不影响工厂函数注入）。
   * 统一工具池后，所有工具对所有 AI 可注入，由 toolsPolicy 配置决定实际启用。
   * 'frontend' = 前端 AI 默认启用；'dmn' = 记忆工作流默认启用；'lilith' = 莉莉丝专属（工具边界隔离）；
   * 两者/三者都列 = 对应端默认启用。
   */
  agents: readonly ('frontend' | 'dmn' | 'lilith')[]
  /**
   * 声明式能力标签（如 'system:input'、'filesystem:write'、'network'）。
   * CapabilityGuard 按此做结构化拦截：denyCaps 命中任一则拦、allowCaps 白名单模式。
   */
  caps?: readonly string[]
  /**
    * 可见性条件：满足条件才出现在 system prompt / tool_info 中。
   * 与 policy 开关的区别：policy 控制"启不启用"，visible 控制"配置不允许时根本不暴露"——
   * 避免 AI 看到工具描述却调用必失败（如关闭联网后 web_search 仍列出）。
   * 不传 config 或条件返回非 false 时可见（默认可见，向后兼容）。
   */
  visible?: (cfg?: ToolVisibleConfig) => boolean
}

/**
 * MCP 工具适配后的元数据（扩展 ToolMeta）。
 * 定义在 shared 层（不依赖 MCP SDK），供 registry 动态注册使用。
 */
export interface McpToolMeta extends ToolMeta {
  /** 工具源：builtin 或 mcp */
  source: 'builtin' | 'mcp'
  /** MCP server 名称（source=mcp 时有效） */
  mcpServer?: string
  /** MCP 原始工具名（source=mcp 时有效，不含命名空间） */
  mcpToolName?: string
}

/**
 * 插件工具适配后的元数据（扩展 ToolMeta）。
 * 定义在 shared 层，供 registry 动态注册使用（与 MCP 工具同机制）。
 */
export interface PluginToolMeta extends ToolMeta {
  /** 工具源：plugin */
  source: 'plugin'
  /** 所属插件目录名 */
  plugin: string
}

