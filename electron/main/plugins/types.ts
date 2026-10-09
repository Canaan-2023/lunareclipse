/**
 * 插件子系统类型定义：统一 PluginManifest、工具元数据声明、模块声明、
 * Cordis 声明与 coeffect 服务依赖等跨模块数据契约——插件形态多样
 * （工具/hooks/prompts/config patch/Cordis/面板），需要一套稳定类型
 * 保证装载、注册、回滚各环节结构一致。
 */
import type { AnyTool, ToolParameter } from '../tools/base-tool'
import type { PluginToolMeta } from '../../../shared/tools/registry'

/**
 * 插件来源层级（对齐 SkillSource）：
 * - user：用户级（{root}/plugins/，可编辑/删除，优先级高于 bundled、低于 domain）
 * - domain：领域级（{root}/plugins_domains/，优先级最高，同名覆盖 user）
 * - bundled：内置层（源码 electron/main/plugins/bundled 或打包 resources/plugins/bundled，
 * 只读、不可删除、优先级最低，同名被 user/domain 覆盖）
 */
export type PluginSource = 'user' | 'domain' | 'bundled'

/**
 * 插件类型定义（行动层扩展）。

 * 插件 = abyssac_data/plugins/{插件名}/ 目录（模块的打包和生命周期容器）：
 * plugin.json # 元数据（name/description/version/author + tools 元数据 + 模块声明）
 * tools.js # CJS/ESM 模块：module.exports = [{ name, description, parameters, execute }]
 * hooks.js # 可选：{ register(reg, ctx) } —— 注册函数 hook（事件拦截/改写/注入）
 * prompts.md # 可选：# 标题 分段 —— 注入系统提示词的命名片段
 * config.patch.json # 可选：AppConfig 同构局部覆盖（启用时合并进配置读取链）

 * 加载器把 tools.js 导出的工具对象包装成标准 AnyTool，
 * 元数据注册进 dynamicToolMetas（与 MCP 工具同机制），进统一工具池过滤链。
 * hooks/prompts/configPatch 经内核统一注册表（kernel/registry）登记，
 * 卸载插件时批量回滚（可逆效应）。
 */
export interface PluginToolMetaDecl {
  /** 工具 id（与 tools.js 里导出的工具 name 一致） */
  id: string
  /** 展示名 */
  name: string
  /** 分类（如 'plugin'） */
  category?: string
  /** 一句话描述 */
  description?: string
  /** 默认启用（默认 true） */
  defaultEnabled?: boolean
  /** 风险等级 low/medium/high */
  riskLevel?: 'low' | 'medium' | 'high'
  /** 可见 agent（默认 ['frontend']） */
  agents?: Array<'frontend' | 'dmn' | 'lilith'>
  /** 声明式能力要求：工具所需能力标签（如 'filesystem:write'/'network'），供 CapabilityGuard 声明式校验 */
  caps?: string[]
}

/** plugin.json 结构 */
export interface PluginManifest {
  /** 插件名（kebab-case，唯一，目录同名） */
  name: string
  /** 插件描述 */
  description: string
  /** 版本号 */
  version: string
  /** 作者 */
  author?: string
  /** 来源层级（user=用户级 / domain=领域级，加载时标记，非 plugin.json 声明字段） */
  source?: PluginSource
  /** 工具元数据声明 */
  tools?: PluginToolMetaDecl[]
  /** 可选模块文件声明（缺省时按约定文件名探测） */
  modules?: {
    hooks?: string
    prompts?: string
    configPatch?: string
  }
  /** 依赖的其他插件名（加载顺序保证，先加载被依赖方） */
  dependsOn?: string[]
  /**
   * Cordis 模块声明（阶段 5a）：兼容 Cordis 模块生态。
   * 声明后本插件按 Cordis 协议加载：dynamic import entry 文件，取 default 导出
   * （函数 / Service 子类 / { inject?, apply(ctx) } 对象），由 cordis-mounter 挂载进 rootCtx。
   * - 模块 apply 收到的 ctx = 月蚀 rootCtx（Cordis 内核一致，API 100% 兼容），
   * 依赖经 ctx 服务键获取（ctx.coeffect/ctx.tools/ctx.config...），无需 import 任何框架包；
   * - 依赖上游 npm 包（vendor 目录内包元数据声明的包名）的模块需要服务名映射适配（兼容边界，见架构文档）。
   */
cordis?: {
    /** 入口文件（相对插件目录），default 导出为 Cordis Plugin */
    entry: string
    /** 可选：挂载时传给 apply 的 config（透传 ctx.plugin 第二参数） */
    config?: Record<string, unknown>
    /**
     * 可选：服务隔离声明（对齐 Cordis entry.isolate）：{ 服务名: 作用域标签 }。
     * 挂载时先 ctx.isolate(name, label)，插件在隔离作用域内 provide/get 该服务，
     * 不影响父级绑定；同名标签跨插件 join 同一作用域（对齐原生 isolate 语义）。
     */
    isolate?: Record<string, string>
    /**
     * 可选：服务配置拦截声明（对齐 Cordis entry.intercept）：{ 服务名: 配置片段 }。
     * 挂载时先 ctx.intercept(name, config)，插件内读取该服务配置时按祖先优先合并。
     */
    intercept?: Record<string, unknown>
  }
  /**
   * 提供的 coeffect 服务键（对齐）：列表里的键会在插件加载时 provide，
   * hooks.js 也可在 register 阶段用 reg.provide(key, value) 动态提供。卸载/停用即移除（可逆）。
   */
  provides?: string[]
  /**
   * 依赖的 coeffect 服务键（inject 声明）：加载时若对应服务未被任何已启用插件提供，
   * 插件进入启用但带警告（不崩）；提供方被替换/移除时自动重载依赖方（反应式）。
   */
  deps?: string[]
  /**
   * 前端面板声明：插件可声明自定义右侧栏 tab + 面板组件。
   * 声明后前端通过 plugin:panels IPC 获取面板列表，动态渲染对应组件。
   * 组件不通过插件加载（渲染进程安全边界），由前端按 panelId 硬编码映射。
   * 插件只负责声明"我有一个面板"和面板元数据，前端负责渲染逻辑。
   */
  panel?: PluginPanelDecl
}

/** 插件面板声明（plugin.json 的 panel 字段） */
export interface PluginPanelDecl {
  /** 面板 id（唯一，用作 RightPanelTabId，格式：plugin:{id}） */
  id: string
  /** 面板标题（显示在 tab 上，缺省时前端用插件目录名兜底） */
  title?: string
  /** 图标名（lucide-react 图标名，缺省时前端用 LayoutGrid 兜底） */
  icon?: string
  /** 面板组件标识（前端按此值选择渲染哪个 React 组件，如 'custom-panel'） */
  component: string
}

/** 插件加载结果（一个插件） */
export interface LoadedPlugin {
  /** 插件目录名 */
  dirName: string
  /** 插件目录绝对路径 */
  dirPath: string
  /** 来源层级（user=用户级 / domain=领域级） */
  source: PluginSource
  /** manifest（可能缺省，此时用 dirName 兜底） */
  manifest: PluginManifest
  /** 工具对象（来自 tools.js，可能是空） */
  tools: AnyTool[]
  /** 工具元数据（由 manifest.tools 构造，缺省时从工具对象推导） */
  metas: PluginToolMeta[]
  /** 加载错误（失败时 tools/metas 为空，errors 有内容） */
  errors: string[]
  /** 内核注册句柄（hooks/prompts/configPatch/coeffect提供，卸载时批量回滚） */
  kernelHandles: Array<{ disposed: boolean; dispose(): void }>
  /** 已加载的模块名列表（hooks/prompts/configPatch） */
  loadedModules: string[]
/** Cordis 入口文件绝对路径（manifest.cordis 声明时；未声明为 undefined） */
  cordisEntry?: string
  /** Cordis 挂载 config（透传 ctx.plugin 第二参数） */
  cordisConfig?: Record<string, unknown>
  /** Cordis 隔离声明（manifest.cordis.isolate；挂载时派生 ctx） */
  cordisIsolate?: Record<string, string>
  /** Cordis 拦截声明（manifest.cordis.intercept；挂载时派生 ctx） */
  cordisIntercept?: Record<string, unknown>
  /** 是否启用（运行时开关，默认 true） */
  enabled: boolean
  /** 本插件提供的 coeffect 服务键（react：提供方在加载时登记，卸载回滚） */
  provides: string[]
  /** 本插件依赖的 coeffect 服务键（react：缺失时记警告；提供方变更时触发重载） */
  deps: string[]
  /** 前端面板声明（manifest.panel 声明时存在） */
  panel?: PluginPanelDecl
}

/** PluginLoader 对外接口 */
export interface PluginLoaderApi {
  /** 重新扫描加载全部插件 */
  reload(): Promise<void>
  /** 当前全部已加载插件 */
  list(): LoadedPlugin[]
  /** 全部已启用插件的工具 */
  getTools(): AnyTool[]
  /** 设置插件启用状态（持久化到 .plugin-state.json；禁用回滚内核注册，启用重新加载） */
  setEnabled(dirName: string, enabled: boolean): Promise<void>
  /** 删除插件（注销工具 + 回滚内核句柄 + 删除目录 + 清理状态） */
  deletePlugin(dirName: string): Promise<{ ok: boolean; error?: string }>
  /** 监听变化（加载/启用状态变化时通知）；返回退订函数 */
  onChanged(cb: () => void): () => void
  /** 注册 Cordis 模块卸载回调（cordis-mounter 挂载成功后调用；deletePlugin 依赖它完成"先卸载 fiber 再删目录"） */
  setCordisUnloader(fn: (dirName: string) => Promise<void>): void
  /** 插件根目录 */
  getRootDir(): string
}

/** tools.js 导出的工具对象（模块结构，execute 可选 ctx） */
export type PluginToolModule = Array<{
  name: string
  description: string
  parameters?: ToolParameter[]
  execute: (params: Record<string, unknown>, ctx?: unknown) => Promise<{ ok: boolean; data?: unknown; error?: string }> | { ok: boolean; data?: unknown; error?: string }
}>
