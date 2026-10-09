/**
 * 内核扩展点类型定义（LXK：LunarEclipse Kernel）

 * 统一扩展模型：工具 / hook / prompt 段 / 配置覆盖 / 命令 / 面板 六类扩展，
 * 全部通过 ExtensionRegistry 注册，注册即返回可逆效应（disposer），
 * 卸载插件或停用模块时批量回滚。

 * 设计来源：借鉴"无特权核心 + 注册即效应 + 配置分层"的 harness 思想，
 * 自研轻量实现（不引入外部依赖），保持月蚀"消费者层零改动"的边界。
 */
import type { AnyTool } from '../tools/base-tool'
import type { ToolMeta } from '../../../shared/tools/registry'
import type { HookEvent } from '../../../shared/types'
import type { HookContext, HookResult } from '../hooks/types'

/** 扩展点类别 */
export type ExtensionKind = 'tool' | 'hook' | 'prompt' | 'configPatch' | 'command' | 'panel'

/** 扩展来源：决定回滚粒度与 AI 可见性 */
export type ExtensionSource =
  | { kind: 'builtin' }
  | { kind: 'plugin'; pluginName: string }
  | { kind: 'patch' }

/** 注册条目句柄（可逆效应） */
export interface ExtensionHandle<T = unknown> {
  /** 全局唯一 id */
  id: string
  kind: ExtensionKind
  source: ExtensionSource
  value: T
  /** 调用后该注册失效并执行清理 */
  dispose(): void
  /** 是否已失效 */
  disposed: boolean
}

/** prompt 段（注入系统提示词的命名片段） */
export interface PromptSection {
  /** 段名（slug，唯一） */
  name: string
  /** 段内容（markdown 文本） */
  content: string
  /** 排序权重（小的在前，默认 100） */
  order?: number
}

/** 人类命令（不经模型轮次直接分发） */
export interface CommandDef {
  id: string
  description: string
  run(args: string[], ctx: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: string }>
}

/** 前端面板声明（插件声明自定义右侧栏 tab） */
export interface PanelDef {
  /** 面板 id（唯一，用作 tab id） */
  id: string
  /** 面板标题 */
  title: string
  /** 图标名（lucide-react 图标名） */
  icon: string
  /** 面板组件标识（前端按此值选择渲染哪个 React 组件） */
  component: string
}

/** 函数式 hook 处理器（内核/插件注册形态） */
export type HookFn = (ctx: HookContext) => Promise<HookResult> | HookResult

/** 扩展注册协议（插件模块 / 内置模块共用） */
export interface ExtensionRegistrar {
  registerTool(tool: AnyTool, meta: ToolMeta): ExtensionHandle
  registerHook(event: HookEvent, fn: HookFn, opts?: { matcher?: string; priority?: number }): ExtensionHandle
  registerPrompt(section: PromptSection): ExtensionHandle
  registerConfigPatch(patch: Record<string, unknown>): ExtensionHandle
  registerCommand(cmd: CommandDef): ExtensionHandle
  registerPanel(panel: PanelDef): ExtensionHandle
  /** 提供某服务键（coeffect）的实现，返回可逆句柄（对齐 ctx.set / 提供者） */
  provide(key: string, value: unknown): { disposed: boolean; dispose(): void }
}

/** 插件上下文（register 阶段可用的辅助信息） */
export interface PluginModuleContext {
  pluginName: string
  pluginDir: string
  dataRoot: string
  /** coeffect 服务表访问（读依赖）：提供方已注册的服务在此可查 */
  coeffect: {
    get<T = unknown>(key: string): T | undefined
    has(key: string): boolean
  }
}

/** 插件导出协议（hooks.js 等） */
export interface PluginModule {
  name?: string
  register(reg: ExtensionRegistrar, ctx: PluginModuleContext): void | Promise<void>
}

/** 注册表快照（自我检视用） */
export interface RegistrySnapshot {
  counts: Record<ExtensionKind, number>
  bySource: Record<string, number>
  hooks: Array<{ id: string; event: string; matcher?: string; source: ExtensionSource }>
  tools: Array<{ id: string; name: string; source: ExtensionSource }>
  prompts: Array<{ id: string; name: string; source: ExtensionSource }>
  configPatches: Array<{ id: string; source: ExtensionSource }>
  commands: Array<{ id: string; source: ExtensionSource }>
  panels: Array<{ id: string; title: string; icon: string; component: string; source: ExtensionSource }>
}
