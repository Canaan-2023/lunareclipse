// ===== Hooks 共享类型 =====
// 纯数据类型，供前端 UI 和主进程共享。
// HookContext/HookResult 含 ToolResult 依赖（主进程私有），不在此导出。
// IPC 边界用 Record<string, unknown> 传递 ctx。
// 为什么存在：Hook 生命周期（PreToolUse/PostToolUse 等）在主进程钩子引擎中触发、配置由前端
// 设置页编辑，两端需共享事件/作用域/处理器契约；含主进程私有依赖的类型则留在 main。

/** Hook 生命周期事件 */
export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'PreLLMCall'
  | 'Stop'
  | 'SubagentStop'
  | 'Notification'

/** Hook 作用域（业界三级，月蚀简化为两级，local 按方案第8节排除） */
export type HookScope = 'global' | 'project'

/** Hook 类型（command=shell 命令 / javascript=同进程 JS 函数） */
export type HookType = 'command' | 'javascript'

/** Hook 处理器（command 或 javascript 二选一） */
export interface HookHandler {
  type: HookType
  /** command 类型：要执行的 shell 命令 */
  command?: string
  /** command 类型：命令参数 */
  args?: string[]
  /** javascript 类型：JS 函数体字符串，签名 (ctx) => result */
  handler?: string
  /** 超时（毫秒，默认 10000） */
  timeout?: number
}

/**
 * Hook 匹配器组（业界三层嵌套的中间层）

 * 结构：事件 → matcher 组数组 → hooks 数组
 * matcher 用正则匹配工具名（仅 PreToolUse/PostToolUse 有效），其他事件忽略 matcher
 */
export interface HookMatcherGroup {
  /** 正则匹配工具名（如 "Bash" / "Edit|Write" / ".*"），省略或 ".*" 表示匹配所有 */
  matcher?: string
  /** 该 matcher 组下的处理器数组 */
  hooks: HookHandler[]
}

/**
 * Hook 配置文件结构（业界标准三层嵌套）

 * ```json
 * {
 *   "hooks": {
 *     "PreToolUse": [
 *       { "matcher": "Bash", "hooks": [{ "type": "command", "command": "..." }] }
 *     ]
 *   }
 * }
 * ```
 */
export interface HooksConfig {
  hooks?: Partial<Record<HookEvent, HookMatcherGroup[]>>
}

/** 后端 DMN 配置
 *
 * DMN 已合并到记忆处理工作流（MEMORY_PIPELINE_TEMPLATE），工具集和提示词内嵌在工作流模板节点中。*/
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- 保留类型占位：配置面仍引用 DmnConfig 且允许任意空对象
export interface DmnConfig {
}