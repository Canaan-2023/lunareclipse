/**
 * 记忆处理工作流调度器——共享类型与常量

 * 从 memory-workflow-scheduler.ts 拆出（L2 拆分 1/3）：
 * 类型定义 + 默认配置常量，供调度器主类与持久化模块共用。
 */
import type { MemoryScope } from '../models/paths'
import type { RawMemoryEntry } from '../services/raw-memory-next-batch'

export type DmnStatusValue = 'idle' | 'running' | 'frozen' | 'crashed' | 'stopped'

export interface MemoryWorkflowConfig {
  enabled: boolean
  checkIntervalSeconds: number
  /** 单批次 raw_memory 条数（新架构：每批 1 个封口 RAW，主调度器一次读完） */
  batchSize: number
  /** 子 AGENT 失败最大重试次数（超限交给 review 兜底修复） */
  agentMaxRetries: number
}

export interface MemoryWorkflowCallbacks {
  onOutput?: (dmnId: string, text: string) => void
  onToolCall?: (dmnId: string, toolName: string, params: Record<string, unknown>) => void
  onToolResult?: (
    dmnId: string,
    toolName: string,
    ok: boolean,
    data?: unknown,
    error?: string
  ) => void
  onDmnStart?: (dmnId: string) => void
  onDmnComplete?: (dmnId: string) => void
  onCrash?: (dmnId: string, reason: string) => void
  onConditionWait?: (reason: string) => void
}

export const DEFAULT_CONFIG: MemoryWorkflowConfig = {
  enabled: true,
  checkIntervalSeconds: 60,
  batchSize: 1,
  agentMaxRetries: 1
}

/**
 * 子 AGENT 最大并发数。
 * 曾限 2：LLMClient 单实例串行（currentController 单例），并行子 agent 同时调 LLM
 * 会互相覆盖 abort 控制 → 2 个以上必失败（用户实测）。
 * 根因修复：LLMClient 并发化（每请求独立 controller + abortReason，存 controllers map），并发互不干扰，
 * 放开到 4（仍留余量防 API 限流；DeepSeek 并发过高会 429）。
 */
export const MAX_CONCURRENT_AGENTS = 4

/** 主调度器输出的一条任务（= 一条已建记忆，对应一个子 AGENT 工作流） */
export interface DispatcherTask {
  记忆路径: string
  描述: string
  主题: string
  对话时间: string
  RAW路径: string
}

/** 未完成批次持久化结构（崩溃恢复用，按 stage 恢复） */
export interface PendingBatch {
  batch: RawMemoryEntry[]
  nextProgress: { 最后处理日期: string; 最后处理序号: number }
  /** 当前阶段主实例 ID（dispatcher / review；agents 阶段为 null） */
  instanceId: string | null
  /** 当前阶段：dispatcher / agents / review */
  stage: 'dispatcher' | 'agents' | 'review'
  /** dispatcher 输出的任务清单 JSON 原文（agents/review 阶段用） */
  dispatcherResult?: string
  /** 解析后的任务清单 */
  taskList?: DispatcherTask[]
  /** 排队中的子 AGENT 任务（并发限流：未启动的在此排队） */
  agentQueue?: DispatcherTask[]
  /** 子 AGENT 实例 ID 列表（agents 阶段追踪） */
  agentInstanceIds?: string[]
  /** 子 AGENT 实例 ID → 任务（失败重试时按任务重启） */
  agentTaskMap?: Record<string, DispatcherTask>
  /** 子 AGENT 实例 ID → 已重试次数 */
  agentRetries?: Record<string, number>
  /** 各子 AGENT 处理摘要（review 输入用） */
  agentResults?: string[]
  /** 当前 RAW 路径（注入用） */
  rawPath?: string
  /** 当前 RAW 全文（注入用） */
  rawContent?: string
  /** 记忆作用域（{uid, aiId}，分层：崩溃恢复时按作用域继续） */
  scope?: MemoryScope
}