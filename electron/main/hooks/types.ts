/**
 * Hook 类型定义：为什么存在——前后端与主进程都引用同一套 hook 事件/处理器类型，
 * 单独成文件可避免循环依赖并让类型边界清晰。
 * 作用：复用 shared 层纯数据类型，并补充主进程侧 HookContext / HookResult / ResolvedHook。
 * 不删理由：hook-manager、config-loader、defaults 及 IPC 层均依赖本文件的
 * 统一类型契约，删除会导致主进程与前端 Hook 类型分叉。
 */
import type { ToolResult } from '../tools/base-tool'
// 纯数据类型从 shared 复用，避免前后端类型重复定义
export type {
  HookEvent,
  HookScope,
  HookType,
  HookHandler,
  HookMatcherGroup,
  HooksConfig
} from '@shared/types'
// 本文件内 ResolvedHook/HookContext 引用
import type { HookEvent, HookHandler, HookScope } from '@shared/types'

/**
 * Hook 事件类型说明（详见 @shared/types）

 * 月蚀实现的子集（按实际需求裁剪）：
 * - PreToolUse / PostToolUse：工具执行前后（最常用，90% 护栏需求）
 * - UserPromptSubmit：用户提交消息时
 * - Stop：AI 完成响应时
 * - SubagentStop：子 agent 完成时（直接启用）
 * - Notification：需要通知用户时

 * 不做的事件（见第 8 节）：
 * - SessionStart/SessionEnd：月蚀已有 buildInjectedMessages + closeApiServer
 * - PermissionRequest：月蚀已有 requestPermission 机制
 * - PostToolUseFailure：PostToolUse 已覆盖（result.ok=false 时即为失败）
 * - PreCompact/PostCompact：月蚀的截断是 FIFO，无 LLM 压缩
 */

/**
 * Hook 执行上下文（传给处理器的 JSON）

 * 主进程私有类型：toolResult 依赖 ToolResult（含工具执行细节），
 * 不放 shared，避免前端类型图拉入主进程依赖。
 * IPC 边界（hooksTest）用 Record<string, unknown> 传递。
 */
export interface HookContext {
  /** 触发的事件类型 */
  event: HookEvent
  /** 工具名（PreToolUse/PostToolUse 时有） */
  toolName?: string
  /** 工具参数（PreToolUse/PostToolUse 时有） */
  toolParams?: Record<string, unknown>
  /** 工具执行结果（PostToolUse 时有） */
  toolResult?: ToolResult
  /** 用户提交的消息（UserPromptSubmit 时有） */
  userPrompt?: string
  /** 会话尾部连续空转轮数（PreLLMCall 时有；空转=assistant 消息无工具调用且内容为空/超短） */
  idleRounds?: number
  /** 会话尾部连续失败轮数（PreLLMCall 时有；失败轮=assistant 消息有工具调用且全部 result.ok=false） */
  recentFailures?: number
  /** 治理机制开关（PreLLMCall/PreToolUse 时有；undefined=全部开启，可经 config 覆盖层关闭） */
  governance?: { idleSuppression?: boolean; factCheckReminder?: boolean; closingReflection?: boolean; failureCircuitBreaker?: boolean }
  /** 会话 ID */
  sessionId?: string
  /** DMN ID（DMN 子 agent 场景） */
  dmnId?: string
  /** 子 agent 输出（SubagentStop 时有） */
  subagentOutput?: string
  /** 当前工作目录 */
  cwd: string
}

/**
 * Hook 执行结果
 */
export interface HookResult {
  /** continue=通过 / block=阻断（停止操作） / error=错误（非阻断，显示后继续） */
  action: 'continue' | 'block' | 'error'
  /** block/error 时显示给用户的消息 */
  message?: string
  /** PreToolUse 可修改工具参数（合并到原参数） */
  modifiedParams?: Record<string, unknown>
  /** PostToolUse 可修改工具结果（替换原结果） */
  modifiedResult?: ToolResult
  /** PreLLMCall 可注入上下文文本（追加为一条 user 角色消息，置于用户消息之前） */
  injectedContext?: string
}

/**
 * 已解析的 Hook 条目（内部使用，含作用域和来源信息）
 */
export interface ResolvedHook {
  event: HookEvent
  handler: HookHandler
  matcher?: string
  scope: HookScope
  /** 配置文件路径（调试/错误信息用） */
  sourceFile: string
}
