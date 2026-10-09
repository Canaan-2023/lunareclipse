/**
 * 子代理类型定义：为什么存在——SubAgentManager 与调用方（前端 AI / DMN）需要一份
 * 与具体执行引擎无关的通用类型契约。
 * 作用：定义 NamedTool / SubAgentLaunchOptions / SubAgentResult / 并发配置与子代理事件类型。
 */
import type { ChatMessage } from '@shared/types'

/**
 * 工具项约束：必须有 name 字段（用于白/黑名单过滤）。

 * 设计说明：前端 AI 路径的工具是 ToolExecutor（execute(args) 无 ctx），
 * DMN 路径的工具是 AnyTool（execute(params, ctx)）。两者结构不同且非继承关系，
 * 因此 SubAgentManager 采用泛型 <T extends NamedTool>，由调用方注入具体工具类型。
 */
export interface NamedTool {
  name: string
  caps?: string[]
}

/** 子 agent 启动配置 */
export interface SubAgentLaunchOptions {
  /** 子 agent 的 system prompt（子 agent 独立上下文的系统消息） */
  systemPrompt: string
  /** 用户消息（子任务的具体指令） */
  userMessage: string
  /** 工具白名单（只允许使用的工具名，不填则继承全部启用工具） */
  allowedTools?: string[]
  /** 工具黑名单（从继承列表中移除的工具名） */
  disallowedTools?: string[]
  /** 能力黑名单（子 agent 不允许使用的 caps，如 destructive、network） */
  denyCaps?: string[]
  /** 最大轮次（2026-10-02 起默认不限制，由 timeoutMs 兜底） */
  maxTurns?: number
  /** 超时毫秒（默认 600000 = 10 分钟） */
  timeoutMs?: number
  /** 团队上下文（任务模式：注入成员身份，team_* 工具识别"我是谁"；无则不注入） */
  teamContext?: { teamId: string; memberId: string }
}

/** 子 agent 执行结果 */
export interface SubAgentResult {
  /** 子 agent 的最终输出（完整返回，不折叠不截断；上下文压缩由主链路工具结果蒸馏统一负责） */
  output: string
  /** 是否超时 */
  timedOut: boolean
  /** 实际执行轮次（executeFn 不返回实际轮次，此处为 -1 表示未知，仅记录用） */
  turns: number
  /** 错误信息（执行失败时） */
  error?: string
  /**
   * 超时后的托管任务 id（软超时协议）：超时不硬断——子 agent 转后台继续运行，
   * 登记到托管注册表；AI 用 tool_watch(taskId, waitMs) 检查进度/设定新时间续期，
   * 用 tool_stop(taskId) 主动停止。未超时/未托管时缺失。
   */
  managedTaskId?: string
}

/** 并发控制配置 */
export interface ConcurrencyConfig {
  /**
   * 最大并发数。
   * - 显式数字：按此值限流（调用方强制覆盖，如测试/特殊场景）
   * - 'auto'：启动时检测机器配置（CPU 核心 × 内存）自动计算（见 services/subagent-scheduler.ts）
   * 默认 'auto'——用户明确要求"检查电脑配置、自动分配、排队"，硬编码 10 无法适配不同机型。
   */
  maxConcurrent: number | 'auto'
  /** 最大嵌套深度（默认 1，不嵌套） */
  maxSpawnDepth: number
}

/**
 * 执行函数签名（由调用方注入执行引擎）。
 * - 前端 AI 路径：注入包装 llmClient.streamWithTools 的函数，T = ToolExecutor
 * - DMN 路径：注入包装 dmnRunner.run 的函数，T = AnyTool

 * opts.emit：子 agent 过程事件通道（子 agent 过程对用户可见）。
 * 执行引擎把内部事件（工具开始/结束、输出、错误）通过 emit 实时转发，
 * 由上层（server.ts）转成 WS 消息推给前端渲染。不传 emit 时行为与旧版一致（黑盒）。
 */
export type SubAgentExecuteFn<T extends NamedTool> = (
  messages: ChatMessage[],
  tools: T[],
  opts: { maxTurns?: number; timeoutMs: number; dmnId?: string; signal?: AbortSignal; emit?: (evt: SubAgentEvent) => void }
) => Promise<string>

/** 子 agent 过程事件（SubAgentManager → 上层 → WS → 前端） */
export type SubAgentEvent =
  /** 子 agent 启动（携带任务信息，前端据此创建 subagent 行） */
  | { type: 'start'; agentId: string; prompt: string; mode: 'serial' | 'parallel'; index: number; total: number; parentToolCallId?: string }
  /** 子 agent 内部工具调用开始 */
  | { type: 'tool_start'; agentId: string; toolName: string; toolCallId: string; args: Record<string, unknown>; parentToolCallId?: string }
  /** 子 agent 内部工具调用结束（result 为工具返回的原始字符串） */
  | { type: 'tool_end'; agentId: string; toolName: string; toolCallId: string; result: string; parentToolCallId?: string }
  /** 子 agent 内部输出增量（LLM token 流） */
  | { type: 'output'; agentId: string; text: string; parentToolCallId?: string }
  /** 子 agent 完成（携带最终输出/错误） */
  | { type: 'done'; agentId: string; output: string; error?: string; timedOut?: boolean; managedTaskId?: string; parentToolCallId?: string }
